import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { businessRecords } from "../../drizzle/schema";
import { assertBalanced, makeJournalLine, roundAmount } from "../../shared/accounting";
import type { CurrencyCode, JournalEntry, JournalLine, LoyaltySettings, MenuItem, Promotion } from "../../shared/pos";
import { isPromotionActiveAt, isTimeRange } from "../../shared/promotions";
import { lockBusinessForUpdate, saveBusinessRecord } from "../db";
import { cashierProcedure, managerProcedure, requireDatabase } from "../_core/business";
import { router } from "../_core/trpc";

function id() { return randomUUID(); }
function recordAs<T>(value: Record<string, unknown>) { return value as unknown as T; }
function hashCode(value: string) { return createHash("sha256").update(value.trim().toUpperCase()).digest("hex"); }
function normalizePhone(value: string) { return value.replace(/[^\d+]/g, ""); }
function isDuplicateKey(error: unknown) { const candidate = error as { code?: string; cause?: { code?: string } } | null; return candidate?.code === "ER_DUP_ENTRY" || candidate?.cause?.code === "ER_DUP_ENTRY"; }
function round(value: number, currency: CurrencyCode) { return roundAmount(value, currency); }

async function getRecordTx(tx: any, businessId: string, kind: string, recordId: string) {
  const rows = await tx.select().from(businessRecords)
    .where(and(eq(businessRecords.businessId, businessId), eq(businessRecords.recordKind, kind), eq(businessRecords.recordId, recordId)))
    .for("update").limit(1);
  return rows[0] ?? null;
}

async function listPromotionRecordsTx(tx: any, businessId: string) {
  return tx.select().from(businessRecords)
    .where(and(eq(businessRecords.businessId, businessId), eq(businessRecords.recordKind, "promotion")))
    .for("update");
}

async function post(tx: any, businessId: string, actor: string, currency: CurrencyCode, input: { date: string; reference: string; description: string; lines: JournalLine[] }) {
  assertBalanced(input.lines, currency);
  const entry: JournalEntry = { id: id(), date: input.date, reference: input.reference, description: input.description, lines: input.lines, createdBy: actor };
  await saveBusinessRecord(tx, { businessId, recordKind: "journalEntry", recordId: entry.id, payload: entry as unknown as Record<string, unknown>, actorOpenId: actor });
  return entry;
}

