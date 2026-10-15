import { describe, expect, it } from "vitest";
import { planRecipeConsumption } from "../shared/recipes";
import type { BillOfMaterial, MenuItem, OrderLine } from "../shared/pos";

const products: MenuItem[] = [
  { id: "latte", name: "Latte", description: "", category: "Coffee", price: 5, icon: "coffee", color: "#fff" },
  { id: "cappuccino", name: "Cappuccino", description: "", category: "Coffee", price: 4, icon: "coffee", color: "#fff" },
  { id: "tea", name: "Tea", description: "", category: "Tea", price: 3, icon: "tea", color: "#fff" },
];
const ingredients: MenuItem[] = [
  { id: "milk", name: "Milk", description: "", category: "Ingredients", price: 0, icon: "inventory", color: "#fff", ingredientOnly: true, stockTracked: true, stockOnHand: 1000, stockUnit: "ml", lowStockThreshold: 100, unitCost: 0.02 },
  { id: "beans", name: "Coffee beans", description: "", category: "Ingredients", price: 0, icon: "inventory", color: "#fff", ingredientOnly: true, stockTracked: true, stockOnHand: 500, stockUnit: "g", lowStockThreshold: 50, unitCost: 0.1 },
];
const lines: OrderLine[] = [
  { id: "line-latte", menuItemId: "latte", name: "Latte", category: "Coffee", unitPrice: 5, quantity: 2 },
  { id: "line-capp", menuItemId: "cappuccino", name: "Cappuccino", category: "Coffee", unitPrice: 4, quantity: 1 },
  { id: "line-tea", menuItemId: "tea", name: "Tea", category: "Tea", unitPrice: 3, quantity: 1 },
];
const recipes: BillOfMaterial[] = [
  { menuItemId: "latte", updatedAt: "2026-10-12T00:00:00.000Z", components: [{ ingredientItemId: "milk", quantity: 100 }, { ingredientItemId: "beans", quantity: 18 }] },
  { menuItemId: "cappuccino", updatedAt: "2026-10-12T00:00:00.000Z", components: [{ ingredientItemId: "milk", quantity: 60 }, { ingredientItemId: "beans", quantity: 18 }] },
];

describe("recipe consumption planning", () => {
  it("aggregates shared ingredient demand and snapshots sale-line COGS from unit costs", () => {
    const result = planRecipeConsumption(lines, recipes, [...products, ...ingredients]);
    expect(result.ingredientDemand.get("milk")).toBe(260);
    expect(result.ingredientDemand.get("beans")).toBe(54);
    expect(result.lines[0]).toMatchObject({ menuItemId: "latte", recipeCosted: true, recipeUnitCost: 3.8, recipeCost: 7.6 });
    expect(result.lines[0].ingredients).toEqual([
      { ingredientItemId: "milk", ingredientName: "Milk", unit: "ml", quantityPerItem: 100, quantityUsed: 200, unitCost: 0.02, totalCost: 4 },
      { ingredientItemId: "beans", ingredientName: "Coffee beans", unit: "g", quantityPerItem: 18, quantityUsed: 36, unitCost: 0.1, totalCost: 3.6 },
    ]);
    expect(result.lines[2]).toMatchObject({ menuItemId: "tea", recipeCosted: false, recipeCost: 0, ingredients: [] });
  });

  it("rejects ingredients outside tracked inventory and invalid or repeated component quantities", () => {
    expect(() => planRecipeConsumption(lines.slice(0, 1), [{ ...recipes[0]!, components: [{ ingredientItemId: "latte", quantity: 1 }] }], [...products, ...ingredients])).toThrow(/tracked ingredient/);
    expect(() => planRecipeConsumption(lines.slice(0, 1), [{ ...recipes[0]!, components: [{ ingredientItemId: "milk", quantity: 0 }] }], [...products, ...ingredients])).toThrow(/invalid ingredient quantity/);
    expect(() => planRecipeConsumption(lines.slice(0, 1), [{ ...recipes[0]!, components: [{ ingredientItemId: "milk", quantity: 5 }, { ingredientItemId: "milk", quantity: 4 }] }], [...products, ...ingredients])).toThrow(/repeats an ingredient/);
  });

  it("rejects aggregated recipe consumption above the base-unit stock ceiling", () => {
    const hugeRecipe: BillOfMaterial = { menuItemId: "latte", updatedAt: "2026-10-12T00:00:00.000Z", components: [{ ingredientItemId: "milk", quantity: 1_000_000_000 }] };
    expect(() => planRecipeConsumption([lines[0]!], [hugeRecipe], [...products, ...ingredients])).toThrow(/one billion/);
  });
});
