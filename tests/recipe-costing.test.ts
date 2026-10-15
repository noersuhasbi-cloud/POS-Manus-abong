import { describe, expect, it } from "vitest";
import { summarizeRecipeCosting } from "../shared/recipe-costing";
import type { RecipeSaleCost, Transaction } from "../shared/pos";

const start = new Date("2026-10-11T00:00:00.000Z");
const end = new Date("2026-10-11T23:59:59.999Z");

function transaction(id: string, status: Transaction["status"] = "paid"): Transaction {
  return { id, orderId: `order-${id}`, orderNumber: id, createdAt: "2026-10-11T10:00:00.000Z", items: [], subtotal: 0, discount: 0, tax: 0, total: 0, paymentMethod: "Cash", status };
}

function snapshot(transactionId: string, lines: RecipeSaleCost["lines"]): RecipeSaleCost {
  return { transactionId, orderId: `order-${transactionId}`, orderNumber: transactionId, at: "2026-10-11T10:00:00.000Z", currency: "USD", totalRecipeCogs: lines.reduce((sum, line) => sum + line.recipeCost, 0), lines };
}

const costedLatte: RecipeSaleCost["lines"][number] = {
  menuItemId: "latte", menuItemName: "Latte", quantity: 2, grossSales: 10, discountAllocated: 1, netSales: 9,
  recipeCosted: true, recipeUnitCost: 2, recipeCost: 4,
  ingredients: [{ ingredientItemId: "milk", ingredientName: "Milk", unit: "ml", quantityPerItem: 100, quantityUsed: 200, unitCost: 0.02, totalCost: 4 }],
};

describe("recipe COGS report", () => {
  it("aggregates sale-time ingredient costs and net sales by menu item", () => {
    const secondSale = { ...costedLatte, quantity: 1, grossSales: 5, discountAllocated: 0, netSales: 5, recipeCost: 2, ingredients: [{ ...costedLatte.ingredients[0], quantityUsed: 100, totalCost: 2 }] };
    const result = summarizeRecipeCosting([snapshot("paid-a", [costedLatte]), snapshot("paid-b", [secondSale])], [transaction("paid-a"), transaction("paid-b")], start, end, "USD");
    expect(result).toMatchObject({ recipeCogs: 6, recipeCostedSales: 14, uncostedSales: 0, grossProfit: 8, costCoveragePercent: 100 });
    expect(result.items[0]).toMatchObject({ menuItemId: "latte", quantitySold: 3, recipeCogs: 6, grossProfit: 8 });
    expect(result.items[0].ingredients[0]).toMatchObject({ ingredientItemId: "milk", quantityUsed: 300, totalCost: 6 });
  });

  it("shows uncosted sales and reports recipe-cost coverage instead of assuming missing recipes are zero cost", () => {
    const uncosted = { ...costedLatte, menuItemId: "tea", menuItemName: "Tea", quantity: 1, grossSales: 4, discountAllocated: 0, netSales: 4, recipeCosted: false, recipeUnitCost: 0, recipeCost: 0, ingredients: [] };
    const result = summarizeRecipeCosting([snapshot("paid-a", [costedLatte, uncosted])], [transaction("paid-a")], start, end, "USD");
    expect(result).toMatchObject({ recipeCogs: 4, recipeCostedSales: 9, uncostedSales: 4, grossProfit: 5, costCoveragePercent: 69.23 });
    expect(result.items.find((item) => item.menuItemId === "tea")).toMatchObject({ uncostedQuantity: 1, recipeCogs: 0, grossProfit: 0 });
  });

  it("excludes refunded, voided and out-of-period snapshots", () => {
    const outside = { ...transaction("outside"), createdAt: "2026-10-10T23:59:59.999Z" };
    const result = summarizeRecipeCosting(
      [snapshot("paid-a", [costedLatte]), snapshot("refunded", [costedLatte]), snapshot("voided", [costedLatte]), snapshot("outside", [costedLatte])],
      [transaction("paid-a"), transaction("refunded", "refunded"), transaction("voided", "voided"), outside], start, end, "USD",
    );
    expect(result).toMatchObject({ recipeCogs: 4, recipeCostedSales: 9, uncostedSales: 0 });
    expect(result.items).toHaveLength(1);
  });
});
