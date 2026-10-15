import { roundAmount } from "./accounting";
import type { CurrencyCode, Promotion } from "./pos";

export type PromotionCartLine = { menuItemId: string; quantity: number; unitPrice: number };
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function parseLocalDateTime(value: string) {
  const match = LOCAL_DATE_TIME_RE.exec(value.trim());
  if (!match) throw new RangeError("Use local date/time in YYYY-MM-DD HH:mm format.");
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText), hour = Number(hourText), minute = Number(minuteText);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(asUtc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) throw new RangeError("Enter a real calendar date and time.");
  return { year, month, day, hour, minute, asUtc };
}

function localPartsAt(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute) };
}

/** Convert a human-entered business-local date/time to UTC without assuming the device timezone. */
export function businessDateTimeToUtc(value: string, timeZone: string) {
  const local = parseLocalDateTime(value);
  let candidate = local.asUtc;
  for (let attempt = 0; attempt < 5; attempt++) {
    const observed = localPartsAt(new Date(candidate), timeZone);
    const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute);
    const adjustment = local.asUtc - observedAsUtc;
    if (adjustment === 0) return new Date(candidate).toISOString();
    candidate += adjustment;
  }
  throw new RangeError("This local time does not exist in the selected business timezone. Choose another time.");
}

export function businessDateTimeInput(instant: Date, timeZone: string) {
  const local = localPartsAt(instant, timeZone);
  return `${String(local.year).padStart(4, "0")}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")} ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
}

export function isTimeRange(value: string) { return TIME_RE.test(value); }

export function isPromotionActiveAt(offer: Promotion, now: Date | number, timeZone = "UTC") {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const starts = Date.parse(offer.startsAt);
  const ends = Date.parse(offer.endsAt);
  if (!offer.active || !Number.isFinite(starts) || !Number.isFinite(ends) || nowMs < starts || nowMs > ends) return false;
  const local = localPartsAt(new Date(nowMs), timeZone);
  const weekdayShort = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(nowMs));
  const today = WEEKDAY_INDEX[weekdayShort];
  const weekdays = offer.weekdays;
  const hasDay = (index: number) => !weekdays?.length || weekdays.includes(index);
  if (offer.weekdays?.length) {
    if (offer.dailyStartTime && offer.dailyEndTime && offer.dailyStartTime > offer.dailyEndTime && local.hour * 60 + local.minute <= Number(offer.dailyEndTime.slice(0, 2)) * 60 + Number(offer.dailyEndTime.slice(3, 5))) {
      if (!hasDay((today + 6) % 7)) return false;
    } else if (!hasDay(today)) return false;
  }
  if (!offer.dailyStartTime || !offer.dailyEndTime) return true;
  if (!TIME_RE.test(offer.dailyStartTime) || !TIME_RE.test(offer.dailyEndTime)) return false;
  const currentMinutes = local.hour * 60 + local.minute;
  const startMinutes = Number(offer.dailyStartTime.slice(0, 2)) * 60 + Number(offer.dailyStartTime.slice(3, 5));
  const endMinutes = Number(offer.dailyEndTime.slice(0, 2)) * 60 + Number(offer.dailyEndTime.slice(3, 5));
  return startMinutes <= endMinutes ? currentMinutes >= startMinutes && currentMinutes <= endMinutes : currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

/** Compute server-authoritative discount on canonical, whole menu quantities. Add-on modifier charges remain payable. */
export function calculatePromotionDiscount(offer: Promotion, lines: PromotionCartLine[], subtotal: number, currency: CurrencyCode) {
  const ruleType = offer.ruleType ?? "discount";
  let rawDiscount = 0;
  if (ruleType === "bogo") {
    const buyId = offer.buyItemId, rewardId = offer.rewardItemId;
    const buyQuantity = offer.buyQuantity ?? 0, rewardQuantity = offer.rewardQuantity ?? 0;
    if (!buyId || !rewardId || !Number.isSafeInteger(buyQuantity) || buyQuantity < 1 || !Number.isSafeInteger(rewardQuantity) || rewardQuantity < 1) return 0;
    const bought = lines.filter((line) => line.menuItemId === buyId).reduce((sum, line) => sum + line.quantity, 0);
    const rewards = lines.filter((line) => line.menuItemId === rewardId).reduce((sum, line) => sum + line.quantity, 0);
    const rewardUnitPrice = lines.find((line) => line.menuItemId === rewardId)?.unitPrice ?? 0;
    const sets = buyId === rewardId ? Math.floor(bought / (buyQuantity + rewardQuantity)) : Math.floor(bought / buyQuantity);
    const freeQuantity = Math.min(rewards, sets * rewardQuantity);
    rawDiscount = freeQuantity * rewardUnitPrice;
  } else if (ruleType === "bundle") {
    const bundleItems = offer.bundleItems ?? [];
    const bundlePrice = offer.bundlePrice;
    if (!bundleItems.length || !Number.isFinite(bundlePrice) || bundlePrice! < 0) return 0;
    const sets = Math.min(...bundleItems.map((bundleLine) => {
      if (!Number.isSafeInteger(bundleLine.quantity) || bundleLine.quantity < 1) return 0;
      const available = lines.filter((line) => line.menuItemId === bundleLine.menuItemId).reduce((sum, line) => sum + line.quantity, 0);
      return Math.floor(available / bundleLine.quantity);
    }));
    const baseBundleValue = bundleItems.reduce((sum, bundleLine) => sum + (lines.find((line) => line.menuItemId === bundleLine.menuItemId)?.unitPrice ?? 0) * bundleLine.quantity, 0);
    rawDiscount = Math.max(0, baseBundleValue - bundlePrice!) * sets;
  } else {
    const value = Number(offer.value);
    if (!Number.isFinite(value) || value <= 0) return 0;
    rawDiscount = offer.discountType === "percent" ? subtotal * Math.min(100, value) / 100 : value;
  }
  return roundAmount(Math.min(Math.max(0, rawDiscount), Math.max(0, subtotal)), currency);
}

export function evaluatePromotionAtCheckout(offer: Promotion, lines: PromotionCartLine[], subtotal: number, currency: CurrencyCode, now: Date | number, timeZone: string) {
  if (!isPromotionActiveAt(offer, now, timeZone)) return { eligible: false as const, discount: 0, reason: "inactive" as const };
  const discount = calculatePromotionDiscount(offer, lines, subtotal, currency);
  if (discount <= 0) return { eligible: false as const, discount: 0, reason: "items_or_quantity" as const };
  return { eligible: true as const, discount };
}
