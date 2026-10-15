import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { formatMoney } from "@/shared/accounting";
import type { MenuItem, OrderLine, OrderStatus, PaymentMethod, PosOrder, Transaction } from "@/shared/pos";
import { getDefaultMenu } from "@/shared/pos";
import { useWorkspace } from "@/lib/workspace-context";

export type { BusinessRole, BusinessSettings, CurrencyCode, GiftCard, Invoice, JournalEntry, LoyaltyAccount, LoyaltySettings, MenuItem, Modifier, OrderLine, OrderStatus, PaymentMethod, PosOrder, Promotion, TeamMember, Transaction, TransactionStatus, VendorBill, WorkspaceInvite } from "@/shared/pos";
export { getDefaultMenu } from "@/shared/pos";
export const MENU: MenuItem[] = getDefaultMenu("IDR");
export const LEGACY_STORAGE_KEY = "till-table-pos:local:v1";
export type LegacyPosSnapshot = { orders: PosOrder[]; transactions: Transaction[] };
export async function readLegacyPosSnapshot(): Promise<LegacyPosSnapshot> {
  const raw = await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) return { orders: [], transactions: [] };
  try {
    const value = JSON.parse(raw) as LegacyPosSnapshot;
    return { orders: Array.isArray(value.orders) ? value.orders : [], transactions: Array.isArray(value.transactions) ? value.transactions : [] };
  } catch {
    return { orders: [], transactions: [] };
  }
}

export type CreateOrderInput = {
  lines: OrderLine[];
  paymentMethod: PaymentMethod;
  discountCode?: string;
  promotionId?: string;
  giftCardCode?: string;
  loyaltyAccountId?: string;
  loyaltyRedeemPoints?: number;
  customerName?: string;
  customerPhone?: string;
  qrisVerified?: boolean;
};
type PosContextValue = {
  menu: MenuItem[];
  orders: PosOrder[];
  transactions: Transaction[];
  activePromotions: import("@/shared/pos").Promotion[];
  isLoaded: boolean;
  error: string | null;
  currency: import("@/shared/pos").CurrencyCode;
  taxRateBasisPoints: number;
  money: (value: number) => string;
  createOrder: (requestId: string, input: CreateOrderInput) => Promise<PosOrder>;
  updateOrderStatus: (orderId: string, status: OrderStatus) => Promise<unknown>;
  refundTransaction: (transactionId: string) => Promise<unknown>;
  voidTransaction: (transactionId: string) => Promise<unknown>;
};
const PosContext = createContext<PosContextValue | null>(null);

export function PosProvider({ children }: { children: ReactNode }) {
  const { workspace } = useWorkspace();
  const enabled = Boolean(workspace?.id);
  const canUseRegister = workspace?.role === "manager" || workspace?.role === "cashier";
  const utils = trpc.useUtils();
  const menuQuery = trpc.pos.menu.useQuery(undefined, { enabled: enabled && canUseRegister, refetchInterval: 3_000, retry: 1 });
  const ordersQuery = trpc.pos.orders.useQuery(undefined, { enabled, refetchInterval: 3_000, retry: 1 });
  const transactionsQuery = trpc.pos.transactions.useQuery(undefined, { enabled: enabled && canUseRegister, refetchInterval: 3_000, retry: 1 });
  const promotionsQuery = trpc.programs.activePromotions.useQuery(undefined, { enabled: enabled && canUseRegister, refetchInterval: 3_000, retry: 1 });
  const createMutation = trpc.pos.createOrder.useMutation({ onSuccess: async () => { await Promise.all([utils.pos.menu.invalidate(), utils.pos.orders.invalidate(), utils.pos.transactions.invalidate(), utils.pos.inventory.invalidate(), utils.accounting.report.invalidate()]); } });
  const advanceMutation = trpc.pos.advanceOrder.useMutation({ onSuccess: () => utils.pos.orders.invalidate() });
  const refundMutation = trpc.pos.refund.useMutation({ onSuccess: async () => { await Promise.all([utils.pos.orders.invalidate(), utils.pos.transactions.invalidate(), utils.accounting.report.invalidate()]); } });
  const voidMutation = trpc.pos.voidSale.useMutation({ onSuccess: async () => { await Promise.all([utils.pos.orders.invalidate(), utils.pos.transactions.invalidate(), utils.accounting.report.invalidate()]); } });

  const createOrder = useCallback((requestId: string, input: CreateOrderInput) => createMutation.mutateAsync({
    requestId,
    lines: input.lines.map((line) => ({ id: line.id, menuItemId: line.menuItemId, quantity: line.quantity, modifierId: line.modifier?.id, modifierIds: line.selectedModifierIds, note: line.note })),
    paymentMethod: input.paymentMethod,
    discountCode: input.discountCode,
    promotionId: input.promotionId,
    giftCardCode: input.giftCardCode,
    loyaltyAccountId: input.loyaltyAccountId,
    loyaltyRedeemPoints: input.loyaltyRedeemPoints ?? 0,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    qrisVerified: input.qrisVerified ?? false,
  }), [createMutation]);
  const updateOrderStatus = useCallback((orderId: string, status: OrderStatus) => {
    if (status === "new" || status === "cancelled") return Promise.reject(new Error("Use a valid kitchen transition."));
    return advanceMutation.mutateAsync({ orderId, status });
  }, [advanceMutation]);
  const refundTransaction = useCallback((transactionId: string) => refundMutation.mutateAsync({ transactionId }), [refundMutation]);
  const voidTransaction = useCallback((transactionId: string) => voidMutation.mutateAsync({ transactionId }), [voidMutation]);

  const currency = workspace?.currency ?? "IDR";
  const error = enabled ? [menuQuery.error, ordersQuery.error, transactionsQuery.error].find(Boolean)?.message ?? null : null;
  const value = useMemo<PosContextValue>(() => ({
    menu: enabled && canUseRegister ? menuQuery.data ?? [] : [],
    orders: enabled ? ordersQuery.data ?? [] : [],
    transactions: enabled && canUseRegister ? transactionsQuery.data ?? [] : [],
    activePromotions: enabled && canUseRegister ? promotionsQuery.data ?? [] : [],
    isLoaded: !enabled || ordersQuery.isFetched && (!canUseRegister || menuQuery.isFetched && transactionsQuery.isFetched),
    error,
    currency,
    taxRateBasisPoints: workspace?.taxRateBasisPoints ?? 0,
    money: (amount) => formatMoney(amount, currency),
    createOrder,
    updateOrderStatus,
    refundTransaction,
    voidTransaction,
  }), [menuQuery.data, ordersQuery.data, transactionsQuery.data, promotionsQuery.data, menuQuery.isFetched, ordersQuery.isFetched, transactionsQuery.isFetched, enabled, canUseRegister, workspace?.taxRateBasisPoints, currency, error, createOrder, updateOrderStatus, refundTransaction, voidTransaction]);
  return <PosContext.Provider value={value}>{children}</PosContext.Provider>;
}

export function usePos() {
  const context = useContext(PosContext);
  if (!context) throw new Error("usePos must be used within PosProvider");
  return context;
}
