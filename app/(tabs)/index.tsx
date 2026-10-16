import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Redirect, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { Card, elapsedLabel, PageHeader, palette, Pill, PrimaryButton, SectionTitle, StatusPill, Wordmark } from "@/components/pos/ui";
import { type CreateOrderInput, type MenuItem, type Modifier, type OrderLine, type PaymentMethod, type PosOrder, usePos } from "@/lib/pos-store";
import { useWorkspace } from "@/lib/workspace-context";
import { trpc } from "@/lib/trpc";
import { calculateLoyaltyRedemption } from "@/shared/loyalty";
import { calculatePromotionDiscount } from "@/shared/promotions";
import { formatBusinessTimestamp } from "@/shared/accounting";

const categories = ["All", "Coffee", "Tea", "Food", "Bakery"];
const PENDING_CHECKOUT_PREFIX = "till-table-pos:pending-cloud-checkout:v2";
const EMPTY_CHECKOUT_ID = "00000000-0000-4000-8000-000000000000";
type ModalView = "item" | "cart" | "receipt" | null;
function modifierLines(line: OrderLine) { return line.modifiers?.length ? line.modifiers : line.modifier ? [line.modifier] : []; }
function modifierLabel(line: OrderLine) { return modifierLines(line).map((modifier) => modifier.label).join(", "); }
function lineSubtotal(line: OrderLine) { return (line.unitPrice + modifierLines(line).reduce((sum, modifier) => sum + modifier.price, 0)) * line.quantity; }
function makeCheckoutRequestId() { return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (value) => { const byte = Math.floor(Math.random() * 16); return (value === "x" ? byte : (byte & 3) | 8).toString(16); }); }
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parsePendingCheckout(value: string): { requestId: string; input: CreateOrderInput | null } | null {
  try {
    const snapshot = JSON.parse(value) as { requestId?: unknown; input?: unknown };
    if (typeof snapshot.requestId === "string" && uuidPattern.test(snapshot.requestId)) {
      const input = snapshot.input && typeof snapshot.input === "object" && Array.isArray((snapshot.input as { lines?: unknown }).lines) ? snapshot.input as CreateOrderInput : null;
      return { requestId: snapshot.requestId, input };
    }
  } catch { /* Version-one installs stored only the UUID string. */ }
  return uuidPattern.test(value) ? { requestId: value, input: null } : null;
}

export default function PosScreen() {
  const { workspace } = useWorkspace();
  if (!workspace) return <Redirect href="/workspace" />;
  return <PosScreenBody key={`${workspace.id}:${workspace.memberId}`} businessId={workspace.id} memberId={workspace.memberId} />;
}

