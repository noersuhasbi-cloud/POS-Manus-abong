import { roundAmount } from "./accounting";
import type { CurrencyCode, RecipeSaleCost, Transaction } from "./pos";

export type RecipeCostItemSummary = {
  menuItemId: string;
  menuItemName: string;
  quantitySold: number;
  recipeCostedQuantity: number;
  uncostedQuantity: number;
  netSales: number;
  recipeCostedSales: number;
  uncostedSales: number;
  recipeCogs: number;
  grossProfit: number;
  ingredients: { ingredientItemId: string; ingredientName: string; unit: string; quantityUsed: number; totalCost: number }[];
};

export type RecipeCostSummary = {
  currency: CurrencyCode;
  recipeCogs: number;
  recipeCostedSales: number;
  uncostedSales: number;
  grossProfit: number;
  costCoveragePercent: number;
  items: RecipeCostItemSummary[];
};

/**
 * Summarize immutable sale-time recipe costs for paid transactions in the requested period.
 * This management report is an estimate and must not be posted as ledger COGS.
 */
export function summarizeRecipeCosting(
  snapshots: RecipeSaleCost[],
  transactions: Transaction[],
  start: Date,
  end: Date,
  currency: CurrencyCode,
): RecipeCostSummary {
  const startTime = start.getTime();
  const endTime = end.getTime();
  const paidInPeriod = new Map(transactions
    .filter((transaction) => transaction.status === "paid")
    .filter((transaction) => {
      const timestamp = new Date(transaction.createdAt).getTime();
      return Number.isFinite(timestamp) && timestamp >= startTime && timestamp <= endTime;
    })
    .map((transaction) => [transaction.id, transaction]));
  const items = new Map<string, {
    menuItemId: string;
    menuItemName: string;
    quantitySold: number;
    recipeCostedQuantity: number;
    uncostedQuantity: number;
    netSales: number;
    recipeCostedSales: number;
    uncostedSales: number;
    recipeCogs: number;
    ingredients: Map<string, { ingredientItemId: string; ingredientName: string; unit: string; quantityUsed: number; totalCost: number }>;
  }>();

  for (const snapshot of snapshots) {
    if (!paidInPeriod.has(snapshot.transactionId)) continue;
    for (const line of snapshot.lines) {
      if (!line.menuItemId || !Number.isFinite(line.quantity) || line.quantity <= 0) continue;
      const row = items.get(line.menuItemId) ?? {
        menuItemId: line.menuItemId,
        menuItemName: line.menuItemName,
        quantitySold: 0,
        recipeCostedQuantity: 0,
        uncostedQuantity: 0,
        netSales: 0,
        recipeCostedSales: 0,
        uncostedSales: 0,
        recipeCogs: 0,
        ingredients: new Map(),
      };
      const netSales = Number.isFinite(line.netSales) ? Math.max(0, line.netSales) : 0;
      row.quantitySold += line.quantity;
      row.netSales += netSales;
      if (line.recipeCosted) {
        row.recipeCostedQuantity += line.quantity;
        row.recipeCostedSales += netSales;
        row.recipeCogs += Math.max(0, Number(line.recipeCost) || 0);
        for (const component of line.ingredients) {
          const prior = row.ingredients.get(component.ingredientItemId) ?? {
            ingredientItemId: component.ingredientItemId,
            ingredientName: component.ingredientName,
            unit: component.unit,
            quantityUsed: 0,
            totalCost: 0,
          };
          prior.quantityUsed += Math.max(0, Number(component.quantityUsed) || 0);
          prior.totalCost += Math.max(0, Number(component.totalCost) || 0);
          row.ingredients.set(component.ingredientItemId, prior);
        }
      } else {
        row.uncostedQuantity += line.quantity;
        row.uncostedSales += netSales;
      }
      items.set(line.menuItemId, row);
    }
  }

  const itemRows = [...items.values()].map((item): RecipeCostItemSummary => {
    const recipeCogs = roundAmount(item.recipeCogs, currency);
    return {
      menuItemId: item.menuItemId,
      menuItemName: item.menuItemName,
      quantitySold: item.quantitySold,
      recipeCostedQuantity: item.recipeCostedQuantity,
      uncostedQuantity: item.uncostedQuantity,
      netSales: roundAmount(item.netSales, currency),
      recipeCostedSales: roundAmount(item.recipeCostedSales, currency),
      uncostedSales: roundAmount(item.uncostedSales, currency),
      recipeCogs,
      grossProfit: roundAmount(item.recipeCostedSales - item.recipeCogs, currency),
      ingredients: [...item.ingredients.values()].map((component) => ({
        ...component,
        totalCost: roundAmount(component.totalCost, currency),
      })),
    };
  }).sort((a, b) => b.netSales - a.netSales || a.menuItemName.localeCompare(b.menuItemName));
  const recipeCogs = roundAmount(itemRows.reduce((sum, item) => sum + item.recipeCogs, 0), currency);
  const recipeCostedSales = roundAmount(itemRows.reduce((sum, item) => sum + item.recipeCostedSales, 0), currency);
  const uncostedSales = roundAmount(itemRows.reduce((sum, item) => sum + item.uncostedSales, 0), currency);
  const netSales = recipeCostedSales + uncostedSales;
  return {
    currency,
    recipeCogs,
    recipeCostedSales,
    uncostedSales,
    grossProfit: roundAmount(recipeCostedSales - recipeCogs, currency),
    costCoveragePercent: netSales > 0 ? roundAmount(recipeCostedSales / netSales * 100, "USD") : 0,
    items: itemRows,
  };
}
