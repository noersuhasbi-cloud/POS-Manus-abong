import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { Card, elapsedLabel, EmptyState, orderStatusColor, PageHeader, palette, Pill, PrimaryButton, shortTime, StatusPill } from "@/components/pos/ui";
import { type KitchenOrder, type OrderStatus, usePos } from "@/lib/pos-store";
import { useWorkspace } from "@/lib/workspace-context";

const filters = ["Active", "New", "Preparing", "Ready", "Completed", "Cancelled"] as const;
type KitchenFilter = (typeof filters)[number];
const INITIAL_KITCHEN_NOW = Date.now();

function nextStatus(status: OrderStatus): OrderStatus {
  if (status === "new") return "preparing";
  if (status === "preparing") return "ready";
  return "completed";
}

function nextAction(status: OrderStatus) {
  if (status === "new") return { label: "Start preparing", icon: "play-arrow" as const };
  if (status === "preparing") return { label: "Mark order ready", icon: "check" as const };
  if (status === "ready") return { label: "Complete handoff", icon: "outbox" as const };
  return { label: "Completed", icon: "done-all" as const };
}

function KitchenTicket({ order, onAdvance, now, timezone, canAdvance, busy, actionError }: { order: KitchenOrder; onAdvance: () => void; now: number; timezone: string; canAdvance: boolean; busy: boolean; actionError: string }) {
  const statusColor = orderStatusColor(order.status);
  const minutes = Math.floor((now - new Date(order.createdAt).getTime()) / 60_000);
  const slow = minutes >= 8 && order.status !== "completed";
  const action = nextAction(order.status);
  return (
    <Card style={[styles.ticket, slow && order.status === "new" && styles.ticketLate]}>
      <View style={styles.ticketTop}>
        <View style={styles.orderNumberWrap}><Text style={styles.orderNumber}>{order.number}</Text><Text style={styles.orderTime}>{shortTime(order.createdAt, timezone)}</Text></View>
        <View style={styles.ticketTopRight}><View style={[styles.timerPill, { backgroundColor: slow ? palette.coralSoft : statusColor.bg }]}><MaterialIcons name="schedule" size={13} color={slow ? palette.coral : statusColor.fg} /><Text style={[styles.timerText, { color: slow ? palette.coral : statusColor.fg }]}>{elapsedLabel(order.createdAt, now)}</Text></View><StatusPill status={order.status} /></View>
      </View>
      <View style={styles.ticketDivider} />
      <View style={styles.ticketLines}>
        {order.items.map((line) => (
          <View key={line.id} style={styles.itemLine}>
            <View style={styles.itemQty}><Text style={styles.itemQtyText}>{line.quantity}</Text></View>
            <View style={{ flex: 1 }}><Text style={styles.itemName}>{line.name}{line.modifiers?.length ? ` · ${line.modifiers.map((modifier) => modifier.label).join(", ")}` : line.modifier ? ` · ${line.modifier.label}` : ""}</Text>{line.note ? <Text style={styles.itemNote}>{line.note}</Text> : null}</View>
          </View>
        ))}
      </View>
      <View style={styles.ticketFooter}><Text style={styles.itemCount}>{order.items.reduce((sum, line) => sum + line.quantity, 0)} items · prep ticket</Text><Text style={styles.methodLabel}>POS</Text></View>
      {order.status !== "completed" && order.status !== "cancelled" && canAdvance ? <><PrimaryButton label={busy ? "Updating shared ticket…" : action.label} icon={action.icon} tone={order.status === "ready" ? "amber" : "green"} onPress={onAdvance} loading={busy} disabled={busy} />{actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}</> : order.status !== "completed" && order.status !== "cancelled" ? <View style={styles.completedBanner}><MaterialIcons name="sync" size={15} color={palette.evergreen} /><Text style={styles.completedText}>Status updates across the team</Text></View> : <View style={styles.completedBanner}><MaterialIcons name={order.status === "cancelled" ? "block" : "done-all"} size={15} color={order.status === "cancelled" ? palette.coral : palette.muted} /><Text style={[styles.completedText, order.status === "cancelled" && { color: palette.coral }]}>{order.status === "cancelled" ? "Voided · prep stopped" : "Handed off"}</Text></View>}
    </Card>
  );
}

