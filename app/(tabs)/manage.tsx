import AsyncStorage from "@react-native-async-storage/async-storage";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useEffect, useMemo, useState } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { Card, EmptyState, PageHeader, palette, Pill, PrimaryButton, SectionTitle, Wordmark } from "@/components/pos/ui";
import { readLegacyPosSnapshot, usePos } from "@/lib/pos-store";
import { legacyImportKey } from "@/lib/legacy-storage";
import { useWorkspace } from "@/lib/workspace-context";
import { trpc } from "@/lib/trpc";
import { formatMoney, roundPositiveAmount } from "@/shared/accounting";
import { toLegacyImportRecord } from "@/shared/legacy";
import type { BusinessRole, MenuItem } from "@/shared/pos";
import { CashierPurchaseRequestPanel, PurchasingPanel } from "@/components/pos/purchasing-panel";
import { RecipeCostPanel } from "@/components/pos/recipe-cost-panel";
import { normalizeBaseQuantity } from "@/shared/unit-conversion";
import { businessDateTimeInput, businessDateTimeToUtc, isPromotionActiveAt, isTimeRange } from "@/shared/promotions";
import { BusinessDateTimeField, BusinessTimeField } from "@/components/pos/business-date-time-picker";

type ManagerSection = "Menu" | "Inventory" | "Recipes & costs" | "Purchasing" | "Team" | "Offers" | "Gift & loyalty" | "Settings";
type OfferRuleType = "discount" | "bogo" | "bundle";
type BundleDraft = { menuItemId: string; quantity: string };
const roles: BusinessRole[] = ["manager", "cashier", "kitchen"];
const methodOptions = ["Cash", "Card", "QRIS", "Other"] as const;
const weekdayOptions = [{ label: "Sun", value: 0 }, { label: "Mon", value: 1 }, { label: "Tue", value: 2 }, { label: "Wed", value: 3 }, { label: "Thu", value: 4 }, { label: "Fri", value: 5 }, { label: "Sat", value: 6 }];
function ask(title: string, message: string, action: () => void) {
  if (Platform.OS === "web" && typeof window !== "undefined") { if (window.confirm(`${title}\n\n${message}`)) action(); return; }
  Alert.alert(title, message, [{ text: "Cancel", style: "cancel" }, { text: "Continue", style: "destructive", onPress: action }]);
}
function roleLabel(role: BusinessRole) { return role === "manager" ? "Manager" : role === "cashier" ? "Cashier" : "Kitchen"; }

