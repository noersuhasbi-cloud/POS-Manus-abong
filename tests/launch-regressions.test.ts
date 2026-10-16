import { describe, expect, it } from "vitest";
import { formatBusinessTimestamp, isInBusinessDateRange, roundPositiveAmount } from "../shared/accounting";
import { isSafeTransactionRecordId, legacySnapshotOwnerCanAccess } from "../shared/legacy";
import { projectKitchenOrder, type PosOrder } from "../shared/pos";

describe("launch regression guards", () => {
  it("accepts local legacy records only for their bound identity", () => {
    expect(legacySnapshotOwnerCanAccess("user-a", "user-a")).toBe(true);
    expect(legacySnapshotOwnerCanAccess("user-a", "user-b")).toBe(false);
    expect(legacySnapshotOwnerCanAccess(null, "first-user")).toBe(true);
  });

  it("accepts bounded legacy transaction IDs while rejecting control characters", () => {
    expect(isSafeTransactionRecordId("legacy-old-1")).toBe(true);
    expect(isSafeTransactionRecordId(`legacy-${"x".repeat(75)}`)).toBe(false);
    expect(isSafeTransactionRecordId("legacy-old\n1")).toBe(false);
  });

  it("drops financial and customer data from kitchen projections", () => {
    const order: PosOrder = {
      id: "order-1",
      number: "TT-001",
      createdAt: "2026-10-16T10:00:00.000Z",
      updatedAt: "2026-10-16T10:01:00.000Z",
      items: [{
        id: "line-1", menuItemId: "coffee", name: "Latte", category: "Coffee", unitPrice: 4.25,
        quantity: 2, modifier: { id: "oat", label: "Oat milk", price: 0.5 }, note: "No ice",
      }],
      subtotal: 9.5,
      discountPercent: 0,
      discount: 0,
      tax: 0.95,
      total: 10.45,
      paymentMethod: "Card",
      status: "new",
      cashierName: "Cashier A",
      customerName: "Customer B",
      giftCardAmount: 0,
    };
    const projection = projectKitchenOrder(order);
    expect(projection).toEqual({
      id: "order-1", number: "TT-001", createdAt: order.createdAt, updatedAt: order.updatedAt,
      status: "new", items: [{ id: "line-1", name: "Latte", quantity: 2, modifier: { id: "oat", label: "Oat milk" }, note: "No ice" }],
    });
    expect(JSON.stringify(projection)).not.toMatch(/unitPrice|total|Card|Cashier|Customer|giftCard/i);
  });

  it("rejects invoice-like amounts that round below a currency minor unit", () => {
    expect(roundPositiveAmount(0.004, "USD")).toBeNull();
    expect(roundPositiveAmount(0.01, "USD")).toBe(0.01);
    expect(roundPositiveAmount(0.49, "IDR")).toBeNull();
    expect(roundPositiveAmount(1, "IDR")).toBe(1);
  });

  it("formats receipt timestamps in the workspace timezone", () => {
    expect(formatBusinessTimestamp("2026-10-16T16:00:00.000Z", "Asia/Jakarta")).toMatch(/Oct 16, 2026/);
    expect(formatBusinessTimestamp("not-a-date", "Asia/Jakarta")).toBe("—");
  });

  it("filters book documents by workspace-local business date", () => {
    expect(isInBusinessDateRange("2026-10-15T18:30:00.000Z", "2026-10-16", "2026-10-16", "Asia/Jakarta")).toBe(true);
    expect(isInBusinessDateRange("2026-10-16T18:00:00.000Z", "2026-10-16", "2026-10-16", "Asia/Jakarta")).toBe(false);
  });
});
