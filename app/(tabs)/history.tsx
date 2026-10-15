import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Redirect } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { Card, Divider, EmptyState, PageHeader, palette, paymentIcon, Pill, PrimaryButton, shortTime, transactionStatusColor } from "@/components/pos/ui";
import { type Transaction, usePos } from "@/lib/pos-store";
import { useWorkspace } from "@/lib/workspace-context";

type HistoryFilter = "All" | "Paid" | "Refunded" | "Voided";
function lineModifiers(line: Transaction["items"][number]) { return line.modifiers?.length ? line.modifiers : line.modifier ? [line.modifier] : []; }
function lineModifierText(line: Transaction["items"][number]) { return lineModifiers(line).map((modifier) => modifier.label).join(", "); }
function transactionLineTotal(line: Transaction["items"][number]) { return (line.unitPrice + lineModifiers(line).reduce((sum, modifier) => sum + modifier.price, 0)) * line.quantity; }

export default function HistoryScreen() {
  const { transactions, refundTransaction, voidTransaction, money, error } = usePos();
  const { workspace } = useWorkspace();
  const canAdjust = workspace?.role === "manager";
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HistoryFilter>("All");
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [notice, setNotice] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return transactions.filter((transaction) => {
      const filterMatch = filter === "All" || transaction.status === filter.toLowerCase();
      const searchMatch = !normalized || `${transaction.orderNumber} ${transaction.items.map((item) => `${item.name} ${lineModifierText(item)}`).join(" ")} ${transaction.paymentMethod} ${transaction.customerName ?? ""}`.toLowerCase().includes(normalized);
      return filterMatch && searchMatch;
    });
  }, [transactions, query, filter]);

  function confirmAction(kind: "refund" | "void", transaction: Transaction) {
    const message = kind === "refund"
      ? `Record a full refund of ${money(transaction.total)} for ${transaction.orderNumber}? This creates a reversing ledger entry; actual money returns still happen outside the app.`
      : `Void ${transaction.orderNumber}? This creates a reversing ledger entry; it does not reverse a card or QRIS payment.`;
    const run = () => void (async () => {
      try {
        if (kind === "refund") await refundTransaction(transaction.id);
        else await voidTransaction(transaction.id);
        setNotice(kind === "refund" ? `Full refund recorded for ${transaction.orderNumber}.` : `${transaction.orderNumber} marked void.`);
        setSelected(null);
      } catch (err) { setNotice(err instanceof Error ? err.message : "The accounting update did not finish."); }
    })();
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (window.confirm(message)) run();
      return;
    }
    Alert.alert(kind === "refund" ? "Record full refund?" : "Void this sale?", message, [
      { text: "Keep sale", style: "cancel" },
      { text: kind === "refund" ? "Record refund" : "Void sale", style: "destructive", onPress: run },
    ]);
  }

  async function shareReceipt(transaction: Transaction) {
    const rows = transaction.items.map((line) => `• ${line.quantity} × ${line.name}${lineModifierText(line) ? ` (${lineModifierText(line)})` : ""} — ${money(transactionLineTotal(line))}`).join("\n");
    const message = `TILL & TABLE\n${workspace?.name ?? "Workspace"}\nOrder ${transaction.orderNumber} · ${new Date(transaction.createdAt).toLocaleString()}\n\n${rows}\n\nSubtotal ${money(transaction.subtotal)}\nDiscount −${money(transaction.discount)}\nTax ${money(transaction.tax)}\nTOTAL ${money(transaction.total)}\nPaid by ${transaction.paymentMethod}\nStatus ${transaction.status.toUpperCase()}`;
    try { await Share.share({ message, title: `Receipt ${transaction.orderNumber}` }); } catch { /* The in-app receipt remains available. */ }
  }

  const chosen = transactions.find((transaction) => transaction.id === selected?.id) ?? selected;
  const selectedColor = chosen ? transactionStatusColor(chosen.status) : null;
  if (workspace?.role === "kitchen") return <Redirect href="/(tabs)/kitchen" />;
  return (
    <ScreenContainer containerClassName="bg-background" safeAreaClassName="bg-background">
      <View style={styles.page}>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <PageHeader eyebrow={`${workspace?.name ?? "Workspace"} · shared register`} title="Transaction log" subtitle={`${transactions.length} cloud ${transactions.length === 1 ? "record" : "records"} · updates across signed-in devices`} right={<View style={styles.historyIcon}><MaterialIcons name="manage-search" size={21} color={palette.evergreen} /></View>} />
          <View style={styles.searchBox}><MaterialIcons name="search" size={20} color={palette.muted} /><TextInput value={query} onChangeText={setQuery} placeholder="Search order, item, customer" placeholderTextColor="#98A39A" style={styles.searchInput} returnKeyType="search" /><Pressable onPress={() => setQuery("")} style={styles.clearSearch}>{query ? <MaterialIcons name="close" size={18} color={palette.muted} /> : null}</Pressable></View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>{(["All", "Paid", "Refunded", "Voided"] as const).map((value) => <Pill key={value} label={value} selected={filter === value} count={value === "All" ? transactions.length : undefined} onPress={() => setFilter(value)} />)}</ScrollView>
          {error ? <View style={styles.errorBanner}><MaterialIcons name="cloud-off" size={16} color={palette.coral} /><Text style={styles.errorText}>{error}</Text></View> : null}
          {notice ? <Pressable onPress={() => setNotice("")} style={styles.notice}><MaterialIcons name="info-outline" size={16} color={palette.evergreen} /><Text style={styles.noticeText}>{notice}</Text><MaterialIcons name="close" size={15} color={palette.muted} /></Pressable> : null}
          {filtered.length === 0 ? <EmptyState icon={query || transactions.length ? "search-off" : "receipt-long"} title={query || transactions.length ? "No matching tickets" : "No sales yet"} body={query || transactions.length ? "Try another order number, menu item, customer or filter." : "Completed cashier sales from your workspace will appear here."} /> : <View style={styles.recordList}>{filtered.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} money={money} onPress={() => setSelected(transaction)} />)}</View>}
          <View style={styles.cloudNotice}><MaterialIcons name="cloud-done" size={15} color={palette.evergreen} /><Text style={styles.cloudNoticeText}>Shared cloud records · refund and void actions post to the general ledger.</Text></View>
        </ScrollView>
      </View>
      <Modal visible={Boolean(chosen)} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        {chosen && selectedColor ? <View style={styles.modalBackdrop}><Pressable style={StyleSheet.absoluteFill} onPress={() => setSelected(null)} /><View style={styles.sheet}><View style={styles.sheetHandle} /><ScrollView showsVerticalScrollIndicator={false}>
          <View style={styles.receiptTop}><View style={styles.receiptMark}><MaterialIcons name="receipt-long" size={23} color={palette.white} /></View><Pressable onPress={() => setSelected(null)} style={styles.closeButton}><MaterialIcons name="close" size={20} color={palette.muted} /></Pressable></View>
          <View style={styles.receiptTitleRow}><View><Text style={styles.receiptTitle}>Receipt {chosen.orderNumber}</Text><Text style={styles.receiptDate}>{new Date(chosen.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</Text></View><View style={[styles.transactionState, { backgroundColor: selectedColor.bg }]}><Text style={[styles.transactionStateText, { color: selectedColor.fg }]}>{chosen.status.toUpperCase()}</Text></View></View>
          <Card style={styles.receiptCard}><Text style={styles.receiptSectionLabel}>ITEMS</Text>{chosen.items.map((line) => <View key={line.id} style={styles.receiptLine}><View style={{ flex: 1 }}><Text style={styles.receiptItemName}>{line.quantity} × {line.name}{lineModifierText(line) ? ` · ${lineModifierText(line)}` : ""}</Text>{line.note ? <Text style={styles.receiptNote}>{line.note}</Text> : null}</View><Text style={styles.receiptItemTotal}>{money(transactionLineTotal(line))}</Text></View>)}<Divider /><ReceiptAmount label="Subtotal" value={chosen.subtotal} money={money} /><ReceiptAmount label="Discount" value={-chosen.discount} money={money} /><ReceiptAmount label="Tax" value={chosen.tax} money={money} /><Divider /><View style={styles.totalRow}><Text style={styles.totalLabel}>Total · {chosen.paymentMethod}</Text><Text style={styles.totalValue}>{money(chosen.total)}</Text></View></Card>
          {chosen.status === "paid" ? <View style={styles.actionNote}><MaterialIcons name="info-outline" size={15} color="#98661F" /><Text style={styles.actionNoteText}>{chosen.paymentMethod === "QRIS" ? "QRIS is recorded as manually verified by the cashier; this app does not process or reverse the payment." : "Refunds/voids post an accounting reversal. Any actual cash or bank return is handled outside this app."}</Text></View> : null}
          <View style={styles.actionButtons}><PrimaryButton label="Share receipt" icon="share" tone="light" onPress={() => void shareReceipt(chosen)} />{chosen.status === "paid" && canAdjust ? <><Pressable style={styles.refundButton} onPress={() => confirmAction("refund", chosen)}><MaterialIcons name="undo" size={18} color="#98661F" /><Text style={styles.refundText}>Record full refund</Text></Pressable><Pressable style={styles.voidButton} onPress={() => confirmAction("void", chosen)}><MaterialIcons name="block" size={18} color={palette.coral} /><Text style={styles.voidText}>Void sale</Text></Pressable></> : null}</View>
        </ScrollView></View></View> : null}
      </Modal>
    </ScreenContainer>
  );
}