export default function ManageScreen() {
  const { workspace, logout, user } = useWorkspace();
  const { menu } = usePos();
  const manager = workspace?.role === "manager";
  const utils = trpc.useUtils();
  const [section, setSection] = useState<ManagerSection>("Team");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [inviteRole, setInviteRole] = useState<BusinessRole>("cashier");
  const [createdInvite, setCreatedInvite] = useState<{ code: string; role: BusinessRole; expiresAt: string } | null>(null);
  const [offerName, setOfferName] = useState("");
  const [offerCode, setOfferCode] = useState("");
  const [offerType, setOfferType] = useState<"percent" | "fixed">("percent");
  const [offerValue, setOfferValue] = useState("10");
  const [offerLimit, setOfferLimit] = useState("");
  const [offerRuleType, setOfferRuleType] = useState<OfferRuleType>("discount");
  const [offerBuyItemId, setOfferBuyItemId] = useState("");
  const [offerBuyQuantity, setOfferBuyQuantity] = useState("1");
  const [offerRewardItemId, setOfferRewardItemId] = useState("");
  const [offerRewardQuantity, setOfferRewardQuantity] = useState("1");
  const [offerBundleItems, setOfferBundleItems] = useState<BundleDraft[]>([{ menuItemId: "", quantity: "1" }, { menuItemId: "", quantity: "1" }]);
  const [offerStartAt, setOfferStartAt] = useState(() => new Date());
  const [offerEndAt, setOfferEndAt] = useState(() => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
  const [offerDailyStart, setOfferDailyStart] = useState("");
  const [offerDailyEnd, setOfferDailyEnd] = useState("");
  const [offerWeekdays, setOfferWeekdays] = useState<number[]>([]);
  const [giftAmount, setGiftAmount] = useState("");
  const [giftCustomer, setGiftCustomer] = useState("");
  const [giftMethod, setGiftMethod] = useState<(typeof methodOptions)[number]>("Cash");
  const [qrisVerified, setQrisVerified] = useState(false);
  const [giftCodeOnce, setGiftCodeOnce] = useState("");
  const [currencyStep, setCurrencyStep] = useState<string | null>(null);
  const [pointsEarned, setPointsEarned] = useState<string | null>(null);
  const [pointValue, setPointValue] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState<string | null>(null);
  const [taxPercent, setTaxPercent] = useState<string | null>(null);
  const [businessTimezone, setBusinessTimezone] = useState<string | null>(null);
  const emptyLegacy = { orders: [], transactions: [] } as Awaited<ReturnType<typeof readLegacyPosSnapshot>>;
  const [legacyState, setLegacyState] = useState<{ ownerOpenId: string; snapshot: typeof emptyLegacy; ready: boolean; alreadyImported: boolean }>({ ownerOpenId: "", snapshot: emptyLegacy, ready: false, alreadyImported: false });
  const legacyMatchesUser = Boolean(manager && user?.openId && legacyState.ownerOpenId === user.openId);
  const legacy = legacyMatchesUser ? legacyState.snapshot : emptyLegacy;
  const legacyRead = legacyMatchesUser && legacyState.ready;
  const alreadyImported = legacyMatchesUser && legacyState.alreadyImported;
  const [legacyConfirmed, setLegacyConfirmed] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [menuName, setMenuName] = useState("");
  const [menuDescription, setMenuDescription] = useState("");
  const [menuCategory, setMenuCategory] = useState("");
  const [menuPrice, setMenuPrice] = useState("");
  const [menuAvailable, setMenuAvailable] = useState(true);
  const [menuStockTracked, setMenuStockTracked] = useState(false);
  const [menuStockUnit, setMenuStockUnit] = useState("unit");
  const [menuLowStockThreshold, setMenuLowStockThreshold] = useState("0");
  const [menuOpeningStock, setMenuOpeningStock] = useState("0");
  const [inventoryAction, setInventoryAction] = useState<{ item: MenuItem; mode: "receive" | "opname" } | null>(null);
  const [inventoryQuantity, setInventoryQuantity] = useState("");
  const [inventoryReason, setInventoryReason] = useState("");
  const [inventoryError, setInventoryError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const members = trpc.workspace.members.useQuery(undefined, { enabled: manager, refetchInterval: 3_000 });
  const invites = trpc.workspace.invites.useQuery(undefined, { enabled: manager, refetchInterval: 3_000 });
  const settings = trpc.workspace.settings.useQuery(undefined, { enabled: manager, staleTime: 0, refetchInterval: 3_000, refetchOnMount: "always" });
  const promotions = trpc.programs.promotions.useQuery(undefined, { enabled: manager, refetchInterval: 3_000 });
  const giftCards = trpc.programs.giftCards.useQuery(undefined, { enabled: manager, refetchInterval: 3_000 });
  const giftMovements = trpc.programs.giftCardMovements.useQuery(undefined, { enabled: manager, refetchInterval: 3_000 });
  const loyaltySettings = trpc.programs.loyaltySettings.useQuery(undefined, { enabled: manager, refetchInterval: 3_000 });
  const loyaltyCustomers = trpc.programs.loyaltyCustomers.useQuery(undefined, { enabled: manager, refetchInterval: 3_000 });
  const loyaltyMovements = trpc.programs.loyaltyMovements.useQuery(undefined, { enabled: manager, refetchInterval: 3_000 });
  const inventory = trpc.pos.inventory.useQuery(undefined, { enabled: manager, refetchInterval: 3_000 });
  const createInvite = trpc.workspace.invite.useMutation();
  const updateMember = trpc.workspace.updateMember.useMutation();
  const revokeInvite = trpc.workspace.revokeInvite.useMutation();
  const saveOffer = trpc.programs.savePromotion.useMutation();
  const deactivateOffer = trpc.programs.deactivatePromotion.useMutation();
  const issueGift = trpc.programs.issueGiftCard.useMutation();
  const saveLoyalty = trpc.programs.saveLoyaltySettings.useMutation();
  const updateSettings = trpc.workspace.updateSettings.useMutation();
  const saveMenuItem = trpc.pos.saveMenuItem.useMutation();
  const receiveStock = trpc.pos.receiveStock.useMutation();
  const stockOpname = trpc.pos.stockOpname.useMutation();
  const importLegacy = trpc.pos.importLegacy.useMutation();
  const settingsReady = manager && settings.isSuccess && !settings.isError && !settings.isFetching && Boolean(settings.data);
  const currencyMoney = (value: number) => formatMoney(value, workspace?.currency ?? "IDR");
  const pendingInviteCount = useMemo(() => invites.data?.filter((invite) => !invite.usedAt && !invite.revokedAt && new Date(invite.expiresAt).getTime() > now).length ?? 0, [invites.data, now]);
  const recordCount = legacy.orders.length + legacy.transactions.length;
  const businessNameValue = businessName ?? settings.data?.name ?? "";
  const taxPercentValue = taxPercent ?? String((settings.data?.taxRateBasisPoints ?? 0) / 100);
  const businessTimezoneValue = businessTimezone ?? settings.data?.timezone ?? "Asia/Jakarta";
  const currencyStepValue = currencyStep ?? String(loyaltySettings.data?.currencyStep ?? (workspace?.currency === "IDR" ? 10000 : 1));
  const pointsEarnedValue = pointsEarned ?? String(loyaltySettings.data?.earnPerCurrencyStep ?? 1);
  const pointValueValue = pointValue ?? String(loyaltySettings.data?.redemptionValuePerPoint ?? (workspace?.currency === "IDR" ? 100 : 0.01));
  const editingTrackedItem = menu.find((item) => item.id === menuId)?.stockTracked === true;
  const sellableMenu = menu.filter((item) => item.available !== false && item.ingredientOnly !== true);
  const promotionTimezone = settings.data?.timezone ?? "Asia/Jakarta";
  const trackedItems = inventory.data?.items ?? [];
  const lowStockCount = trackedItems.filter((item) => Number(item.stockOnHand ?? 0) <= Number(item.lowStockThreshold ?? 0)).length;
  useEffect(() => {
    let active = true;
    const openId = manager ? user?.openId : undefined;
    if (!openId) return () => { active = false; };
    void Promise.all([
      readLegacyPosSnapshot(openId).catch(() => ({ orders: [], transactions: [] })),
      AsyncStorage.getItem(legacyImportKey(openId)).catch(() => null),
    ]).then(([snapshot, imported]) => {
      if (active) setLegacyState({ ownerOpenId: openId, snapshot, ready: true, alreadyImported: Boolean(imported) });
    });
    return () => { active = false; };
  }, [manager, user?.openId]);

  async function refreshTeam() { await Promise.all([utils.workspace.members.invalidate(), utils.workspace.invites.invalidate()]); }
  async function refreshPrograms() { await Promise.all([utils.programs.promotions.invalidate(), utils.programs.giftCards.invalidate(), utils.programs.giftCardMovements.invalidate(), utils.programs.loyaltySettings.invalidate(), utils.programs.loyaltyCustomers.invalidate(), utils.programs.loyaltyMovements.invalidate()]); }
  async function issueInvite() {
    setError(""); setNotice("");
    try { const result = await createInvite.mutateAsync({ role: inviteRole }); setCreatedInvite(result); await utils.workspace.invites.invalidate(); }
    catch (err) { setError(err instanceof Error ? err.message : "Invite could not be created."); }
  }
  async function shareInvite() {
    if (!createdInvite) return;
    try { await Share.share({ title: "Till & Table team invite", message: `Join ${workspace?.name ?? "our Till & Table workspace"} as ${roleLabel(createdInvite.role)}. Sign in with your Manus account and enter this one-time invite code: ${createdInvite.code}. It expires ${new Date(createdInvite.expiresAt).toLocaleString()}.` }); }
    catch { setNotice("Keep this one-time code private and share it directly with your staff member."); }
  }
  function changeMember(member: NonNullable<typeof members.data>[number], update: { role?: BusinessRole; status?: "active" | "suspended" }) {
    const role = update.role ?? member.role; const status = update.status ?? member.status;
    const message = `${member.displayName || member.email || "This member"} will be ${status === "suspended" ? "suspended" : `set to ${roleLabel(role)}`} in this workspace.`;
    ask("Update team access?", message, () => void (async () => { setError(""); try { await updateMember.mutateAsync({ id: member.id, role, status }); await refreshTeam(); setNotice("Team access updated."); } catch (err) { setError(err instanceof Error ? err.message : "Team access was not changed."); } })());
  }
  function toggleOfferWeekday(day: number) { setOfferWeekdays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort()); }
  function updateOfferBundleItem(index: number, patch: Partial<BundleDraft>) { setOfferBundleItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)); }
  function addOfferBundleItem() {
    if (offerBundleItems.length >= 20) { setError("A bundle can contain at most 20 different menu items."); return; }
    setOfferBundleItems((current) => [...current, { menuItemId: "", quantity: "1" }]);
  }
  function removeOfferBundleItem(index: number) { if (offerBundleItems.length > 2) setOfferBundleItems((current) => current.filter((_item, itemIndex) => itemIndex !== index)); }
  async function makeOffer() {
    setError(""); setNotice("");
    const value = Number(offerValue);
    const max = offerLimit.trim() ? Number(offerLimit) : undefined;
    const buyQuantity = Number(offerBuyQuantity);
    const rewardQuantity = Number(offerRewardQuantity);
    const hasDailySchedule = Boolean(offerDailyStart || offerDailyEnd);
    const bundleItems = offerBundleItems.map((item) => ({ menuItemId: item.menuItemId, quantity: Number(item.quantity) }));
    if (!offerName.trim()) { setError("Enter a name for the offer."); return; }
    if (!Number.isFinite(offerStartAt.getTime()) || !Number.isFinite(offerEndAt.getTime()) || offerEndAt <= offerStartAt) { setError("Choose an end date and time after the start date and time."); return; }
    if (offerRuleType === "discount" && (!Number.isFinite(value) || value <= 0 || offerType === "percent" && value > 100)) { setError("Enter a positive discount (percentage up to 100%)."); return; }
    if (offerRuleType === "bundle" && (!Number.isFinite(value) || value < 0)) { setError("Enter a non-negative fixed price for the bundle."); return; }
    if (max !== undefined && (!Number.isInteger(max) || max <= 0)) { setError("The redemption limit must be a positive whole number."); return; }
    if (offerRuleType === "bogo" && (!sellableMenu.some((item) => item.id === offerBuyItemId) || !sellableMenu.some((item) => item.id === offerRewardItemId) || !Number.isInteger(buyQuantity) || buyQuantity <= 0 || !Number.isInteger(rewardQuantity) || rewardQuantity <= 0)) { setError("Choose qualifying and reward menu items and positive whole quantities for Buy X Get Y Free."); return; }
    if (offerRuleType === "bundle" && (bundleItems.length < 2 || bundleItems.some((item) => !sellableMenu.some((menuItem) => menuItem.id === item.menuItemId) || !Number.isInteger(item.quantity) || item.quantity <= 0) || new Set(bundleItems.map((item) => item.menuItemId)).size !== bundleItems.length)) { setError("Add at least two different menu items with positive whole quantities to the bundle."); return; }
    if (Boolean(offerDailyStart) !== Boolean(offerDailyEnd) || offerDailyStart && !isTimeRange(offerDailyStart) || offerDailyEnd && !isTimeRange(offerDailyEnd)) { setError("Set both recurring daily times using 24-hour HH:mm, or clear both."); return; }
    try {
      const startsAt = businessDateTimeToUtc(businessDateTimeInput(offerStartAt, promotionTimezone), promotionTimezone);
      const endsAt = businessDateTimeToUtc(businessDateTimeInput(offerEndAt, promotionTimezone), promotionTimezone);
      const offer = await saveOffer.mutateAsync({
        name: offerName.trim(), code: offerCode.trim() || undefined,
        discountType: offerRuleType === "discount" ? offerType : "fixed",
        value: offerRuleType === "discount" ? value : 1,
        ruleType: offerRuleType,
        buyItemId: offerRuleType === "bogo" ? offerBuyItemId : undefined,
        buyQuantity: offerRuleType === "bogo" ? buyQuantity : undefined,
        rewardItemId: offerRuleType === "bogo" ? offerRewardItemId : undefined,
        rewardQuantity: offerRuleType === "bogo" ? rewardQuantity : undefined,
        bundleItems: offerRuleType === "bundle" ? bundleItems : undefined,
        bundlePrice: offerRuleType === "bundle" ? value : undefined,
        dailyStartTime: hasDailySchedule ? offerDailyStart : undefined,
        dailyEndTime: hasDailySchedule ? offerDailyEnd : undefined,
        weekdays: offerWeekdays.length ? offerWeekdays : undefined,
        startsAt, endsAt, active: true, maxRedemptions: max,
      });
      await refreshPrograms();
      setOfferName(""); setOfferCode(""); setOfferType("percent"); setOfferValue("10"); setOfferLimit(""); setOfferRuleType("discount");
      setOfferBuyItemId(""); setOfferRewardItemId(""); setOfferBuyQuantity("1"); setOfferRewardQuantity("1");
      setOfferBundleItems([{ menuItemId: "", quantity: "1" }, { menuItemId: "", quantity: "1" }]);
      setOfferStartAt(new Date()); setOfferEndAt(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
      setOfferDailyStart(""); setOfferDailyEnd(""); setOfferWeekdays([]);
      setNotice(`${offer.name} saved${offer.code ? ` · coupon ${offer.code}` : " · register offer"}.`);
    }
    catch (err) { setError(err instanceof Error ? err.message : "Offer could not be saved."); }
  }
  async function turnOffOffer(id: string) {
    try { await deactivateOffer.mutateAsync({ id }); await refreshPrograms(); setNotice("Offer deactivated."); }
    catch (err) { setError(err instanceof Error ? err.message : "Offer could not be deactivated."); }
  }
  async function issueCard() {
    setError(""); setNotice(""); const amount = Number(giftAmount);
    if (!Number.isFinite(amount) || roundPositiveAmount(amount, workspace?.currency ?? "IDR") === null) { setError(`Enter a gift-card value that rounds to at least one ${workspace?.currency ?? "IDR"} minor unit.`); return; }
    if (giftMethod === "QRIS" && !qrisVerified) { setError("Verify QRIS in the merchant app before issuing the gift card."); return; }
    ask("Issue a gift card?", `${currencyMoney(amount)} will be recorded as gift-card liability${giftMethod === "QRIS" ? " after manual QRIS verification" : ""}. The card code will be shown only once.`, () => void (async () => {
      try { const result = await issueGift.mutateAsync({ amount, paymentMethod: giftMethod, customerName: giftCustomer.trim() || undefined, qrisVerified }); setGiftCodeOnce(result.code); setGiftAmount(""); setGiftCustomer(""); setQrisVerified(false); await refreshPrograms(); }
      catch (err) { setError(err instanceof Error ? err.message : "Gift card could not be issued."); }
    })());
  }
  async function savePoints() {
    const step = Number(currencyStepValue); const earned = Number(pointsEarnedValue); const value = Number(pointValueValue);
    if (!Number.isFinite(step) || step <= 0 || !Number.isInteger(earned) || earned <= 0 || !Number.isFinite(value) || value <= 0) { setError("Enter a valid spend threshold, whole points earned and positive redemption value."); return; }
    try { await saveLoyalty.mutateAsync({ currencyStep: step, earnPerCurrencyStep: earned, redemptionValuePerPoint: value }); await refreshPrograms(); setNotice("Loyalty earn and redemption rules saved."); }
    catch (err) { setError(err instanceof Error ? err.message : "Loyalty settings were not saved."); }
  }
  async function saveBusiness() {
    if (!settingsReady) { setError("Workspace settings have not loaded successfully. Retry before saving to avoid overwriting them with defaults."); return; }
    const tax = Number(taxPercentValue);
    if (!businessNameValue.trim() || !Number.isFinite(tax) || tax < 0 || tax > 30) { setError("Enter a business name and tax rate from 0% to 30%."); return; }
    try { await updateSettings.mutateAsync({ name: businessNameValue.trim(), taxRateBasisPoints: Math.round(tax * 100), timezone: businessTimezoneValue.trim() }); await Promise.all([utils.workspace.settings.invalidate(), utils.workspace.current.invalidate()]); await settings.refetch(); setNotice("Business settings saved."); }
    catch (err) { setError(err instanceof Error ? err.message : "Business settings were not saved. Check that the business time zone is a valid IANA name."); }
  }
  async function importOldRecords() {
    if (!user?.openId) { setError("Your sign-in session could not be verified. Please sign in again before importing."); return; }
    if (!legacyRead) { setError("Local register ownership is still being verified. Wait for it to finish, then retry."); return; }
    if (!recordCount || !legacyConfirmed) { setError("Confirm that the local amounts match this workspace currency before importing."); return; }
    ask("Import old register data?", `${recordCount} old records will be copied into ${workspace?.name ?? "this workspace"} without converting their amounts. Confirm that the chosen workspace currency already matches those records.`, () => void (async () => {
      try { const result = await importLegacy.mutateAsync({ ownerOpenId: user.openId, currencyConfirmed: true, orders: legacy.orders.map(toLegacyImportRecord), transactions: legacy.transactions.map(toLegacyImportRecord) }); await AsyncStorage.setItem(legacyImportKey(user.openId), result.importId); setLegacyState((current) => current.ownerOpenId === user.openId ? { ...current, alreadyImported: true } : current); setNotice(result.alreadyImported ? "These records were already imported." : `${result.imported} records imported unchanged.`); }
      catch (err) { setError(err instanceof Error ? err.message : "Import failed. The original on-device records remain intact."); }
    })());
  }

  function editMenuItem(item?: MenuItem) {
    setMenuId(item?.id ?? null);
    setMenuName(item?.name ?? "");
    setMenuDescription(item?.description ?? "");
    setMenuCategory(item?.category ?? "Coffee");
    setMenuPrice(item ? String(item.price) : "");
    setMenuAvailable(item?.available !== false);
    setMenuStockTracked(item?.stockTracked === true);
    setMenuStockUnit(item?.stockUnit ?? "unit");
    setMenuLowStockThreshold(String(item?.lowStockThreshold ?? 0));
    setMenuOpeningStock("0");
    setError("");
    setNotice("");
  }

  async function saveMenu() {
    const price = Number(menuPrice);
    if (!menuName.trim() || !menuCategory.trim() || !Number.isFinite(price) || price < 0) { setError("Enter a name, category and non-negative price for this menu item."); return; }
    const lowStockThreshold = Number(menuLowStockThreshold);
    const openingStock = Number(menuOpeningStock);
    const currentlyTracked = menu.find((item) => item.id === menuId)?.stockTracked === true;
    if (menuStockTracked && (!menuStockUnit.trim() || !Number.isInteger(lowStockThreshold) || lowStockThreshold < 0 || !currentlyTracked && (!Number.isInteger(openingStock) || openingStock < 0))) { setError("Enter a stock unit and whole-number opening balance and low-stock threshold."); return; }
    try {
      const item = await saveMenuItem.mutateAsync({ id: menuId ?? undefined, name: menuName.trim(), description: menuDescription.trim(), category: menuCategory.trim(), price, available: menuAvailable, stockTracked: menuStockTracked, stockUnit: menuStockUnit.trim() || "unit", lowStockThreshold: menuStockTracked ? lowStockThreshold : 0, openingStock: menuStockTracked && !currentlyTracked ? openingStock : 0 });
      await Promise.all([utils.pos.menu.invalidate(), utils.pos.inventory.invalidate()]);
      editMenuItem();
      setNotice(`${item.name} saved. Previous orders keep their original price and description.`);
    } catch (err) { setError(err instanceof Error ? err.message : "Menu item was not saved."); }
  }

  function changeMenuAvailability(item: MenuItem) {
    const available = item.available === false;
    ask(available ? "Reactivate this item?" : "Hide this item?", available ? "Cashiers can sell it again. Historical tickets remain unchanged." : "It will disappear from cashier menus; historical tickets remain unchanged.", () => void (async () => {
      try { await saveMenuItem.mutateAsync({ id: item.id, name: item.name, description: item.description, category: item.category, price: item.price, available, stockTracked: item.stockTracked === true, stockUnit: item.stockUnit ?? "unit", lowStockThreshold: item.lowStockThreshold ?? 0, openingStock: 0 }); await Promise.all([utils.pos.menu.invalidate(), utils.pos.inventory.invalidate()]); setNotice(`${item.name} ${available ? "reactivated" : "hidden"}.`); }
      catch (err) { setError(err instanceof Error ? err.message : "Menu availability was not changed."); }
    })());
  }

  function openInventoryAction(item: MenuItem, mode: "receive" | "opname") {
    setInventoryAction({ item, mode });
    setInventoryQuantity(mode === "opname" ? String(item.stockOnHand ?? 0) : "");
    setInventoryReason("");
    setInventoryError("");
    setError("");
    setNotice("");
  }

  async function saveInventoryAction() {
    if (!inventoryAction || !inventoryQuantity.trim() || !inventoryReason.trim()) { setInventoryError("Enter a quantity and a reason for this inventory change."); return; }
    let quantity = Number(inventoryQuantity);
    if (inventoryAction.item.ingredientOnly === true) {
      try { quantity = normalizeBaseQuantity(quantity, inventoryAction.mode === "receive" ? "Receipt quantity" : "Physical count"); }
      catch { setInventoryError("Ingredient quantities must be non-negative with no more than three decimal places."); return; }
    } else if (!Number.isInteger(quantity) || quantity < 0) { setInventoryError("Direct goods require a whole-unit count of zero or greater."); return; }
    if (quantity < 0 || inventoryAction.mode === "receive" && quantity <= 0) { setInventoryError(inventoryAction.mode === "receive" ? "Receive quantity must be greater than zero." : "Physical count must be zero or greater."); return; }
    try {
      let noticeText = "";
      if (inventoryAction.mode === "receive") {
        await receiveStock.mutateAsync({ itemId: inventoryAction.item.id, quantity, reason: inventoryReason.trim() });
        noticeText = `${quantity} ${inventoryAction.item.stockUnit ?? "unit"} added to ${inventoryAction.item.name}.`;
      } else {
        const result = await stockOpname.mutateAsync({ itemId: inventoryAction.item.id, countedQuantity: quantity, reason: inventoryReason.trim() });
        const variance = result.variance;
        noticeText = `Stock opname saved for ${inventoryAction.item.name}: ${variance > 0 ? "+" : ""}${variance} ${inventoryAction.item.stockUnit ?? "unit"}.`;
      }
      await Promise.all([utils.pos.menu.invalidate(), utils.pos.inventory.invalidate()]);
      setInventoryAction(null);
      setInventoryError("");
      setNotice(noticeText);
    } catch (err) { setInventoryError(err instanceof Error ? err.message : "Inventory change was not saved."); }
  }

  if (!manager) return <ScreenContainer containerClassName="bg-background" safeAreaClassName="bg-background"><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"><View style={styles.topRow}><Wordmark /></View><PageHeader eyebrow="Your team account" title="On this shift" subtitle="Your manager controls which shared workspace screens are available to your role." /><Card style={styles.profileCard}><View style={styles.profileIcon}><MaterialIcons name={workspace?.role === "kitchen" ? "soup-kitchen" : "point-of-sale"} size={23} color={palette.evergreen} /></View><Text style={styles.profileName}>{workspace?.memberName}</Text><Text style={styles.profileBusiness}>{workspace?.name}</Text><View style={styles.rolePill}><Text style={styles.rolePillText}>{roleLabel(workspace?.role ?? "cashier").toUpperCase()}</Text></View><Text style={styles.profileNote}>Work is synced with this business while you are online. Sign in with your own Manus account to keep activity assigned to you.</Text><PrimaryButton label="Sign out" icon="logout" tone="light" onPress={() => void logout()} /></Card>{workspace?.role === "cashier" ? <CashierPurchaseRequestPanel /> : null}</ScrollView></ScreenContainer>;

  const sections: ManagerSection[] = ["Menu", "Inventory", "Recipes & costs", "Purchasing", "Team", "Offers", "Gift & loyalty", "Settings"];
  return (
    <ScreenContainer containerClassName="bg-background" safeAreaClassName="bg-background">
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={styles.topRow}><Wordmark /><Pressable onPress={() => void logout()} style={styles.signOut}><MaterialIcons name="logout" size={15} color={palette.muted} /><Text style={styles.signOutText}>Sign out</Text></Pressable></View>
        <PageHeader eyebrow={`${workspace?.name ?? "Workspace"} · manager`} title="Manager desk" subtitle="Menu, inventory, purchasing, team access and business rules." right={<View style={styles.managerMark}><MaterialIcons name="tune" size={19} color={palette.evergreen} /></View>} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sectionTabs}>{sections.map((value) => <Pill key={value} label={value} selected={section === value} onPress={() => { setSection(value); setError(""); setNotice(""); }} />)}</ScrollView>
        {error ? <View style={styles.errorBanner}><MaterialIcons name="error-outline" size={15} color={palette.coral} /><Text style={styles.errorText}>{error}</Text></View> : null}
        {notice ? <Pressable onPress={() => setNotice("")} style={styles.notice}><MaterialIcons name="check-circle" size={15} color={palette.evergreen} /><Text style={styles.noticeText}>{notice}</Text><MaterialIcons name="close" size={14} color={palette.muted} /></Pressable> : null}

        {section === "Settings" && !settingsReady ? <View style={styles.errorBanner}><MaterialIcons name={settings.isError ? "cloud-off" : "hourglass-empty"} size={15} color={settings.isError ? palette.coral : palette.muted} /><Text style={styles.errorText}>{settings.isError ? `Saved workspace settings could not be loaded${settings.error instanceof Error ? `: ${settings.error.message}` : "."} No fallback values can be saved.` : "Loading saved workspace settings. Saving is disabled until they load."}</Text>{settings.isError ? <Pressable onPress={() => void settings.refetch()}><Text style={styles.changeRoleText}>Retry</Text></Pressable> : null}</View> : null}

        {section === "Menu" ? <>
          <Card style={styles.formCard}>
            <Text style={styles.cardTitle}>{menuId ? "Edit menu item" : "Add a menu item"}</Text>
            <Text style={styles.smallNote}>Price changes apply to future tickets only. Existing modifiers and past receipts are preserved.</Text>
            <Field label="ITEM NAME" value={menuName} onChangeText={setMenuName} placeholder="e.g. Signature cold brew" />
            <Field label="DESCRIPTION" value={menuDescription} onChangeText={setMenuDescription} placeholder="Short description for the register" />
            <Field label="CATEGORY" value={menuCategory} onChangeText={setMenuCategory} placeholder="Coffee, Food, Bakery…" />
            <Field label={`PRICE · ${workspace?.currency ?? "IDR"}`} value={menuPrice} onChangeText={setMenuPrice} placeholder="0" keyboardType="decimal-pad" />
            <Text style={[styles.fieldLabel, { marginTop: 11 }]}>INVENTORY</Text>
            {editingTrackedItem ? <Text style={styles.smallNote}>Stock tracking is enabled. Change quantities in Inventory so every receipt and stock count stays auditable.</Text> : <View style={styles.roleChoices}><Pill label="Not tracked" selected={!menuStockTracked} onPress={() => setMenuStockTracked(false)} /><Pill label="Track stock" selected={menuStockTracked} onPress={() => setMenuStockTracked(true)} /></View>}
            {menuStockTracked ? <><Field label="STOCK UNIT · e.g. cup, bottle, piece" value={menuStockUnit} onChangeText={setMenuStockUnit} placeholder="unit" /><Field label="MINIMUM STOCK / REORDER POINT · WHOLE UNITS" value={menuLowStockThreshold} onChangeText={setMenuLowStockThreshold} placeholder="0" keyboardType="number-pad" />{!editingTrackedItem ? <Field label="OPENING STOCK BALANCE · WHOLE UNITS" value={menuOpeningStock} onChangeText={setMenuOpeningStock} placeholder="0" keyboardType="number-pad" /> : <Text style={styles.smallNote}>Current balance: {menu.find((item) => item.id === menuId)?.stockOnHand ?? 0} {menuStockUnit}. Catalog edits never reset it.</Text>}</> : null}
            <View style={styles.roleChoices}><Pill label="Available to sell" selected={menuAvailable} onPress={() => setMenuAvailable(true)} /><Pill label="Hidden" selected={!menuAvailable} onPress={() => setMenuAvailable(false)} /></View>
            <PrimaryButton label={saveMenuItem.isPending ? "Saving…" : menuId ? "Save menu item" : "Add menu item"} icon="restaurant-menu" onPress={() => void saveMenu()} loading={saveMenuItem.isPending} disabled={saveMenuItem.isPending} />
            {menuId ? <Pressable onPress={() => editMenuItem()} style={styles.changeRole}><Text style={styles.changeRoleText}>Cancel edit</Text></Pressable> : null}
          </Card>
          <SectionTitle title="Workspace menu" action={`${menu.length} items`} />
          {menu.length ? <View style={styles.list}>{menu.map((item) => <Card key={item.id} style={styles.offerCard}>
            <View style={styles.memberTop}><View style={{ flex: 1 }}><Text style={styles.memberName}>{item.name}</Text><Text style={styles.memberEmail}>{item.category} · {item.modifiers?.length ?? 0} modifier option(s)</Text></View><View style={[styles.statusTag, item.available === false ? styles.suspendedTag : styles.activeTag]}><Text style={[styles.statusTagText, item.available === false ? styles.suspendedText : styles.activeText]}>{item.available === false ? "HIDDEN" : "SELLING"}</Text></View></View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 10 }}><View><Text style={{ color: palette.evergreen, fontSize: 15, fontWeight: "900" }}>{currencyMoney(item.price)}</Text>{item.stockTracked ? <Text style={{ color: Number(item.stockOnHand ?? 0) <= Number(item.lowStockThreshold ?? 0) ? palette.coral : palette.muted, fontSize: 8, fontWeight: "800", marginTop: 3 }}>{item.stockOnHand ?? 0} {item.stockUnit ?? "unit"} in stock</Text> : null}</View><View style={{ flexDirection: "row", gap: 6 }}><Pressable onPress={() => editMenuItem(item)} style={styles.changeRole}><Text style={styles.changeRoleText}>Edit</Text></Pressable><Pressable onPress={() => changeMenuAvailability(item)} style={styles.suspendButton}><Text style={styles.suspendText}>{item.available === false ? "Reactivate" : "Hide"}</Text></Pressable></View></View>
          </Card>)}</View> : <EmptyState icon="restaurant-menu" title="No menu items yet" body="Add a menu item so cashiers can start a shared register ticket." />}
        </> : null}

        {section === "Inventory" ? <>
          <View style={styles.metricRow}><Metric label="TRACKED GOODS" value={inventory.error ? "—" : String(trackedItems.length)} /><Metric label="LOW / OUT OF STOCK" value={inventory.error ? "—" : String(lowStockCount)} /></View>
          <Card style={styles.formCard}><Text style={styles.cardTitle}>Shared stock control</Text><Text style={styles.smallNote}>Cashier sales deduct stock automatically. Receive deliveries here, or count the shelf and post a stock opname. Updates sync to cashier registers within five seconds.</Text></Card>
          <SectionTitle title="Tracked goods" action={`${trackedItems.length} items`} />
          {inventory.isLoading ? <Text style={styles.smallNote}>Loading shared inventory…</Text> : inventory.error ? <Card style={styles.formCard}><Text style={styles.errorText}>Inventory could not be synced. Check the connection before receiving stock or counting goods.</Text></Card> : trackedItems.length ? <View style={styles.list}>{trackedItems.map((item) => {
            const balance = Number(item.stockOnHand ?? 0);
            const low = balance <= Number(item.lowStockThreshold ?? 0);
            return <Card key={item.id} style={styles.offerCard}>
              <View style={styles.memberTop}><View style={{ flex: 1 }}><Text style={styles.memberName}>{item.name}</Text><Text style={styles.memberEmail}>{item.category} · {item.stockUnit ?? "unit"}{item.available === false ? " · hidden from cashier" : ""}</Text></View><View style={[styles.statusTag, low ? styles.suspendedTag : styles.activeTag]}><Text style={[styles.statusTagText, low ? styles.suspendedText : styles.activeText]}>{balance <= 0 ? "OUT" : low ? "LOW" : "IN STOCK"}</Text></View></View>
              <Text style={{ color: palette.evergreen, fontSize: 18, fontWeight: "900", marginTop: 8 }}>{balance} <Text style={{ color: palette.muted, fontSize: 10 }}>{item.stockUnit ?? "unit"}</Text></Text>
              <Text style={styles.memberEmail}>Minimum / reorder point: {item.lowStockThreshold ?? 0} {item.stockUnit ?? "unit"}</Text>
              <View style={{ flexDirection: "row", gap: 7, marginTop: 9 }}><Pressable onPress={() => openInventoryAction(item, "receive")} style={styles.changeRole}><Text style={styles.changeRoleText}>＋ Receive stock</Text></Pressable><Pressable onPress={() => openInventoryAction(item, "opname")} style={styles.suspendButton}><Text style={styles.suspendText}>Stock opname</Text></Pressable></View>
            </Card>;
          })}</View> : <EmptyState icon="inventory-2" title="No tracked goods yet" body="Edit a menu good, choose Track stock, and enter its opening balance to start inventory control." />}
          <SectionTitle title="Recent stock movements" action={`${inventory.data?.movements.length ?? 0} shown`} />
          {inventory.error || inventory.isLoading ? null : inventory.data?.movements.length ? <View style={styles.list}>{inventory.data.movements.slice(0, 20).map((movement) => {
            const kindLabel = movement.kind === "sale" ? "POS sale" : movement.kind === "recipe" ? "Recipe use" : movement.kind === "receipt" ? "Stock received" : movement.kind === "opname" ? "Stock opname" : "Opening balance";
            const actor = members.data?.find((member) => member.openId === movement.actorOpenId);
            return <View key={movement.id} style={styles.auditRow}><View style={{ flex: 1, minWidth: 170 }}><Text style={styles.auditPrimary}>{movement.itemName} · {kindLabel}</Text><Text style={styles.auditDate}>{movement.reason} · {actor?.displayName || actor?.email || "Workspace member"}</Text><Text style={styles.auditDate}>{movement.quantityBefore} → {movement.quantityAfter} {movement.unit} · {new Date(movement.at).toLocaleString()} · {movement.reference}</Text></View><Text style={[styles.auditAmount, movement.quantityDelta < 0 && { color: palette.coral }]}>{movement.quantityDelta > 0 ? "+" : ""}{movement.quantityDelta} {movement.unit}</Text></View>;
          })}</View> : <Text style={styles.smallNote}>Opening balances, receipts, POS deductions and opname variances will appear here.</Text>}
        </> : null}

        {section === "Recipes & costs" ? <RecipeCostPanel /> : null}
        {section === "Purchasing" ? <PurchasingPanel /> : null}

        {section === "Team" ? <>
          <View style={styles.metricRow}><Metric label="TEAM MEMBERS" value={String(members.data?.filter((item) => item.status === "active").length ?? 0)} /><Metric label="PENDING INVITES" value={String(pendingInviteCount)} /></View>
          <SectionTitle title="People in this workspace" action="Invite staff" onAction={() => setCreatedInvite(null)} />
          <Card style={styles.inviteCard}><Text style={styles.cardTitle}>Create a one-time code</Text><Text style={styles.smallNote}>The team member signs in with their own Manus account, then enters the code. It expires after 48 hours.</Text><View style={styles.roleChoices}>{roles.map((role) => <Pill key={role} label={roleLabel(role)} selected={inviteRole === role} onPress={() => setInviteRole(role)} />)}</View><PrimaryButton label={createInvite.isPending ? "Creating code…" : `Create ${roleLabel(inviteRole).toLowerCase()} invite`} icon="group-add" onPress={() => void issueInvite()} loading={createInvite.isPending} /></Card>
          {createdInvite ? <Card style={styles.codeCard}><Text style={styles.codeEyebrow}>SINGLE USE · {roleLabel(createdInvite.role).toUpperCase()} · EXPIRES {new Date(createdInvite.expiresAt).toLocaleString()}</Text><Text selectable style={styles.inviteCode}>{createdInvite.code}</Text><Text style={styles.smallNote}>This code is visible only now. Send it privately; it is stored as a hash.</Text><PrimaryButton label="Share invite" icon="share" tone="light" onPress={() => void shareInvite()} /></Card> : null}
          <SectionTitle title="Current members" />
          {members.data?.length ? <View style={styles.list}>{members.data.map((member) => <Card key={member.id} style={styles.memberCard}><View style={styles.memberTop}><View style={styles.memberAvatar}><Text style={styles.memberInitial}>{(member.displayName || member.email || "?").slice(0, 1).toUpperCase()}</Text></View><View style={{ flex: 1 }}><Text style={styles.memberName}>{member.displayName || "Team member"}</Text><Text style={styles.memberEmail}>{member.email || "Manus account"}</Text></View><View style={[styles.statusTag, member.status === "active" ? styles.activeTag : styles.suspendedTag]}><Text style={[styles.statusTagText, member.status === "active" ? styles.activeText : styles.suspendedText]}>{member.status.toUpperCase()}</Text></View></View><Text style={styles.memberRole}>ROLE · {roleLabel(member.role).toUpperCase()}</Text><View style={styles.memberActions}>{roles.filter((role) => role !== member.role).map((role) => <Pressable key={role} onPress={() => changeMember(member, { role })} style={styles.changeRole}><Text style={styles.changeRoleText}>Set {roleLabel(role)}</Text></Pressable>)}<Pressable onPress={() => changeMember(member, { status: member.status === "active" ? "suspended" : "active" })} style={styles.suspendButton}><Text style={styles.suspendText}>{member.status === "active" ? "Suspend" : "Reactivate"}</Text></Pressable></View></Card>)}</View> : <EmptyState icon="groups" title="No members loaded" body="Your active manager account appears here after the team refreshes." />}
          <SectionTitle title="Invite codes" />{invites.data?.length ? <View style={styles.list}>{invites.data.slice(0, 8).map((invite) => { const status = invite.usedAt ? "USED" : invite.revokedAt ? "REVOKED" : new Date(invite.expiresAt).getTime() <= now ? "EXPIRED" : "READY"; return <Card key={invite.id} style={styles.inviteRow}><View style={{ flex: 1 }}><Text style={styles.memberName}>{roleLabel(invite.role)} invite · {status}</Text><Text style={styles.memberEmail}>Expires {new Date(invite.expiresAt).toLocaleString()}</Text></View>{status === "READY" ? <Pressable onPress={() => ask("Revoke this invite?", "The unused code will no longer allow someone to join.", () => void (async () => { await revokeInvite.mutateAsync({ id: invite.id }); await utils.workspace.invites.invalidate(); })())} style={styles.suspendButton}><Text style={styles.suspendText}>Revoke</Text></Pressable> : null}</Card>; })}</View> : <Text style={styles.smallNote}>No invite codes yet.</Text>}
        </> : null}

        {section === "Offers" ? <>
          <Card style={styles.formCard}>
            <Text style={styles.cardTitle}>Create promotion or coupon</Text>
            <Text style={styles.smallNote}>Choose an offer rule and schedule it in the business timezone. Add a code so cashiers can enter it at checkout.</Text>
            <Field label="OFFER NAME" value={offerName} onChangeText={setOfferName} placeholder="e.g. Afternoon coffee" />
            <Field label="COUPON CODE · OPTIONAL" value={offerCode} onChangeText={(value) => setOfferCode(value.toUpperCase().replace(/\s/g, ""))} placeholder="HAPPYHOUR" />
            <Text style={[styles.fieldLabel, { marginTop: 12 }]}>PROMOTION RULE</Text>
            <View style={styles.roleChoices}>
              <Pill label="Percent / fixed discount" selected={offerRuleType === "discount"} onPress={() => setOfferRuleType("discount")} />
              <Pill label="Buy X · get Y free" selected={offerRuleType === "bogo"} onPress={() => setOfferRuleType("bogo")} />
              <Pill label="Fixed-price bundle" selected={offerRuleType === "bundle"} onPress={() => setOfferRuleType("bundle")} />
            </View>
            {offerRuleType === "discount" ? <>
              <View style={styles.roleChoices}><Pill label="Percentage" selected={offerType === "percent"} onPress={() => setOfferType("percent")} /><Pill label={`Fixed · ${workspace?.currency}`} selected={offerType === "fixed"} onPress={() => setOfferType("fixed")} /></View>
              <Field label={offerType === "percent" ? "DISCOUNT · %" : `DISCOUNT · ${workspace?.currency}`} value={offerValue} onChangeText={setOfferValue} placeholder="10" keyboardType="decimal-pad" />
            </> : null}
            {offerRuleType === "bogo" ? <>
              <OfferItemPicker label="BUY ITEM" items={sellableMenu} value={offerBuyItemId} onChange={setOfferBuyItemId} />
              <Field label="BUY QUANTITY · WHOLE ITEMS" value={offerBuyQuantity} onChangeText={setOfferBuyQuantity} placeholder="1" keyboardType="number-pad" />
              <OfferItemPicker label="FREE REWARD ITEM" items={sellableMenu} value={offerRewardItemId} onChange={setOfferRewardItemId} />
              <Field label="FREE REWARD QUANTITY · WHOLE ITEMS" value={offerRewardQuantity} onChangeText={setOfferRewardQuantity} placeholder="1" keyboardType="number-pad" />
              {!sellableMenu.length ? <Text style={styles.smallNote}>Add an available sellable menu item before creating a BOGO rule.</Text> : null}
            </> : null}
            {offerRuleType === "bundle" ? <>
              <Text style={[styles.fieldLabel, { marginTop: 12 }]}>BUNDLE CONTENTS · AT LEAST TWO DIFFERENT ITEMS</Text>
              {offerBundleItems.map((item, index) => <View key={`bundle-${index}`} style={{ padding: 9, borderWidth: 1, borderColor: palette.line, borderRadius: 11, marginTop: 7 }}>
                <OfferItemPicker label={`ITEM ${index + 1}`} items={sellableMenu} value={item.menuItemId} onChange={(menuItemId) => updateOfferBundleItem(index, { menuItemId })} />
                <Field label="QUANTITY · WHOLE ITEMS" value={item.quantity} onChangeText={(quantity) => updateOfferBundleItem(index, { quantity })} placeholder="1" keyboardType="number-pad" />
                {offerBundleItems.length > 2 ? <Pressable onPress={() => removeOfferBundleItem(index)} style={styles.changeRole}><Text style={styles.changeRoleText}>Remove item</Text></Pressable> : null}
              </View>)}
              <Pressable onPress={addOfferBundleItem} style={[styles.changeRole, { alignSelf: "flex-start", marginTop: 8 }]}><Text style={styles.changeRoleText}>＋ Add bundle item</Text></Pressable>
              <Field label={`FIXED BUNDLE PRICE · ${workspace?.currency}`} value={offerValue} onChangeText={setOfferValue} placeholder="0" keyboardType="decimal-pad" />
              {!sellableMenu.length ? <Text style={styles.smallNote}>Add sellable menu items before creating a bundle.</Text> : null}
            </> : null}
            <Text style={[styles.fieldLabel, { marginTop: 12 }]}>ACTIVE DATE / TIME · {promotionTimezone}</Text>
            <BusinessDateTimeField label="STARTS" value={offerStartAt} onChange={setOfferStartAt} timeZone={promotionTimezone} />
            <BusinessDateTimeField label="ENDS" value={offerEndAt} onChange={setOfferEndAt} timeZone={promotionTimezone} />
            <Text style={[styles.fieldLabel, { marginTop: 12 }]}>RECURRING WEEKDAYS · NONE SELECTED = EVERY DAY</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.roleChoices}>{weekdayOptions.map((day) => <Pill key={day.value} label={day.label} selected={offerWeekdays.includes(day.value)} onPress={() => toggleOfferWeekday(day.value)} />)}</ScrollView>
            <Text style={[styles.fieldLabel, { marginTop: 8 }]}>RECURRING DAILY WINDOW · OPTIONAL HAPPY HOUR · 24-HOUR CLOCK</Text>
            <BusinessTimeField label="DAILY START · LEAVE BOTH BLANK FOR ALL DAY" value={offerDailyStart} onChange={setOfferDailyStart} timeZone={promotionTimezone} />
            <BusinessTimeField label="DAILY END" value={offerDailyEnd} onChange={setOfferDailyEnd} timeZone={promotionTimezone} />
            {offerDailyStart || offerDailyEnd ? <Pressable onPress={() => { setOfferDailyStart(""); setOfferDailyEnd(""); }} style={[styles.changeRole, { alignSelf: "flex-start", marginTop: 8 }]}><Text style={styles.changeRoleText}>Clear daily window</Text></Pressable> : null}
            <Field label="MAX REDEMPTIONS · OPTIONAL" value={offerLimit} onChangeText={setOfferLimit} placeholder="Unlimited" keyboardType="number-pad" />
            <View style={{ height: 10 }} /><PrimaryButton label={saveOffer.isPending ? "Saving…" : "Create scheduled offer"} icon="sell" onPress={() => void makeOffer()} loading={saveOffer.isPending} disabled={saveOffer.isPending} />
          </Card>
          <SectionTitle title="Promotions & coupons" action={`${promotions.data?.length ?? 0} total`} />
          {promotions.data?.length ? <View style={styles.list}>{promotions.data.map((offer) => {
            const activeNow = isPromotionActiveAt(offer, now, promotionTimezone);
            const exhausted = offer.maxRedemptions !== undefined && offer.redemptionCount >= offer.maxRedemptions;
            const ended = Date.parse(offer.endsAt) < now;
            const statusLabel = !offer.active ? "OFF" : exhausted ? "LIMIT" : ended ? "ENDED" : activeNow ? "LIVE" : "SCHEDULED";
            const rule = offer.ruleType ?? "discount";
            const menuName = (id: string) => menu.find((item) => item.id === id)?.name ?? "menu item";
            const offerSummary = rule === "bogo"
              ? `Buy ${offer.buyQuantity ?? 1} ${menuName(offer.buyItemId ?? "")}, get ${offer.rewardQuantity ?? 1} ${menuName(offer.rewardItemId ?? "")} free`
              : rule === "bundle"
                ? `${offer.bundleItems?.map((item) => `${item.quantity} × ${menuName(item.menuItemId)}`).join(" + ") ?? "Bundle"} for ${currencyMoney(offer.bundlePrice ?? 0)}`
                : offer.discountType === "percent" ? `${offer.value}% off` : `${currencyMoney(offer.value)} off`;
            const days = offer.weekdays?.length ? weekdayOptions.filter((day) => offer.weekdays?.includes(day.value)).map((day) => day.label).join(", ") : "Every day";
            const dailyHours = offer.dailyStartTime && offer.dailyEndTime ? ` · ${offer.dailyStartTime}–${offer.dailyEndTime}` : "";
            let businessWindow = `${offer.startsAt} → ${offer.endsAt}`;
            try { businessWindow = `${businessDateTimeInput(new Date(offer.startsAt), promotionTimezone)} → ${businessDateTimeInput(new Date(offer.endsAt), promotionTimezone)}`; } catch { /* Keep the stored UTC values visible if timezone formatting fails. */ }
            const statusStyle = statusLabel === "LIVE" ? { backgroundColor: palette.evergreenSoft } : statusLabel === "SCHEDULED" ? { backgroundColor: palette.amberSoft } : { backgroundColor: palette.coralSoft };
            const statusTextStyle = statusLabel === "LIVE" ? { color: palette.evergreen } : statusLabel === "SCHEDULED" ? { color: "#98661F" } : { color: palette.coral };
            return <Card key={offer.id} style={styles.offerCard}>
              <View style={styles.memberTop}><View style={{ flex: 1 }}><Text style={styles.memberName}>{offer.name}</Text><Text style={styles.memberEmail}>{offerSummary}{offer.code ? ` · ${offer.code}` : " · register offer"}</Text></View><View style={[styles.statusTag, statusStyle]}><Text style={[styles.statusTagText, statusTextStyle]}>{statusLabel}</Text></View></View>
              <Text style={styles.memberEmail}>{businessWindow} · {promotionTimezone}</Text>
              <Text style={styles.memberEmail}>{days}{dailyHours} · {offer.redemptionCount} uses{offer.maxRedemptions ? ` / ${offer.maxRedemptions}` : ""}</Text>
              {offer.active ? <Pressable onPress={() => ask("Turn off this offer?", "Cashiers will no longer be able to apply it.", () => void turnOffOffer(offer.id))} style={styles.deactivateButton}><Text style={styles.deactivateText}>Deactivate offer</Text></Pressable> : null}
            </Card>;
          })}</View> : <EmptyState icon="sell" title="No offers yet" body="Create a scheduled discount, Buy X Get Y offer or conditional bundle; add a code to make it a coupon." />}
        </> : null}

        {section === "Gift & loyalty" ? <>
          <Card style={styles.formCard}><Text style={styles.cardTitle}>Issue a gift card</Text><Text style={styles.smallNote}>The code is displayed once. Its unredeemed amount is posted as a liability, not sales income.</Text><Field label={`STARTING VALUE · ${workspace?.currency}`} value={giftAmount} onChangeText={setGiftAmount} placeholder="0" keyboardType="decimal-pad" /><Field label="CUSTOMER · OPTIONAL" value={giftCustomer} onChangeText={setGiftCustomer} placeholder="Name" /><View style={styles.roleChoices}>{methodOptions.map((method) => <Pill key={method} label={method} selected={giftMethod === method} onPress={() => { setGiftMethod(method); setQrisVerified(false); }} />)}</View>{giftMethod === "QRIS" ? <Pressable onPress={() => setQrisVerified(!qrisVerified)} style={styles.confirmRow}><View style={[styles.checkbox, qrisVerified && styles.checkboxActive]}>{qrisVerified ? <MaterialIcons name="check" size={12} color={palette.white} /> : null}</View><Text style={styles.smallNote}>I verified the QRIS settlement in the merchant app.</Text></Pressable> : null}<PrimaryButton label={issueGift.isPending ? "Issuing…" : "Issue gift card"} icon="card-giftcard" onPress={() => void issueCard()} loading={issueGift.isPending} disabled={giftMethod === "QRIS" && !qrisVerified} /></Card>
          <SectionTitle title="Gift cards" action={`${giftCards.data?.length ?? 0} issued`} />
          {giftCards.data?.length ? <View style={styles.list}>{giftCards.data.slice(0, 8).map((card) => <Card key={card.id} style={styles.offerCard}><View style={styles.memberTop}><View style={{ flex: 1 }}><Text style={styles.memberName}>•••• {card.lastFour} · {card.customerName || "Gift card"}</Text><Text style={styles.memberEmail}>Issued {new Date(card.issuedAt).toLocaleDateString()} · starting value {currencyMoney(card.initialBalance)}</Text></View><Text style={styles.cardBalance}>{currencyMoney(card.balance)}</Text></View><Text style={styles.memberEmail}>{card.status.toUpperCase()} · balance remaining</Text></Card>)}</View> : <Text style={styles.smallNote}>Gift-card balances will appear here.</Text>}
          {giftMovements.data?.length ? <><SectionTitle title="Gift-card history" /><View style={styles.list}>{giftMovements.data.slice(0, 12).map((movement) => <View key={String(movement.id)} style={styles.auditRow}><Text style={styles.auditPrimary}>•••• {movement.lastFour} · {movement.kind === "issue" ? "Issued" : movement.kind === "reversal" ? "Balance restored" : "Redeemed"}</Text><Text style={styles.auditAmount}>{currencyMoney(Number(movement.amount ?? 0))}</Text><Text style={styles.auditDate}>{new Date(String(movement.at)).toLocaleString()}</Text></View>)}</View></> : null}
          <SectionTitle title="Loyalty rules" /><Card style={styles.formCard}><Text style={styles.smallNote}>Customers earn points after payment. Points reduce the next eligible ticket at the value below.</Text><Field label={`SPEND PER EARNING STEP · ${workspace?.currency}`} value={currencyStepValue} onChangeText={setCurrencyStep} placeholder={workspace?.currency === "IDR" ? "10000" : "1"} keyboardType="decimal-pad" /><Field label="POINTS EARNED PER STEP" value={pointsEarnedValue} onChangeText={setPointsEarned} placeholder="1" keyboardType="number-pad" /><Field label={`REDEMPTION VALUE PER POINT · ${workspace?.currency}`} value={pointValueValue} onChangeText={setPointValue} placeholder={workspace?.currency === "IDR" ? "100" : "0.01"} keyboardType="decimal-pad" /><PrimaryButton label={saveLoyalty.isPending ? "Saving…" : "Save loyalty rules"} icon="loyalty" tone="light" onPress={() => void savePoints()} loading={saveLoyalty.isPending} /></Card>
          <SectionTitle title="Loyalty members" action={`${loyaltyCustomers.data?.length ?? 0} customers`} />{loyaltyCustomers.data?.length ? <View style={styles.list}>{loyaltyCustomers.data.slice(0, 10).map((customer) => <View key={customer.id} style={styles.auditRow}><Text style={styles.auditPrimary}>{customer.customerName} · {customer.phone}</Text><Text style={styles.auditAmount}>{customer.pointsBalance} pts</Text></View>)}</View> : <Text style={styles.smallNote}>Cashiers can enroll customers from checkout.</Text>}
          {loyaltyMovements.data?.length ? <><SectionTitle title="Points history" /><View style={styles.list}>{loyaltyMovements.data.slice(0, 12).map((movement) => <View key={String(movement.id)} style={styles.auditRow}><Text style={styles.auditPrimary}>{movement.customerName} · {movement.kind === "reversal" ? "Refund/void adjustment" : "Sale points"} · {movement.pointsChange > 0 ? "+" : ""}{movement.pointsChange} pts{movement.earnedPointsUnavailable > 0 ? ` · ${movement.earnedPointsUnavailable} previously spent points preserved` : ""}</Text><Text style={styles.auditDate}>{new Date(String(movement.at)).toLocaleString()}</Text></View>)}</View></> : null}
        </> : null}

        {section === "Settings" ? <>
          <Card style={styles.formCard}><Text style={styles.cardTitle}>Business & financial defaults</Text><Text style={styles.smallNote}>Currency is chosen when the workspace is created and stays fixed to protect menu prices and accounting. Tax begins at zero unless your manager sets it.</Text><Field label="BUSINESS NAME" value={businessNameValue} onChangeText={setBusinessName} placeholder="Business name" /><Text style={styles.fieldLabel}>WORKSPACE CURRENCY · LOCKED</Text><View style={{ minHeight: 42, justifyContent: "center", borderColor: palette.line, borderWidth: 1, borderRadius: 11, backgroundColor: palette.surface, paddingHorizontal: 11, marginBottom: 9 }}><Text style={{ color: palette.ink, fontSize: 12, fontWeight: "800" }}>{workspace?.currency ?? settings.data?.currency ?? "IDR"}</Text></View><Field label="BUSINESS TIME ZONE · IANA" value={businessTimezoneValue} onChangeText={setBusinessTimezone} placeholder="Asia/Jakarta" /><Field label="SALES TAX · %" value={taxPercentValue} onChangeText={setTaxPercent} placeholder="0" keyboardType="decimal-pad" /><PrimaryButton label={updateSettings.isPending ? "Saving…" : "Save business settings"} icon="save" onPress={() => void saveBusiness()} loading={updateSettings.isPending} disabled={!settingsReady || updateSettings.isPending} /></Card>
          <SectionTitle title="Local register history" />
          <Card style={styles.formCard}><Text style={styles.cardTitle}>{legacyRead ? alreadyImported ? "Legacy import already used" : `${recordCount} records on this device` : "Looking for local records…"}</Text><Text style={styles.smallNote}>Your earlier local register stays on this device. Import only if its original amounts are already in {workspace?.currency}; this process never converts or silently copies values.</Text>{recordCount > 0 && !alreadyImported ? <><Pressable onPress={() => setLegacyConfirmed(!legacyConfirmed)} style={styles.confirmRow}><View style={[styles.checkbox, legacyConfirmed && styles.checkboxActive]}>{legacyConfirmed ? <MaterialIcons name="check" size={12} color={palette.white} /> : null}</View><Text style={styles.smallNote}>I confirm the local amounts use {workspace?.currency}.</Text></Pressable><PrimaryButton label={importLegacy.isPending ? "Importing…" : "Import local records once"} icon="cloud-upload" tone="light" disabled={!legacyConfirmed || importLegacy.isPending} loading={importLegacy.isPending} onPress={() => void importOldRecords()} /></> : null}{alreadyImported ? <Text style={styles.noticeText}>A prior import was completed from this device.</Text> : null}</Card>
        </> : null}

        <View style={styles.footer}><MaterialIcons name="cloud-done" size={15} color={palette.evergreen} /><Text style={styles.footerText}>Cloud workspace · server-checked roles · online updates in seconds</Text></View>
      </ScrollView>
      <Modal visible={Boolean(inventoryAction)} transparent animationType="slide" onRequestClose={() => setInventoryAction(null)}><View style={styles.giftBackdrop}><Card style={{ width: "100%", padding: 17 }}><Text style={styles.cardTitle}>{inventoryAction?.mode === "receive" ? "Receive stock" : "Stock opname"}</Text><Text style={styles.smallNote}>{inventoryAction?.item.name} · current balance {inventoryAction?.item.stockOnHand ?? 0} {inventoryAction?.item.stockUnit ?? "unit"}</Text><Field label={inventoryAction?.mode === "receive" ? `QUANTITY RECEIVED · ${inventoryAction?.item.stockUnit ?? "unit"}` : `PHYSICAL COUNT · ${inventoryAction?.item.stockUnit ?? "unit"}`} value={inventoryQuantity} onChangeText={setInventoryQuantity} placeholder="0" keyboardType={inventoryAction?.item.ingredientOnly === true ? "decimal-pad" : "number-pad"} />{inventoryAction?.mode === "opname" && inventoryQuantity.trim() && Number.isFinite(Number(inventoryQuantity)) ? <Text style={styles.smallNote}>Variance: {Number(inventoryQuantity) - Number(inventoryAction.item.stockOnHand ?? 0) > 0 ? "+" : ""}{Number(inventoryQuantity) - Number(inventoryAction.item.stockOnHand ?? 0)} {inventoryAction.item.stockUnit ?? "unit"}</Text> : null}<Field label="REASON · REQUIRED" value={inventoryReason} onChangeText={setInventoryReason} placeholder={inventoryAction?.mode === "receive" ? "e.g. Supplier delivery" : "e.g. Weekly shelf count"} />{inventoryError ? <Text style={[styles.errorText, { marginTop: 8 }]}>{inventoryError}</Text> : null}<View style={{ height: 12 }} /><PrimaryButton label={receiveStock.isPending || stockOpname.isPending ? "Saving…" : inventoryAction?.mode === "receive" ? "Add stock" : "Post stock opname"} icon={inventoryAction?.mode === "receive" ? "add-box" : "fact-check"} loading={receiveStock.isPending || stockOpname.isPending} disabled={receiveStock.isPending || stockOpname.isPending} onPress={() => void saveInventoryAction()} /><Pressable onPress={() => setInventoryAction(null)} style={styles.dismiss}><Text style={styles.dismissText}>Cancel</Text></Pressable></Card></View></Modal>
      <Modal visible={Boolean(giftCodeOnce)} transparent animationType="fade" onRequestClose={() => setGiftCodeOnce("")}><View style={styles.giftBackdrop}><Card style={styles.giftModal}><View style={styles.giftIcon}><MaterialIcons name="card-giftcard" size={24} color={palette.white} /></View><Text style={styles.cardTitle}>Gift card issued</Text><Text style={styles.smallNote}>Share this secure code with the recipient now. It cannot be displayed again.</Text><Text selectable style={styles.giftCode}>{giftCodeOnce}</Text><PrimaryButton label="Share code" icon="share" onPress={() => void Share.share({ title: "Your Till & Table gift card", message: `Gift card code: ${giftCodeOnce}` })} /><Pressable onPress={() => setGiftCodeOnce("")} style={styles.dismiss}><Text style={styles.dismissText}>Done</Text></Pressable></Card></View></Modal>
    </ScreenContainer>
  );
}

