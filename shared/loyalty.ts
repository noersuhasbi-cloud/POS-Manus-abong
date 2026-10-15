import { roundAmount } from "./accounting";
import type { CurrencyCode } from "./pos";

export type LoyaltyRedemption = { points: number; discount: number };

export function calculateLoyaltyRedemption(pointsInput: number, remainingAmount: number, valuePerPointInput: number, currency: CurrencyCode): LoyaltyRedemption | null {
  const points = Math.max(0, Math.floor(pointsInput));
  if (points === 0) return { points: 0, discount: 0 };
  if (!Number.isFinite(remainingAmount) || !Number.isFinite(valuePerPointInput) || valuePerPointInput <= 0) return null;
  const requestedDiscount = roundAmount(points * valuePerPointInput, currency);
  const availableAmount = roundAmount(Math.max(0, remainingAmount), currency);
  if (requestedDiscount <= 0 || requestedDiscount > availableAmount) return null;
  return { points, discount: requestedDiscount };
}

export type LoyaltyReversal = { balance: number; pointsDebited: number; pointsRestored: number; earnedPointsUnavailable: number; pointsChange: number };

export function reverseLoyaltyPoints(balanceInput: number, earnedInput: number, redeemedInput: number): LoyaltyReversal {
  const balance = Number.isFinite(balanceInput) ? Math.max(0, Math.floor(balanceInput)) : 0;
  const earned = Number.isFinite(earnedInput) ? Math.max(0, Math.floor(earnedInput)) : 0;
  const redeemed = Number.isFinite(redeemedInput) ? Math.max(0, Math.floor(redeemedInput)) : 0;
  const pointsDebited = Math.min(balance, earned);
  const earnedPointsUnavailable = earned - pointsDebited;
  const pointsRestored = redeemed;
  const nextBalance = balance - pointsDebited + pointsRestored;
  return { balance: nextBalance, pointsDebited, pointsRestored, earnedPointsUnavailable, pointsChange: nextBalance - balance };
}
