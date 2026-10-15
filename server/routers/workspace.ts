import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { businessInvites, businessMembers, businesses } from "../../drizzle/schema";
import { getDefaultMenu, type BusinessRole, type CurrencyCode } from "../../shared/pos";
import { getBusinessMemberByOpenId, getDb, saveBusinessRecord } from "../db";
import { managerProcedure, requireDatabase } from "../_core/business";
import { protectedProcedure, router } from "../_core/trpc";

const roleSchema = z.enum(["manager", "cashier", "kitchen"]);
const timeZoneSchema = z.string().trim().min(3).max(64).refine((value) => { try { Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; } }, "Choose a valid IANA time zone.");
const defaultAccounts = [
  { code: "1000", name: "Cash on hand", type: "asset" },
  { code: "1010", name: "Card & QRIS clearing", type: "asset" },
  { code: "1100", name: "Accounts receivable", type: "asset" },
  { code: "2000", name: "Accounts payable", type: "liability" },
  { code: "2100", name: "Tax payable", type: "liability" },
  { code: "2200", name: "Gift card liability", type: "liability" },
  { code: "3000", name: "Owner equity", type: "equity" },
  { code: "4000", name: "Sales revenue", type: "income" },
  { code: "4100", name: "Sales discounts & returns", type: "contra_income" },
  { code: "5000", name: "Cost of goods sold", type: "expense" },
  { code: "6000", name: "Operating expenses", type: "expense" },
] as const;