export default function KitchenScreen() {
  const { orders, updateOrderStatus } = usePos();
  const { workspace } = useWorkspace();
  const timezone = workspace?.timezone ?? "Asia/Jakarta";
  const canAdvance = workspace?.role === "manager" || workspace?.role === "kitchen";
  const [filter, setFilter] = useState<KitchenFilter>("Active");
  const [now, setNow] = useState(INITIAL_KITCHEN_NOW);
  const [pendingOrderId, setPendingOrderId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [failedOrderId, setFailedOrderId] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const activeCount = orders.filter((order) => order.status !== "completed" && order.status !== "cancelled").length;
  const newCount = orders.filter((order) => order.status === "new").length;
  const visibleOrders = useMemo(() => {
    const filtered = orders.filter((order) => {
      if (filter === "Active") return order.status !== "completed" && order.status !== "cancelled";
      return order.status === filter.toLowerCase();
    });
    return filtered.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [orders, filter]);

  async function advance(order: KitchenOrder) {
    setActionError("");
    setFailedOrderId(null);
    setPendingOrderId(order.id);
    try { await updateOrderStatus(order.id, nextStatus(order.status)); }
    catch (err) { setActionError(err instanceof Error ? err.message : "Kitchen status could not be saved. Check your connection and retry."); setFailedOrderId(order.id); }
    finally { setPendingOrderId(null); }
  }

  return (
    <ScreenContainer containerClassName="bg-background" safeAreaClassName="bg-background">
      <ScrollView style={styles.page} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.topStrip}><View style={styles.liveLabel}><View style={styles.liveDot} /><Text style={styles.liveText}>LIVE KITCHEN</Text></View><Text style={styles.shiftClock}>{shortTime(new Date(now).toISOString(), timezone)}</Text></View>
        <PageHeader eyebrow={`${workspace?.name ?? "Workspace"} · ${workspace?.role ?? "team"}`} title="Order board" subtitle="Cloud tickets refresh across cashier and kitchen stations." right={<View style={styles.activeCount}><Text style={styles.activeCountValue}>{activeCount}</Text><Text style={styles.activeCountLabel}>ACTIVE</Text></View>} />
        <Card style={styles.newTicketBanner}><View style={styles.bannerIcon}><MaterialIcons name="notifications-active" size={19} color={newCount ? palette.evergreen : palette.muted} /></View><View style={{ flex: 1 }}><Text style={styles.bannerTitle}>{newCount ? `${newCount} new ${newCount === 1 ? "ticket" : "tickets"}` : "You’re all caught up"}</Text><Text style={styles.bannerSub}>{newCount ? "Start the first ticket when your station is ready." : "New cashier orders will appear here."}</Text></View><Text style={styles.bannerArrow}>KITCHEN</Text></Card>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
          {filters.map((value) => <Pill key={value} label={value} selected={filter === value} count={value === "Active" ? activeCount : value === "New" ? newCount : undefined} onPress={() => setFilter(value)} />)}
        </ScrollView>
        {visibleOrders.length === 0 ? (
          <EmptyState icon={filter === "Completed" ? "done-all" : "soup-kitchen"} title={filter === "Completed" ? "No handoffs yet" : "Your pass is clear"} body={filter === "Completed" ? "Completed kitchen tickets will stay here for the shift." : "When the cashier completes a sale, its ticket will appear here instantly."} />
        ) : (
          <View style={styles.ticketList}>{visibleOrders.map((order) => <KitchenTicket key={order.id} order={order} now={now} timezone={timezone} canAdvance={canAdvance} busy={pendingOrderId === order.id} actionError={failedOrderId === order.id ? actionError : ""} onAdvance={() => void advance(order)} />)}</View>
        )}
        <View style={styles.syncNote}><MaterialIcons name="cloud-done" size={16} color={palette.evergreen} /><Text style={styles.syncNoteText}>Shared workspace queue · online updates appear in seconds.</Text></View>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.background },
  content: { paddingHorizontal: 18, paddingTop: 10, paddingBottom: 25 },
  topStrip: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 18 },
  liveLabel: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: palette.evergreen, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 7 },
  liveDot: { width: 7, height: 7, borderRadius: 5, backgroundColor: "#9DD19F" },
  liveText: { color: palette.white, fontSize: 9, fontWeight: "900", letterSpacing: 1.3 },
  shiftClock: { color: palette.muted, fontSize: 12, fontWeight: "700" },
  activeCount: { minWidth: 53, height: 53, borderRadius: 17, backgroundColor: palette.amberSoft, alignItems: "center", justifyContent: "center" },
  activeCountValue: { color: "#98661F", fontSize: 19, fontWeight: "900" },
  activeCountLabel: { color: "#98661F", fontSize: 8, fontWeight: "900", letterSpacing: 0.6 },
  newTicketBanner: { backgroundColor: palette.evergreenSoft, borderColor: "#DAE5DB", padding: 12, flexDirection: "row", alignItems: "center", gap: 10, marginTop: -2, marginBottom: 15 },
  bannerIcon: { width: 35, height: 35, borderRadius: 12, backgroundColor: palette.surface, alignItems: "center", justifyContent: "center" },
  bannerTitle: { color: palette.ink, fontSize: 12, fontWeight: "900" },
  bannerSub: { color: palette.muted, fontSize: 10, marginTop: 3, lineHeight: 14 },
  bannerArrow: { color: palette.evergreen, fontSize: 8, fontWeight: "900", letterSpacing: 1 },
  filters: { gap: 7, paddingBottom: 12 },
  ticketList: { gap: 11 },
  ticket: { padding: 14 },
  ticketLate: { borderColor: "#E6B09A" },
  ticketTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  orderNumberWrap: { gap: 3 },
  orderNumber: { color: palette.ink, fontSize: 17, fontWeight: "900" },
  orderTime: { color: palette.muted, fontSize: 10, fontWeight: "600" },
  ticketTopRight: { alignItems: "flex-end", gap: 7 },
  timerPill: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 10 },
  timerText: { fontSize: 10, fontWeight: "800" },
  ticketDivider: { height: 1, backgroundColor: palette.line, marginVertical: 11 },
  ticketLines: { gap: 10 },
  itemLine: { flexDirection: "row", alignItems: "flex-start", gap: 9 },
  itemQty: { minWidth: 23, height: 23, paddingHorizontal: 4, borderRadius: 8, backgroundColor: palette.evergreenSoft, alignItems: "center", justifyContent: "center" },
  itemQtyText: { color: palette.evergreen, fontSize: 11, fontWeight: "900" },
  itemName: { color: palette.ink, fontSize: 12, fontWeight: "800", lineHeight: 16 },
  itemNote: { color: palette.coral, fontSize: 10, fontWeight: "700", marginTop: 3 },
  ticketFooter: { flexDirection: "row", justifyContent: "space-between", marginTop: 13, marginBottom: 12 },
  itemCount: { color: palette.muted, fontSize: 10, fontWeight: "700" },
  methodLabel: { color: palette.muted, fontSize: 8, fontWeight: "900", letterSpacing: 1 },
  completedBanner: { minHeight: 42, backgroundColor: "#EEF0EB", borderRadius: 13, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  completedText: { color: palette.muted, fontSize: 9, fontWeight: "700" },
  actionError: { color: palette.coral, fontSize: 9, fontWeight: "700", marginTop: 5 },
  syncNote: { marginTop: 14, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6 },
  syncNoteText: { color: palette.muted, fontSize: 10 },
});
