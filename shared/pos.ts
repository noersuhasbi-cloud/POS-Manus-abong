export type BusinessRole = "manager" | "cashier" | "kitchen";
export type PaymentMethod = "Cash" | "Card" | "QRIS" | "Other" | "Gift Card";
export type OrderStatus = "new" | "preparing" | "ready" | "completed" | "cancelled";
export type TransactionStatus = "paid" | "refunded" | "voided";
export type CurrencyCode = "IDR" | "USD";
export type InventoryMovementKind = "opening" | "receipt" | "sale" | "recipe" | "opname";
export type InventoryMovement = {
  id: string;
  itemId: string;
  itemName: string;
  unit: string;
  kind: InventoryMovementKind;
  quantityDelta: number;
  quantityBefore: number;
  quantityAfter: number;
  reason: string;
  reference: string;
  at: string;
  actorOpenId: string;
  purchaseQuantity?: number;
  purchaseUnit?: string;
  purchaseOrderId?: string;
  purchaseOrderLineId?: string;
  goodsReceiptId?: string;
  baseUnitsPerPurchaseUnit?: number;
};

export type Supplier = { id: string; name: string; contactName?: string; email?: string; phone?: string; notes?: string; active: boolean; createdAt: string; updatedAt: string };
export type PurchaseRequestStatus = "requested" | "approved" | "rejected" | "ordered" | "partially_received" | "received";
export type PurchaseRequest = { id: string; itemId: string; itemName: string; unit: string; quantity: number; reason: string; stockOnHandAtRequest: number; minimumStockAtRequest: number; status: PurchaseRequestStatus; createdByOpenId: string; createdAt: string; reviewedByOpenId?: string; reviewedAt?: string; reviewNote?: string; purchaseOrderId?: string; stockUnit?: string; baseUnitsPerPurchaseUnit?: number };
export type PurchaseOrderStatus = "ordered" | "partially_received" | "received";
export type PurchaseOrderLine = { id: string; itemId: string; itemName: string; unit: string; quantity: number; receivedQuantity: number; unitCost: number; stockUnit?: string; baseUnitsPerPurchaseUnit?: number };
export type PurchaseOrder = { id: string; number: string; supplierId: string; supplierName: string; status: PurchaseOrderStatus; items: PurchaseOrderLine[]; estimatedTotal: number; expectedDeliveryDate?: string; purchaseRequestId?: string; createdByOpenId: string; createdAt: string; updatedAt: string; requestFingerprint?: string };
export type GoodsReceiptLine = { lineId: string; itemId: string; itemName: string; unit: string; quantity: number; quantityBefore: number; quantityAfter: number; stockUnit?: string; baseQuantity?: number; baseUnitsPerPurchaseUnit?: number };
export type GoodsReceipt = { id: string; number: string; purchaseOrderId: string; purchaseOrderNumber: string; supplierName: string; lines: GoodsReceiptLine[]; note: string; receivedAt: string; receivedByOpenId: string; requestFingerprint?: string };

