import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Redirect } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { Card, EmptyState, PageHeader, palette, Pill, PrimaryButton, SectionTitle } from "@/components/pos/ui";
import { usePos } from "@/lib/pos-store";
import { useWorkspace } from "@/lib/workspace-context";
import { trpc } from "@/lib/trpc";
import type { Invoice, PettyExpense, VendorBill } from "@/shared/pos";
import { businessDateBoundary, businessDateKey, displayDateOnly, isInBusinessDateRange, roundPositiveAmount, shiftDateKey } from "@/shared/accounting";

type Period = "Today" | "7 days" | "30 days";
type BookTab = "P&L" | "Recipe costing" | "General ledger" | "Invoices" | "Vendor bills";
function dateRange(period: Period, todayKey: string) {
  const startKey = period === "Today" ? todayKey : shiftDateKey(todayKey, period === "7 days" ? -6 : -29);
  return { startKey, endKey: todayKey };
}
function csvCell(value: unknown) { return `"${String(value ?? "").replace(/"/g, '""')}"`; }
function clientRequestId() { return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => { const value = Math.floor(Math.random() * 16); return (char === "x" ? value : (value & 0x3) | 0x8).toString(16); }); }

export default function ReportsScreen() {
  const { money, currency } = usePos();
  const { workspace } = useWorkspace();
  const isManager = workspace?.role === "manager";
  const timezone = workspace?.timezone ?? "Asia/Jakarta";
  const utils = trpc.useUtils();
  const [period, setPeriod] = useState<Period>("Today");
  const [bookTab, setBookTab] = useState<BookTab>("P&L");
  const [modal, setModal] = useState<"invoice" | "bill" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [invoiceDescription, setInvoiceDescription] = useState("");
  const [invoiceAmount, setInvoiceAmount] = useState("");
  const [invoiceDue, setInvoiceDue] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [billDescription, setBillDescription] = useState("");
  const [billAmount, setBillAmount] = useState("");
  const [billDue, setBillDue] = useState("");
  const [billCategory, setBillCategory] = useState<"cogs" | "operating">("operating");
  const [payment, setPayment] = useState<"Cash" | "Card" | "QRIS" | "Other">("Cash");
  const [qrisVerified, setQrisVerified] = useState(false);
  const [expenseDescription, setExpenseDescription] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseCategory, setExpenseCategory] = useState<PettyExpense["category"]>("other");
  const [expensePayment, setExpensePayment] = useState<"Cash" | "Card" | "QRIS" | "Other">("Cash");
  const [expenseQrisVerified, setExpenseQrisVerified] = useState(false);
  const expenseAttempt = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const todayISO = useMemo(() => businessDateKey(now, timezone), [now, timezone]);
  const range = useMemo(() => dateRange(period, todayISO), [period, todayISO]);
  useEffect(() => {
    const nextDay = businessDateBoundary(shiftDateKey(todayISO, 1), timezone).getTime();
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, Math.max(1000, nextDay + 50 - Date.now())));
    return () => clearTimeout(timer);
  }, [todayISO, timezone]);
  const report = trpc.accounting.report.useQuery({ start: range.startKey, end: range.endKey }, { enabled: isManager, refetchInterval: 3_000, retry: 1 });
  const invoices = trpc.accounting.invoices.useQuery(undefined, { enabled: isManager, refetchInterval: 3_000, retry: 1 });
  const bills = trpc.accounting.bills.useQuery(undefined, { enabled: isManager, refetchInterval: 3_000, retry: 1 });
  const createInvoice = trpc.accounting.createInvoice.useMutation();
  const issueInvoiceMutation = trpc.accounting.issueInvoice.useMutation();
  const payInvoice = trpc.accounting.payInvoice.useMutation();
  const voidInvoice = trpc.accounting.voidInvoice.useMutation();
  const createBill = trpc.accounting.createBill.useMutation();
  const createQuickExpense = trpc.accounting.createQuickExpense.useMutation();
  const payBill = trpc.accounting.payBill.useMutation();
  const voidBill = trpc.accounting.voidBill.useMutation();
  const pnl = report.data?.profitAndLoss;
  const recipeCosting = report.data?.recipeCosting;
  const ledgerLines = report.data?.ledgerLines ?? [];
  const invoiceRows = invoices.data ?? [];
  const billRows = bills.data ?? [];
  const active = createInvoice.isPending || issueInvoiceMutation.isPending || createBill.isPending || createQuickExpense.isPending || saving;
  const booksLoadError = report.error ?? invoices.error ?? bills.error;
  const booksReady = report.isSuccess && invoices.isSuccess && bills.isSuccess && !booksLoadError;
  const booksRefreshing = report.isFetching || invoices.isFetching || bills.isFetching;

  function openDocumentForm(kind: "invoice" | "bill") {
    setError("");
    const dueDate = shiftDateKey(businessDateKey(Date.now(), timezone), 7);
    if (kind === "invoice") setInvoiceDue(dueDate); else setBillDue(dueDate);
    setModal(kind);
  }

  async function refreshBooks() { await Promise.all([utils.accounting.report.invalidate(), utils.accounting.invoices.invalidate(), utils.accounting.bills.invalidate()]); }
  async function submitInvoice(status: "draft" | "open") {
    setError(""); setNotice("");
    const amount = Number(invoiceAmount);
    if (!customerName.trim() || !invoiceDescription.trim() || !Number.isFinite(amount) || amount <= 0 || roundPositiveAmount(amount, currency) === null) { setError(`Add a customer, description and an amount that rounds to at least one ${currency} minor unit.`); return; }
    setSaving(true);
    try { const invoice = await createInvoice.mutateAsync({ customerName: customerName.trim(), customerEmail: customerEmail.trim(), issueDate: businessDateKey(Date.now(), timezone), dueDate: invoiceDue, lines: [{ description: invoiceDescription.trim(), quantity: 1, unitPrice: amount }], status }); setNotice(status === "draft" ? `${invoice.number} saved as a draft · ${money(invoice.total)} planned.` : `${invoice.number} issued · ${money(invoice.total)} due.`); setModal(null); setCustomerName(""); setCustomerEmail(""); setInvoiceDescription(""); setInvoiceAmount(""); await refreshBooks(); }
    catch (err) { setError(err instanceof Error ? err.message : "Invoice could not be saved."); } finally { setSaving(false); }
  }
  async function issueDraftInvoice(invoice: Invoice) {
    setError(""); setNotice("");
    try { const issued = await issueInvoiceMutation.mutateAsync({ id: invoice.id }); await refreshBooks(); setNotice(`${issued.number} issued to the books · ${money(issued.total)} receivable.`); }
    catch (err) { setError(err instanceof Error ? err.message : "The invoice draft could not be issued."); }
  }
  async function submitBill() {
    setError(""); setNotice(""); const amount = Number(billAmount);
    if (!vendorName.trim() || !billDescription.trim() || !Number.isFinite(amount) || amount <= 0 || roundPositiveAmount(amount, currency) === null) { setError(`Add a supplier, description and an amount that rounds to at least one ${currency} minor unit.`); return; }
    setSaving(true);
    try { const bill = await createBill.mutateAsync({ vendorName: vendorName.trim(), description: billDescription.trim(), category: billCategory, billDate: businessDateKey(Date.now(), timezone), dueDate: billDue, amount }); setNotice(`${bill.number} recorded · ${money(bill.amount)} payable.`); setModal(null); setVendorName(""); setBillDescription(""); setBillAmount(""); await refreshBooks(); }
    catch (err) { setError(err instanceof Error ? err.message : "Vendor bill could not be saved."); } finally { setSaving(false); }
  }
  async function submitQuickExpense() {
    setError(""); setNotice("");
    const amount = Number(expenseAmount);
    if (!expenseDescription.trim() || !Number.isFinite(amount) || amount <= 0) { setError("Add an expense description and positive amount."); return; }
    if (expensePayment === "QRIS" && !expenseQrisVerified) { setError("Verify QRIS settlement in the merchant app before recording this expense."); return; }
    const details = { businessDate: todayISO, description: expenseDescription.trim(), category: expenseCategory, amount, paymentMethod: expensePayment, qrisVerified: expensePayment === "QRIS" && expenseQrisVerified };
    const fingerprint = JSON.stringify(details);
    if (!expenseAttempt.current || expenseAttempt.current.fingerprint !== fingerprint) expenseAttempt.current = { fingerprint, requestId: clientRequestId() };
    try {
      const expense = await createQuickExpense.mutateAsync({ requestId: expenseAttempt.current.requestId, ...details });
      expenseAttempt.current = null;
      setExpenseDescription(""); setExpenseAmount(""); setExpenseCategory("other"); setExpenseQrisVerified(false);
      setNotice(`${expense.number} logged · ${money(expense.amount)} added to operating expenses.`);
      await refreshBooks();
    } catch (err) { setError(err instanceof Error ? err.message : "The quick expense could not be saved. Retry the same details to reconcile safely."); }
  }
  async function markInvoicePaid(invoice: Invoice) {
    if (payment === "QRIS" && !qrisVerified) { setError("Verify QRIS in the merchant app before recording settlement."); return; }
    try { await payInvoice.mutateAsync({ id: invoice.id, paymentMethod: payment, qrisVerified }); await refreshBooks(); setNotice(`${invoice.number} marked paid.`); }
    catch (err) { setError(err instanceof Error ? err.message : "Invoice payment did not save."); }
  }
  async function markBillPaid(bill: VendorBill) {
    if (payment === "QRIS" && !qrisVerified) { setError("Verify QRIS in the merchant app before recording settlement."); return; }
    try { await payBill.mutateAsync({ id: bill.id, paymentMethod: payment, qrisVerified }); await refreshBooks(); setNotice(`${bill.number} marked paid.`); }
    catch (err) { setError(err instanceof Error ? err.message : "Bill payment did not save."); }
  }
  function confirmVoid(kind: "invoice" | "bill", id: string, label: string, hasLedgerEntry = true) {
    const prompt = kind === "invoice" ? hasLedgerEntry ? `Void ${label}? This creates a general-ledger reversal.` : `Void the unissued draft ${label}? No ledger reversal will be created.` : `Void ${label}? This reverses the open expense accrual.`;
    const run = () => void (async () => { try { if (kind === "invoice") await voidInvoice.mutateAsync({ id }); else await voidBill.mutateAsync({ id }); await refreshBooks(); setNotice(hasLedgerEntry ? `${label} voided and reversed.` : `${label} draft voided without a ledger entry.`); } catch (err) { setError(err instanceof Error ? err.message : "The reversal did not save."); } })();
    if (Platform.OS === "web" && typeof window !== "undefined") { if (window.confirm(prompt)) run(); return; }
    Alert.alert(kind === "invoice" ? "Void invoice?" : "Void vendor bill?", prompt, [{ text: "Cancel", style: "cancel" }, { text: hasLedgerEntry ? "Create reversal" : "Void draft", style: "destructive", onPress: run }]);
  }
  async function exportCsv() {
    if (!booksReady || booksRefreshing) { setError("Books data is not fully loaded. Retry the cloud queries before exporting."); return; }
    const pnlRows = [["Account", "Amount", "Currency"], ["Gross sales", pnl?.salesRevenue ?? 0, currency], ["Refunds", -(pnl?.refunds ?? 0), currency], ["Voids", -(pnl?.voids ?? 0), currency], ["Discounts", -(pnl?.discounts ?? 0), currency], ["Net revenue", pnl?.netRevenue ?? 0, currency], ["Cost of goods sold", pnl?.costOfGoodsSold ?? 0, currency], ["Gross profit", pnl?.grossProfit ?? 0, currency], ["Operating expenses", pnl?.operatingExpenses ?? 0, currency], ["Net income", pnl?.netIncome ?? 0, currency], ["Tax collected", pnl?.taxCollected ?? 0, currency]];
    const glRows = [["Date", "Reference", "Description", "Account code", "Account", "Debit", "Credit", "Currency"], ...ledgerLines.map((line) => [line.date, line.reference, line.description, line.accountCode, line.accountName, line.debit, line.credit, currency])];
    const recipeRows = [["Menu item", "Quantity sold", "Recipe-costed quantity", "Uncosted quantity", "Net sales", "Recipe COGS estimate", "Estimated gross profit", "Currency"], ...(recipeCosting?.items ?? []).map((item) => [item.menuItemName, item.quantitySold, item.recipeCostedQuantity, item.uncostedQuantity, item.netSales, item.recipeCogs, item.grossProfit, currency])];
    const periodInvoices = invoiceRows.filter((item) => isInBusinessDateRange(item.issueDate, range.startKey, range.endKey, timezone));
    const periodBills = billRows.filter((item) => isInBusinessDateRange(item.billDate, range.startKey, range.endKey, timezone));
    const docRows = [["Type", "Number", "Counterparty", "Date", "Due date", "Status", "Amount", "Currency"], ...periodInvoices.map((item) => ["Invoice", item.number, item.customerName, item.issueDate, item.dueDate, item.status, item.total, currency]), ...periodBills.map((item) => ["Vendor bill", item.number, item.vendorName, item.billDate, item.dueDate, item.status, item.amount, currency])];
    const expenseRows = [["Date", "Number", "Description", "Category", "Tender", "Amount", "Currency"], ...(report.data?.pettyExpenses ?? []).map((item) => [item.businessDate, item.number, item.description, item.category, item.paymentMethod, item.amount, currency])];
    const csv = ["PROFIT AND LOSS", ...pnlRows.map((row) => row.map(csvCell).join(",")), "", "QUICK OPERATING EXPENSES", ...expenseRows.map((row) => row.map(csvCell).join(",")), "", "RECIPE COSTING ESTIMATE · NOT POSTED TO LEDGER", ...recipeRows.map((row) => row.map(csvCell).join(",")), "", "GENERAL LEDGER", ...glRows.map((row) => row.map(csvCell).join(",")), "", "INVOICES AND VENDOR BILLS", ...docRows.map((row) => row.map(csvCell).join(","))].join("\n");
    if (Platform.OS === "web" && typeof document !== "undefined") { const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = `till-table-books-${todayISO}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return; }
    setError("");
    try {
      const directory = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
      if (!directory) throw new Error("A temporary export location is unavailable.");
      const fileUri = `${directory}till-table-books-${todayISO}.csv`;
      await FileSystem.writeAsStringAsync(fileUri, csv, { encoding: FileSystem.EncodingType.UTF8 });
      if (!(await Sharing.isAvailableAsync())) throw new Error("File sharing is unavailable on this device.");
      await Sharing.shareAsync(fileUri, { dialogTitle: `Till & Table books · ${period}`, mimeType: "text/csv", UTI: "public.comma-separated-values-text" });
    } catch (err) {
      setError(err instanceof Error ? `CSV export failed: ${err.message}` : "CSV export failed.");
    }
  }

  if (workspace && workspace.role !== "manager") return <Redirect href="/(tabs)/manage" />;

  return (
    <ScreenContainer containerClassName="bg-background" safeAreaClassName="bg-background">
      <ScrollView style={styles.page} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <PageHeader eyebrow="Books · manager view" title="Business books" subtitle={`${displayDateOnly(range.startKey)} — ${displayDateOnly(range.endKey)} · ${currency}`} right={<Pressable disabled={!booksReady || booksRefreshing} onPress={() => void exportCsv()} style={[styles.exportButton, (!booksReady || booksRefreshing) && { opacity: 0.45 }]}><MaterialIcons name="file-download" size={18} color={palette.evergreen} /><Text style={styles.exportLabel}>CSV</Text></Pressable>} />
        <View style={styles.periodRow}>{(["Today", "7 days", "30 days"] as const).map((value) => <Pill key={value} label={value} selected={period === value} onPress={() => setPeriod(value)} />)}</View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>{(["P&L", "Recipe costing", "General ledger", "Invoices", "Vendor bills"] as const).map((value) => <Pill key={value} label={value} selected={bookTab === value} onPress={() => setBookTab(value)} />)}</ScrollView>
        {error ? <View style={styles.errorBanner}><MaterialIcons name="error-outline" size={16} color={palette.coral} /><Text style={styles.errorText}>{error}</Text></View> : null}
        {notice ? <Pressable onPress={() => setNotice("")} style={styles.notice}><MaterialIcons name="check-circle" size={15} color={palette.evergreen} /><Text style={styles.noticeText}>{notice}</Text><MaterialIcons name="close" size={14} color={palette.muted} /></Pressable> : null}
        {!booksReady ? <Card style={styles.pnlCard}><Text style={styles.docMeta}>{booksLoadError ? `Business books could not be loaded${booksLoadError instanceof Error ? `: ${booksLoadError.message}` : "."} Totals and CSV export are unavailable until fresh data loads.` : "Loading shared business books… Totals and export are unavailable until all records load."}</Text>{booksLoadError ? <PrimaryButton label="Retry cloud data" icon="refresh" tone="light" onPress={() => void Promise.all([report.refetch(), invoices.refetch(), bills.refetch()])} /> : null}</Card> : <>
        <View style={styles.paymentMethodRow}><Text style={styles.paymentLabel}>SETTLEMENT TENDER</Text>{(["Cash", "Card", "QRIS", "Other"] as const).map((value) => <Pill key={value} label={value} selected={payment === value} onPress={() => { setPayment(value); setQrisVerified(false); }} />)}</View>
        {payment === "QRIS" ? <Pressable onPress={() => setQrisVerified(!qrisVerified)} style={styles.qrisNotice}><View style={[styles.checkbox, qrisVerified && styles.checkboxActive]}>{qrisVerified ? <MaterialIcons name="check" size={12} color={palette.white} /> : null}</View><Text style={styles.qrisText}>I verified settlement in the merchant QRIS app. This records settlement only; it does not process payment.</Text></Pressable> : null}
        {bookTab === "P&L" ? <>
          <Card style={styles.heroCard}><View style={styles.heroHead}><MaterialIcons name="account-balance" size={18} color={palette.amber} /><Text style={styles.heroLabel}>NET INCOME · RECORDED BOOKS</Text></View><Text style={styles.heroValue}>{money(pnl?.netIncome ?? 0)}</Text><Text style={styles.heroCaption}>Accrual revenue less categorized vendor-bill expenses in this period.</Text></Card>
          <SectionTitle title="Profit & loss" /><Card style={styles.pnlCard}><PnlRow label="Gross sales" value={pnl?.salesRevenue ?? 0} money={money} /><PnlRow label="Refunds" value={-(pnl?.refunds ?? 0)} money={money} /><PnlRow label="Voids" value={-(pnl?.voids ?? 0)} money={money} /><PnlRow label="Discounts" value={-(pnl?.discounts ?? 0)} money={money} /><View style={styles.separator} /><PnlRow label="Net revenue" value={pnl?.netRevenue ?? 0} money={money} bold /><PnlRow label="Posted COGS · vendor bills" value={-(pnl?.costOfGoodsSold ?? 0)} money={money} /><PnlRow label="Gross profit" value={pnl?.grossProfit ?? 0} money={money} bold /><PnlRow label="Operating expenses" value={-(pnl?.operatingExpenses ?? 0)} money={money} /><View style={styles.separator} /><PnlRow label="Net income" value={pnl?.netIncome ?? 0} money={money} bold /><PnlRow label="Tax payable · memorandum" value={pnl?.taxCollected ?? 0} money={money} /></Card>
          <SectionTitle title="One-tap expense" action="Posted to P&L" />
          <Card style={styles.pnlCard}><Text style={styles.docMeta}>Log a cash expense now; it posts to Operating Expenses and the General Ledger, separate from vendor bills.</Text><Field label="WHAT WAS IT?" value={expenseDescription} onChangeText={setExpenseDescription} placeholder="e.g. paper cups" /><Field label={`AMOUNT · ${currency}`} value={expenseAmount} onChangeText={setExpenseAmount} placeholder="0" keyboardType="decimal-pad" /><View style={styles.categoryRow}>{(["supplies", "utilities", "staff", "transport", "other"] as const).map((value) => <Pill key={value} label={value} selected={expenseCategory === value} onPress={() => setExpenseCategory(value)} />)}</View><View style={styles.paymentMethodRow}><Text style={styles.paymentLabel}>PAID BY</Text>{(["Cash", "Card", "QRIS", "Other"] as const).map((value) => <Pill key={value} label={value} selected={expensePayment === value} onPress={() => { setExpensePayment(value); setExpenseQrisVerified(false); }} />)}</View>{expensePayment === "QRIS" ? <Pressable onPress={() => setExpenseQrisVerified(!expenseQrisVerified)} style={styles.qrisNotice}><View style={[styles.checkbox, expenseQrisVerified && styles.checkboxActive]}>{expenseQrisVerified ? <MaterialIcons name="check" size={12} color={palette.white} /> : null}</View><Text style={styles.qrisText}>I verified this QRIS expense settlement in the merchant app.</Text></Pressable> : null}<PrimaryButton label={active ? "Saving…" : "Log expense"} icon="add-card" onPress={() => void submitQuickExpense()} loading={active} disabled={active} /></Card>
          {report.data?.pettyExpenses.length ? <><SectionTitle title="Quick expenses · this period" action={`${report.data.pettyExpenses.length} entries`} /><View style={styles.documentList}>{report.data.pettyExpenses.slice(0, 8).map((expense) => <Card key={expense.id} style={styles.docCard}><View style={styles.docTop}><View style={{ flex: 1 }}><Text style={styles.docNumber}>{expense.description}</Text><Text style={styles.docMeta}>{displayDateOnly(expense.businessDate)} · {expense.category} · {expense.paymentMethod} · {expense.number}</Text></View><Text style={styles.docTotal}>{money(expense.amount)}</Text></View></Card>)}</View></> : null}
          <View style={styles.disclaimer}><MaterialIcons name="info-outline" size={15} color="#98661F" /><Text style={styles.disclaimerText}>Operational records only. Categorize vendor bills accurately and review statutory accounting/tax treatment with your accountant.</Text></View>
        </> : null}
        {bookTab === "Recipe costing" ? <>
          <Card style={styles.heroCard}><View style={styles.heroHead}><MaterialIcons name="restaurant-menu" size={18} color={palette.amber} /><Text style={styles.heroLabel}>RECIPE COGS · ESTIMATE</Text></View><Text style={styles.heroValue}>{money(recipeCosting?.recipeCogs ?? 0)}</Text><Text style={styles.heroCaption}>{money(recipeCosting?.recipeCostedSales ?? 0)} recipe-costed sales · {recipeCosting?.costCoveragePercent ?? 0}% cost coverage · {money(recipeCosting?.uncostedSales ?? 0)} sales have no BOM.</Text></Card>
          <SectionTitle title="Recipe cost by menu item" action={`${recipeCosting?.items.length ?? 0} items`} />
          {recipeCosting?.items.length ? <View style={styles.documentList}>{recipeCosting.items.map((item) => <Card key={item.menuItemId} style={styles.pnlCard}><View style={styles.pnlRow}><Text style={[styles.pnlLabel, styles.pnlBold]}>{item.menuItemName}</Text><Text style={styles.pnlValue}>{item.quantitySold} sold</Text></View><PnlRow label="Net sales after ticket discounts" value={item.netSales} money={money} /><PnlRow label="Recipe-costed / uncosted quantity" value={item.recipeCostedQuantity} money={(quantity) => `${quantity} / ${item.uncostedQuantity}`} /><PnlRow label="Recipe COGS estimate" value={-item.recipeCogs} money={money} /><PnlRow label="Estimated gross profit · costed sales only" value={item.grossProfit} money={money} bold />{item.uncostedSales > 0 ? <Text style={styles.docMeta}>{money(item.uncostedSales)} net sales had no recipe and are excluded from estimated margin.</Text> : null}{item.ingredients.length ? <View style={styles.separator} /> : null}{item.ingredients.map((ingredient) => <Text key={ingredient.ingredientItemId} style={styles.docMeta}>{ingredient.ingredientName} · {ingredient.quantityUsed} {ingredient.unit} used · {money(ingredient.totalCost)}</Text>)}</Card>)}</View> : <EmptyState icon="restaurant-menu" title="No recipe-costed sales in this period" body="Add ingredients and bills of materials in Manage → Recipes & costs. Future paid sales will add sale-time recipe costs here." />}
          <View style={styles.disclaimer}><MaterialIcons name="info-outline" size={15} color="#98661F" /><Text style={styles.disclaimerText}>This is an estimated BOM margin report, not a posted ledger expense. Voided and refunded sales are excluded. P&amp;L and General Ledger continue to use actual posted vendor bills, avoiding double-counting.</Text></View>
        </> : null}
        {bookTab === "General ledger" ? <><SectionTitle title="General ledger" action={`${ledgerLines.length} lines`} /><Card style={styles.ledgerHead}><Text style={[styles.ledgerText, styles.ledgerAccount]}>DATE · REFERENCE · ACCOUNT</Text><Text style={styles.debitHead}>DR</Text><Text style={styles.creditHead}>CR</Text></Card>{ledgerLines.length ? <View style={styles.ledgerList}>{ledgerLines.map((line, index) => <View key={`${line.reference}-${line.accountCode}-${index}`} style={styles.ledgerRow}><View style={styles.ledgerMain}><Text style={styles.ledgerDate}>{displayDateOnly(businessDateKey(new Date(line.date), timezone))} · {line.reference}</Text><Text style={styles.ledgerAccountName}>{line.accountCode} · {line.accountName}</Text><Text style={styles.ledgerDescription}>{line.description}</Text></View><Text style={styles.debitValue}>{line.debit ? money(line.debit) : "—"}</Text><Text style={styles.creditValue}>{line.credit ? money(line.credit) : "—"}</Text></View>)}</View> : <EmptyState icon="menu-book" title="No ledger entries" body="Sales, invoices and bills create balanced journal entries here." />}</> : null}
        {bookTab === "Invoices" ? <><SectionTitle title="Customer invoices" action="New invoice" onAction={() => openDocumentForm("invoice")} />{invoiceRows.length ? <View style={styles.documentList}>{invoiceRows.map((invoice) => <InvoiceCard key={invoice.id} invoice={invoice} money={money} timezone={timezone} onPay={() => void markInvoicePaid(invoice)} onIssue={() => void issueDraftInvoice(invoice)} onVoid={() => confirmVoid("invoice", invoice.id, invoice.number, Boolean(invoice.journalEntryId))} />)}</View> : <EmptyState icon="request-quote" title="No invoices yet" body="Save an invoice draft, then explicitly issue it to post receivables and revenue to the general ledger." />}</> : null}
        {bookTab === "Vendor bills" ? <><SectionTitle title="Vendor bills" action="New bill" onAction={() => openDocumentForm("bill")} />{billRows.length ? <View style={styles.documentList}>{billRows.map((bill) => <BillCard key={bill.id} bill={bill} money={money} timezone={timezone} onPay={() => void markBillPaid(bill)} onVoid={() => confirmVoid("bill", bill.id, bill.number)} />)}</View> : <EmptyState icon="request-quote" title="No vendor bills yet" body="Record supplier bills as cost of goods sold or operating expenses." />}</> : null}
        </>}
        {booksRefreshing ? <Text style={styles.syncLine}>Syncing shared books… CSV export is paused until refresh completes.</Text> : null}
        <Modal visible={Boolean(modal)} transparent animationType="slide" onRequestClose={() => setModal(null)}><View style={styles.modalBackdrop}><Pressable style={StyleSheet.absoluteFill} onPress={() => setModal(null)} /><View style={styles.sheet}><View style={styles.handle} /><View style={styles.modalHead}><Text style={styles.modalTitle}>{modal === "invoice" ? "New customer invoice" : "New vendor bill"}</Text><Pressable onPress={() => setModal(null)}><MaterialIcons name="close" size={20} color={palette.muted} /></Pressable></View>
          {modal === "invoice" ? <><Field label="CUSTOMER" value={customerName} onChangeText={setCustomerName} placeholder="Business or person" /><Field label="EMAIL · OPTIONAL" value={customerEmail} onChangeText={setCustomerEmail} placeholder="accounts@example.com" /><Field label="DESCRIPTION" value={invoiceDescription} onChangeText={setInvoiceDescription} placeholder="Service or goods supplied" /><Field label={`AMOUNT · ${currency}`} value={invoiceAmount} onChangeText={setInvoiceAmount} placeholder="0" keyboardType="decimal-pad" /><Field label="DUE DATE · YYYY-MM-DD" value={invoiceDue} onChangeText={setInvoiceDue} placeholder="YYYY-MM-DD" /><Text style={styles.modalFootnote}>Save a draft without posting. Issuing it posts accounts receivable, revenue and tax; the draft keeps the tax estimate from today.</Text><View style={styles.docActions}><Pressable onPress={() => void submitInvoice("draft")} style={styles.docVoid} disabled={active}><Text style={styles.docVoidText}>Save as draft</Text></Pressable><PrimaryButton label={active ? "Saving…" : "Issue invoice"} icon="request-quote" onPress={() => void submitInvoice("open")} loading={active} disabled={active} /></View></> : modal === "bill" ? <><Field label="SUPPLIER" value={vendorName} onChangeText={setVendorName} placeholder="Vendor name" /><Field label="DESCRIPTION" value={billDescription} onChangeText={setBillDescription} placeholder="What is this bill for?" /><View style={styles.categoryRow}><Pill label="Operating expense" selected={billCategory === "operating"} onPress={() => setBillCategory("operating")} /><Pill label="Cost of goods sold" selected={billCategory === "cogs"} onPress={() => setBillCategory("cogs")} /></View><Field label={`AMOUNT · ${currency}`} value={billAmount} onChangeText={setBillAmount} placeholder="0" keyboardType="decimal-pad" /><Field label="DUE DATE · YYYY-MM-DD" value={billDue} onChangeText={setBillDue} placeholder="YYYY-MM-DD" /><Text style={styles.modalFootnote}>Posting records the expense and accounts payable. Payment creates a separate settlement entry.</Text><PrimaryButton label={active ? "Saving…" : "Record vendor bill"} icon="receipt-long" onPress={() => void submitBill()} loading={active} disabled={active} /></> : null}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}</View></View></Modal>
      </ScrollView>
    </ScreenContainer>
  );
}

function PnlRow({ label, value, money, bold = false }: { label: string; value: number; money: (amount: number) => string; bold?: boolean }) { return <View style={styles.pnlRow}><Text style={[styles.pnlLabel, bold && styles.pnlBold]}>{label}</Text><Text style={[styles.pnlValue, bold && styles.pnlBold]}>{value < 0 ? `−${money(Math.abs(value))}` : money(value)}</Text></View>; }
function Field({ label, value, onChangeText, placeholder, keyboardType }: { label: string; value: string; onChangeText: (value: string) => void; placeholder: string; keyboardType?: "default" | "decimal-pad" }) { return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor="#9AA49D" keyboardType={keyboardType ?? "default"} style={styles.input} /></View>; }
function InvoiceCard({ invoice, money, onPay, onIssue, onVoid, timezone }: { invoice: Invoice; money: (amount: number) => string; onPay: () => void; onIssue: () => void; onVoid: () => void; timezone: string }) { const status = invoice.status; const due = displayDateOnly(businessDateKey(new Date(invoice.dueDate), timezone)); return <Card style={styles.docCard}><View style={styles.docTop}><View style={{ flex: 1 }}><Text style={styles.docNumber}>{invoice.number}</Text><Text style={styles.docName}>{invoice.customerName}</Text><Text style={styles.docMeta}>Due {due} · {invoice.lines.length} line(s)</Text></View><View style={[styles.statusPill, { backgroundColor: status === "paid" ? palette.evergreenSoft : status === "overdue" ? palette.coralSoft : status === "void" ? "#EEF0EB" : palette.amberSoft }]}><Text style={[styles.statusText, { color: status === "paid" ? palette.evergreen : status === "overdue" ? palette.coral : status === "void" ? palette.muted : "#98661F" }]}>{status.toUpperCase()}</Text></View></View><Text style={styles.docTotal}>{money(invoice.total)}</Text>{invoice.status === "draft" ? <View style={styles.docActions}><Pressable onPress={onIssue} style={styles.docPay}><Text style={styles.docPayText}>Issue to books</Text></Pressable><Pressable onPress={onVoid} style={styles.docVoid}><Text style={styles.docVoidText}>Void draft</Text></Pressable></View> : invoice.status === "open" || invoice.status === "overdue" ? <View style={styles.docActions}><Pressable onPress={onPay} style={styles.docPay}><Text style={styles.docPayText}>Record payment</Text></Pressable><Pressable onPress={onVoid} style={styles.docVoid}><Text style={styles.docVoidText}>Void</Text></Pressable></View> : null}</Card>; }
function BillCard({ bill, money, onPay, onVoid, timezone }: { bill: VendorBill; money: (amount: number) => string; onPay: () => void; onVoid: () => void; timezone: string }) { const status = bill.status; const due = displayDateOnly(businessDateKey(new Date(bill.dueDate), timezone)); return <Card style={styles.docCard}><View style={styles.docTop}><View style={{ flex: 1 }}><Text style={styles.docNumber}>{bill.number}</Text><Text style={styles.docName}>{bill.vendorName}</Text><Text style={styles.docMeta}>{bill.category === "cogs" ? "Cost of goods sold" : "Operating expense"} · due {due}</Text></View><View style={[styles.statusPill, { backgroundColor: status === "paid" ? palette.evergreenSoft : status === "overdue" ? palette.coralSoft : status === "void" ? "#EEF0EB" : palette.amberSoft }]}><Text style={[styles.statusText, { color: status === "paid" ? palette.evergreen : status === "overdue" ? palette.coral : status === "void" ? palette.muted : "#98661F" }]}>{status.toUpperCase()}</Text></View></View><Text style={styles.docMeta}>{bill.description}</Text><Text style={styles.docTotal}>{money(bill.amount)}</Text>{bill.status === "open" || bill.status === "overdue" ? <View style={styles.docActions}><Pressable onPress={onPay} style={styles.docPay}><Text style={styles.docPayText}>Record payment</Text></Pressable><Pressable onPress={onVoid} style={styles.docVoid}><Text style={styles.docVoidText}>Void</Text></Pressable></View> : null}</Card>; }

const styles = StyleSheet.create({ page: { flex: 1, backgroundColor: palette.background }, content: { paddingHorizontal: 17, paddingTop: 14, paddingBottom: 30 }, exportButton: { minHeight: 37, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, backgroundColor: palette.surface, borderColor: palette.line, borderWidth: 1, borderRadius: 12 }, exportLabel: { color: palette.evergreen, fontSize: 9, fontWeight: "900" }, periodRow: { flexDirection: "row", gap: 7, marginBottom: 8 }, tabs: { flexDirection: "row", gap: 7, paddingBottom: 13 }, errorBanner: { flexDirection: "row", gap: 7, padding: 10, backgroundColor: palette.coralSoft, borderRadius: 11 }, errorText: { color: palette.coral, fontSize: 10, lineHeight: 15, flex: 1, marginTop: 5 }, notice: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: palette.evergreenSoft, padding: 9, borderRadius: 10, marginTop: 8 }, noticeText: { color: palette.evergreen, fontSize: 10, flex: 1, fontWeight: "700" }, paymentMethodRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 7 }, paymentLabel: { color: palette.muted, fontSize: 8, fontWeight: "900", letterSpacing: 0.7 }, qrisNotice: { flexDirection: "row", gap: 8, backgroundColor: palette.amberSoft, padding: 9, borderRadius: 10, marginBottom: 9 }, checkbox: { width: 17, height: 17, borderRadius: 5, borderWidth: 1, borderColor: "#D7C39E", alignItems: "center", justifyContent: "center", backgroundColor: palette.surface }, checkboxActive: { backgroundColor: palette.evergreen, borderColor: palette.evergreen }, qrisText: { flex: 1, color: "#79551D", fontSize: 9, lineHeight: 13 }, heroCard: { backgroundColor: palette.evergreen, borderColor: palette.evergreen, padding: 16, borderRadius: 19 }, heroHead: { flexDirection: "row", alignItems: "center", gap: 7 }, heroLabel: { color: "#DDE8DF", fontSize: 9, fontWeight: "900", letterSpacing: 1 }, heroValue: { color: palette.white, fontSize: 34, fontWeight: "900", marginTop: 13 }, heroCaption: { color: "#C3D2C8", fontSize: 10, lineHeight: 15, marginTop: 4 }, pnlCard: { padding: 14 }, pnlRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 7 }, pnlLabel: { color: palette.muted, fontSize: 11 }, pnlValue: { color: palette.ink, fontSize: 11, fontWeight: "700" }, pnlBold: { color: palette.ink, fontWeight: "900", fontSize: 12 }, separator: { height: 1, backgroundColor: palette.line, marginVertical: 5 }, disclaimer: { flexDirection: "row", gap: 7, backgroundColor: palette.amberSoft, padding: 10, borderRadius: 11, marginTop: 12 }, disclaimerText: { flex: 1, color: "#79551D", fontSize: 9, lineHeight: 14 }, ledgerHead: { flexDirection: "row", alignItems: "center", backgroundColor: palette.evergreenSoft, padding: 10, marginBottom: 7 }, ledgerText: { color: palette.evergreen, fontSize: 8, fontWeight: "900" }, ledgerAccount: { flex: 1 }, debitHead: { width: 70, textAlign: "right", color: palette.evergreen, fontSize: 8, fontWeight: "900" }, creditHead: { width: 70, textAlign: "right", color: palette.evergreen, fontSize: 8, fontWeight: "900" }, ledgerList: { gap: 6 }, ledgerRow: { flexDirection: "row", gap: 4, alignItems: "center", backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 13, padding: 9 }, ledgerMain: { flex: 1 }, ledgerDate: { color: palette.muted, fontSize: 8, fontWeight: "800" }, ledgerAccountName: { color: palette.ink, fontSize: 9, fontWeight: "800", marginTop: 3 }, ledgerDescription: { color: palette.muted, fontSize: 8, marginTop: 2 }, debitValue: { width: 70, textAlign: "right", color: palette.ink, fontSize: 8, fontWeight: "700" }, creditValue: { width: 70, textAlign: "right", color: palette.evergreen, fontSize: 8, fontWeight: "700" }, documentList: { gap: 8 }, docCard: { padding: 12 }, docTop: { flexDirection: "row", gap: 7, alignItems: "flex-start" }, docNumber: { color: palette.ink, fontSize: 12, fontWeight: "900" }, docName: { color: palette.ink, fontSize: 10, fontWeight: "700", marginTop: 3 }, docMeta: { color: palette.muted, fontSize: 9, marginTop: 3 }, statusPill: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 9 }, statusText: { fontSize: 8, fontWeight: "900" }, docTotal: { color: palette.evergreen, fontSize: 17, fontWeight: "900", marginTop: 10 }, docActions: { flexDirection: "row", gap: 7, marginTop: 10 }, docPay: { flex: 1, minHeight: 37, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: palette.evergreen }, docPayText: { color: palette.white, fontSize: 10, fontWeight: "800" }, docVoid: { minWidth: 63, minHeight: 37, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: palette.coralSoft }, docVoidText: { color: palette.coral, fontSize: 10, fontWeight: "800" }, syncLine: { color: palette.muted, fontSize: 9, textAlign: "center", marginTop: 12 }, modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(17,36,30,0.4)" }, sheet: { maxHeight: "90%", backgroundColor: palette.background, borderTopLeftRadius: 25, borderTopRightRadius: 25, padding: 19, paddingTop: 10, paddingBottom: 22 }, handle: { width: 40, height: 4, borderRadius: 3, backgroundColor: "#CDD2C9", alignSelf: "center", marginBottom: 14 }, modalHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 13 }, modalTitle: { color: palette.ink, fontSize: 17, fontWeight: "900" }, field: { marginBottom: 10 }, fieldLabel: { color: palette.muted, fontSize: 8, fontWeight: "900", letterSpacing: 0.9, marginBottom: 5 }, input: { minHeight: 42, borderRadius: 11, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, paddingHorizontal: 10, color: palette.ink, fontSize: 11 }, categoryRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 11 }, modalFootnote: { color: palette.muted, fontSize: 9, lineHeight: 14, marginVertical: 10 } });