function hashInvite(code: string) {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function isDuplicateKey(error: unknown) {
  const candidate = error as { code?: string; cause?: { code?: string } } | null;
  return candidate?.code === "ER_DUP_ENTRY" || candidate?.cause?.code === "ER_DUP_ENTRY";
}

function membershipConflict(status?: string) {
  if (status === "suspended") return new TRPCError({ code: "FORBIDDEN", message: "This Manus account is linked to a suspended workspace. Ask its manager to restore access." });
  return new TRPCError({ code: "CONFLICT", message: "This account already belongs to a workspace." });
}

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function seedWorkspace(db: any, businessId: string, openId: string, currency: CurrencyCode) {
  for (const account of defaultAccounts) {
    await saveBusinessRecord(db, { businessId, recordKind: "account", recordId: account.code, payload: account as unknown as Record<string, unknown>, actorOpenId: openId });
  }
  for (const menuItem of getDefaultMenu(currency)) {
    await saveBusinessRecord(db, { businessId, recordKind: "menuItem", recordId: menuItem.id, payload: menuItem as unknown as Record<string, unknown>, actorOpenId: openId });
  }
  await saveBusinessRecord(db, { businessId, recordKind: "loyaltySettings", recordId: "default", payload: { currencyStep: currency === "IDR" ? 10000 : 1, earnPerCurrencyStep: 1, redemptionValuePerPoint: currency === "IDR" ? 100 : 0.01 }, actorOpenId: openId });
}

export const workspaceRouter = router({
  current: protectedProcedure.input(z.object({ cacheScope: z.string().min(1).max(128) })).query(async ({ ctx }) => {
    const member = await getBusinessMemberByOpenId(ctx.user.openId);
    if (!member) return { sessionOpenId: ctx.user.openId, workspace: null };
    return {
      sessionOpenId: ctx.user.openId,
      workspace: {
        id: member.business.id,
        name: member.business.name,
        currency: member.business.currency,
        taxRateBasisPoints: member.business.taxRateBasisPoints,
        timezone: member.business.timezone,
        role: member.role,
        memberId: member.id,
        memberName: member.displayName || ctx.user.name || "Team member",
      },
    };
  }),

  create: protectedProcedure.input(z.object({ name: z.string().trim().min(2).max(120), currency: z.enum(["IDR", "USD"]).default("IDR"), taxRateBasisPoints: z.number().int().min(0).max(3000).default(0), timezone: timeZoneSchema.default("Asia/Jakarta") })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const existing = await db.select().from(businessMembers).where(eq(businessMembers.openId, ctx.user.openId)).limit(1);
    if (existing[0]) throw membershipConflict(existing[0].status);
    const id = randomUUID();
    try {
      await db.transaction(async (tx) => {
        await tx.insert(businesses).values({ id, name: input.name, createdByOpenId: ctx.user.openId, currency: input.currency, taxRateBasisPoints: input.taxRateBasisPoints, timezone: input.timezone });
        await tx.insert(businessMembers).values({ id: randomUUID(), businessId: id, openId: ctx.user.openId, displayName: ctx.user.name || "Manager", email: ctx.user.email, role: "manager", status: "active" });
        await seedWorkspace(tx, id, ctx.user.openId, input.currency);
      });
    } catch (error) { if (isDuplicateKey(error)) throw membershipConflict(); throw error; }
    return { success: true, id };
  }),

  join: protectedProcedure.input(z.object({ code: z.string().trim().min(12).max(32) })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const existing = await db.select().from(businessMembers).where(eq(businessMembers.openId, ctx.user.openId)).limit(1);
    if (existing[0]) throw membershipConflict(existing[0].status);
    const codeHash = hashInvite(input.code);
    try {
      await db.transaction(async (tx) => {
        const invites = await tx.select().from(businessInvites).where(eq(businessInvites.codeHash, codeHash)).for("update").limit(1);
        const invite = invites[0];
        if (!invite || invite.usedAt || invite.revokedAt || invite.expiresAt.getTime() <= Date.now()) throw new TRPCError({ code: "NOT_FOUND", message: "That invite code is invalid, expired, or already used." });
        await tx.insert(businessMembers).values({ id: randomUUID(), businessId: invite.businessId, openId: ctx.user.openId, displayName: ctx.user.name || "Team member", email: ctx.user.email, role: invite.role, status: "active" });
        await tx.update(businessInvites).set({ usedAt: new Date() }).where(eq(businessInvites.id, invite.id));
      });
    } catch (error) { if (isDuplicateKey(error)) throw membershipConflict(); throw error; }
    return { success: true };
  }),

  invite: managerProcedure.input(z.object({ role: roleSchema })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const code = randomBytes(10).toString("hex").toUpperCase();
    const now = new Date();
    await db.insert(businessInvites).values({ id: randomUUID(), businessId: ctx.member.businessId, codeHash: hashInvite(code), role: input.role, createdByOpenId: ctx.user.openId, expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000) });
    return { code, role: input.role, expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString() };
  }),

  invites: managerProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const rows = await db.select().from(businessInvites).where(eq(businessInvites.businessId, ctx.member.businessId)).orderBy(desc(businessInvites.createdAt));
    return rows.map((row) => ({ id: row.id, role: row.role, expiresAt: iso(row.expiresAt)!, usedAt: iso(row.usedAt), revokedAt: iso(row.revokedAt), createdAt: iso(row.createdAt)! }));
  }),

  revokeInvite: managerProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    await db.update(businessInvites).set({ revokedAt: new Date() }).where(and(eq(businessInvites.id, input.id), eq(businessInvites.businessId, ctx.member.businessId), isNull(businessInvites.usedAt), isNull(businessInvites.revokedAt)));
    return { success: true };
  }),

  members: managerProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const rows = await db.select().from(businessMembers).where(eq(businessMembers.businessId, ctx.member.businessId)).orderBy(desc(businessMembers.createdAt));
    return rows.map((row) => ({ id: row.id, openId: row.openId, displayName: row.displayName, email: row.email, role: row.role, status: row.status, createdAt: iso(row.createdAt)! }));
  }),

  updateMember: managerProcedure.input(z.object({ id: z.string().uuid(), role: roleSchema, status: z.enum(["active", "suspended"]) })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    await db.transaction(async (tx) => {
      const workspaceRows = await tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, ctx.member.businessId)).for("update").limit(1);
      if (!workspaceRows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found." });
      const targetRows = await tx.select().from(businessMembers).where(and(eq(businessMembers.id, input.id), eq(businessMembers.businessId, ctx.member.businessId))).for("update").limit(1);
      const target = targetRows[0];
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Team member not found." });
      if (target.role === "manager" && target.status === "active" && (input.role !== "manager" || input.status !== "active")) {
        const managers = await tx.select().from(businessMembers).where(and(eq(businessMembers.businessId, ctx.member.businessId), eq(businessMembers.role, "manager"), eq(businessMembers.status, "active")));
        if (managers.length <= 1) throw new TRPCError({ code: "BAD_REQUEST", message: "The last active manager cannot be suspended or demoted." });
      }
      await tx.update(businessMembers).set({ role: input.role, status: input.status }).where(eq(businessMembers.id, input.id));
    });
    return { success: true };
  }),

  settings: managerProcedure.query(({ ctx }) => ({ id: ctx.member.business.id, name: ctx.member.business.name, currency: ctx.member.business.currency, taxRateBasisPoints: ctx.member.business.taxRateBasisPoints, timezone: ctx.member.business.timezone })),

  updateSettings: managerProcedure.input(z.object({ name: z.string().trim().min(2).max(120), taxRateBasisPoints: z.number().int().min(0).max(3000), timezone: timeZoneSchema })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    await db.update(businesses).set({ name: input.name, taxRateBasisPoints: input.taxRateBasisPoints, timezone: input.timezone }).where(eq(businesses.id, ctx.member.businessId));
    return { success: true };
  }),
});