export type Modifier = { id: string; label: string; price: number };
export type RecipeModifierOption = Modifier & { components: BillOfMaterialComponent[]; unavailable?: boolean; ingredientWarnings?: string[] };
export type RecipeModifierGroup = { id: string; name: string; minSelections: number; maxSelections: number; options: RecipeModifierOption[] };
export type MenuItem = {
  id: string;
  name: string;
  description: string;
  category: string;
  price: number;
  icon: string;
  color: string;
  available?: boolean;
  modifiers?: Modifier[];
  stockTracked?: boolean;
  stockOnHand?: number;
  stockUnit?: string;
  purchaseUnit?: string;
  baseUnitsPerPurchaseUnit?: number;
  lowStockThreshold?: number;
  ingredientOnly?: boolean;
  unitCost?: number;
  ingredientWarnings?: string[];
  recipeUnavailable?: boolean;
  modifierGroups?: Array<Omit<RecipeModifierGroup, "options"> & { options: Array<Modifier & { unavailable?: boolean; ingredientWarnings?: string[] }> }>;
};
export type BillOfMaterialComponent = { ingredientItemId: string; quantity: number };
export type BillOfMaterial = { menuItemId: string; components: BillOfMaterialComponent[]; modifierGroups?: RecipeModifierGroup[]; updatedAt: string };
export type RecipeSaleCostComponent = { ingredientItemId: string; ingredientName: string; unit: string; quantityPerItem: number; quantityUsed: number; unitCost: number; totalCost: number; sourceLabel?: string };
export type RecipeSaleCostLine = { menuItemId: string; menuItemName: string; quantity: number; grossSales: number; discountAllocated: number; netSales: number; recipeCosted: boolean; recipeUnitCost: number; recipeCost: number; ingredients: RecipeSaleCostComponent[] };
export type RecipeSaleCost = { transactionId: string; orderId: string; orderNumber: string; at: string; currency: CurrencyCode; totalRecipeCogs: number; lines: RecipeSaleCostLine[] };
export type OrderLine = {
  id: string;
  menuItemId: string;
  name: string;
  category: string;
  unitPrice: number;
  quantity: number;
  modifier?: Modifier;
  modifiers?: Modifier[];
  selectedModifierIds?: string[];
  note?: string;
};
export type PosOrder = {
  id: string;
  number: string;
  createdAt: string;
  updatedAt: string;
  items: OrderLine[];
  subtotal: number;
  discountPercent: number;
  discount: number;
  tax: number;
  total: number;
  paymentMethod: PaymentMethod;
  status: OrderStatus;
  cashierName?: string;
  customerName?: string;
  customerPhone?: string;
  couponCode?: string;
  promotionId?: string;
  offerDiscount?: number;
  loyaltyDiscount?: number;
  loyaltyAccountId?: string;
  loyaltyPointsEarned?: number;
  loyaltyPointsRedeemed?: number;
  giftCardId?: string;
  giftCardAmount?: number;
  qrisVerifiedAt?: string;
};
export type KitchenOrder = Pick<PosOrder, "id" | "number" | "createdAt" | "updatedAt" | "status"> & {
  items: Array<Pick<OrderLine, "id" | "name" | "quantity" | "note"> & {
    modifier?: Pick<Modifier, "id" | "label">;
    modifiers?: Array<Pick<Modifier, "id" | "label">>;
  }>;
};
export function projectKitchenOrder(order: PosOrder): KitchenOrder {
  return {
    id: order.id,
    number: order.number,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    status: order.status,
    items: order.items.map((item) => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      ...(item.modifier ? { modifier: { id: item.modifier.id, label: item.modifier.label } } : {}),
      ...(item.modifiers?.length ? { modifiers: item.modifiers.map(({ id, label }) => ({ id, label })) } : {}),
      ...(item.note ? { note: item.note } : {}),
    })),
  };
}
export type Transaction = {
  id: string;
  orderId: string;
  orderNumber: string;
  createdAt: string;
  items: OrderLine[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  paymentMethod: PaymentMethod;
  status: TransactionStatus;
  refundedAt?: string;
  voidedAt?: string;
  cashierName?: string;
  customerName?: string;
  customerPhone?: string;
  couponCode?: string;
  promotionId?: string;
  offerDiscount?: number;
  loyaltyDiscount?: number;
  loyaltyAccountId?: string;
  loyaltyPointsEarned?: number;
  loyaltyPointsRedeemed?: number;
  giftCardId?: string;
  giftCardAmount?: number;
  qrisVerifiedAt?: string;
  journalEntryId?: string;
  refundJournalEntryId?: string;
  voidJournalEntryId?: string;
};
export type BusinessSettings = {
  id: string;
  name: string;
  currency: CurrencyCode;
  taxRateBasisPoints: number;
  timezone: string;
  role: BusinessRole;
  memberId: string;
  memberName: string;
};
export type TeamMember = {
  id: string;
  openId: string;
  displayName: string | null;
  email: string | null;
  role: BusinessRole;
  status: "active" | "suspended";
  createdAt: string;
};
export type WorkspaceInvite = {
  id: string;
  role: BusinessRole;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};
export type JournalLine = { accountCode: string; accountName: string; debit: number; credit: number };
export type JournalEntry = { id: string; date: string; reference: string; description: string; lines: JournalLine[]; createdBy: string };
export type Invoice = {
  id: string;
  number: string;
  customerName: string;
  customerEmail?: string;
  issueDate: string;
  dueDate: string;
  lines: { description: string; quantity: number; unitPrice: number }[];
  subtotal: number;
  tax: number;
  total: number;
  status: "draft" | "open" | "paid" | "overdue" | "void";
  paidAt?: string;
  paymentMethod?: Exclude<PaymentMethod, "Gift Card">;
  qrisVerifiedAt?: string;
  createdAt: string;
  journalEntryId?: string;
  paymentJournalEntryId?: string;
  voidedAt?: string;
  voidJournalEntryId?: string;
};
export type VendorBill = {
  id: string;
  number: string;
  vendorName: string;
  description: string;
  category: "cogs" | "operating";
  billDate: string;
  dueDate: string;
  amount: number;
  status: "open" | "overdue" | "paid" | "void";
  paidAt?: string;
  paymentMethod?: Exclude<PaymentMethod, "Gift Card">;
  qrisVerifiedAt?: string;
  createdAt: string;
  journalEntryId?: string;
  paymentJournalEntryId?: string;
  voidedAt?: string;
  voidJournalEntryId?: string;
};
export type Promotion = {
  id: string;
  name: string;
  code?: string;
  discountType: "percent" | "fixed";
  value: number;
  ruleType?: "discount" | "bogo" | "bundle";
  buyItemId?: string;
  buyQuantity?: number;
  rewardItemId?: string;
  rewardQuantity?: number;
  bundleItems?: Array<{ menuItemId: string; quantity: number }>;
  bundlePrice?: number;
  dailyStartTime?: string;
  dailyEndTime?: string;
  weekdays?: number[];
  startsAt: string;
  endsAt: string;
  active: boolean;
  maxRedemptions?: number;
  redemptionCount: number;
  createdAt: string;
};
export type GiftCard = {
  id: string;
  lastFour: string;
  initialBalance: number;
  balance: number;
  status: "active" | "redeemed" | "void";
  issuedAt: string;
  customerName?: string;
};
export type LoyaltyAccount = {
  id: string;
  customerName: string;
  phone: string;
  pointsBalance: number;
  createdAt: string;
};
export type LoyaltySettings = { earnPerCurrencyStep: number; currencyStep: number; redemptionValuePerPoint: number };
export type PettyExpense = { id: string; number: string; businessDate: string; description: string; category: "supplies" | "utilities" | "staff" | "transport" | "other"; amount: number; paymentMethod: Exclude<PaymentMethod, "Gift Card">; createdAt: string; createdByOpenId: string; journalEntryId: string; requestFingerprint?: string; qrisVerifiedAt?: string };

export function getDefaultMenu(currency: CurrencyCode): MenuItem[] {
  const idr = currency === "IDR";
  return [
    { id: "espresso", name: "Espresso", description: "Double shot · house blend", category: "Coffee", price: idr ? 28000 : 2.25, icon: "coffee", color: "#EFE2CE", modifiers: [{ id: "extra-shot", label: "Extra shot", price: idr ? 8000 : 0.65 }, { id: "oat-milk", label: "Oat milk", price: idr ? 7000 : 0.5 }] },
    { id: "iced-latte", name: "Iced latte", description: "Espresso · cold milk", category: "Coffee", price: idr ? 38000 : 3.1, icon: "local-cafe", color: "#E8E9DC", modifiers: [{ id: "oat-milk", label: "Oat milk", price: idr ? 7000 : 0.5 }, { id: "extra-shot", label: "Extra shot", price: idr ? 8000 : 0.65 }] },
    { id: "matcha-cloud", name: "Matcha cloud", description: "Ceremonial matcha · vanilla", category: "Tea", price: idr ? 45000 : 3.7, icon: "emoji-food-beverage", color: "#E3EBDD", modifiers: [{ id: "oat-milk", label: "Oat milk", price: idr ? 7000 : 0.5 }] },
    { id: "citrus-fizz", name: "Citrus fizz", description: "Orange · lemon · sparkling", category: "Tea", price: idr ? 34000 : 2.8, icon: "local-drink", color: "#F4E4C8" },
    { id: "avocado-toast", name: "Avocado toast", description: "Sourdough · herbs · chili", category: "Food", price: idr ? 58000 : 4.8, icon: "bakery-dining", color: "#E8E8D9", modifiers: [{ id: "add-egg", label: "Add soft egg", price: idr ? 12000 : 1 }, { id: "extra-avocado", label: "Extra avocado", price: idr ? 15000 : 1.25 }] },
    { id: "breakfast-bowl", name: "Breakfast bowl", description: "Grains · greens · jammy egg", category: "Food", price: idr ? 64000 : 5.25, icon: "ramen-dining", color: "#E7E3D7", modifiers: [{ id: "extra-avocado", label: "Extra avocado", price: idr ? 15000 : 1.25 }] },
    { id: "tomato-soup", name: "Tomato soup", description: "Slow-roasted · basil oil", category: "Food", price: idr ? 48000 : 3.95, icon: "soup-kitchen", color: "#F1DECF" },
    { id: "butter-croissant", name: "Butter croissant", description: "Baked fresh this morning", category: "Bakery", price: idr ? 32000 : 2.6, icon: "bakery-dining", color: "#F2E4D0" },
  ];
}
