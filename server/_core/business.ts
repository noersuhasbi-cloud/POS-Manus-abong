import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { businessMembers } from "../../drizzle/schema";
import { getBusinessMemberByOpenId, getDb } from "../db";
import { protectedProcedure } from "./trpc";

export const workspaceProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const member = await getBusinessMemberByOpenId(ctx.user.openId);
  if (!member) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Create or join a workspace to continue." });
  return next({ ctx: { ...ctx, member } });
});

export const managerProcedure = workspaceProcedure.use(async ({ ctx, next }) => {
  if (ctx.member.role !== "manager") throw new TRPCError({ code: "FORBIDDEN", message: "Manager access is required for this action." });
  return next({ ctx });
});

export const cashierProcedure = workspaceProcedure.use(async ({ ctx, next }) => {
  if (ctx.member.role !== "cashier" && ctx.member.role !== "manager") throw new TRPCError({ code: "FORBIDDEN", message: "Cashier access is required for this action." });
  return next({ ctx });
});

export const kitchenProcedure = workspaceProcedure.use(async ({ ctx, next }) => {
  if (ctx.member.role !== "kitchen" && ctx.member.role !== "manager") throw new TRPCError({ code: "FORBIDDEN", message: "Kitchen access is required for this action." });
  return next({ ctx });
});

export async function requireDatabase() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "The shared register is temporarily unavailable. Check your connection and try again." });
  return db;
}

export async function ensureWorkspaceMemberPresent(openId: string) {
  const db = await requireDatabase();
  return db.select().from(businessMembers).where(eq(businessMembers.openId, openId)).limit(1);
}
