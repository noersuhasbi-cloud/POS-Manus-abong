export const INGREDIENT_BASE_UNITS = ["piece", "g", "ml"] as const;
export const INGREDIENT_PURCHASE_UNITS = ["piece", "box", "bag", "pack", "bottle", "can", "case", "g", "kg", "ml", "liter"] as const;
export type IngredientBaseUnit = (typeof INGREDIENT_BASE_UNITS)[number];
export type IngredientPurchaseUnit = (typeof INGREDIENT_PURCHASE_UNITS)[number];

export const MAX_BASE_QUANTITY = 1_000_000_000;
const BASE_PRECISION = 1_000;

export function normalizeBaseQuantity(value: number, label = "Base-unit quantity") {
  if (!Number.isFinite(value) || value < 0 || value > MAX_BASE_QUANTITY || Math.abs(value * BASE_PRECISION - Math.round(value * BASE_PRECISION)) > 1e-7) {
    throw new RangeError(`${label} must be between zero and one billion with no more than three decimal places.`);
  }
  return Math.round(value * BASE_PRECISION) / BASE_PRECISION;
}

export function isPositiveConversionFactor(value: number) {
  return Number.isFinite(value) && value > 0 && value <= MAX_BASE_QUANTITY && Math.abs(value * BASE_PRECISION - Math.round(value * BASE_PRECISION)) <= 1e-7;
}

/** Return a safe common conversion suggestion; package contents must still be confirmed by a manager. */
export function suggestBaseUnitsPerPurchaseUnit(purchaseUnit: string, baseUnit: string): number | null {
  if (purchaseUnit === baseUnit) return 1;
  if (purchaseUnit === "kg" && baseUnit === "g") return 1_000;
  if (purchaseUnit === "liter" && baseUnit === "ml") return 1_000;
  return null;
}

export function convertPurchaseToBaseQuantity(purchaseQuantity: number, factor: number) {
  if (!Number.isSafeInteger(purchaseQuantity) || purchaseQuantity < 0 || purchaseQuantity > MAX_BASE_QUANTITY) {
    throw new RangeError("Purchase quantity must be a whole number of packs from zero to one billion.");
  }
  if (!isPositiveConversionFactor(factor)) throw new RangeError("Conversion factor must be positive and have no more than three decimal places.");
  return normalizeBaseQuantity(purchaseQuantity * factor, "Converted base-unit quantity");
}

/** Reorder just enough whole purchase units to bring stock back to the configured minimum. */
export function calculateReorderPacks(stockOnHand: number, minimumStock: number, factor: number) {
  const stock = normalizeBaseQuantity(stockOnHand, "Current stock");
  const minimum = normalizeBaseQuantity(minimumStock, "Minimum stock");
  if (!isPositiveConversionFactor(factor)) throw new RangeError("Conversion factor must be positive.");
  if (stock >= minimum) return 0;
  const deficit = normalizeBaseQuantity(minimum - stock, "Stock deficit");
  return Math.ceil(deficit / factor - 1e-10);
}
