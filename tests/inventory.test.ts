import { describe, expect, it } from "vitest";
import { aggregateStockDemand, applyStockDelta, calculateStockCount, normalizeStockQuantity } from "../shared/inventory";

describe("shared inventory arithmetic", () => {
  it("aggregates repeated goods in a single cashier ticket", () => {
    expect([...aggregateStockDemand([
      { menuItemId: "coffee", quantity: 2 },
      { menuItemId: "tea", quantity: 1 },
      { menuItemId: "coffee", quantity: 3 },
    ])]).toEqual([["coffee", 5], ["tea", 1]]);
  });

  it("deducts stock and prevents a negative balance", () => {
    expect(applyStockDelta(8, -3)).toBe(5);
    expect(applyStockDelta(0, 0)).toBe(0);
    expect(() => applyStockDelta(2, -3)).toThrow(/Insufficient stock/);
    expect(() => applyStockDelta(-1, 1)).toThrow(/whole number/);
  });

  it("accepts only whole stock units and bounds balances", () => {
    expect(normalizeStockQuantity(1)).toBe(1);
    expect(applyStockDelta(1, 1)).toBe(2);
    expect(() => normalizeStockQuantity(1.5)).toThrow(/whole number/);
    expect(() => normalizeStockQuantity(-1)).toThrow(/whole number/);
    expect(() => applyStockDelta(1_000_000_000, 1)).toThrow(/cannot exceed/);
    expect(() => aggregateStockDemand([{ menuItemId: "x", quantity: 0.5 }])).toThrow(/whole quantity/);
  });

  it("records positive and negative whole-unit stock-opname variances", () => {
    expect(calculateStockCount(5, 4)).toEqual({ before: 5, after: 4, variance: -1 });
    expect(calculateStockCount(2, 3)).toEqual({ before: 2, after: 3, variance: 1 });
    expect(() => calculateStockCount(3, -1)).toThrow(/whole number/);
    expect(() => calculateStockCount(3, 1.5)).toThrow(/whole number/);
  });
});
