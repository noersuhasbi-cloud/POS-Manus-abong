import type { PaymentMethod } from "./pos";

export type LegacyPaymentMethod = Exclude<PaymentMethod, "Gift Card">;

/** Keep the version-one local import contract exact; never relabel a stored-value tender as cash/card. */
export function toLegacyImportRecord<T extends { paymentMethod: PaymentMethod }>(record: T): Omit<T, "paymentMethod"> & { paymentMethod: LegacyPaymentMethod } {
  if (record.paymentMethod === "Gift Card") {
    throw new Error("Gift-card-paid records cannot be imported from this device archive. The original local record is unchanged.");
  }
  return record as Omit<T, "paymentMethod"> & { paymentMethod: LegacyPaymentMethod };
}
