import type { PurchaseOrder, PurchaseOrderLine, PurchaseOrderStatus } from "./pos";

export type PurchaseReceiptQuantity = { lineId: string; quantity: number };

function requireWholeUnits(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new Error(`${label} must be a whole quantity between zero and one billion.`);
  }
  return value;
}

export function calculateReorderQuantity(stockOnHand: number, minimumStock: number) {
  const current = requireWholeUnits(stockOnHand, "Current stock");
  const minimum = requireWholeUnits(minimumStock, "Minimum stock");
  return Math.max(0, minimum - current);
}

export function linkedPurchaseRequestStatus(requestedQuantity: number, receivedQuantity: number): "ordered" | "partially_received" | "received" {
  const requested = requireWholeUnits(requestedQuantity, "Requested quantity");
  const received = requireWholeUnits(receivedQuantity, "Received quantity");
  if (requested <= 0) throw new Error("Requested quantity must be greater than zero.");
  return received >= requested ? "received" : received > 0 ? "partially_received" : "ordered";
}

export function applyPurchaseReceipt(order: Pick<PurchaseOrder, "items" | "status">, receipts: PurchaseReceiptQuantity[]): { items: PurchaseOrderLine[]; status: PurchaseOrderStatus } {
  if (order.status === "received") throw new Error("This purchase order has already been fully received.");
  if (!receipts.length) throw new Error("Enter at least one received quantity.");

  const byLine = new Map<string, number>();
  for (const receipt of receipts) {
    if (!receipt.lineId || byLine.has(receipt.lineId)) throw new Error("Each purchase-order line can be received only once per receipt.");
    const quantity = requireWholeUnits(receipt.quantity, "Received quantity");
    if (quantity <= 0) throw new Error("Received quantities must be greater than zero.");
    byLine.set(receipt.lineId, quantity);
  }

  const items = order.items.map((line) => {
    const incoming = byLine.get(line.id);
    if (incoming === undefined) return line;
    const ordered = requireWholeUnits(line.quantity, "Ordered quantity");
    const alreadyReceived = requireWholeUnits(line.receivedQuantity, "Previously received quantity");
    const outstanding = ordered - alreadyReceived;
    if (outstanding <= 0) throw new Error(`${line.itemName} has no outstanding quantity to receive.`);
    if (incoming > outstanding) throw new Error(`Receipt quantity exceeds the outstanding quantity for ${line.itemName} (${outstanding} ${line.unit}).`);
    byLine.delete(line.id);
    return { ...line, receivedQuantity: alreadyReceived + incoming };
  });
  if (byLine.size) throw new Error("A received line does not belong to this purchase order.");

  const status: PurchaseOrderStatus = items.every((line) => line.receivedQuantity === line.quantity) ? "received" : "partially_received";
  return { items, status };
}
