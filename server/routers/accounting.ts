import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { businessRecords } from "../../drizzle/schema";
import { assertBalanced, businessDateBoundary, businessDateKey, makeJournalLine, roundAmount, summarizeProfitAndLoss } from "../../shared/accounting";
import { summarizeRecipeCosting } from "../../shared/recipe-costing";
import type { CurrencyCode, Invoice, JournalEntry, JournalLine, PettyExpense, RecipeSaleCost, Transaction, VendorBill } from "../../shared/pos";
import { saveBusinessRecord } from "../db";
import { managerProcedure, requireDatabase } from "../_core/business";
import { router } from "../_core/trpc";

function as<T>(value: Record<string, unknown>) { return value as unknown as T; }
function id() { return randomUUID(); }
function round(value: number, currency: CurrencyCode) { return roundAmount(value, currency); }

async function records(tx: any, businessId: string, kind: string, lock = false) {
  let query = tx.select().from(businessRecords).where(and(eq(businessRecords.businessId, businessId), eq(businessRecords.recordKind, kind)));
  if (lock) query = query.for("update");
  return query;
}

async function record(tx: any, businessId: string, kind: string, recordId: string, lock = false) {
  let query = tx.select().from(businessRecords).where(and(eq(businessRecords.businessId, businessId), eq(businessRecords.recordKind, kind), eq(businessRecords.recordId, recordId)));
  if (lock) query = query.for("update");
  const rows = await query.limit(1);
  return rows[0] ?? null;
}

async function post(tx: any, businessId: string, actor: string, currency: CurrencyCode, date: string, reference: string, description: string, lines: JournalLine[]) {
  assertBalanced(lines, currency);
  const entry: JournalEntry = { id: id(), date, reference, description, lines, createdBy: actor };
  await saveBusinessRecord(tx, { businessId, recordKind: "journalEntry", recordId: entry.id, payload: entry as unknown as Record<string, unknown>, actorOpenId: actor });
  return entry;
}

function tenderAccount(method: "Cash" | "Card" | "QRIS" | "Other") {
  return method === "Cash" ? { code: "1000", name: "Cash on hand" } : { code: "1010", name: method === "QRIS" ? "QRIS clearing" : method === "Card" ? "Card clearing" : "Other tender clearing" };
}