export const programsRouter = router({
  activePromotions: cashierProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const rows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "promotion"))).orderBy(desc(businessRecords.createdAt));
    const now = Date.now();
    const timezone = ctx.member.business.timezone ?? "Asia/Jakarta";
    return rows.map((row) => recordAs<Promotion>(row.payload)).filter((offer) => isPromotionActiveAt(offer, now, timezone) && (offer.maxRedemptions === undefined || offer.redemptionCount < offer.maxRedemptions));
  }),

  promotions: managerProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const rows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "promotion"))).orderBy(desc(businessRecords.createdAt));
    return rows.map((row) => recordAs<Promotion>(row.payload));
  }),

  savePromotion: managerProcedure.input(z.object({
    id: z.string().uuid().optional(), name: z.string().trim().min(2).max(100), code: z.string().trim().max(32).optional(),
    discountType: z.enum(["percent", "fixed"]), value: z.number().finite().positive().max(1_000_000_000), ruleType: z.enum(["discount", "bogo", "bundle"]).default("discount"),
    buyItemId: z.string().min(1).max(80).optional(), buyQuantity: z.number().int().min(1).max(1_000_000).optional(), rewardItemId: z.string().min(1).max(80).optional(), rewardQuantity: z.number().int().min(1).max(1_000_000).optional(),
    bundleItems: z.array(z.object({ menuItemId: z.string().min(1).max(80), quantity: z.number().int().min(1).max(1_000_000) })).max(20).optional(), bundlePrice: z.number().finite().min(0).max(1_000_000_000).optional(),
    dailyStartTime: z.string().max(5).optional(), dailyEndTime: z.string().max(5).optional(), weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    startsAt: z.string().min(10), endsAt: z.string().min(10), active: z.boolean(), maxRedemptions: z.number().int().positive().max(100000).optional(),
  }).superRefine((input, issue) => {
    if (input.ruleType === "discount" && input.discountType === "percent" && input.value > 100) issue.addIssue({ code: "custom", message: "A percentage discount cannot exceed 100%.", path: ["value"] });
    if ((input.dailyStartTime === undefined) !== (input.dailyEndTime === undefined)) issue.addIssue({ code: "custom", message: "Set both daily schedule times or leave both blank.", path: ["dailyStartTime"] });
    if (input.dailyStartTime && !isTimeRange(input.dailyStartTime)) issue.addIssue({ code: "custom", message: "Use a valid 24-hour daily start time (HH:mm).", path: ["dailyStartTime"] });
    if (input.dailyEndTime && !isTimeRange(input.dailyEndTime)) issue.addIssue({ code: "custom", message: "Use a valid 24-hour daily end time (HH:mm).", path: ["dailyEndTime"] });
    if (new Set(input.weekdays ?? []).size !== (input.weekdays ?? []).length) issue.addIssue({ code: "custom", message: "Choose each weekday only once.", path: ["weekdays"] });
    if (input.ruleType === "bogo" && (!input.buyItemId || !input.rewardItemId || !input.buyQuantity || !input.rewardQuantity)) issue.addIssue({ code: "custom", message: "Choose the qualifying and reward items and quantities for Buy X Get Y Free.", path: ["buyItemId"] });
    if (input.ruleType === "bundle") {
      if (!input.bundleItems || input.bundleItems.length < 2 || !Number.isFinite(input.bundlePrice)) issue.addIssue({ code: "custom", message: "A bundle requires at least two item lines and a fixed bundle price.", path: ["bundleItems"] });
      if (new Set((input.bundleItems ?? []).map((line) => line.menuItemId)).size !== (input.bundleItems ?? []).length) issue.addIssue({ code: "custom", message: "Each menu item must appear once in a bundle; combine its quantity.", path: ["bundleItems"] });
    }
  })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const currency = ctx.member.business.currency as CurrencyCode;
    const start = new Date(input.startsAt);
    const end = new Date(input.endsAt);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a valid start and end date." });
    return db.transaction(async (tx) => {
      await lockBusinessForUpdate(tx, ctx.member.businessId);
      const promotionItemIds = input.ruleType === "bogo" ? [input.buyItemId!, input.rewardItemId!] : input.ruleType === "bundle" ? (input.bundleItems ?? []).map((line) => line.menuItemId) : [];
      if (promotionItemIds.length) {
        const menuRows = await tx.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "menuItem")));
        const menuItems = new Map(menuRows.map((row: any) => [row.recordId, recordAs<MenuItem>(row.payload)]));
        if (promotionItemIds.some((itemId) => { const item = menuItems.get(itemId); return !item || item.ingredientOnly === true; })) throw new TRPCError({ code: "BAD_REQUEST", message: "Promotion rules can include only sellable menu items in this workspace." });
      }
      const code = input.code?.trim().toUpperCase() || undefined;
      const rows = await listPromotionRecordsTx(tx, ctx.member.businessId);
      if (code && rows.some((row: any) => String(row.payload.code ?? "").toUpperCase() === code && row.recordId !== input.id)) throw new TRPCError({ code: "CONFLICT", message: "That coupon code is already in use." });
      const existing = input.id ? rows.find((row: any) => row.recordId === input.id) : undefined;
      const offer: Promotion = {
        id: input.id || id(), name: input.name, code, discountType: input.discountType,
        value: input.ruleType === "discount" && input.discountType === "fixed" ? round(input.value, currency) : input.value,
        ruleType: input.ruleType,
        buyItemId: input.ruleType === "bogo" ? input.buyItemId : undefined,
        buyQuantity: input.ruleType === "bogo" ? input.buyQuantity : undefined,
        rewardItemId: input.ruleType === "bogo" ? input.rewardItemId : undefined,
        rewardQuantity: input.ruleType === "bogo" ? input.rewardQuantity : undefined,
        bundleItems: input.ruleType === "bundle" ? input.bundleItems : undefined,
        bundlePrice: input.ruleType === "bundle" && input.bundlePrice !== undefined ? round(input.bundlePrice, currency) : undefined,
        dailyStartTime: input.dailyStartTime, dailyEndTime: input.dailyEndTime, weekdays: input.weekdays?.length ? [...input.weekdays].sort() : undefined,
        startsAt: start.toISOString(), endsAt: end.toISOString(), active: input.active, maxRedemptions: input.maxRedemptions,
        redemptionCount: Number(existing?.payload.redemptionCount ?? 0), createdAt: String(existing?.payload.createdAt ?? new Date().toISOString()),
      };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "promotion", recordId: offer.id, payload: offer as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      return offer;
    });
  }),

  deactivatePromotion: managerProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    return db.transaction(async (tx) => {
      await lockBusinessForUpdate(tx, ctx.member.businessId);
      const row = await getRecordTx(tx, ctx.member.businessId, "promotion", input.id);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Promotion not found." });
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "promotion", recordId: input.id, payload: { ...row.payload, active: false }, actorOpenId: ctx.user.openId });
      return { success: true };
    });
  }),

  giftCards: managerProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const rows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "giftCard"))).orderBy(desc(businessRecords.createdAt));
    return rows.map((row) => ({ id: row.recordId, lastFour: String(row.payload.lastFour ?? ""), initialBalance: Number(row.payload.initialBalance ?? 0), balance: Number(row.payload.balance ?? 0), status: String(row.payload.status ?? "active") as "active" | "redeemed" | "void", issuedAt: String(row.payload.issuedAt ?? row.createdAt), customerName: typeof row.payload.customerName === "string" ? row.payload.customerName : undefined }))
      .filter((card) => card.status !== "void");
  }),

  giftCardMovements: managerProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const [cards, movements] = await Promise.all([
      db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "giftCard"))),
      db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "giftCardMovement"))).orderBy(desc(businessRecords.createdAt)).limit(500),
    ]);
    const lastFour = new Map(cards.map((row) => [row.recordId, String(row.payload.lastFour ?? "")]));
    return movements.map((row) => ({ id: row.recordId, lastFour: lastFour.get(String(row.payload.giftCardId ?? "")) ?? "????", kind: row.payload.kind === "issue" ? "issue" as const : row.payload.kind === "reversal" ? "reversal" as const : "redeem" as const, amount: Number(row.payload.amount ?? 0), at: String(row.payload.at ?? row.createdAt) }));
  }),

  issueGiftCard: managerProcedure.input(z.object({ amount: z.number().positive().max(1_000_000_000), paymentMethod: z.enum(["Cash", "Card", "QRIS", "Other"]), customerName: z.string().trim().max(120).optional(), qrisVerified: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const currency = ctx.member.business.currency as CurrencyCode;
    const amount = round(input.amount, currency);
    if (amount <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: `Enter an amount that rounds to at least one ${currency} minor unit.` });
    if (input.paymentMethod === "QRIS" && !input.qrisVerified) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Verify the QRIS payment in the merchant app before issuing the card." });
    const code = randomBytes(8).toString("hex").toUpperCase();
    const cardId = id();
    const now = new Date().toISOString();
    return db.transaction(async (tx) => {
      const tender = input.paymentMethod === "Cash" ? { code: "1000", name: "Cash on hand" } : { code: "1010", name: input.paymentMethod === "QRIS" ? "QRIS clearing" : input.paymentMethod === "Card" ? "Card clearing" : "Other tender clearing" };
      const journal = await post(tx, ctx.member.businessId, ctx.user.openId, currency, { date: now, reference: `GIFT ${cardId.slice(0, 8).toUpperCase()}`, description: "Gift card issued", lines: [makeJournalLine(tender.code, tender.name, amount, 0, currency), makeJournalLine("2200", "Gift card liability", 0, amount, currency)] });
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "giftCard", recordId: cardId, payload: { codeHash: hashCode(code), lastFour: code.slice(-4), initialBalance: amount, balance: amount, status: "active", issuedAt: now, customerName: input.customerName || undefined, issueJournalEntryId: journal.id } as Record<string, unknown>, actorOpenId: ctx.user.openId });
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "giftCardMovement", recordId: id(), payload: { giftCardId: cardId, amount, kind: "issue", at: now }, actorOpenId: ctx.user.openId });
      return { id: cardId, code, amount, lastFour: code.slice(-4) };
    });
  }),

  loyaltySettings: managerProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const rows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "loyaltySettings"), eq(businessRecords.recordId, "default"))).limit(1);
    if (rows[0]) return recordAs<LoyaltySettings>(rows[0].payload);
    return { currencyStep: ctx.member.business.currency === "IDR" ? 10000 : 1, earnPerCurrencyStep: 1, redemptionValuePerPoint: ctx.member.business.currency === "IDR" ? 100 : 0.01 };
  }),

  saveLoyaltySettings: managerProcedure.input(z.object({ currencyStep: z.number().positive().max(1_000_000_000), earnPerCurrencyStep: z.number().int().positive().max(10000), redemptionValuePerPoint: z.number().positive().max(1_000_000) })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const currency = ctx.member.business.currency as CurrencyCode;
    const currencyStep = round(input.currencyStep, currency);
    const redemptionValuePerPoint = round(input.redemptionValuePerPoint, currency);
    if (currencyStep <= 0 || redemptionValuePerPoint <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: `Choose a spend threshold and point value that round to at least one ${currency} minor unit.` });
    const settings: LoyaltySettings = { currencyStep, earnPerCurrencyStep: input.earnPerCurrencyStep, redemptionValuePerPoint };
    await saveBusinessRecord(db, { businessId: ctx.member.businessId, recordKind: "loyaltySettings", recordId: "default", payload: settings as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
    return settings;
  }),

  loyaltyCustomers: managerProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const rows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "loyaltyAccount"))).orderBy(desc(businessRecords.createdAt)).limit(500);
    return rows.map((row) => ({ id: row.recordId, customerName: String(row.payload.customerName ?? "Customer"), phone: String(row.payload.phone ?? ""), pointsBalance: Number(row.payload.pointsBalance ?? 0), createdAt: String(row.payload.createdAt ?? row.createdAt) }));
  }),

  loyaltyMovements: managerProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const [accounts, movements] = await Promise.all([
      db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "loyaltyAccount"))),
      db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "loyaltyMovement"))).orderBy(desc(businessRecords.createdAt)).limit(500),
    ]);
    const accountNames = new Map(accounts.map((row) => [row.recordId, String(row.payload.customerName ?? "Customer")]));
    return movements.map((row) => ({ id: row.recordId, customerName: accountNames.get(String(row.payload.accountId ?? "")) ?? "Former customer", kind: row.payload.kind === "reversal" ? "reversal" as const : "sale" as const, pointsChange: Number(row.payload.pointsChange ?? Number(row.payload.earned ?? 0) - Number(row.payload.redeemed ?? 0)), earnedPointsUnavailable: Number(row.payload.earnedPointsUnavailable ?? 0), at: String(row.payload.at ?? row.createdAt) }));
  }),

  getLoyaltySettings: cashierProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const rows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "loyaltySettings"), eq(businessRecords.recordId, "default"))).limit(1);
    if (rows[0]) return recordAs<LoyaltySettings>(rows[0].payload);
    return { currencyStep: ctx.member.business.currency === "IDR" ? 10000 : 1, earnPerCurrencyStep: 1, redemptionValuePerPoint: ctx.member.business.currency === "IDR" ? 100 : 0.01 };
  }),

  findLoyaltyCustomer: cashierProcedure.input(z.object({ phone: z.string().trim().min(3).max(40) })).query(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const rows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "loyaltyAccount")));
    const normalized = normalizePhone(input.phone);
    const match = rows.find((row) => normalizePhone(String(row.payload.phone ?? "")) === normalized);
    if (!match) return null;
    return { id: match.recordId, customerName: match.payload.customerName, phone: match.payload.phone, pointsBalance: Number(match.payload.pointsBalance ?? 0) };
  }),

  createLoyaltyCustomer: cashierProcedure.input(z.object({ customerName: z.string().trim().min(1).max(120), phone: z.string().trim().min(6).max(40).refine((value) => /^\+?\d{6,15}$/.test(normalizePhone(value)), "Enter a phone number with 6–15 digits.") })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const rows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "loyaltyAccount")));
    const phone = normalizePhone(input.phone);
    const existing = rows.find((row) => normalizePhone(String(row.payload.phone ?? "")) === phone);
    if (existing) return { id: existing.recordId, customerName: existing.payload.customerName, phone: existing.payload.phone, pointsBalance: Number(existing.payload.pointsBalance ?? 0), existed: true };
    const accountId = createHash("sha256").update(`${ctx.member.businessId}:${phone}`).digest("hex");
    const customer = { id: accountId, customerName: input.customerName, phone: input.phone.trim(), pointsBalance: 0, createdAt: new Date().toISOString() };
    try {
      await db.insert(businessRecords).values({ id: id(), businessId: ctx.member.businessId, recordKind: "loyaltyAccount", recordId: accountId, payload: customer, createdByOpenId: ctx.user.openId });
      return { ...customer, existed: false };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const concurrent = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "loyaltyAccount"), eq(businessRecords.recordId, accountId))).limit(1);
      if (!concurrent[0]) throw error;
      return { id: concurrent[0].recordId, customerName: concurrent[0].payload.customerName, phone: concurrent[0].payload.phone, pointsBalance: Number(concurrent[0].payload.pointsBalance ?? 0), existed: true };
    }
  }),
});