function PosScreenBody({ businessId, memberId }: { businessId: string; memberId: string }) {
  const { menu, orders, transactions, createOrder, activePromotions, isLoaded, error, currency, taxRateBasisPoints, money } = usePos();
  const { workspace } = useWorkspace();
  const pendingCheckoutKey = `${PENDING_CHECKOUT_PREFIX}:${businessId}:${memberId}`;
  const router = useRouter();
  const [category, setCategory] = useState("All");
  const [cart, setCart] = useState<OrderLine[]>([]);
  const [discountCode, setDiscountCode] = useState("");
  const [promotionId, setPromotionId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("Cash");
  const [giftCardCode, setGiftCardCode] = useState("");
  const [qrisVerified, setQrisVerified] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [loyaltyAccountId, setLoyaltyAccountId] = useState("");
  const [loyaltyPointsBalance, setLoyaltyPointsBalance] = useState<number | null>(null);
  const [loyaltyRedeemPoints, setLoyaltyRedeemPoints] = useState("0");
  const [loyaltyNotice, setLoyaltyNotice] = useState("");
  const [checkoutError, setCheckoutError] = useState("");
  const [activeModal, setActiveModal] = useState<ModalView>(null);
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);
  const [selectedModifier, setSelectedModifier] = useState<Modifier | undefined>();
  const [selectedModifierIds, setSelectedModifierIds] = useState<string[]>([]);
  const [expandedModifierGroups, setExpandedModifierGroups] = useState<Record<string, boolean>>({});
  const [itemQuantity, setItemQuantity] = useState(1);
  const [itemNote, setItemNote] = useState("");
  const [lastOrder, setLastOrder] = useState<PosOrder | null>(null);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [pendingCheckoutId, setPendingCheckoutId] = useState<string | null>(null);
  const [pendingCheckoutInput, setPendingCheckoutInput] = useState<CreateOrderInput | null>(null);
  const [pendingStorageReady, setPendingStorageReady] = useState(false);
  const loyaltySettingsQuery = trpc.programs.getLoyaltySettings.useQuery(undefined, { enabled: Boolean(workspace && workspace.role !== "kitchen"), staleTime: 30_000 });
  const loyaltyQuery = trpc.programs.findLoyaltyCustomer.useQuery({ phone: customerPhone }, { enabled: false, retry: false });
  const createLoyalty = trpc.programs.createLoyaltyCustomer.useMutation();
  const pendingCheckoutQuery = trpc.pos.checkoutStatus.useQuery({ requestId: pendingCheckoutId ?? EMPTY_CHECKOUT_ID }, { enabled: pendingStorageReady && Boolean(pendingCheckoutId) && !saving, retry: false, refetchInterval: pendingCheckoutId && !saving ? 3_000 : false });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const recoveredOrder = useMemo(() => pendingCheckoutQuery.data?.status === "complete" ? pendingCheckoutQuery.data.order : null, [pendingCheckoutQuery.data]);
  const filteredMenu = category === "All" ? menu : menu.filter((item) => item.category === category);
  const selectedOffer = useMemo(() => promotionId ? activePromotions.find((offer) => offer.id === promotionId) : discountCode ? activePromotions.find((offer) => offer.code?.toUpperCase() === discountCode.trim().toUpperCase()) : undefined, [activePromotions, promotionId, discountCode]);
  const subtotal = cart.reduce((sum, line) => sum + lineSubtotal(line), 0);
  const offerDiscount = selectedOffer ? calculatePromotionDiscount(selectedOffer, cart.map((line) => ({ menuItemId: line.menuItemId, quantity: line.quantity, unitPrice: line.unitPrice })), subtotal, currency) : 0;
  const pointValue = loyaltySettingsQuery.data?.redemptionValuePerPoint ?? (currency === "IDR" ? 100 : 0.01);
  const requestedPoints = Math.max(0, Math.floor(Number(loyaltyRedeemPoints) || 0));
  const loyaltyRedemption = calculateLoyaltyRedemption(requestedPoints, subtotal - offerDiscount, pointValue, currency);
  const loyaltyDiscount = loyaltyRedemption?.discount ?? 0;
  const redemptionInvalid = requestedPoints > 0 && (!loyaltyAccountId || !loyaltyRedemption);
  const discount = Math.min(subtotal, offerDiscount + loyaltyDiscount);
  const tax = Math.round((subtotal - discount) * (taxRateBasisPoints / 10_000) * (currency === "IDR" ? 1 : 100)) / (currency === "IDR" ? 1 : 100);
  const total = subtotal - discount + tax;
  const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const latestTickets = orders.filter((order) => order.status !== "cancelled").slice(0, 2);
  const selectedGroupedModifiers = (selectedItem?.modifierGroups ?? []).flatMap((group) => group.options.filter((option) => selectedModifierIds.includes(option.id)).map((option) => ({ id: option.id, label: option.label, price: option.price })));
  const selectedModifierTotal = (selectedModifier?.price ?? 0) + selectedGroupedModifiers.reduce((sum, modifier) => sum + modifier.price, 0);

  function remainingStock(item: MenuItem) {
    if (item.stockTracked !== true) return Number.POSITIVE_INFINITY;
    const alreadyInCart = cart.filter((line) => line.menuItemId === item.id).reduce((sum, line) => sum + line.quantity, 0);
    return Math.max(0, Math.floor(Number(item.stockOnHand ?? 0)) - alreadyInCart);
  }
  function openItem(item: MenuItem) {
    if (item.recipeUnavailable) { setCheckoutError(`${item.name} cannot be prepared with current ingredient stock. Ask a manager to review the BOM or receive stock.`); return; }
    const remaining = remainingStock(item);
    if (remaining <= 0) { setCheckoutError(`${item.name} is out of stock. Refresh the register after stock is received.`); return; }
    setCheckoutError(""); setSelectedItem(item); setSelectedModifier(undefined); setSelectedModifierIds([]); setExpandedModifierGroups({}); setItemQuantity(1); setItemNote(""); setActiveModal("item");
  }
  function toggleModifier(groupId: string, optionId: string, maximum: number) {
    const group = selectedItem?.modifierGroups?.find((candidate) => candidate.id === groupId);
    const option = group?.options.find((candidate) => candidate.id === optionId);
    if (!group || !option || option.unavailable) return;
    setSelectedModifierIds((current) => {
      const selectedInGroup = current.filter((id) => group.options.some((candidate) => candidate.id === id));
      if (selectedInGroup.includes(optionId)) return current.filter((id) => id !== optionId);
      const withoutGroup = current.filter((id) => !group.options.some((candidate) => candidate.id === id));
      const nextInGroup = maximum === 1 ? [optionId] : selectedInGroup.length < maximum ? [...selectedInGroup, optionId] : selectedInGroup;
      return [...withoutGroup, ...nextInGroup];
    });
  }
  function addSelectedItem() {
    if (!selectedItem) return;
    const selectionError = (selectedItem.modifierGroups ?? []).find((group) => {
      const count = selectedModifierIds.filter((id) => group.options.some((option) => option.id === id)).length;
      return count < group.minSelections || count > group.maxSelections;
    });
    if (selectionError) { setCheckoutError(`Choose ${selectionError.minSelections === selectionError.maxSelections ? `exactly ${selectionError.minSelections}` : `at least ${selectionError.minSelections}`} option(s) in ${selectionError.name}.`); return; }
    const remaining = remainingStock(selectedItem);
    const stockLimited = selectedItem.stockTracked === true && itemQuantity > remaining;
    const quantity = stockLimited ? remaining : itemQuantity;
    if (quantity <= 0) { setCheckoutError(`${selectedItem.name} is out of stock. Refresh the register after stock is received.`); return; }
    const groupedModifiers = (selectedItem.modifierGroups ?? []).flatMap((group) => group.options.filter((option) => selectedModifierIds.includes(option.id)).map((option) => ({ id: option.id, label: option.label, price: option.price })));
    const selectedModifiers = [...(selectedModifier ? [selectedModifier] : []), ...groupedModifiers];
    const line: OrderLine = { id: `${selectedItem.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, menuItemId: selectedItem.id, name: selectedItem.name, category: selectedItem.category, unitPrice: selectedItem.price, quantity, modifier: selectedModifier, modifiers: selectedModifiers.length ? selectedModifiers : undefined, selectedModifierIds, note: itemNote.trim() || undefined };
    setCart((current) => [...current, line]); setCheckoutError(stockLimited ? `Only ${quantity} ${selectedItem.stockUnit ?? "unit"} of ${selectedItem.name} remain, so the ticket quantity was capped.` : ""); setActiveModal("cart");
  }
  function changeQuantity(lineId: string, amount: number) {
    const line = cart.find((item) => item.id === lineId);
    if (!line) return;
    const nextQuantity = line.quantity + amount;
    const item = menu.find((candidate) => candidate.id === line.menuItemId);
    if (nextQuantity > line.quantity && item?.stockTracked === true) {
      const otherUnits = cart.filter((candidate) => candidate.menuItemId === item.id && candidate.id !== lineId).reduce((sum, candidate) => sum + candidate.quantity, 0);
      if (nextQuantity + otherUnits > Number(item.stockOnHand ?? 0)) { setCheckoutError(`Only ${Math.max(0, Number(item.stockOnHand ?? 0) - otherUnits)} ${item.stockUnit ?? "unit"} of ${item.name} are available.`); return; }
    }
    setCart((current) => current.map((candidate) => candidate.id === lineId ? { ...candidate, quantity: candidate.quantity + amount } : candidate).filter((candidate) => candidate.quantity > 0));
    setCheckoutError("");
  }
  function resetTicket() { setCart([]); setDiscountCode(""); setPromotionId(""); setPaymentMethod("Cash"); setGiftCardCode(""); setQrisVerified(false); setCustomerName(""); setCustomerPhone(""); setLoyaltyAccountId(""); setLoyaltyPointsBalance(null); setLoyaltyRedeemPoints("0"); setLoyaltyNotice(""); }
  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(pendingCheckoutKey).then((value) => {
      if (!active || !value) return;
      const snapshot = parsePendingCheckout(value);
      if (snapshot) { setPendingCheckoutId(snapshot.requestId); setPendingCheckoutInput(snapshot.input); }
      else { setPendingCheckoutId(EMPTY_CHECKOUT_ID); setCheckoutError("A saved checkout could not be read. Keep the register locked and reconcile its status before taking another payment."); }
    }).catch(() => { if (active) { setPendingCheckoutId(EMPTY_CHECKOUT_ID); setCheckoutError("Could not read the saved checkout state. Keep the register locked and reconcile it before taking another payment."); } }).finally(() => { if (active) setPendingStorageReady(true); });
    return () => { active = false; };
  }, [pendingCheckoutKey]);
  useEffect(() => {
    if (!pendingCheckoutId || !recoveredOrder) return;
    let active = true;
    void AsyncStorage.removeItem(pendingCheckoutKey).catch(() => undefined).then(() => {
      if (!active) return;
      setLastOrder(recoveredOrder); resetTicket(); setActiveModal("receipt"); setCheckoutError(""); setPendingCheckoutId(null); setPendingCheckoutInput(null);
    });
    return () => { active = false; };
  }, [pendingCheckoutId, pendingCheckoutKey, recoveredOrder]);
  useEffect(() => {
    if (!pendingCheckoutId || saving || pendingCheckoutQuery.data?.status !== "failed") return;
    let active = true;
    void AsyncStorage.removeItem(pendingCheckoutKey).catch(() => undefined).then(() => {
      if (!active) return;
      setPendingCheckoutId(null); setPendingCheckoutInput(null); setCheckoutError("The register confirmed no sale was posted. Review the ticket before trying again.");
    });
    return () => { active = false; };
  }, [pendingCheckoutId, pendingCheckoutKey, saving, pendingCheckoutQuery.data?.status]);
  async function resumePendingCheckout() {
    if (!pendingCheckoutId || !pendingCheckoutInput || saving) return;
    setSaving(true); setCheckoutError("");
    try {
      const order = await createOrder(pendingCheckoutId, pendingCheckoutInput);
      await AsyncStorage.removeItem(pendingCheckoutKey);
      setPendingCheckoutId(null); setPendingCheckoutInput(null); setLastOrder(order); resetTicket(); setActiveModal("receipt");
    } catch (err) {
      setCheckoutError(`${err instanceof Error ? err.message : "The cloud could not confirm this ticket."} The saved ticket remains locked; resume it with the same request ID.`);
      void pendingCheckoutQuery.refetch();
    } finally { setSaving(false); }
  }
  async function finishSale() {
    if (!cart.length || !pendingStorageReady || pendingCheckoutId) return;
    setSaving(true); setCheckoutError("");
    try {
      const requestId = makeCheckoutRequestId();
      const input: CreateOrderInput = { lines: cart, paymentMethod, discountCode: discountCode.trim() || undefined, promotionId: promotionId || undefined, giftCardCode: giftCardCode.trim() || undefined, loyaltyAccountId: loyaltyAccountId || undefined, loyaltyRedeemPoints: requestedPoints, customerName: customerName.trim() || undefined, customerPhone: customerPhone.trim() || undefined, qrisVerified };
      await AsyncStorage.setItem(pendingCheckoutKey, JSON.stringify({ requestId, input }));
      setPendingCheckoutId(requestId);
      setPendingCheckoutInput(input);
      const order = await createOrder(requestId, input);
      await AsyncStorage.removeItem(pendingCheckoutKey);
      setPendingCheckoutId(null);
      setPendingCheckoutInput(null);
      setLastOrder(order); resetTicket(); setActiveModal("receipt");
    } catch (err) { setCheckoutError(`${err instanceof Error ? err.message : "The cloud could not confirm this sale."} The ticket is locked until its saved request is safely resolved.`); }
    finally { setSaving(false); }
  }
  async function shareReceipt(order: PosOrder) {
    const rows = order.items.map((line) => `• ${line.quantity} × ${line.name}${modifierLabel(line) ? ` (${modifierLabel(line)})` : ""} — ${money(lineSubtotal(line))}`).join("\n");
    const message = `TILL & TABLE\n${workspace?.name ?? "Workspace"}\nOrder ${order.number} · ${formatBusinessTimestamp(order.createdAt, workspace?.timezone ?? "Asia/Jakarta")}\n\n${rows}\n\nSubtotal ${money(order.subtotal)}\nDiscount −${money(order.discount)}\nTax ${money(order.tax)}\nTOTAL ${money(order.total)}\nPaid by ${order.paymentMethod}`;
    try { await Share.share({ message, title: `Receipt ${order.number}` }); } catch { /* Keep the digital receipt open. */ }
  }
  async function lookupCustomer() {
    setLoyaltyNotice("");
    if (!customerPhone.trim()) { setLoyaltyNotice("Enter a phone number to find or create a loyalty account."); return; }
    const result = await loyaltyQuery.refetch();
    if (result.data) { setLoyaltyAccountId(result.data.id); setLoyaltyPointsBalance(result.data.pointsBalance); setCustomerName(String(result.data.customerName ?? customerName)); setLoyaltyNotice(`${result.data.pointsBalance} points available.`); }
    else { setLoyaltyNotice("No account found. Enter a customer name to enroll them."); setLoyaltyAccountId(""); setLoyaltyPointsBalance(null); }
  }
  async function enrollCustomer() {
    if (!customerName.trim() || !customerPhone.trim()) { setLoyaltyNotice("Enter both a customer name and phone number."); return; }
    try { const account = await createLoyalty.mutateAsync({ customerName: customerName.trim(), phone: customerPhone.trim() }); setLoyaltyAccountId(account.id); setLoyaltyPointsBalance(account.pointsBalance); setLoyaltyNotice(`${account.existed ? "Existing account found" : "Loyalty account created"} · ${account.pointsBalance} points.`); }
    catch (err) { setLoyaltyNotice(err instanceof Error ? err.message : "Couldn’t create the loyalty account."); }
  }

  if (workspace?.role === "kitchen") return <Redirect href="/(tabs)/kitchen" />;

  return (
    <ScreenContainer containerClassName="bg-background" safeAreaClassName="bg-background">
      <View style={styles.page}>
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <View style={styles.topRow}><Wordmark /><View style={styles.syncBadge}><View style={styles.onlineDot} /><Text style={styles.shiftText}>CLOUD REGISTER</Text></View></View>
          <PageHeader eyebrow={`${workspace?.name ?? "Business"} · cashier`} title="Build a ticket" subtitle="Tap an item, customize it, then send the shared order to the kitchen." right={<View style={styles.salesBadge}><Text style={styles.salesBadgeValue}>{transactions.length}</Text><Text style={styles.salesBadgeLabel}>SALES</Text></View>} />
          {error ? <View style={styles.errorBanner}><MaterialIcons name="cloud-off" size={16} color={palette.coral} /><Text style={styles.errorText}>{error}</Text></View> : null}
          <View style={styles.menuHeader}><SectionTitle title="Menu" /><Text style={styles.menuHint}>{isLoaded ? "Tap to customize" : "Loading shared menu…"}</Text></View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryList}>{categories.map((value) => <Pill key={value} label={value} selected={category === value} onPress={() => setCategory(value)} />)}</ScrollView>
          {menu.length === 0 && isLoaded ? <Card style={styles.emptyMenu}><MaterialIcons name="cloud-off" size={22} color={palette.coral} /><Text style={styles.emptyMenuText}>The shared menu is unavailable. Check the connection before taking payment.</Text></Card> : null}
          <View style={styles.menuGrid}>
            {filteredMenu.map((item) => {
              const remaining = remainingStock(item);
              const outOfStock = item.stockTracked === true && remaining <= 0 || Boolean(item.recipeUnavailable);
              const lowStock = !outOfStock && (item.stockTracked === true && remaining <= Number(item.lowStockThreshold ?? 0) || Boolean(item.ingredientWarnings?.length));
              const minimumLabel = Number(item.lowStockThreshold ?? 0);
              const stockLabel = item.recipeUnavailable ? "INGREDIENT OUT" : item.stockTracked === true ? outOfStock ? "OUT OF STOCK" : lowStock ? `LOW · ${remaining} left · min ${minimumLabel}` : `${remaining} ${item.stockUnit ?? "unit"} left` : item.category;
              return <Pressable key={item.id} disabled={!isLoaded || outOfStock} onPress={() => openItem(item)} style={({ pressed }) => [styles.menuCard, pressed && styles.pressed, (!isLoaded || outOfStock) && { opacity: 0.62 }]}>
                <View style={[styles.menuIconWrap, { backgroundColor: item.color }]}><MaterialIcons name={item.icon as never} size={24} color={palette.evergreen} /><View style={styles.addIcon}><MaterialIcons name={outOfStock ? "remove" : "add"} size={15} color={palette.white} /></View></View>
                <Text style={styles.menuName} numberOfLines={1}>{item.name}</Text>
                <Text style={styles.menuDesc} numberOfLines={2}>{item.description}</Text>
                <View style={styles.menuBottom}><Text style={styles.menuPrice}>{money(item.price)}</Text><Text style={[styles.menuCategory, (outOfStock || lowStock) && { color: palette.coral }]}>{stockLabel}</Text></View>
                {item.ingredientWarnings?.length ? <Text style={[styles.menuCategory, { color: palette.coral, marginTop: 4 }]} numberOfLines={1}>INGREDIENT LOW · {item.ingredientWarnings.join(", ")}</Text> : null}
              </Pressable>;
            })}
          </View>
          <SectionTitle title="Kitchen watch" action="Open kitchen" onAction={() => router.push("/(tabs)/kitchen")} />
          {latestTickets.length ? <View style={styles.watchList}>{latestTickets.map((order) => <CashierKitchenWatch key={order.id} order={order} now={now} />)}</View> : <Card style={styles.watchEmpty}><MaterialIcons name="soup-kitchen" size={19} color={palette.evergreen} /><Text style={styles.watchEmptyText}>Your shared ticket status appears here after checkout.</Text></Card>}
        </ScrollView>
        <View style={styles.cartDock}><Pressable style={styles.cartSummary} onPress={() => setActiveModal("cart")}><View style={styles.cartIcon}><MaterialIcons name="receipt-long" size={20} color={palette.white} /><View style={styles.cartCount}><Text style={styles.cartCountText}>{itemCount}</Text></View></View><View style={{ flex: 1 }}><Text style={styles.cartLabel}>{itemCount ? `${itemCount} ${itemCount === 1 ? "item" : "items"} in ticket` : "Start a new ticket"}</Text><Text style={styles.cartSub}>{itemCount ? `${money(subtotal)} before discount & tax` : "Choose something from the shared menu"}</Text></View><View style={styles.cartTotal}><Text style={styles.cartTotalLabel}>TOTAL</Text><Text style={styles.cartTotalValue}>{money(total)}</Text></View><MaterialIcons name="chevron-right" size={22} color={palette.evergreen} /></Pressable><PrimaryButton label={itemCount ? "Review & pay" : "View ticket"} icon="arrow-forward" onPress={() => setActiveModal("cart")} disabled={itemCount === 0 || !isLoaded} /></View>
      </View>

      <Modal visible={activeModal !== null || Boolean(pendingCheckoutId)} transparent animationType="slide" onRequestClose={() => { if (!pendingCheckoutId) setActiveModal(null); }}>
        <View style={styles.modalBackdrop}><Pressable style={StyleSheet.absoluteFill} onPress={() => { if (!pendingCheckoutId) setActiveModal(null); }} /><View style={styles.sheet}><View style={styles.sheetHandle} />
          {activeModal === "item" && selectedItem ? <ScrollView showsVerticalScrollIndicator={false}>
            <View style={styles.sheetHeadingRow}><View style={[styles.itemModalIcon, { backgroundColor: selectedItem.color }]}><MaterialIcons name={selectedItem.icon as never} size={27} color={palette.evergreen} /></View><Pressable onPress={() => setActiveModal(null)} style={styles.closeButton}><MaterialIcons name="close" size={20} color={palette.muted} /></Pressable></View>
            <Text style={styles.sheetTitle}>{selectedItem.name}</Text><Text style={styles.sheetSubtitle}>{selectedItem.description}</Text><Text style={styles.itemModalPrice}>{money(selectedItem.price)}</Text>
            {selectedItem.ingredientWarnings?.length ? <View style={extensionStyles.ingredientWarningBox}><MaterialIcons name="warning-amber" size={15} color={palette.coral} /><Text style={extensionStyles.ingredientWarningText}>LOW INGREDIENT · {selectedItem.ingredientWarnings.join(", ")}</Text></View> : null}
            {selectedItem.modifiers?.length ? <><Text style={styles.fieldLabel}>LEGACY EXTRAS · OPTIONAL</Text><View style={styles.modifierList}>{selectedItem.modifiers.map((modifier) => { const active = selectedModifier?.id === modifier.id; return <Pressable key={modifier.id} onPress={() => setSelectedModifier(active ? undefined : modifier)} style={[styles.modifierRow, active && styles.modifierRowActive]}><View style={[styles.radio, active && styles.radioActive]}>{active ? <View style={styles.radioDot} /> : null}</View><Text style={styles.modifierName}>{modifier.label}</Text><Text style={styles.modifierPrice}>+{money(modifier.price)}</Text></Pressable>; })}</View></> : null}
            {selectedItem.modifierGroups?.map((group) => {
              const selectedCount = selectedModifierIds.filter((id) => group.options.some((option) => option.id === id)).length;
              const expanded = expandedModifierGroups[group.id] ?? group.minSelections > 0;
              const requirement = group.minSelections > 0 ? `Required · ${group.minSelections}–${group.maxSelections}` : `Optional · up to ${group.maxSelections}`;
              return <View key={group.id} style={extensionStyles.modifierGroup}>
                <Pressable onPress={() => setExpandedModifierGroups((current) => ({ ...current, [group.id]: !expanded }))} style={extensionStyles.modifierGroupHeader} accessibilityRole="button" accessibilityState={{ expanded }}>
                  <View style={{ flex: 1 }}><Text style={extensionStyles.modifierGroupName}>{group.name}</Text><Text style={extensionStyles.modifierGroupMeta}>{requirement} · {selectedCount} selected</Text></View><MaterialIcons name={expanded ? "expand-less" : "expand-more"} size={22} color={palette.evergreen} />
                </Pressable>
                {expanded ? <View style={extensionStyles.modifierOptions}>{group.options.map((option) => {
                  const active = selectedModifierIds.includes(option.id);
                  return <Pressable key={option.id} disabled={option.unavailable} onPress={() => toggleModifier(group.id, option.id, group.maxSelections)} style={[extensionStyles.modifierOptionRow, active && extensionStyles.modifierOptionRowActive, option.unavailable && extensionStyles.modifierOptionDisabled]}>
                    <View style={[styles.checkbox, active && styles.checkboxActive]}>{active ? <MaterialIcons name="check" size={13} color={palette.white} /> : null}</View><View style={{ flex: 1 }}><Text style={styles.modifierName}>{option.label}{option.unavailable ? " · OUT OF STOCK" : ""}</Text>{option.ingredientWarnings?.length ? <Text style={extensionStyles.modifierOptionWarning}>LOW · {option.ingredientWarnings.join(", ")}</Text> : null}</View><Text style={styles.modifierPrice}>+{money(option.price)}</Text>
                  </Pressable>;
                })}</View> : null}
              </View>;
            })}
            <Text style={styles.fieldLabel}>KITCHEN NOTE · OPTIONAL</Text><TextInput value={itemNote} onChangeText={setItemNote} placeholder="e.g. no chili, serve separately…" placeholderTextColor="#9AA49D" style={styles.noteInput} multiline maxLength={120} />
            <View style={styles.quantityRow}><Text style={styles.fieldLabel}>QUANTITY</Text><QuantityControl quantity={itemQuantity} setQuantity={setItemQuantity} /></View>
            <PrimaryButton label={`Add to ticket · ${money((selectedItem.price + selectedModifierTotal) * itemQuantity)}`} icon="add" onPress={addSelectedItem} />
          </ScrollView> : null}
          {pendingCheckoutId ? <View style={{ padding: 18, gap: 12, backgroundColor: palette.surface, borderColor: palette.line, borderWidth: 1, borderRadius: 18, marginTop: 8 }}><View style={{ flexDirection: "row", alignItems: "center", gap: 9 }}><MaterialIcons name="sync" size={21} color={palette.evergreen} /><Text style={{ flex: 1, color: palette.ink, fontSize: 15, fontWeight: "900" }}>Checkout needs confirmation</Text></View><Text style={{ color: palette.muted, fontSize: 12, lineHeight: 18 }}>{pendingCheckoutQuery.data?.status === "missing" ? "The cloud has not reported this request yet; the first request may still be arriving. Keep this ticket unchanged—never start a new sale." : pendingCheckoutQuery.error ? "We can’t confirm yet. Keep this ticket unchanged and retry the status check before taking another payment." : "The cashier is checking whether this ticket reached the shared register. Please don’t submit it a second time."}</Text>{checkoutError ? <Text style={styles.errorText}>{checkoutError}</Text> : null}<PrimaryButton label={saving ? "Resuming checkout…" : pendingCheckoutInput ? "Safely resume this exact ticket" : pendingCheckoutQuery.isFetching ? "Checking…" : "Check checkout status"} icon={pendingCheckoutInput ? "sync" : "refresh"} tone="light" loading={saving || pendingCheckoutQuery.isFetching && !pendingCheckoutInput} disabled={saving || pendingCheckoutQuery.isFetching && !pendingCheckoutInput} onPress={pendingCheckoutInput ? () => void resumePendingCheckout() : () => void pendingCheckoutQuery.refetch()} /></View> : null}
          {activeModal === "cart" && !pendingCheckoutId ? <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled"><View style={styles.sheetTitleRow}><View><Text style={styles.sheetTitle}>Your ticket</Text><Text style={styles.sheetSubtitle}>{itemCount} {itemCount === 1 ? "item" : "items"} · shared cloud checkout</Text></View><Pressable onPress={() => setActiveModal(null)} style={styles.closeButton}><MaterialIcons name="close" size={20} color={palette.muted} /></Pressable></View>{cart.length === 0 ? <View style={styles.emptyCart}><MaterialIcons name="receipt-long" size={27} color={palette.muted} /><Text style={styles.emptyCartText}>Your ticket is waiting for its first item.</Text></View> : <View style={styles.cartItems}>{cart.map((line) => <View key={line.id} style={styles.cartLine}><View style={{ flex: 1 }}><Text style={styles.cartLineName}>{line.name}{modifierLabel(line) ? ` · ${modifierLabel(line)}` : ""}</Text>{line.note ? <Text style={styles.cartLineNote}>{line.note}</Text> : null}<Text style={styles.cartLinePrice}>{money(lineSubtotal(line))}</Text></View><QuantityControl quantity={line.quantity} setQuantity={(next) => changeQuantity(line.id, next - line.quantity)} /></View>)}</View>}
            <Text style={styles.fieldLabel}>ACTIVE OFFER OR COUPON</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.offerList}>{activePromotions.map((offer) => <Pill key={offer.id} label={offer.code || `${offer.name} · ${offer.discountType === "percent" ? `${offer.value}%` : money(offer.value)}`} selected={promotionId === offer.id || (offer.code ? discountCode.toUpperCase() === offer.code.toUpperCase() : false)} onPress={() => { if (offer.code) { setDiscountCode(offer.code); setPromotionId(""); } else { setPromotionId(offer.id); setDiscountCode(""); } }} />)}</ScrollView><TextInput value={discountCode} onChangeText={(value) => { setDiscountCode(value.toUpperCase()); setPromotionId(""); }} placeholder="Coupon code" autoCapitalize="characters" style={styles.noteInput} maxLength={40} />
            <Text style={styles.fieldLabel}>CUSTOMER · OPTIONAL</Text>
            <View style={styles.customerRow}><TextInput value={customerPhone} onChangeText={(value) => { setCustomerPhone(value); setCustomerName(""); setLoyaltyAccountId(""); setLoyaltyPointsBalance(null); }} placeholder="Phone number" keyboardType="phone-pad" style={[styles.noteInput, { flex: 1 }]} /><Pressable onPress={() => void lookupCustomer()} style={styles.lookupButton} accessibilityRole="button"><MaterialIcons name="person-search" size={16} color={palette.evergreen} /><Text style={styles.lookupLabel}>Find</Text></Pressable></View>
            {loyaltyAccountId ? <View style={extensionStyles.linkedCustomer}><View style={extensionStyles.memberIcon}><MaterialIcons name="verified-user" size={17} color={palette.evergreen} /></View><View style={{ flex: 1 }}><Text style={extensionStyles.linkedCustomerName}>{customerName || "Loyalty member"}</Text><Text style={styles.hint}>{loyaltyPointsBalance ?? 0} points · earns after successful payment</Text></View><Pressable onPress={() => { setLoyaltyAccountId(""); setLoyaltyPointsBalance(null); setCustomerPhone(""); setCustomerName(""); setLoyaltyRedeemPoints("0"); setLoyaltyNotice(""); }} accessibilityRole="button"><Text style={extensionStyles.removeMember}>Remove</Text></Pressable></View> : <><TextInput value={customerName} onChangeText={setCustomerName} placeholder="Customer name (for receipt or new member)" style={styles.noteInput} />{customerName.trim() && customerPhone.trim() ? <Pressable onPress={() => void enrollCustomer()} style={styles.enrollButton}><MaterialIcons name="card-membership" size={15} color={palette.evergreen} /><Text style={styles.lookupLabel}>{createLoyalty.isPending ? "Saving customer…" : "Attach customer & earn points"}</Text></Pressable> : null}</>}
            {loyaltyNotice ? <Text style={styles.hint}>{loyaltyNotice}</Text> : null}<View style={styles.loyaltyRow}><TextInput value={loyaltyRedeemPoints} onChangeText={setLoyaltyRedeemPoints} placeholder="Redeem points" keyboardType="number-pad" editable={Boolean(loyaltyAccountId)} style={[styles.noteInput, { flex: 1, opacity: loyaltyAccountId ? 1 : 0.55 }]} /><Text style={styles.hint}>{loyaltyAccountId ? `Balance: ${loyaltyPointsBalance ?? 0}` : "Find or attach a member to redeem"}</Text></View>{redemptionInvalid ? <Text style={styles.errorText}>{!loyaltyAccountId ? "Find or attach a loyalty account before redeeming points." : "That redemption exceeds the remaining ticket amount; reduce the points."}</Text> : null}
            <Text style={[styles.fieldLabel, { marginTop: 13 }]}>PAYMENT METHOD</Text><View style={styles.discountRow}>{(["Cash", "Card", "QRIS", "Other", "Gift Card"] as const).map((method) => <Pill key={method} label={method} selected={paymentMethod === method} onPress={() => { setPaymentMethod(method); setQrisVerified(false); }} />)}</View>{paymentMethod === "Gift Card" ? <TextInput value={giftCardCode} onChangeText={(value) => setGiftCardCode(value.toUpperCase())} placeholder="Enter gift card code" autoCapitalize="characters" style={styles.noteInput} /> : null}{paymentMethod === "QRIS" ? <Pressable onPress={() => setQrisVerified(!qrisVerified)} style={styles.qrisConfirm}><View style={[styles.checkbox, qrisVerified && styles.checkboxActive]}>{qrisVerified ? <MaterialIcons name="check" size={14} color={palette.white} /> : null}</View><Text style={styles.qrisText}>I checked the merchant app and confirm this QRIS payment is received.</Text></Pressable> : null}
            <Card style={styles.totalCard}><TotalsRow label="Subtotal" value={subtotal} money={money} /><TotalsRow label="Offer & points" value={-discount} money={money} /><TotalsRow label={`Tax · ${(taxRateBasisPoints / 100).toFixed(2)}%`} value={tax} money={money} emphasized /><View style={styles.totalDivider} /><TotalsRow label="Total due" value={total} money={money} emphasized /></Card>{checkoutError ? <Text style={styles.errorText}>{checkoutError}</Text> : null}{paymentMethod === "QRIS" ? <Text style={styles.warning}>QRIS is manual only. This app does not generate a QR or verify the transfer.</Text> : null}<View style={{ height: 10 }} /><PrimaryButton label={saving ? "Saving to cloud…" : `Complete sale · ${money(total)}`} icon="check-circle" onPress={() => void finishSale()} disabled={!cart.length || saving || redemptionInvalid || paymentMethod === "QRIS" && !qrisVerified} loading={saving} /><Text style={styles.checkoutNote}>The sale, kitchen ticket and ledger entry are saved together to your workspace.</Text></ScrollView> : null}
          {activeModal === "receipt" && lastOrder ? <ScrollView showsVerticalScrollIndicator={false}><View style={styles.receiptHeader}><View style={styles.receiptMark}><MaterialIcons name="check" size={22} color={palette.white} /></View><Pressable onPress={() => setActiveModal(null)} style={styles.closeButton}><MaterialIcons name="close" size={20} color={palette.muted} /></Pressable></View><Text style={styles.sheetTitle}>Ticket sent</Text><Text style={styles.sheetSubtitle}>{lastOrder.number} · shared with your kitchen</Text><Card style={styles.totalCard}><Text style={styles.receiptItems}>{lastOrder.items.map((line) => `${line.quantity} × ${line.name}${modifierLabel(line) ? ` · ${modifierLabel(line)}` : ""}`).join("\n")}</Text><View style={styles.totalDivider} /><TotalsRow label="Subtotal" value={lastOrder.subtotal} money={money} /><TotalsRow label="Discount" value={-lastOrder.discount} money={money} /><TotalsRow label="Tax" value={lastOrder.tax} money={money} /><TotalsRow label={`Paid · ${lastOrder.paymentMethod}`} value={lastOrder.total} money={money} emphasized /></Card><StatusPill status={lastOrder.status} /><View style={{ height: 12 }} /><PrimaryButton label="Share digital receipt" icon="share" tone="light" onPress={() => void shareReceipt(lastOrder)} /><View style={{ height: 8 }} /><PrimaryButton label="New ticket" icon="add" onPress={() => setActiveModal(null)} /></ScrollView> : null}
        </View></View>
      </Modal>
    </ScreenContainer>
  );
}

function CashierKitchenWatch({ order, now }: { order: import("@/shared/pos").KitchenOrder; now: number }) { const detail = order.status === "new" ? "Waiting for kitchen" : order.status === "preparing" ? "In preparation" : order.status === "ready" ? "Ready for handoff" : order.status === "cancelled" ? "Cancelled" : "Handed off"; return <Card style={styles.watchCard}><View style={styles.watchTop}><View style={{ flex: 1 }}><Text style={styles.watchOrder}>{order.number} <Text style={styles.watchTime}>· {elapsedLabel(order.createdAt, now)}</Text></Text><Text style={styles.watchDetail}>{detail}</Text></View><StatusPill status={order.status} /></View><Text style={styles.watchItems} numberOfLines={1}>{order.items.map((item) => `${item.quantity}× ${item.name}`).join(" · ")}</Text></Card>; }
function QuantityControl({ quantity, setQuantity }: { quantity: number; setQuantity: (quantity: number) => void }) { return <View style={styles.quantityControl}><Pressable onPress={() => setQuantity(Math.max(0, quantity - 1))} style={styles.quantityButton}><MaterialIcons name="remove" size={16} color={palette.evergreen} /></Pressable><Text style={styles.quantityValue}>{quantity}</Text><Pressable onPress={() => setQuantity(quantity + 1)} style={styles.quantityButton}><MaterialIcons name="add" size={16} color={palette.evergreen} /></Pressable></View>; }
function TotalsRow({ label, value, money, emphasized = false }: { label: string; value: number; money: (value: number) => string; emphasized?: boolean }) { return <View style={styles.totalsRow}><Text style={[styles.totalsLabel, emphasized && styles.totalsEmphasis]}>{label}</Text><Text style={[styles.totalsValue, emphasized && styles.totalsEmphasis]}>{value < 0 ? `−${money(Math.abs(value))}` : money(value)}</Text></View>; }
const styles = StyleSheet.create({ page: { flex: 1, backgroundColor: palette.background }, scrollContent: { paddingHorizontal: 18, paddingTop: 11, paddingBottom: 18 }, topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 17 }, syncBadge: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 10, backgroundColor: palette.evergreenSoft }, onlineDot: { width: 6, height: 6, borderRadius: 4, backgroundColor: "#4E805C" }, shiftText: { color: palette.evergreen, fontSize: 8, fontWeight: "900", letterSpacing: 0.9 }, salesBadge: { minWidth: 48, height: 48, borderRadius: 15, backgroundColor: palette.amberSoft, alignItems: "center", justifyContent: "center" }, salesBadgeValue: { color: "#98661F", fontSize: 16, fontWeight: "900" }, salesBadgeLabel: { color: "#98661F", fontSize: 7, fontWeight: "900", letterSpacing: 0.8 }, errorBanner: { flexDirection: "row", gap: 8, padding: 10, backgroundColor: palette.coralSoft, borderRadius: 11, marginBottom: 12 }, errorText: { color: palette.coral, fontSize: 10, lineHeight: 15, flex: 1 }, menuHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: -13 }, menuHint: { color: palette.muted, fontSize: 10 }, categoryList: { flexDirection: "row", gap: 7, paddingBottom: 12 }, menuGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 9 }, menuCard: { width: "48.5%", minHeight: 160, padding: 11, borderRadius: 17, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line }, pressed: { opacity: 0.82, transform: [{ scale: 0.99 }] }, menuIconWrap: { width: 43, height: 43, borderRadius: 14, alignItems: "center", justifyContent: "center", position: "relative" }, addIcon: { width: 19, height: 19, borderRadius: 7, backgroundColor: palette.evergreen, position: "absolute", right: -4, bottom: -4, alignItems: "center", justifyContent: "center" }, menuName: { color: palette.ink, fontSize: 12, fontWeight: "900", marginTop: 10 }, menuDesc: { minHeight: 26, color: palette.muted, fontSize: 9, lineHeight: 13, marginTop: 3 }, menuBottom: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 7 }, menuPrice: { color: palette.evergreen, fontSize: 12, fontWeight: "900" }, menuCategory: { color: palette.muted, fontSize: 8, fontWeight: "700" }, emptyMenu: { flexDirection: "row", gap: 8, marginBottom: 10, alignItems: "center" }, emptyMenuText: { flex: 1, color: palette.coral, fontSize: 10, lineHeight: 15 }, watchList: { gap: 8 }, watchCard: { padding: 11 }, watchTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }, watchOrder: { color: palette.ink, fontSize: 12, fontWeight: "900" }, watchTime: { color: palette.muted, fontSize: 10, fontWeight: "600" }, watchDetail: { color: palette.muted, fontSize: 9, marginTop: 3 }, watchItems: { color: palette.ink, fontSize: 9, marginTop: 8 }, watchEmpty: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12 }, watchEmptyText: { color: palette.muted, fontSize: 10, flex: 1 }, cartDock: { paddingHorizontal: 16, paddingTop: 9, paddingBottom: 10, backgroundColor: palette.background, borderTopColor: palette.line, borderTopWidth: 1, gap: 7 }, cartSummary: { minHeight: 46, flexDirection: "row", alignItems: "center", gap: 9 }, cartIcon: { width: 35, height: 35, borderRadius: 12, backgroundColor: palette.evergreen, alignItems: "center", justifyContent: "center" }, cartCount: { position: "absolute", right: -4, top: -5, minWidth: 15, height: 15, borderRadius: 8, backgroundColor: palette.amber, alignItems: "center", justifyContent: "center" }, cartCountText: { color: palette.ink, fontSize: 8, fontWeight: "900" }, cartLabel: { color: palette.ink, fontSize: 11, fontWeight: "900" }, cartSub: { color: palette.muted, fontSize: 9, marginTop: 2 }, cartTotal: { alignItems: "flex-end" }, cartTotalLabel: { color: palette.muted, fontSize: 7, fontWeight: "900", letterSpacing: 0.7 }, cartTotalValue: { color: palette.evergreen, fontSize: 12, fontWeight: "900", marginTop: 2 }, modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(17,36,30,0.4)" }, sheet: { backgroundColor: palette.background, borderTopLeftRadius: 25, borderTopRightRadius: 25, maxHeight: "94%", paddingHorizontal: 19, paddingTop: 10, paddingBottom: 20 }, sheetHandle: { width: 40, height: 4, borderRadius: 3, backgroundColor: "#CDD2C9", alignSelf: "center", marginBottom: 14 }, sheetHeadingRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, itemModalIcon: { width: 50, height: 50, borderRadius: 16, alignItems: "center", justifyContent: "center" }, closeButton: { width: 36, height: 36, borderRadius: 12, backgroundColor: palette.surface, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: palette.line }, sheetTitle: { color: palette.ink, fontSize: 20, fontWeight: "900", marginTop: 6 }, sheetSubtitle: { color: palette.muted, fontSize: 11, lineHeight: 16, marginTop: 3 }, itemModalPrice: { color: palette.evergreen, fontSize: 21, fontWeight: "900", marginTop: 7, marginBottom: 15 }, fieldLabel: { color: palette.muted, fontSize: 9, fontWeight: "900", letterSpacing: 1, marginTop: 11, marginBottom: 7 }, modifierList: { gap: 6, marginBottom: 9 }, modifierRow: { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 43, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface }, modifierRowActive: { borderColor: palette.evergreen, backgroundColor: palette.evergreenSoft }, radio: { width: 16, height: 16, borderRadius: 9, borderWidth: 1, borderColor: palette.muted, alignItems: "center", justifyContent: "center" }, radioActive: { borderColor: palette.evergreen }, radioDot: { width: 8, height: 8, borderRadius: 5, backgroundColor: palette.evergreen }, modifierName: { flex: 1, color: palette.ink, fontSize: 11, fontWeight: "700" }, modifierPrice: { color: palette.evergreen, fontSize: 10, fontWeight: "800" }, noteInput: { minHeight: 43, borderRadius: 12, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, color: palette.ink, paddingHorizontal: 11, paddingVertical: 9, fontSize: 11, marginBottom: 5 }, quantityRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginVertical: 9 }, quantityControl: { flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 5, minHeight: 36, borderRadius: 12, backgroundColor: palette.evergreenSoft }, quantityButton: { width: 31, height: 31, alignItems: "center", justifyContent: "center" }, quantityValue: { color: palette.ink, fontSize: 12, fontWeight: "900", minWidth: 14, textAlign: "center" }, sheetTitleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }, emptyCart: { alignItems: "center", padding: 22, gap: 8 }, emptyCartText: { color: palette.muted, fontSize: 11 }, cartItems: { gap: 8 }, cartLine: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10, backgroundColor: palette.surface, borderRadius: 14, borderWidth: 1, borderColor: palette.line, marginBottom: 7 }, cartLineName: { color: palette.ink, fontSize: 11, fontWeight: "800" }, cartLineNote: { color: palette.coral, fontSize: 9, marginTop: 2 }, cartLinePrice: { color: palette.evergreen, fontSize: 10, fontWeight: "800", marginTop: 4 }, offerList: { flexDirection: "row", gap: 7, paddingBottom: 6 }, discountRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" }, customerRow: { flexDirection: "row", gap: 7 }, loyaltyRow: { flexDirection: "row", alignItems: "center", gap: 7 }, lookupButton: { minHeight: 40, paddingHorizontal: 9, flexDirection: "row", alignItems: "center", gap: 5, borderRadius: 11, backgroundColor: palette.evergreenSoft }, lookupLabel: { color: palette.evergreen, fontSize: 9, fontWeight: "800" }, enrollButton: { flexDirection: "row", alignItems: "center", gap: 6, padding: 8 }, hint: { color: palette.muted, fontSize: 9, marginTop: 3 }, qrisConfirm: { flexDirection: "row", alignItems: "flex-start", gap: 8, backgroundColor: palette.amberSoft, borderRadius: 11, padding: 10, marginTop: 6 }, checkbox: { width: 19, height: 19, borderRadius: 5, borderWidth: 1, borderColor: "#D7C39E", alignItems: "center", justifyContent: "center", backgroundColor: palette.surface }, checkboxActive: { backgroundColor: palette.evergreen, borderColor: palette.evergreen }, qrisText: { flex: 1, color: "#79551D", fontSize: 9, lineHeight: 14, fontWeight: "700" }, warning: { color: "#875C1B", fontSize: 9, lineHeight: 14, marginTop: 6 }, totalCard: { padding: 13, marginTop: 11 }, totalsRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 4 }, totalsLabel: { color: palette.muted, fontSize: 10 }, totalsValue: { color: palette.ink, fontSize: 10, fontWeight: "700" }, totalsEmphasis: { color: palette.ink, fontSize: 13, fontWeight: "900" }, totalDivider: { height: 1, backgroundColor: palette.line, marginVertical: 5 }, checkoutNote: { color: palette.muted, textAlign: "center", fontSize: 9, lineHeight: 13, marginTop: 7 }, receiptHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, receiptMark: { width: 44, height: 44, borderRadius: 15, backgroundColor: palette.evergreen, alignItems: "center", justifyContent: "center" }, receiptItems: { color: palette.ink, fontSize: 11, lineHeight: 19 }, });


const extensionStyles = StyleSheet.create({
  ingredientWarningBox: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: palette.coralSoft, borderRadius: 11, padding: 9, marginBottom: 8 },
  ingredientWarningText: { flex: 1, color: palette.coral, fontSize: 9, fontWeight: "900", letterSpacing: 0.3 },
  modifierGroup: { marginBottom: 8, borderRadius: 14, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, overflow: "hidden" },
  modifierGroupHeader: { flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 11, paddingVertical: 10 },
  modifierGroupName: { color: palette.ink, fontSize: 11, fontWeight: "900" },
  modifierGroupMeta: { color: palette.muted, fontSize: 8, marginTop: 3 },
  modifierOptions: { paddingHorizontal: 8, paddingBottom: 7, gap: 5 },
  modifierOptionRow: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, borderRadius: 10, backgroundColor: palette.background },
  modifierOptionRowActive: { backgroundColor: palette.evergreenSoft, borderWidth: 1, borderColor: "#C7D8CA" },
  modifierOptionDisabled: { opacity: 0.48 },
  modifierOptionWarning: { color: palette.coral, fontSize: 8, marginTop: 2 },
  linkedCustomer: { flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: "#C9D8CC", backgroundColor: palette.evergreenSoft, marginBottom: 6 },
  memberIcon: { width: 31, height: 31, borderRadius: 10, backgroundColor: palette.surface, alignItems: "center", justifyContent: "center" },
  linkedCustomerName: { color: palette.ink, fontSize: 10, fontWeight: "900" },
  removeMember: { color: palette.coral, fontSize: 9, fontWeight: "800", padding: 5 },
});
