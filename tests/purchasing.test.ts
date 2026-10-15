import { describe, expect, it } from "vitest";
import type { PurchaseOrder } from "../shared/pos";
import { applyPurchaseReceipt, calculateReorderQuantity, linkedPurchaseRequestStatus } from "../shared/purchasing";

const order: Pick<PurchaseOrder, "items" | "status"> = {
  status: "ordered",
  items: [
    { id: "line-coffee", itemId: "coffee", itemName: "Coffee beans", unit: "bag", quantity: 8, receivedQuantity: 0, unitCost: 12 },
    { id: "line-cups", itemId: "cups", itemName: "Cups", unit: "box", quantity: 4, receivedQuantity: 0, unitCost: 6 },
  ],
};

describe("purchasing stock helpers", () => {
  it("calculates a zero or positive reorder quantity from the minimum", () => {
    expect(calculateReorderQuantity(3, 10)).toBe(7);
    expect(calculateReorderQuantity(10, 10)).toBe(0);
    expect(calculateReorderQuantity(12, 10)).toBe(0);
    expect(() => calculateReorderQuantity(1.5, 10)).toThrow(/whole quantity/);
  });

  it("tracks linked requests against their own goods and requested amount", () => {
    expect(linkedPurchaseRequestStatus(3, 0)).toBe("ordered");
    expect(linkedPurchaseRequestStatus(3, 2)).toBe("partially_received");
    expect(linkedPurchaseRequestStatus(3, 3)).toBe("received");
    expect(linkedPurchaseRequestStatus(3, 8)).toBe("received");
    expect(() => linkedPurchaseRequestStatus(0, 0)).toThrow(/greater than zero/);
  });

  it("applies partial receipts without receiving unrelated lines", () => {
    const result = applyPurchaseReceipt(order, [{ lineId: "line-coffee", quantity: 3 }]);
    expect(result.status).toBe("partially_received");
    expect(result.items.map((item) => item.receivedQuantity)).toEqual([3, 0]);
  });

  it("marks the order received only when every ordered unit is accounted for", () => {
    const partial = applyPurchaseReceipt(order, [{ lineId: "line-coffee", quantity: 8 }]);
    const completed = applyPurchaseReceipt({ ...order, items: partial.items, status: partial.status }, [{ lineId: "line-cups", quantity: 4 }]);
    expect(completed.status).toBe("received");
    expect(completed.items.map((item) => item.receivedQuantity)).toEqual([8, 4]);
  });

  it("rejects over-receipts, duplicate lines, non-integer amounts and unknown lines", () => {
    expect(() => applyPurchaseReceipt(order, [{ lineId: "line-coffee", quantity: 9 }])).toThrow(/exceeds the outstanding/);
    expect(() => applyPurchaseReceipt(order, [{ lineId: "line-coffee", quantity: 1 }, { lineId: "line-coffee", quantity: 1 }])).toThrow(/only once/);
    expect(() => applyPurchaseReceipt(order, [{ lineId: "line-cups", quantity: 1.5 }])).toThrow(/whole quantity/);
    expect(() => applyPurchaseReceipt(order, [{ lineId: "unknown", quantity: 1 }])).toThrow(/does not belong/);
  });
});
