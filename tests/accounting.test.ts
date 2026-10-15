import { describe, expect, it } from "vitest";
import { assertBalanced, businessDateBoundary, businessDateKey, displayDateOnly, makeJournalLine, roundAmount, shiftDateKey, summarizeProfitAndLoss } from "../shared/accounting";
import { calculateLoyaltyRedemption, reverseLoyaltyPoints } from "../shared/loyalty";
import type { Invoice, JournalEntry, Transaction } from "../shared/pos";

const saleAt = "2026-10-10T04:00:00.000Z";
const refundAt = "2026-10-10T06:00:00.000Z";

function entry(id: string, date: string, lines: JournalEntry["lines"]): JournalEntry {
  return { id, date, reference: id, description: id, lines, createdBy: "user" };
}

function saleTransaction(status: Transaction["status"] = "paid"): Transaction {
  return { id: "tx-1", orderId: "order-1", orderNumber: "#1", createdAt: saleAt, items: [], subtotal: 100, discount: 10, tax: 7, total: 97, paymentMethod: "Cash", status, refundedAt: status === "refunded" ? refundAt : undefined, voidedAt: status === "voided" ? refundAt : undefined };
}

const saleEntry = entry("sale", saleAt, [
  makeJournalLine("1000", "Cash", 97, 0, "USD"),
  makeJournalLine("4100", "Discount", 10, 0, "USD"),
  makeJournalLine("4000", "Sales", 0, 100, "USD"),
  makeJournalLine("2100", "Tax payable", 0, 7, "USD"),
]);
const refundEntry = entry("refund", refundAt, [
  makeJournalLine("4000", "Sales", 100, 0, "USD"),
  makeJournalLine("2100", "Tax payable", 7, 0, "USD"),
  makeJournalLine("1000", "Cash", 0, 97, "USD"),
  makeJournalLine("4100", "Discount", 0, 10, "USD"),
]);

function report(entries: JournalEntry[], transactions: Transaction[], invoices: Invoice[] = [], start = new Date("2026-10-10T00:00:00.000Z"), end = new Date("2026-10-10T23:59:59.999Z")) {
  return summarizeProfitAndLoss(entries, transactions, invoices, start, end, "USD");
}

