import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { businessMembers, businessRecords, businesses, type InsertUser, users } from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the Drizzle instance so local tooling can run without a database.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch {
      console.warn("[Database] Failed to connect");
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }
  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  const textFields = ["name", "email", "loginMethod"] as const;
  type TextField = (typeof textFields)[number];
  const assignNullable = (field: TextField) => {
    const value = user[field];
    if (value === undefined) return;
    const normalized = value ?? null;
    values[field] = normalized;
    updateSet[field] = normalized;
  };
  textFields.forEach(assignNullable);
  if (user.lastSignedIn !== undefined) {
    values.lastSignedIn = user.lastSignedIn;
    updateSet.lastSignedIn = user.lastSignedIn;
  }
  if (user.role !== undefined) {
    values.role = user.role;
    updateSet.role = user.role;
  } else if (user.openId === ENV.ownerOpenId) {
    values.role = "admin";
    updateSet.role = "admin";
  }
  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
  try {
    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user");
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function getBusinessMemberByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(businessMembers)
    .innerJoin(businesses, eq(businessMembers.businessId, businesses.id))
    .where(and(eq(businessMembers.openId, openId), eq(businessMembers.status, "active")))
    .orderBy(desc(businessMembers.createdAt)).limit(1);
  if (!rows[0]) return null;
  return { ...rows[0].business_members, business: rows[0].businesses };
}

export async function getBusinessRecord(businessId: string, recordKind: string, recordId: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(businessRecords)
    .where(and(eq(businessRecords.businessId, businessId), eq(businessRecords.recordKind, recordKind), eq(businessRecords.recordId, recordId))).limit(1);
  return rows[0] ?? null;
}

export async function listBusinessRecords(businessId: string, recordKind: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(businessRecords)
    .where(and(eq(businessRecords.businessId, businessId), eq(businessRecords.recordKind, recordKind)))
    .orderBy(desc(businessRecords.createdAt));
}

export async function lockBusinessForUpdate(executor: any, businessId: string) {
  const rows = await executor.select({ id: businesses.id }).from(businesses)
    .where(eq(businesses.id, businessId)).for("update").limit(1);
  if (!rows[0]) throw new Error("The workspace no longer exists.");
}

export async function saveBusinessRecord(
  executor: any,
  input: { businessId: string; recordKind: string; recordId: string; payload: Record<string, unknown>; actorOpenId: string },
) {
  await executor.insert(businessRecords).values({
    id: crypto.randomUUID(),
    businessId: input.businessId,
    recordKind: input.recordKind,
    recordId: input.recordId,
    payload: input.payload,
    createdByOpenId: input.actorOpenId,
  }).onDuplicateKeyUpdate({ set: { payload: input.payload, updatedAt: new Date() } });
}
