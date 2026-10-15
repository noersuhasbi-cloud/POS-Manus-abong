import { index, int, json, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

/** Core Manus OAuth user table. Application roles belong to a business membership, not this global row. */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const businesses = mysqlTable("businesses", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  createdByOpenId: varchar("createdByOpenId", { length: 64 }).notNull().references(() => users.openId),
  currency: mysqlEnum("currency", ["IDR", "USD"]).default("IDR").notNull(),
  taxRateBasisPoints: int("taxRateBasisPoints").default(0).notNull(),
  timezone: varchar("timezone", { length: 64 }).default("Asia/Jakarta").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const businessMembers = mysqlTable("business_members", {
  id: varchar("id", { length: 36 }).primaryKey(),
  businessId: varchar("businessId", { length: 36 }).notNull().references(() => businesses.id),
  openId: varchar("openId", { length: 64 }).notNull().references(() => users.openId),
  displayName: varchar("displayName", { length: 160 }),
  email: varchar("email", { length: 320 }),
  role: mysqlEnum("role", ["manager", "cashier", "kitchen"]).default("cashier").notNull(),
  status: mysqlEnum("status", ["active", "suspended"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("business_members_business_openid_uq").on(table.businessId, table.openId),
  uniqueIndex("business_members_user_uq").on(table.openId),
]);

export const businessInvites = mysqlTable("business_invites", {
  id: varchar("id", { length: 36 }).primaryKey(),
  businessId: varchar("businessId", { length: 36 }).notNull().references(() => businesses.id),
  codeHash: varchar("codeHash", { length: 64 }).notNull().unique(),
  role: mysqlEnum("role", ["manager", "cashier", "kitchen"]).notNull(),
  createdByOpenId: varchar("createdByOpenId", { length: 64 }).notNull().references(() => users.openId),
  expiresAt: timestamp("expiresAt").notNull(),
  usedAt: timestamp("usedAt"),
  revokedAt: timestamp("revokedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [index("business_invites_business_idx").on(table.businessId)]);

export const businessRecords = mysqlTable("business_records", {
  id: varchar("id", { length: 36 }).primaryKey(),
  businessId: varchar("businessId", { length: 36 }).notNull().references(() => businesses.id),
  recordKind: varchar("recordKind", { length: 48 }).notNull(),
  recordId: varchar("recordId", { length: 80 }).notNull(),
  payload: json("payload").$type<Record<string, unknown>>().notNull(),
  createdByOpenId: varchar("createdByOpenId", { length: 64 }).notNull().references(() => users.openId),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("business_records_scope_key_uq").on(table.businessId, table.recordKind, table.recordId),
  index("business_records_kind_idx").on(table.businessId, table.recordKind, table.createdAt),
]);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Business = typeof businesses.$inferSelect;
export type BusinessMember = typeof businessMembers.$inferSelect;
export type BusinessInvite = typeof businessInvites.$inferSelect;
export type BusinessRecord = typeof businessRecords.$inferSelect;