function Metric({ label, value }: { label: string; value: string }) { return <Card style={styles.metric}><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></Card>; }
function Field({ label, value, onChangeText, placeholder, keyboardType }: { label: string; value: string; onChangeText: (value: string) => void; placeholder: string; keyboardType?: "default" | "decimal-pad" | "number-pad" }) { return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor="#99A39B" keyboardType={keyboardType ?? "default"} autoCapitalize="sentences" style={styles.input} /></View>; }

function OfferItemPicker({ label, items, value, onChange }: { label: string; items: MenuItem[]; value: string; onChange: (itemId: string) => void }) {
  return <View style={styles.field}>
    <Text style={styles.fieldLabel}>{label}</Text>
    {items.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.roleChoices}>{items.map((item) => <Pill key={item.id} label={item.name} selected={value === item.id} onPress={() => onChange(item.id)} />)}</ScrollView> : <Text style={styles.smallNote}>No available sellable menu items. Add one in Menu first.</Text>}
  </View>;
}

const styles = StyleSheet.create({ content: { paddingHorizontal: 17, paddingTop: 12, paddingBottom: 35, backgroundColor: palette.background }, topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }, signOut: { flexDirection: "row", alignItems: "center", gap: 5, padding: 7 }, signOutText: { color: palette.muted, fontSize: 10, fontWeight: "800" }, managerMark: { width: 42, height: 42, borderRadius: 14, backgroundColor: palette.evergreenSoft, alignItems: "center", justifyContent: "center" }, sectionTabs: { flexDirection: "row", gap: 7, paddingBottom: 13 }, errorBanner: { flexDirection: "row", gap: 7, backgroundColor: palette.coralSoft, padding: 10, borderRadius: 11, marginBottom: 8 }, errorText: { color: palette.coral, fontSize: 10, lineHeight: 15, flex: 1 }, notice: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: palette.evergreenSoft, padding: 9, borderRadius: 10, marginBottom: 8 }, noticeText: { color: palette.evergreen, fontSize: 10, fontWeight: "700", flex: 1 }, metricRow: { flexDirection: "row", gap: 8 }, metric: { flex: 1, padding: 12 }, metricValue: { color: palette.evergreen, fontSize: 22, fontWeight: "900" }, metricLabel: { color: palette.muted, fontSize: 8, fontWeight: "900", letterSpacing: 0.7, marginTop: 3 }, inviteCard: { padding: 13 }, cardTitle: { color: palette.ink, fontSize: 13, fontWeight: "900" }, smallNote: { color: palette.muted, fontSize: 9, lineHeight: 14, marginTop: 5 }, roleChoices: { flexDirection: "row", gap: 6, flexWrap: "wrap", marginVertical: 10 }, codeCard: { padding: 14, marginTop: 9, borderColor: palette.evergreen, borderWidth: 1 }, codeEyebrow: { color: palette.muted, fontSize: 8, fontWeight: "900", letterSpacing: 0.7 }, inviteCode: { color: palette.evergreen, fontSize: 24, fontWeight: "900", letterSpacing: 2, marginVertical: 8 }, memberCard: { padding: 11 }, list: { gap: 7 }, memberTop: { flexDirection: "row", alignItems: "center", gap: 8 }, memberAvatar: { width: 34, height: 34, borderRadius: 12, backgroundColor: palette.evergreenSoft, alignItems: "center", justifyContent: "center" }, memberInitial: { color: palette.evergreen, fontSize: 13, fontWeight: "900" }, memberName: { color: palette.ink, fontSize: 10, fontWeight: "900" }, memberEmail: { color: palette.muted, fontSize: 8, marginTop: 3 }, statusTag: { paddingHorizontal: 7, paddingVertical: 4, borderRadius: 8 }, activeTag: { backgroundColor: palette.evergreenSoft }, suspendedTag: { backgroundColor: palette.coralSoft }, statusTagText: { fontSize: 7, fontWeight: "900" }, activeText: { color: palette.evergreen }, suspendedText: { color: palette.coral }, memberRole: { color: palette.muted, fontSize: 8, fontWeight: "800", marginTop: 8 }, memberActions: { flexDirection: "row", gap: 5, flexWrap: "wrap", marginTop: 8 }, changeRole: { borderWidth: 1, borderColor: palette.line, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 6, backgroundColor: "#FBFAF5" }, changeRoleText: { color: palette.evergreen, fontSize: 8, fontWeight: "800" }, suspendButton: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: palette.coralSoft }, suspendText: { color: palette.coral, fontSize: 8, fontWeight: "800" }, inviteRow: { padding: 10, flexDirection: "row", alignItems: "center", gap: 6 }, formCard: { padding: 13 }, field: { marginTop: 10 }, fieldLabel: { color: palette.muted, fontSize: 8, fontWeight: "900", letterSpacing: 0.8, marginBottom: 5 }, input: { minHeight: 41, borderRadius: 11, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, paddingHorizontal: 10, color: palette.ink, fontSize: 10 }, offerCard: { padding: 11 }, deactivateButton: { alignSelf: "flex-start", paddingHorizontal: 9, paddingVertical: 6, backgroundColor: palette.coralSoft, borderRadius: 9, marginTop: 9 }, deactivateText: { color: palette.coral, fontSize: 8, fontWeight: "800" }, confirmRow: { flexDirection: "row", alignItems: "center", gap: 7, marginVertical: 9 }, checkbox: { width: 17, height: 17, borderRadius: 5, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, alignItems: "center", justifyContent: "center" }, checkboxActive: { backgroundColor: palette.evergreen, borderColor: palette.evergreen }, cardBalance: { color: palette.evergreen, fontSize: 14, fontWeight: "900" }, auditRow: { backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 11, padding: 9, flexDirection: "row", alignItems: "center", gap: 7, flexWrap: "wrap" }, auditPrimary: { flex: 1, color: palette.ink, fontSize: 8, fontWeight: "800" }, auditAmount: { color: palette.evergreen, fontSize: 8, fontWeight: "900" }, auditDate: { color: palette.muted, fontSize: 7 }, profileCard: { alignItems: "center", padding: 21, marginTop: 10 }, profileIcon: { width: 55, height: 55, borderRadius: 18, backgroundColor: palette.evergreenSoft, alignItems: "center", justifyContent: "center" }, profileName: { color: palette.ink, fontSize: 17, fontWeight: "900", marginTop: 13 }, profileBusiness: { color: palette.muted, fontSize: 11, marginTop: 3 }, rolePill: { backgroundColor: palette.amberSoft, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 5, marginTop: 10 }, rolePillText: { color: "#98661F", fontSize: 8, fontWeight: "900" }, profileNote: { color: palette.muted, fontSize: 10, lineHeight: 16, textAlign: "center", marginVertical: 17 }, footer: { flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", marginTop: 20 }, footerText: { color: palette.muted, fontSize: 8, textAlign: "center", flexShrink: 1 }, giftBackdrop: { flex: 1, backgroundColor: "rgba(17,36,30,0.42)", justifyContent: "center", padding: 21 }, giftModal: { padding: 18, alignItems: "center" }, giftIcon: { width: 48, height: 48, borderRadius: 16, backgroundColor: palette.evergreen, alignItems: "center", justifyContent: "center", marginBottom: 12 }, giftCode: { color: palette.evergreen, fontSize: 19, letterSpacing: 2, fontWeight: "900", marginVertical: 17, textAlign: "center" }, dismiss: { marginTop: 12, padding: 8 }, dismissText: { color: palette.muted, fontSize: 10, fontWeight: "800" } });
