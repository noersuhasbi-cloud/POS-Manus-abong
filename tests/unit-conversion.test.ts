import { describe, expect, it } from "vitest";
import { calculateReorderPacks, convertPurchaseToBaseQuantity, isPositiveConversionFactor, normalizeBaseQuantity, suggestBaseUnitsPerPurchaseUnit } from "../shared/unit-conversion";

describe("ingredient purchase-unit conversion", () => {
  it("suggests matching and standard mass/volume factors", () => {
    expect(suggestBaseUnitsPerPurchaseUnit("g", "g")).toBe(1);
    expect(suggestBaseUnitsPerPurchaseUnit("kg", "g")).toBe(1_000);
    expect(suggestBaseUnitsPerPurchaseUnit("liter", "ml")).toBe(1_000);
    expect(suggestBaseUnitsPerPurchaseUnit("ml", "ml")).toBe(1);
    expect(suggestBaseUnitsPerPurchaseUnit("box", "piece")).toBeNull();
    expect(suggestBaseUnitsPerPurchaseUnit("kg", "ml")).toBeNull();
  });

  it("converts purchased bottles into recipe base units", () => {
    expect(convertPurchaseToBaseQuantity(2, 750)).toBe(1_500);
    expect(convertPurchaseToBaseQuantity(1, 0.375)).toBe(0.375);
  });

  it("validates and rounds only to millibase precision", () => {
    expect(normalizeBaseQuantity(15.125)).toBe(15.125);
    expect(isPositiveConversionFactor(0.001)).toBe(true);
    expect(isPositiveConversionFactor(0.0001)).toBe(false);
    expect(() => normalizeBaseQuantity(1.0001)).toThrow(/three decimal/);
    expect(() => convertPurchaseToBaseQuantity(1.5, 750)).toThrow(/whole number of packs/);
    expect(() => convertPurchaseToBaseQuantity(1, 0)).toThrow(/Conversion factor/);
  });

  it("suggests the ceiling number of whole packs needed to reach minimum stock", () => {
    expect(calculateReorderPacks(100, 250, 750)).toBe(1);
    expect(calculateReorderPacks(100, 1_600, 750)).toBe(2);
    expect(calculateReorderPacks(1_700, 1_600, 750)).toBe(0);
  });
});
