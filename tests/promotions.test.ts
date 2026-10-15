import { describe, expect, it } from "vitest";
import { businessDateTimeInput, businessDateTimeToUtc, calculatePromotionDiscount, evaluatePromotionAtCheckout, isPromotionActiveAt } from "../shared/promotions";
import type { Promotion } from "../shared/pos";

const base: Promotion = { id: "offer", name: "Offer", discountType: "percent", value: 10, startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-11-01T00:00:00.000Z", active: true, redemptionCount: 0, createdAt: "2026-10-01T00:00:00.000Z" };

describe("promotion dates and rules", () => {
  it("converts local promotion fields using the business timezone, not the device timezone", () => {
    expect(businessDateTimeToUtc("2026-10-13 09:00", "Asia/Jakarta")).toBe("2026-10-13T02:00:00.000Z");
    expect(businessDateTimeInput(new Date("2026-10-13T02:00:00.000Z"), "Asia/Jakarta")).toBe("2026-10-13 09:00");
    expect(businessDateTimeToUtc("2026-01-14 09:00", "America/New_York")).toBe("2026-01-14T14:00:00.000Z");
    expect(() => businessDateTimeToUtc("2026-02-30 09:00", "Asia/Jakarta")).toThrow(/real calendar date/);
  });

  it("honors daily time and weekday schedule windows in business-local time", () => {
    const scheduled = { ...base, startsAt: "2026-10-13T00:00:00.000Z", endsAt: "2026-10-14T00:00:00.000Z", dailyStartTime: "09:00", dailyEndTime: "11:00", weekdays: [2] };
    expect(isPromotionActiveAt(scheduled, new Date("2026-10-13T02:00:00.000Z"), "Asia/Jakarta")).toBe(true);
    expect(isPromotionActiveAt(scheduled, new Date("2026-10-13T05:30:00.000Z"), "Asia/Jakarta")).toBe(false);
    expect(isPromotionActiveAt(scheduled, new Date("2026-10-14T02:00:00.000Z"), "Asia/Jakarta")).toBe(false);
  });

  it("keeps percent/fixed discounts and applies one free item only after the BOGO quantity is met", () => {
    const lines = [{ menuItemId: "tea", quantity: 2, unitPrice: 5 }];
    expect(calculatePromotionDiscount(base, lines, 10, "USD")).toBe(1);
    expect(calculatePromotionDiscount({ ...base, discountType: "fixed", value: 3 }, lines, 10, "USD")).toBe(3);
    const bogo = { ...base, ruleType: "bogo" as const, buyItemId: "tea", buyQuantity: 1, rewardItemId: "tea", rewardQuantity: 1 };
    expect(calculatePromotionDiscount(bogo, [{ ...lines[0], quantity: 1 }], 5, "USD")).toBe(0);
    expect(calculatePromotionDiscount(bogo, lines, 10, "USD")).toBe(5);
  });

  it("discounts bundles to their configured base-item package price", () => {
    const bundle = { ...base, ruleType: "bundle" as const, bundleItems: [{ menuItemId: "latte", quantity: 2 }, { menuItemId: "cookie", quantity: 1 }], bundlePrice: 9 };
    const lines = [{ menuItemId: "latte", quantity: 2, unitPrice: 5 }, { menuItemId: "cookie", quantity: 1, unitPrice: 2 }];
    expect(calculatePromotionDiscount(bundle, lines, 12, "USD")).toBe(3);
    expect(calculatePromotionDiscount(bundle, [lines[0]], 10, "USD")).toBe(0);
  });

  it("rejects inactive or unqualified offers before checkout can record a redemption", () => {
    const bogo = { ...base, ruleType: "bogo" as const, buyItemId: "tea", buyQuantity: 1, rewardItemId: "tea", rewardQuantity: 1 };
    const now = new Date("2026-10-13T02:00:00.000Z");
    expect(evaluatePromotionAtCheckout({ ...bogo, startsAt: "2026-10-14T00:00:00.000Z" }, [{ menuItemId: "tea", quantity: 2, unitPrice: 5 }], 10, "USD", now, "Asia/Jakarta")).toMatchObject({ eligible: false, reason: "inactive" });
    expect(evaluatePromotionAtCheckout(bogo, [{ menuItemId: "tea", quantity: 1, unitPrice: 5 }], 5, "USD", now, "Asia/Jakarta")).toMatchObject({ eligible: false, reason: "items_or_quantity" });
    expect(evaluatePromotionAtCheckout(bogo, [{ menuItemId: "tea", quantity: 2, unitPrice: 5 }], 10, "USD", now, "Asia/Jakarta")).toMatchObject({ eligible: true, discount: 5 });
  });
});
