export type StockDemandLine = { menuItemId: string; quantity: number };
export const MAX_STOCK_QUANTITY = 1_000_000_000;
import { normalizeBaseQuantity } from "./unit-conversion";

/** Inventory uses whole configured units to match the POS's existing integer line quantities. */
export function normalizeStockQuantity(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_STOCK_QUANTITY) {
    throw new RangeError("Stock quantity must be a whole number from zero to one billion.");
  }
  return value;
}

/** Apply an inventory movement and reject any movement that would leave negative stock. */
export function applyStockDelta(current: number, delta: number) {
  const before = normalizeStockQuantity(current);
  if (!Number.isSafeInteger(delta)) throw new RangeError("Stock movement must be a whole number.");
  const after = before + delta;
  if (after < 0) throw new RangeError("Insufficient stock for this movement.");
  if (after > MAX_STOCK_QUANTITY) throw new RangeError("Stock balance cannot exceed one billion units.");
  return after;
}

/** Combine repeated goods in a ticket before validating and posting stock deductions. */
export function aggregateStockDemand(lines: StockDemandLine[]) {
  const demand = new Map<string, number>();
  for (const line of lines) {
    if (!line.menuItemId || !Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new RangeError("POS stock demand requires a good and a positive whole quantity.");
    }
    demand.set(line.menuItemId, (demand.get(line.menuItemId) ?? 0) + line.quantity);
  }
  return demand;
}

/** Physical stock opname replaces book quantity with the counted whole-unit quantity. */
export function calculateStockCount(current: number, counted: number) {
  const before = normalizeStockQuantity(current);
  const after = normalizeStockQuantity(counted);
  return { before, after, variance: after - before };
}

/** Ingredient-only stock uses precise base units; direct menu goods remain whole-unit stock. */
export function applyIngredientStockDelta(current: number, delta: number) {
  const before = normalizeBaseQuantity(current, "Current ingredient stock");
  const movement = normalizeBaseQuantity(Math.abs(delta), "Ingredient movement");
  const after = normalizeBaseQuantity(before + Math.sign(delta) * movement, "Resulting ingredient stock");
  if (delta < 0 && after < 0) throw new RangeError("Insufficient ingredient stock for this movement.");
  return after;
}

export function calculateIngredientStockCount(current: number, counted: number) {
  const before = normalizeBaseQuantity(current, "Current ingredient stock");
  const after = normalizeBaseQuantity(counted, "Counted ingredient stock");
  return { before, after, variance: normalizeBaseQuantity(after - before, "Stock variance") };
}