describe("business currency and calendar helpers", () => {
  it("rounds IDR to whole rupiah and USD to cents", () => {
    expect(roundAmount(1050.49, "IDR")).toBe(1050);
    expect(roundAmount(10.235, "USD")).toBe(10.24);
  });

  it("rejects unbalanced journal entries using workspace currency precision", () => {
    expect(() => assertBalanced([makeJournalLine("1000", "Cash", 100, 0, "IDR"), makeJournalLine("4000", "Sales", 0, 99, "IDR")], "IDR")).toThrow(/Unbalanced journal/);
    expect(() => assertBalanced([makeJournalLine("1000", "Cash", 10.24, 0, "USD"), makeJournalLine("4000", "Sales", 0, 10.24, "USD")], "USD")).not.toThrow();
  });

  it("builds UTC bounds that represent the complete Jakarta business day", () => {
    const start = businessDateBoundary("2026-10-10", "Asia/Jakarta");
    const end = businessDateBoundary("2026-10-10", "Asia/Jakarta", true);
    expect(start.toISOString()).toBe("2026-10-09T17:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-10T16:59:59.999Z");
    expect(businessDateKey(start, "Asia/Jakarta")).toBe("2026-10-10");
    expect(businessDateKey(end, "Asia/Jakarta")).toBe("2026-10-10");
    expect(businessDateKey(end.getTime() + 1, "Asia/Jakarta")).toBe("2026-10-11");
  });

  it("shifts validated ISO date keys and formats them without device timezone drift", () => {
    expect(shiftDateKey("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftDateKey("2024-02-29", 1)).toBe("2024-03-01");
    expect(displayDateOnly("2026-10-10")).toContain("Oct 10, 2026");
    expect(() => shiftDateKey("2026-02-30", 1)).toThrow(/valid calendar date/);
  });
});

describe("profit and loss period reconciliation", () => {
  it("nets a fully refunded, discounted sale within the same period without double counting", () => {
    const result = report([saleEntry, refundEntry], [saleTransaction("refunded")]);
    expect(result).toMatchObject({ salesRevenue: 100, discounts: 10, refunds: 90, voids: 0, netRevenue: 0, taxCollected: 0, netIncome: 0 });
  });

  it("records a current-period refund against a sale from an earlier period", () => {
    const priorSale = { ...saleEntry, date: "2026-10-09T04:00:00.000Z" };
    const priorTransaction = { ...saleTransaction("refunded"), createdAt: "2026-10-09T04:00:00.000Z" };
    const result = report([refundEntry], [priorTransaction]);
    expect(result).toMatchObject({ salesRevenue: 0, discounts: 0, refunds: 90, netRevenue: -90, taxCollected: -7 });
    expect(priorSale).toBeDefined();
  });

  it("reverses a voided invoice in the period in which it was voided", () => {
    const invoiceEntry = entry("invoice-void", refundAt, [makeJournalLine("4000", "Sales", 100, 0, "USD"), makeJournalLine("1100", "A/R", 0, 100, "USD")]);
    const invoice: Invoice = { id: "inv-1", number: "INV-1", customerName: "Guest", issueDate: "2026-10-09T04:00:00.000Z", dueDate: "2026-10-20T16:59:59.999Z", lines: [{ description: "Catering", quantity: 1, unitPrice: 100 }], subtotal: 100, tax: 0, total: 100, status: "void", createdAt: "2026-10-09T04:00:00.000Z", voidedAt: refundAt, journalEntryId: invoiceEntry.id };
    const result = report([invoiceEntry], [], [invoice]);
    expect(result).toMatchObject({ salesRevenue: 0, voids: 100, netRevenue: -100 });
  });

  it("nets an invoice issued and voided within the same reporting period", () => {
    const issued = entry("invoice-issued", saleAt, [makeJournalLine("1100", "A/R", 100, 0, "USD"), makeJournalLine("4000", "Sales", 0, 100, "USD")]);
    const reversed = entry("invoice-reversed", refundAt, [makeJournalLine("4000", "Sales", 100, 0, "USD"), makeJournalLine("1100", "A/R", 0, 100, "USD")]);
    const invoice: Invoice = { id: "inv-same-period", number: "INV-SAME-PERIOD", customerName: "Guest", issueDate: saleAt, dueDate: "2026-10-20T16:59:59.999Z", lines: [{ description: "Catering", quantity: 1, unitPrice: 100 }], subtotal: 100, tax: 0, total: 100, status: "void", createdAt: saleAt, voidedAt: refundAt, journalEntryId: issued.id, voidJournalEntryId: reversed.id };
    const result = report([issued, reversed], [], [invoice]);
    expect(result).toMatchObject({ salesRevenue: 100, voids: 100, netRevenue: 0, netIncome: 0 });
  });

  it("does not treat an unissued voided draft as reversed revenue", () => {
    const draft: Invoice = { id: "inv-draft", number: "INV-DRAFT", customerName: "Guest", issueDate: saleAt, dueDate: refundAt, lines: [{ description: "Catering", quantity: 1, unitPrice: 100 }], subtotal: 100, tax: 0, total: 100, status: "void", createdAt: saleAt, voidedAt: refundAt };
    expect(report([], [], [draft])).toMatchObject({ salesRevenue: 0, voids: 0, netRevenue: 0, netIncome: 0 });
  });
});


describe("loyalty balance safety", () => {
  it("rejects a redemption that exceeds the remaining ticket instead of spending excess points", () => {
    expect(calculateLoyaltyRedemption(10, 1.5, 0.25, "USD")).toBeNull();
    expect(calculateLoyaltyRedemption(6, 1.5, 0.25, "USD")).toEqual({ points: 6, discount: 1.5 });
  });

  it("never returns a negative loyalty balance when refunded points were already spent", () => {
    expect(reverseLoyaltyPoints(5, 10, 3)).toEqual({ balance: 3, pointsDebited: 5, pointsRestored: 3, earnedPointsUnavailable: 5, pointsChange: -2 });
    expect(reverseLoyaltyPoints(0, 8, 0).balance).toBe(0);
  });
});