function TransactionRow({ transaction, onPress, money }: { transaction: Transaction; onPress: () => void; money: (value: number) => string }) {
  const color = transactionStatusColor(transaction.status);
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.recordCard, pressed && styles.pressed]}><View style={styles.recordIcon}><MaterialIcons name={paymentIcon(transaction.paymentMethod)} size={18} color={palette.evergreen} /></View><View style={styles.recordMain}><View style={styles.recordTitleRow}><Text style={styles.recordOrder}>{transaction.orderNumber}</Text><Text style={styles.recordTotal}>{money(transaction.total)}</Text></View><Text style={styles.recordDetails}>{transaction.items.reduce((sum, line) => sum + line.quantity, 0)} items · {transaction.paymentMethod} · {shortTime(transaction.createdAt)}</Text></View><View style={[styles.stateDot, { backgroundColor: color.bg }]}><View style={[styles.stateDotInner, { backgroundColor: color.fg }]} /></View><MaterialIcons name="chevron-right" size={19} color="#9BA59D" /></Pressable>;
}
function ReceiptAmount({ label, value, money }: { label: string; value: number; money: (value: number) => string }) { return <View style={styles.receiptAmount}><Text style={styles.amountLabel}>{label}</Text><Text style={styles.amountValue}>{value < 0 ? `−${money(Math.abs(value))}` : money(value)}</Text></View>; }
const styles = StyleSheet.create({ page: { flex: 1, backgroundColor: palette.background }, content: { paddingHorizontal: 18, paddingTop: 15, paddingBottom: 26 }, historyIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: palette.evergreenSoft, alignItems: "center", justifyContent: "center" }, searchBox: { minHeight: 46, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, borderRadius: 14, flexDirection: "row", alignItems: "center", gap: 9, paddingLeft: 13, paddingRight: 8 }, searchInput: { flex: 1, color: palette.ink, fontSize: 12, paddingVertical: 10 }, clearSearch: { width: 30, height: 30, alignItems: "center", justifyContent: "center" }, filters: { flexDirection: "row", gap: 7, paddingVertical: 13 }, errorBanner: { backgroundColor: palette.coralSoft, borderRadius: 11, padding: 10, flexDirection: "row", gap: 7, marginBottom: 10 }, errorText: { color: palette.coral, fontSize: 10, flex: 1 }, notice: { backgroundColor: palette.evergreenSoft, borderRadius: 12, padding: 10, flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 11 }, noticeText: { flex: 1, color: palette.evergreen, fontSize: 10, fontWeight: "700" }, recordList: { gap: 8 }, recordCard: { minHeight: 72, padding: 11, borderRadius: 16, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, flexDirection: "row", alignItems: "center", gap: 10 }, pressed: { opacity: 0.75 }, recordIcon: { width: 37, height: 37, borderRadius: 13, backgroundColor: palette.evergreenSoft, alignItems: "center", justifyContent: "center" }, recordMain: { flex: 1 }, recordTitleRow: { flexDirection: "row", justifyContent: "space-between", gap: 8 }, recordOrder: { color: palette.ink, fontSize: 13, fontWeight: "900" }, recordTotal: { color: palette.evergreen, fontSize: 13, fontWeight: "900" }, recordDetails: { color: palette.muted, fontSize: 9, marginTop: 4, fontWeight: "600" }, stateDot: { width: 16, height: 16, borderRadius: 9, alignItems: "center", justifyContent: "center" }, stateDotInner: { width: 6, height: 6, borderRadius: 4 }, cloudNotice: { flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", marginTop: 16 }, cloudNoticeText: { color: palette.muted, fontSize: 9, flexShrink: 1, textAlign: "center" }, modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(17,36,30,0.38)" }, sheet: { backgroundColor: palette.background, borderTopLeftRadius: 26, borderTopRightRadius: 26, maxHeight: "91%", paddingHorizontal: 20, paddingTop: 10, paddingBottom: 22 }, sheetHandle: { width: 42, height: 4, borderRadius: 3, backgroundColor: "#CDD2C9", alignSelf: "center", marginBottom: 17 }, receiptTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, receiptMark: { width: 46, height: 46, borderRadius: 15, backgroundColor: palette.evergreen, alignItems: "center", justifyContent: "center" }, closeButton: { width: 38, height: 38, borderRadius: 13, backgroundColor: palette.surface, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: palette.line }, receiptTitleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginVertical: 15, gap: 9 }, receiptTitle: { color: palette.ink, fontSize: 20, fontWeight: "900", letterSpacing: -0.4 }, receiptDate: { color: palette.muted, fontSize: 10, marginTop: 4 }, transactionState: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 9 }, transactionStateText: { fontSize: 8, fontWeight: "900", letterSpacing: 0.7 }, receiptCard: { padding: 14 }, receiptSectionLabel: { color: palette.muted, fontSize: 9, fontWeight: "900", letterSpacing: 1.3, marginBottom: 6 }, receiptLine: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 9, paddingVertical: 8 }, receiptItemName: { color: palette.ink, fontSize: 11, fontWeight: "700" }, receiptNote: { color: palette.coral, fontSize: 9, marginTop: 3 }, receiptItemTotal: { color: palette.ink, fontSize: 11, fontWeight: "800" }, receiptAmount: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 }, amountLabel: { color: palette.muted, fontSize: 11 }, amountValue: { color: palette.ink, fontSize: 11, fontWeight: "700" }, totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, totalLabel: { color: palette.ink, fontSize: 13, fontWeight: "900" }, totalValue: { color: palette.evergreen, fontSize: 17, fontWeight: "900" }, actionNote: { flexDirection: "row", gap: 7, backgroundColor: palette.amberSoft, borderRadius: 11, padding: 10, marginTop: 12, alignItems: "flex-start" }, actionNoteText: { color: "#875C1B", flex: 1, fontSize: 9, lineHeight: 14, fontWeight: "600" }, actionButtons: { gap: 8, marginTop: 13 }, refundButton: { minHeight: 46, borderRadius: 14, backgroundColor: palette.amberSoft, borderWidth: 1, borderColor: "#EBDCBF", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 }, refundText: { color: "#875C1B", fontSize: 12, fontWeight: "800" }, voidButton: { minHeight: 42, borderRadius: 14, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 }, voidText: { color: palette.coral, fontSize: 11, fontWeight: "800" } });