const invoiceLine = z.object({ description: z.string().trim().min(1).max(160), quantity: z.number().positive().max(10000), unitPrice: z.number().nonnegative().max(1_000_000_000) });
const paymentMethod = z.enum(["Cash", "Card", "QRIS", "Other"]);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
function parseBusinessDate(value: string, timezone: string, endOfDay = false) {
  try { return businessDateBoundary(value, timezone, endOfDay); }
  catch { throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a valid calendar date." }); }
}

export const accountingRouter = router({
  report: managerProcedure.input(z.object({ start: dateOnly, end: dateOnly })).query(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const timezone = ctx.member.business.timezone;
    const startDate = parseBusinessDate(input.start, timezone);
    const endDate = parseBusinessDate(input.end, timezone, true);
    const start = startDate.getTime();
    const end = endDate.getTime();
    if (start > end) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a valid reporting period." });
    const rows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "journalEntry"))).orderBy(desc(businessRecords.createdAt));
    const entries = rows.map((row) => as<JournalEntry>(row.payload)).filter((entry) => {
      const date = new Date(entry.date).getTime();
      return date >= start && date <= end;
    });
    const currency = ctx.member.business.currency as CurrencyCode;
    const transactionRows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "transaction")));
    const transactions = transactionRows.map((row) => as<Transaction>(row.payload));
    const recipeRows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "recipeSaleCost")));
    const recipeCosting = summarizeRecipeCosting(recipeRows.map((row) => as<RecipeSaleCost>(row.payload)), transactions, startDate, endDate, currency);
    const invoiceRows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "invoice")));
    const invoices = invoiceRows.map((row) => as<Invoice>(row.payload));
    const expenseRows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "pettyExpense"))).orderBy(desc(businessRecords.createdAt));
    const pettyExpenses = expenseRows.map((row) => as<PettyExpense>(row.payload)).filter((expense) => expense.businessDate >= input.start && expense.businessDate <= input.end);
    const profitAndLoss = summarizeProfitAndLoss(entries, transactions, invoices, startDate, endDate, currency);
    return {
      currency: ctx.member.business.currency,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      profitAndLoss: { ...profitAndLoss, businessDate: businessDateKey(Date.now(), timezone) },
      recipeCosting,
      pettyExpenses,
      journalEntries: entries,
      ledgerLines: entries.flatMap((entry) => entry.lines.map((line) => ({ date: entry.date, reference: entry.reference, description: entry.description, ...line }))).sort((a, b) => a.date.localeCompare(b.date)),
    };
  }),

  invoices: managerProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const rows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "invoice"))).orderBy(desc(businessRecords.createdAt)).limit(500);
    const today = businessDateKey(Date.now(), ctx.member.business.timezone);
    return rows.map((row) => { const invoice = as<Invoice>(row.payload); const due = businessDateKey(new Date(invoice.dueDate), ctx.member.business.timezone); return invoice.status === "open" && due < today ? { ...invoice, status: "overdue" as const } : invoice; });
  }),

  createInvoice: managerProcedure.input(z.object({ customerName: z.string().trim().min(1).max(120), customerEmail: z.string().email().max(320).optional().or(z.literal("")), issueDate: dateOnly, dueDate: dateOnly, lines: z.array(invoiceLine).min(1).max(100), status: z.enum(["draft", "open"]).default("open") })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const currency = ctx.member.business.currency as CurrencyCode;
    const timezone = ctx.member.business.timezone;
    const issue = parseBusinessDate(input.issueDate, timezone);
    const due = parseBusinessDate(input.dueDate, timezone, true);
    if (due < issue) throw new TRPCError({ code: "BAD_REQUEST", message: "The due date must be on or after the issue date." });
    const subtotal = round(input.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0), currency);
    const tax = round(subtotal * ctx.member.business.taxRateBasisPoints / 10_000, currency);
    const total = round(subtotal + tax, currency);
    const now = new Date().toISOString();
    const invoiceId = id();
    const number = `INV-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
    return db.transaction(async (tx) => {
      const journal = input.status === "open" ? await post(tx, ctx.member.businessId, ctx.user.openId, currency, issue.toISOString(), number, `Invoice ${number} · ${input.customerName}`, [
        makeJournalLine("1100", "Accounts receivable", total, 0, currency),
        makeJournalLine("4000", "Sales revenue", 0, subtotal, currency),
        makeJournalLine("2100", "Tax payable", 0, tax, currency),
      ]) : undefined;
      const invoice: Invoice = { id: invoiceId, number, customerName: input.customerName, customerEmail: input.customerEmail || undefined, issueDate: issue.toISOString(), dueDate: due.toISOString(), lines: input.lines, subtotal, tax, total, status: input.status, createdAt: now, journalEntryId: journal?.id };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "invoice", recordId: invoiceId, payload: invoice as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      return invoice;
    });
  }),

  issueInvoice: managerProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const currency = ctx.member.business.currency as CurrencyCode;
    const timezone = ctx.member.business.timezone;
    return db.transaction(async (tx) => {
      const row = await record(tx, ctx.member.businessId, "invoice", input.id, true);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found." });
      const invoice = as<Invoice>(row.payload);
      if (invoice.status !== "draft") throw new TRPCError({ code: "BAD_REQUEST", message: "Only an unissued draft can be issued." });
      const issue = parseBusinessDate(businessDateKey(Date.now(), timezone), timezone);
      const journal = await post(tx, ctx.member.businessId, ctx.user.openId, currency, issue.toISOString(), invoice.number, `Invoice ${invoice.number} · ${invoice.customerName}`, [
        makeJournalLine("1100", "Accounts receivable", invoice.total, 0, currency),
        makeJournalLine("4000", "Sales revenue", 0, invoice.subtotal, currency),
        makeJournalLine("2100", "Tax payable", 0, invoice.tax, currency),
      ]);
      const updated = { ...invoice, status: "open" as const, issueDate: issue.toISOString(), journalEntryId: journal.id };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "invoice", recordId: invoice.id, payload: updated as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      return updated;
    });
  }),

  payInvoice: managerProcedure.input(z.object({ id: z.string().uuid(), paymentMethod, qrisVerified: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
    if (input.paymentMethod === "QRIS" && !input.qrisVerified) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Verify QRIS settlement in the merchant app before recording this payment." });
    const db = await requireDatabase();
    const currency = ctx.member.business.currency as CurrencyCode;
    return db.transaction(async (tx) => {
      const row = await record(tx, ctx.member.businessId, "invoice", input.id, true);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found." });
      const invoice = as<Invoice>(row.payload);
      if (invoice.status !== "open" && invoice.status !== "overdue") throw new TRPCError({ code: "BAD_REQUEST", message: "Only an open invoice can be marked paid." });
      const now = new Date().toISOString();
      const tender = tenderAccount(input.paymentMethod);
      const journal = await post(tx, ctx.member.businessId, ctx.user.openId, currency, now, `RECEIPT ${invoice.number}`, `Payment received for ${invoice.number}`, [makeJournalLine(tender.code, tender.name, invoice.total, 0, currency), makeJournalLine("1100", "Accounts receivable", 0, invoice.total, currency)]);
      const updated = { ...invoice, status: "paid" as const, paidAt: now, paymentMethod: input.paymentMethod, qrisVerifiedAt: input.paymentMethod === "QRIS" ? now : undefined, paymentJournalEntryId: journal.id };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "invoice", recordId: invoice.id, payload: updated as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      return updated;
    });
  }),

  voidInvoice: managerProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const currency = ctx.member.business.currency as CurrencyCode;
    return db.transaction(async (tx) => {
      const row = await record(tx, ctx.member.businessId, "invoice", input.id, true);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found." });
      const invoice = as<Invoice>(row.payload);
      if (invoice.status === "paid" || invoice.status === "void") throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice cannot be voided." });
      const now = new Date().toISOString();
      const journal = invoice.status === "draft" ? undefined : await post(tx, ctx.member.businessId, ctx.user.openId, currency, now, `VOID ${invoice.number}`, `Void invoice ${invoice.number}`, [makeJournalLine("4000", "Sales revenue", invoice.subtotal, 0, currency), makeJournalLine("2100", "Tax payable", invoice.tax, 0, currency), makeJournalLine("1100", "Accounts receivable", 0, invoice.total, currency)]);
      const updated = { ...invoice, status: "void" as const, voidedAt: now, voidJournalEntryId: journal?.id };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "invoice", recordId: invoice.id, payload: updated as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      return updated;
    });
  }),

  bills: managerProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const rows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "vendorBill"))).orderBy(desc(businessRecords.createdAt)).limit(500);
    const today = businessDateKey(Date.now(), ctx.member.business.timezone);
    return rows.map((row) => { const bill = as<VendorBill>(row.payload); const due = businessDateKey(new Date(bill.dueDate), ctx.member.business.timezone); return bill.status === "open" && due < today ? { ...bill, status: "overdue" as const } : bill; });
  }),

  createBill: managerProcedure.input(z.object({ vendorName: z.string().trim().min(1).max(120), description: z.string().trim().min(1).max(240), category: z.enum(["cogs", "operating"]), billDate: dateOnly, dueDate: dateOnly, amount: z.number().positive().max(1_000_000_000) })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const currency = ctx.member.business.currency as CurrencyCode;
    const timezone = ctx.member.business.timezone;
    const billDate = parseBusinessDate(input.billDate, timezone);
    const dueDate = parseBusinessDate(input.dueDate, timezone, true);
    if (dueDate < billDate) throw new TRPCError({ code: "BAD_REQUEST", message: "The due date must be on or after the bill date." });
    const amount = round(input.amount, currency);
    const now = new Date().toISOString();
    const billId = id();
    const number = `BILL-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
    return db.transaction(async (tx) => {
      const expenseAccount = input.category === "cogs" ? { code: "5000", name: "Cost of goods sold" } : { code: "6000", name: "Operating expenses" };
      const journal = await post(tx, ctx.member.businessId, ctx.user.openId, currency, billDate.toISOString(), number, `${input.vendorName} · ${input.description}`, [makeJournalLine(expenseAccount.code, expenseAccount.name, amount, 0, currency), makeJournalLine("2000", "Accounts payable", 0, amount, currency)]);
      const bill: VendorBill = { id: billId, number, vendorName: input.vendorName, description: input.description, category: input.category, billDate: billDate.toISOString(), dueDate: dueDate.toISOString(), amount, status: "open", createdAt: now, journalEntryId: journal.id };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "vendorBill", recordId: billId, payload: bill as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      return bill;
    });
  }),

  createQuickExpense: managerProcedure.input(z.object({ requestId: z.string().uuid(), businessDate: dateOnly, description: z.string().trim().min(1).max(180), category: z.enum(["supplies", "utilities", "staff", "transport", "other"]), amount: z.number().finite().positive().max(1_000_000_000), paymentMethod, qrisVerified: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
    if (input.paymentMethod === "QRIS" && !input.qrisVerified) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Verify QRIS settlement in the merchant app before recording this expense." });
    const db = await requireDatabase();
    const currency = ctx.member.business.currency as CurrencyCode;
    const expenseDate = parseBusinessDate(input.businessDate, ctx.member.business.timezone);
    const amount = round(input.amount, currency);
    if (amount <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: `Enter an amount that rounds to at least one ${currency} minor unit.` });
    const requestFingerprint = createHash("sha256").update(JSON.stringify({ businessDate: input.businessDate, description: input.description, category: input.category, amount, paymentMethod: input.paymentMethod, qrisVerified: input.paymentMethod === "QRIS" && input.qrisVerified })).digest("hex");
    return db.transaction(async (tx) => {
      const existing = await record(tx, ctx.member.businessId, "pettyExpense", input.requestId, true);
      if (existing) {
        const prior = as<PettyExpense>(existing.payload);
        if (existing.createdByOpenId !== ctx.user.openId || prior.requestFingerprint !== requestFingerprint) throw new TRPCError({ code: "CONFLICT", message: "This expense retry key was already used for different details." });
        return prior;
      }
      const now = new Date().toISOString();
      const number = `EXP-${input.businessDate.replaceAll("-", "")}-${input.requestId.slice(0, 6).toUpperCase()}`;
      const tender = tenderAccount(input.paymentMethod);
      const journal = await post(tx, ctx.member.businessId, ctx.user.openId, currency, expenseDate.toISOString(), number, `${input.category.toUpperCase()} · ${input.description}`, [
        makeJournalLine("6000", "Operating expenses", amount, 0, currency),
        makeJournalLine(tender.code, tender.name, 0, amount, currency),
      ]);
      const expense: PettyExpense = {
        id: input.requestId,
        number,
        businessDate: input.businessDate,
        description: input.description,
        category: input.category,
        amount,
        paymentMethod: input.paymentMethod,
        createdAt: now,
        createdByOpenId: ctx.user.openId,
        journalEntryId: journal.id,
        requestFingerprint,
        qrisVerifiedAt: input.paymentMethod === "QRIS" ? now : undefined,
      };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "pettyExpense", recordId: expense.id, payload: expense as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      return expense;
    });
  }),

  payBill: managerProcedure.input(z.object({ id: z.string().uuid(), paymentMethod, qrisVerified: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
    if (input.paymentMethod === "QRIS" && !input.qrisVerified) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Verify QRIS settlement in the merchant app before recording this payment." });
    const db = await requireDatabase();
    const currency = ctx.member.business.currency as CurrencyCode;
    return db.transaction(async (tx) => {
      const row = await record(tx, ctx.member.businessId, "vendorBill", input.id, true);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Vendor bill not found." });
      const bill = as<VendorBill>(row.payload);
      if (bill.status !== "open" && bill.status !== "overdue") throw new TRPCError({ code: "BAD_REQUEST", message: "Only an open or overdue vendor bill can be marked paid." });
      const now = new Date().toISOString();
      const tender = tenderAccount(input.paymentMethod);
      const journal = await post(tx, ctx.member.businessId, ctx.user.openId, currency, now, `PAYMENT ${bill.number}`, `Payment for ${bill.vendorName}`, [makeJournalLine("2000", "Accounts payable", bill.amount, 0, currency), makeJournalLine(tender.code, tender.name, 0, bill.amount, currency)]);
      const updated = { ...bill, status: "paid" as const, paidAt: now, paymentMethod: input.paymentMethod, qrisVerifiedAt: input.paymentMethod === "QRIS" ? now : undefined, paymentJournalEntryId: journal.id };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "vendorBill", recordId: bill.id, payload: updated as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      return updated;
    });
  }),

  voidBill: managerProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const currency = ctx.member.business.currency as CurrencyCode;
    return db.transaction(async (tx) => {
      const row = await record(tx, ctx.member.businessId, "vendorBill", input.id, true);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Vendor bill not found." });
      const bill = as<VendorBill>(row.payload);
      if (bill.status !== "open" && bill.status !== "overdue") throw new TRPCError({ code: "BAD_REQUEST", message: "Only an open or overdue bill can be voided." });
      const account = bill.category === "cogs" ? { code: "5000", name: "Cost of goods sold" } : { code: "6000", name: "Operating expenses" };
      const now = new Date().toISOString();
      const journal = await post(tx, ctx.member.businessId, ctx.user.openId, currency, now, `VOID ${bill.number}`, `Void vendor bill ${bill.number}`, [makeJournalLine("2000", "Accounts payable", bill.amount, 0, currency), makeJournalLine(account.code, account.name, 0, bill.amount, currency)]);
      const updated = { ...bill, status: "void" as const, voidedAt: now, voidJournalEntryId: journal.id };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "vendorBill", recordId: bill.id, payload: updated as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      return updated;
    });
  }),
});
