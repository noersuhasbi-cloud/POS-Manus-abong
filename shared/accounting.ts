import type { CurrencyCode, Invoice, JournalEntry, JournalLine, Transaction } from "./pos";

export function roundAmount(value: number, currency: CurrencyCode) {
  const digits = currency === "IDR" ? 0 : 2;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function roundPositiveAmount(value: number, currency: CurrencyCode): number | null {
  const amount = roundAmount(value, currency);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function formatBusinessTimestamp(value: string | Date, timezone: string, locale = "en-US") {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatMoney(value: number, currency: CurrencyCode = "IDR") {
  return new Intl.NumberFormat(currency === "IDR" ? "id-ID" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "IDR" ? 0 : 2,
    minimumFractionDigits: currency === "IDR" ? 0 : 2,
  }).format(value);
}

export function makeJournalLine(accountCode: string, accountName: string, debit = 0, credit = 0, currency: CurrencyCode = "IDR"): JournalLine {
  return { accountCode, accountName, debit: roundAmount(debit, currency), credit: roundAmount(credit, currency) };
}

export function assertBalanced(lines: JournalLine[], currency: CurrencyCode) {
  const debit = roundAmount(lines.reduce((sum, line) => sum + line.debit, 0), currency);
  const credit = roundAmount(lines.reduce((sum, line) => sum + line.credit, 0), currency);
  if (debit !== credit) throw new Error(`Unbalanced journal: debits ${debit} do not equal credits ${credit}`);
}

function datePartsFor(value: Date | number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const part = (name: string) => Number(parts.find((item) => item.type === name)?.value ?? 0);
  return { year: part("year"), month: part("month"), day: part("day") };
}

export function businessDateKey(value: Date | number, timezone: string) {
  const { year, month, day } = datePartsFor(value, timezone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isInBusinessDateRange(value: string | Date, startKey: string, endKey: string, timezone: string) {
  if (startKey > endKey) return false;
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return false;
  const key = businessDateKey(timestamp, timezone);
  return key >= startKey && key <= endKey;
}

export function shiftDateKey(value: string, days: number) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("Use a YYYY-MM-DD date.");
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const current = new Date(Date.UTC(year, month - 1, day, 12));
  if (current.getUTCFullYear() !== year || current.getUTCMonth() + 1 !== month || current.getUTCDate() !== day) throw new Error("Choose a valid calendar date.");
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return date.toISOString().slice(0, 10);
}

export function businessDateBoundary(value: string, timezone: string, endOfDay = false) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("Use a YYYY-MM-DD date.");
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) throw new Error("Choose a valid calendar date.");
  const target = Date.UTC(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  let timestamp = target;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (let i = 0; i < 3; i += 1) {
    const parts = formatter.formatToParts(new Date(timestamp));
    const part = (name: string) => Number(parts.find((item) => item.type === name)?.value ?? 0);
    const representedUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    timestamp = target - (representedUtc - timestamp);
  }
  return new Date(timestamp + (endOfDay ? 999 : 0));
}

export function displayDateOnly(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.slice(0, 10));
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  return date.toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

export function summarizeProfitAndLoss(entries: JournalEntry[], transactions: Transaction[], invoices: Invoice[], start: Date, end: Date, currency: CurrencyCode) {
  const startTime = start.getTime();
  const endTime = end.getTime();
  const inRange = (value: string | undefined) => {
    if (!value) return false;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) && timestamp >= startTime && timestamp <= endTime;
  };
  const sumAccount = (code: string) => roundAmount(entries.flatMap((entry) => entry.lines).filter((line) => line.accountCode === code).reduce((sum, line) => sum + line.credit - line.debit, 0), currency);
  const salesRevenue = roundAmount(entries.flatMap((entry) => entry.lines).filter((line) => line.accountCode === "4000").reduce((sum, line) => sum + line.credit, 0), currency);
  const discounts = roundAmount(transactions.filter((transaction) => inRange(transaction.createdAt)).reduce((sum, transaction) => sum + transaction.discount, 0), currency);
  const refunds = roundAmount(transactions.filter((transaction) => transaction.status === "refunded" && inRange(transaction.refundedAt)).reduce((sum, transaction) => sum + Math.max(0, transaction.subtotal - transaction.discount), 0), currency);
  const voidedSales = transactions.filter((transaction) => transaction.status === "voided" && inRange(transaction.voidedAt)).reduce((sum, transaction) => sum + Math.max(0, transaction.subtotal - transaction.discount), 0);
  const voidedInvoices = invoices.filter((invoice) => invoice.status === "void" && Boolean(invoice.journalEntryId) && inRange(invoice.voidedAt)).reduce((sum, invoice) => sum + invoice.subtotal, 0);
  const voids = roundAmount(voidedSales + voidedInvoices, currency);
  const netRevenue = roundAmount(salesRevenue - refunds - voids - discounts, currency);
  const costOfGoodsSold = roundAmount(-sumAccount("5000"), currency);
  const operatingExpenses = roundAmount(-sumAccount("6000"), currency);
  const totalExpenses = roundAmount(costOfGoodsSold + operatingExpenses, currency);
  return {
    salesRevenue,
    refunds,
    voids,
    discounts,
    netRevenue,
    costOfGoodsSold,
    grossProfit: roundAmount(netRevenue - costOfGoodsSold, currency),
    operatingExpenses,
    totalExpenses,
    netIncome: roundAmount(netRevenue - totalExpenses, currency),
    taxCollected: sumAccount("2100"),
  };
}
