import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { Card, EmptyState, palette, Pill, PrimaryButton, SectionTitle } from "@/components/pos/ui";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/lib/workspace-context";
import { formatMoney } from "@/shared/accounting";
import { calculateReorderPacks } from "@/shared/unit-conversion";
import type { GoodsReceipt, PurchaseOrder, PurchaseRequest, Supplier } from "@/shared/pos";

function makeRequestKey(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 15)}`;
}

function orderStatus(status: PurchaseOrder["status"] | PurchaseRequest["status"]) {
  return status === "partially_received" ? "PARTIAL" : status === "received" ? "RECEIVED" : status === "approved" ? "APPROVED" : status === "rejected" ? "DECLINED" : status === "ordered" ? "ORDERED" : "REQUESTED";
}

type DraftLine = { itemId: string; itemName: string; unit: string; stockUnit: string; baseUnitsPerPurchaseUnit: number; quantity: number; unitCost: number };
function baseQuantityLabel(quantity: number) { return String(Number(quantity.toFixed(3))); }

export function PurchasingPanel() {
  const { workspace } = useWorkspace();
  const utils = trpc.useUtils();
  const suppliers = trpc.purchasing.suppliers.useQuery(undefined, { refetchInterval: 3_000 });
  const requests = trpc.purchasing.requests.useQuery(undefined, { refetchInterval: 3_000 });
  const orders = trpc.purchasing.purchaseOrders.useQuery(undefined, { refetchInterval: 3_000 });
  const receipts = trpc.purchasing.receipts.useQuery(undefined, { refetchInterval: 3_000 });
  const inventory = trpc.pos.inventory.useQuery(undefined, { refetchInterval: 3_000 });
  const saveSupplier = trpc.purchasing.saveSupplier.useMutation();
  const createRequest = trpc.purchasing.createRequest.useMutation();
  const reviewRequest = trpc.purchasing.reviewRequest.useMutation();
  const createPurchaseOrder = trpc.purchasing.createPurchaseOrder.useMutation();
  const receivePurchaseOrder = trpc.purchasing.receivePurchaseOrder.useMutation();

  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [supplierEditId, setSupplierEditId] = useState<string | null>(null);
  const [supplierName, setSupplierName] = useState("");
  const [supplierContact, setSupplierContact] = useState("");
  const [supplierEmail, setSupplierEmail] = useState("");
  const [supplierPhone, setSupplierPhone] = useState("");
  const [supplierNotes, setSupplierNotes] = useState("");
  const [supplierActive, setSupplierActive] = useState(true);
  const [decisionNote, setDecisionNote] = useState("");
  const [purchaseSupplierId, setPurchaseSupplierId] = useState("");
  const [selectedItemId, setSelectedItemId] = useState("");
  const [orderQuantity, setOrderQuantity] = useState("1");
  const [unitCost, setUnitCost] = useState("");
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState("");
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);
  const [purchaseRequestId, setPurchaseRequestId] = useState<string | undefined>();
  const [orderRequestId, setOrderRequestId] = useState(() => makeRequestKey("po"));
  const [receivingOrder, setReceivingOrder] = useState<PurchaseOrder | null>(null);
  const [receiptQuantities, setReceiptQuantities] = useState<Record<string, string>>({});
  const [receiptNote, setReceiptNote] = useState("");
  const [receiptKey, setReceiptKey] = useState(() => makeRequestKey("gr"));
  const [receiptError, setReceiptError] = useState("");

  const trackedGoods = useMemo(() => inventory.data?.items ?? [], [inventory.data?.items]);
  const activeSuppliers = useMemo(() => (suppliers.data ?? []).filter((supplier) => supplier.active), [suppliers.data]);
  const resolvedSupplierId = activeSuppliers.some((supplier) => supplier.id === purchaseSupplierId) ? purchaseSupplierId : activeSuppliers[0]?.id ?? "";
  const resolvedItemId = trackedGoods.some((item) => item.id === selectedItemId) ? selectedItemId : trackedGoods[0]?.id ?? "";
  const selectedOrderItem = trackedGoods.find((item) => item.id === resolvedItemId);
  const orderPurchaseUnit = selectedOrderItem?.purchaseUnit ?? selectedOrderItem?.stockUnit ?? "unit";
  const orderStockUnit = selectedOrderItem?.stockUnit ?? "unit";
  const orderConversionFactor = Number(selectedOrderItem?.baseUnitsPerPurchaseUnit ?? 1);
  const lowStockGoods = trackedGoods.filter((item) => Number(item.stockOnHand ?? 0) <= Number(item.lowStockThreshold ?? 0));
  const currency = workspace?.currency ?? "IDR";
  const money = (amount: number) => formatMoney(amount, currency);

  async function refreshPurchasing() {
    await Promise.all([
      utils.purchasing.suppliers.invalidate(),
      utils.purchasing.requests.invalidate(),
      utils.purchasing.purchaseOrders.invalidate(),
      utils.purchasing.receipts.invalidate(),
      utils.pos.inventory.invalidate(),
      utils.pos.menu.invalidate(),
    ]);
  }

  function resetSupplierForm() {
    setSupplierEditId(null); setSupplierName(""); setSupplierContact(""); setSupplierEmail(""); setSupplierPhone(""); setSupplierNotes(""); setSupplierActive(true);
  }

  function editSupplier(supplier: Supplier) {
    setSupplierEditId(supplier.id); setSupplierName(supplier.name); setSupplierContact(supplier.contactName ?? ""); setSupplierEmail(supplier.email ?? ""); setSupplierPhone(supplier.phone ?? ""); setSupplierNotes(supplier.notes ?? ""); setSupplierActive(supplier.active); setError("");
  }

  async function submitSupplier(active = supplierActive) {
    if (!supplierName.trim()) { setError("Enter a supplier name."); return; }
    setError(""); setNotice("");
    try {
      const supplier = await saveSupplier.mutateAsync({ id: supplierEditId ?? undefined, name: supplierName.trim(), contactName: supplierContact.trim() || undefined, email: supplierEmail.trim() || undefined, phone: supplierPhone.trim() || undefined, notes: supplierNotes.trim() || undefined, active });
      await utils.purchasing.suppliers.invalidate();
      setNotice(`${supplier.name} ${active ? "saved" : "deactivated"}.`); resetSupplierForm();
    } catch (err) { setError(err instanceof Error ? err.message : "Supplier could not be saved."); }
  }

  async function setSupplierStatus(supplier: Supplier, active: boolean) {
    setError(""); setNotice("");
    try {
      await saveSupplier.mutateAsync({ id: supplier.id, name: supplier.name, contactName: supplier.contactName, email: supplier.email, phone: supplier.phone, notes: supplier.notes, active });
      await utils.purchasing.suppliers.invalidate();
      setNotice(`${supplier.name} ${active ? "reactivated" : "deactivated"}.`);
      if (supplierEditId === supplier.id) setSupplierActive(active);
    } catch (err) { setError(err instanceof Error ? err.message : "Supplier status could not be changed."); }
  }

  async function requestLowStock(item: (typeof trackedGoods)[number]) {
    const balance = Number(item.stockOnHand ?? 0);
    const minimum = Number(item.lowStockThreshold ?? 0);
    const factor = Number(item.baseUnitsPerPurchaseUnit ?? 1);
    const packsNeeded = calculateReorderPacks(balance, minimum, factor);
    const quantity = Math.max(1, packsNeeded);
    const purchaseUnit = item.purchaseUnit ?? item.stockUnit ?? "unit";
    const requestId = makeRequestKey("req");
    setError(""); setNotice("");
    try {
      const request = await createRequest.mutateAsync({ requestId, itemId: item.id, quantity, reason: `Minimum-stock reorder · ${balance} ${item.stockUnit ?? "unit"} on hand; minimum ${minimum}; ${packsNeeded} ${purchaseUnit} pack(s) needed${packsNeeded === 0 ? `; ${quantity} requested manually` : ""}.` });
      await utils.purchasing.requests.invalidate();
      setNotice(`Purchase request for ${request.quantity} ${request.unit} of ${request.itemName} submitted (${packsNeeded} pack(s) needed to cover the current deficit).`);
    } catch (err) {
      const refreshed = await requests.refetch();
      const prior = refreshed.data?.find((candidate) => candidate.id === requestId);
      if (prior) { setNotice(`Purchase request for ${prior.quantity} ${prior.unit} of ${prior.itemName} was already submitted.`); return; }
      setError(err instanceof Error ? err.message : "Purchase request could not be submitted.");
    }
  }

  async function decideRequest(request: PurchaseRequest, decision: "approved" | "rejected") {
    setError(""); setNotice("");
    try {
      await reviewRequest.mutateAsync({ id: request.id, decision, note: decisionNote.trim() || undefined });
      await utils.purchasing.requests.invalidate();
      setNotice(`${request.itemName} request ${decision}.`);
      setDecisionNote("");
    } catch (err) { setError(err instanceof Error ? err.message : "Purchase request could not be reviewed."); }
  }

  function startOrderFromRequest(request: PurchaseRequest) {
    const item = trackedGoods.find((good) => good.id === request.itemId);
    setPurchaseRequestId(request.id);
    setDraftLines([{ itemId: request.itemId, itemName: request.itemName, unit: request.unit, stockUnit: item?.stockUnit ?? "unit", baseUnitsPerPurchaseUnit: Number(item?.baseUnitsPerPurchaseUnit ?? 1), quantity: request.quantity, unitCost: 0 }]);
    setSelectedItemId(request.itemId);
    setOrderQuantity("1"); setUnitCost(""); setPurchaseSupplierId(activeSuppliers[0]?.id ?? "");
    setNotice(`Purchase order will include the approved request for ${request.quantity} ${request.unit} of ${request.itemName}. Select a supplier and place the order.`);
  }

  function addOrderLine() {
    const item = trackedGoods.find((good) => good.id === resolvedItemId);
    const quantity = Number(orderQuantity);
    const cost = unitCost.trim() ? Number(unitCost) : 0;
    if (!item) { setError("Choose a tracked good to add to the purchase order."); return; }
    if (!Number.isInteger(quantity) || quantity <= 0) { setError("Order quantity must be a positive whole number."); return; }
    if (!Number.isFinite(cost) || cost < 0) { setError("Enter a valid non-negative quoted unit cost."); return; }
    if (draftLines.some((line) => line.itemId === item.id)) { setError("That good is already on the order; remove it and add the combined quantity."); return; }
    setDraftLines((current) => [...current, { itemId: item.id, itemName: item.name, unit: item.purchaseUnit ?? item.stockUnit ?? "unit", stockUnit: item.stockUnit ?? "unit", baseUnitsPerPurchaseUnit: Number(item.baseUnitsPerPurchaseUnit ?? 1), quantity, unitCost: cost }]);
    setOrderQuantity("1"); setUnitCost(""); setError("");
  }

  async function submitOrder() {
    if (!resolvedSupplierId || !activeSuppliers.some((supplier) => supplier.id === resolvedSupplierId)) { setError("Choose an active supplier first."); return; }
    if (!draftLines.length) { setError("Add at least one tracked good to the purchase order."); return; }
    if (expectedDeliveryDate.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(expectedDeliveryDate.trim())) { setError("Enter an expected delivery date as YYYY-MM-DD, or leave it blank."); return; }
    setError(""); setNotice("");
    try {
      const order = await createPurchaseOrder.mutateAsync({ requestId: orderRequestId, supplierId: resolvedSupplierId, purchaseRequestId, expectedDeliveryDate: expectedDeliveryDate.trim() || undefined, items: draftLines.map((line) => ({ itemId: line.itemId, quantity: line.quantity, unitCost: line.unitCost })) });
      await refreshPurchasing();
      setNotice(`${order.number} placed with ${order.supplierName}. Share the order details with the vendor when ready.`);
      setDraftLines([]); setPurchaseRequestId(undefined); setExpectedDeliveryDate(""); setOrderRequestId(makeRequestKey("po"));
    } catch (err) {
      const refreshed = await orders.refetch();
      const existing = refreshed.data?.find((order) => order.id === orderRequestId);
      if (existing) { setNotice(`${existing.number} is already saved. Check its status before creating another order.`); setDraftLines([]); setPurchaseRequestId(undefined); setOrderRequestId(makeRequestKey("po")); }
      else setError(err instanceof Error ? err.message : "Purchase order was not saved. Retry using the same form.");
    }
  }

  async function shareOrder(order: PurchaseOrder) {
    const lines = order.items.map((line) => `• ${line.quantity} ${line.unit} × ${line.itemName}${line.unitCost > 0 ? ` · ${money(line.unitCost)} each` : ""}`).join("\n");
    const expected = order.expectedDeliveryDate ? `\nExpected delivery: ${order.expectedDeliveryDate}` : "";
    const message = `TILL & TABLE · PURCHASE ORDER\n${workspace?.name ?? "Workspace"}\n${order.number}\nSupplier: ${order.supplierName}\nOrdered: ${new Date(order.createdAt).toLocaleDateString()}${expected}\n\n${lines}\n\nEstimated quoted total: ${order.estimatedTotal > 0 ? money(order.estimatedTotal) : "not provided"}\nDeliver to: Main warehouse`;
    try { await Share.share({ title: `${order.number} · ${order.supplierName}`, message }); }
    catch (err) { setError(err instanceof Error ? `Purchase order could not be shared: ${err.message}` : "Purchase order could not be shared."); }
  }

  function openReceipt(order: PurchaseOrder) {
    setReceivingOrder(order); setReceiptQuantities({}); setReceiptNote(""); setReceiptKey(makeRequestKey("gr")); setReceiptError("");
  }

  async function submitReceipt() {
    if (!receivingOrder) return;
    if (!receiptNote.trim()) { setReceiptError("Enter a delivery or packing-slip reference."); return; }
    const items = receivingOrder.items.map((line) => ({ lineId: line.id, quantity: Number(receiptQuantities[line.id]) })).filter((line) => Number.isInteger(line.quantity) && line.quantity > 0);
    if (!items.length) { setReceiptError("Enter a positive whole-unit quantity for at least one delivered good."); return; }
    const invalid = items.find((item) => {
      const line = receivingOrder.items.find((candidate) => candidate.id === item.lineId)!;
      return item.quantity > line.quantity - line.receivedQuantity;
    });
    if (invalid) { setReceiptError("A received quantity cannot exceed the outstanding amount on its order line."); return; }
    setReceiptError("");
    try {
      const result = await receivePurchaseOrder.mutateAsync({ requestId: receiptKey, purchaseOrderId: receivingOrder.id, note: receiptNote.trim(), items });
      await refreshPurchasing();
      setNotice(`${result.receipt.number} posted · ${result.purchaseOrder.number} is ${orderStatus(result.purchaseOrder.status).toLowerCase()}. Stock is now in the Main warehouse.`);
      setReceivingOrder(null);
    } catch (err) {
      const refreshed = await receipts.refetch();
      const existing = refreshed.data?.find((receipt) => receipt.id === receiptKey);
      if (existing) { setNotice(`${existing.number} was already posted. Check the updated order balance before retrying.`); setReceivingOrder(null); }
      else setReceiptError(err instanceof Error ? err.message : "Goods receipt could not be saved. Retry the same quantities and reference.");
    }
  }

  const purchaseOrderText = (order: PurchaseOrder) => order.items.map((line) => {
    const factor = Number(line.baseUnitsPerPurchaseUnit ?? 1);
    const baseReceived = baseQuantityLabel(line.receivedQuantity * factor);
    const baseOrdered = baseQuantityLabel(line.quantity * factor);
    return `${line.itemName}: ${line.receivedQuantity}/${line.quantity} ${line.unit} packs · ${baseReceived}/${baseOrdered} ${line.stockUnit ?? "unit"}`;
  }).join(" · ");

  return <View style={{ gap: 10 }}>
    <View style={styles.metricRow}><Metric label="ACTIVE SUPPLIERS" value={suppliers.error ? "—" : String(activeSuppliers.length)} /><Metric label="OPEN / PARTIAL ORDERS" value={orders.error ? "—" : String((orders.data ?? []).filter((order) => order.status !== "received").length)} /><Metric label="REORDER CANDIDATES" value={inventory.error ? "—" : String(lowStockGoods.length)} /></View>
    {error ? <View style={styles.errorBanner}><Text style={styles.errorText}>{error}</Text></View> : null}
    {notice ? <Pressable style={styles.notice} onPress={() => setNotice("")}><Text style={styles.noticeText}>{notice}</Text><Text style={styles.dismissMark}>×</Text></Pressable> : null}

    <SectionTitle title="Minimum-stock reorder queue" action={`${lowStockGoods.length} items`} />
    {inventory.isLoading ? <Text style={styles.smallNote}>Loading the shared Main warehouse…</Text> : inventory.error ? <Card style={styles.panelCard}><Text style={styles.errorText}>Inventory is not synchronized. Reconnect before raising stock requests.</Text></Card> : lowStockGoods.length ? <View style={styles.list}>{lowStockGoods.map((item) => {
      const balance = Number(item.stockOnHand ?? 0); const minimum = Number(item.lowStockThreshold ?? 0); const factor = Number(item.baseUnitsPerPurchaseUnit ?? 1); const validFactor = Number.isFinite(factor) && factor > 0; const suggested = validFactor ? calculateReorderPacks(balance, minimum, factor) : 0; const requestedPacks = Math.max(1, suggested); const purchaseUnit = item.purchaseUnit ?? item.stockUnit ?? "unit";
      return <Card key={item.id} style={styles.panelCard}><View style={styles.rowBetween}><View style={{ flex: 1 }}><Text style={styles.primary}>{item.name}</Text><Text style={styles.secondary}>{item.ingredientOnly ? "INGREDIENT" : "SELLABLE GOOD"} · {balance} / {minimum} {item.stockUnit ?? "unit"} · {balance <= 0 ? "out of stock" : "at/below minimum"}</Text><Text style={styles.secondary}>1 {purchaseUnit} = {validFactor ? factor : "invalid conversion"} {item.stockUnit ?? "unit"} · {suggested} {purchaseUnit} pack(s) needed to restore minimum</Text></View><Pressable disabled={createRequest.isPending || !validFactor} onPress={() => void requestLowStock(item)} style={styles.smallButton}><Text style={styles.smallButtonText}>{createRequest.isPending ? "Saving…" : suggested ? `Request ${requestedPacks} ${purchaseUnit}` : `Request 1 ${purchaseUnit} anyway`}</Text></Pressable></View></Card>;
    })}</View> : <EmptyState icon="inventory-2" title="No items at minimum stock" body="Tracked goods and BOM ingredients at or below their configured minimum appear here as purchase-request candidates." />}

    <SectionTitle title="Supplier directory" action={`${suppliers.data?.length ?? 0} saved`} />
    <Card style={styles.panelCard}><Text style={styles.cardTitle}>{supplierEditId ? "Edit supplier" : "Add supplier"}</Text><Field label="SUPPLIER / VENDOR NAME" value={supplierName} onChangeText={setSupplierName} placeholder="e.g. Northside Produce" /><Field label="CONTACT PERSON · OPTIONAL" value={supplierContact} onChangeText={setSupplierContact} placeholder="Name" /><Field label="EMAIL · OPTIONAL" value={supplierEmail} onChangeText={setSupplierEmail} placeholder="orders@example.com" keyboardType="email-address" /><Field label="PHONE · OPTIONAL" value={supplierPhone} onChangeText={setSupplierPhone} placeholder="Phone number" keyboardType="phone-pad" /><Field label="NOTES · OPTIONAL" value={supplierNotes} onChangeText={setSupplierNotes} placeholder="Delivery window, account code…" /><View style={styles.choiceRow}><Pill label="Active supplier" selected={supplierActive} onPress={() => setSupplierActive(true)} /><Pill label="Inactive" selected={!supplierActive} onPress={() => setSupplierActive(false)} /></View><PrimaryButton label={saveSupplier.isPending ? "Saving…" : supplierEditId ? "Save supplier" : "Add supplier"} icon="storefront" onPress={() => void submitSupplier()} loading={saveSupplier.isPending} disabled={saveSupplier.isPending} />{supplierEditId ? <Pressable style={styles.textButton} onPress={resetSupplierForm}><Text style={styles.textButtonLabel}>Cancel supplier edit</Text></Pressable> : null}</Card>
    {suppliers.error ? <Card style={styles.panelCard}><Text style={styles.errorText}>Supplier list could not be synchronized.</Text></Card> : suppliers.data?.length ? <View style={styles.list}>{suppliers.data.map((supplier) => <Card key={supplier.id} style={styles.panelCard}><View style={styles.rowBetween}><View style={{ flex: 1 }}><Text style={styles.primary}>{supplier.name}</Text><Text style={styles.secondary}>{[supplier.contactName, supplier.phone, supplier.email].filter(Boolean).join(" · ") || "No contact details"}</Text></View><Text style={[styles.status, supplier.active ? styles.activeText : styles.inactiveText]}>{supplier.active ? "ACTIVE" : "INACTIVE"}</Text></View><View style={styles.choiceRow}><Pressable onPress={() => editSupplier(supplier)} style={styles.smallButton}><Text style={styles.smallButtonText}>Edit</Text></Pressable><Pressable onPress={() => void setSupplierStatus(supplier, !supplier.active)} style={styles.textButton}><Text style={styles.textButtonLabel}>{supplier.active ? "Deactivate" : "Reactivate"}</Text></Pressable></View></Card>)}</View> : <Text style={styles.smallNote}>Add an active vendor to create purchase orders.</Text>}

    <SectionTitle title="Purchase requests" action={`${requests.data?.length ?? 0} total`} />
    {requests.data?.some((request) => request.status === "requested") ? <Field label="DECISION NOTE · OPTIONAL · APPLIES TO YOUR NEXT APPROVE / REJECT" value={decisionNote} onChangeText={setDecisionNote} placeholder="e.g. confirm the storage space is ready" /> : null}
    {requests.error ? <Card style={styles.panelCard}><Text style={styles.errorText}>Purchase requests could not be synchronized.</Text></Card> : requests.data?.length ? <View style={styles.list}>{requests.data.map((request) => <Card key={request.id} style={styles.panelCard}><View style={styles.rowBetween}><View style={{ flex: 1 }}><Text style={styles.primary}>{request.itemName} · {request.quantity} {request.unit}</Text><Text style={styles.secondary}>{request.reason} · {new Date(request.createdAt).toLocaleString()}</Text></View><Text style={[styles.status, request.status === "rejected" ? styles.inactiveText : request.status === "received" ? styles.activeText : styles.pendingText]}>{orderStatus(request.status)}</Text></View>{request.reviewNote ? <Text style={styles.secondary}>Manager note: {request.reviewNote}</Text> : null}<View style={styles.choiceRow}>{request.status === "requested" ? <><Pressable disabled={reviewRequest.isPending} onPress={() => void decideRequest(request, "approved")} style={styles.smallButton}><Text style={styles.smallButtonText}>Approve</Text></Pressable><Pressable disabled={reviewRequest.isPending} onPress={() => void decideRequest(request, "rejected")} style={styles.textButton}><Text style={styles.textButtonLabel}>Reject</Text></Pressable></> : request.status === "approved" ? <Pressable onPress={() => startOrderFromRequest(request)} style={styles.smallButton}><Text style={styles.smallButtonText}>Create purchase order</Text></Pressable> : request.purchaseOrderId ? <Text style={styles.secondary}>Linked PO · {orders.data?.find((order) => order.id === request.purchaseOrderId)?.number ?? "syncing"}</Text> : null}</View></Card>)}</View> : <EmptyState icon="assignment" title="No purchase requests" body="Cashier requests and manager low-stock requests will appear here." />}

    <SectionTitle title="Create purchase order" action={draftLines.length ? `${draftLines.length} line(s)` : undefined} />
    <Card style={styles.panelCard}><Text style={styles.cardTitle}>{purchaseRequestId ? "Order approved request" : "New vendor order"}</Text><Text style={styles.smallNote}>Create a numbered order for the vendor. Share the order when ready; it is not sent automatically.</Text>
      {activeSuppliers.length ? <><Text style={styles.fieldLabel}>SUPPLIER</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.choiceRow}>{activeSuppliers.map((supplier) => <Pill key={supplier.id} label={supplier.name} selected={resolvedSupplierId === supplier.id} onPress={() => setPurchaseSupplierId(supplier.id)} />)}</ScrollView></> : <Text style={styles.warningText}>Add an active supplier before placing an order.</Text>}
      {trackedGoods.length ? <><Text style={styles.fieldLabel}>TRACKED STOCK ITEM</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.choiceRow}>{trackedGoods.map((item) => <Pill key={item.id} label={item.ingredientOnly ? `${item.name} · ingredient` : item.name} selected={resolvedItemId === item.id} onPress={() => setSelectedItemId(item.id)} />)}</ScrollView><View style={styles.inlineFields}><Field label={`ORDER QTY · WHOLE ${orderPurchaseUnit.toUpperCase()} PACKS`} value={orderQuantity} onChangeText={setOrderQuantity} placeholder="1" keyboardType="number-pad" /><Field label={`QUOTED COST PER ${orderPurchaseUnit.toUpperCase()} · ${currency} · OPTIONAL`} value={unitCost} onChangeText={setUnitCost} placeholder="Not quoted" keyboardType="decimal-pad" /></View><Text style={styles.smallNote}>1 {orderPurchaseUnit} = {orderConversionFactor} {orderStockUnit} · received ingredients enter stock in base units.</Text><Pressable onPress={addOrderLine} style={styles.smallButton}><Text style={styles.smallButtonText}>＋ Add stock item to order</Text></Pressable></> : <Text style={styles.smallNote}>Enable tracking for goods or add an ingredient in Recipes & costs before ordering stock.</Text>}
      {draftLines.length ? <View style={styles.orderLines}>{draftLines.map((line) => <View key={line.itemId} style={styles.rowBetween}><Text style={styles.secondary}>{line.quantity} {line.unit} pack(s) × {line.itemName} · {baseQuantityLabel(line.quantity * line.baseUnitsPerPurchaseUnit)} {line.stockUnit}{line.unitCost > 0 ? ` · ${money(line.unitCost)} per pack` : ""}</Text><Pressable onPress={() => setDraftLines((current) => current.filter((candidate) => candidate.itemId !== line.itemId))}><Text style={styles.removeLabel}>Remove</Text></Pressable></View>)}</View> : null}
      <Field label="EXPECTED DELIVERY · YYYY-MM-DD · OPTIONAL" value={expectedDeliveryDate} onChangeText={setExpectedDeliveryDate} placeholder="YYYY-MM-DD" />
      {purchaseRequestId ? <Pressable style={styles.textButton} onPress={() => { setPurchaseRequestId(undefined); setDraftLines([]); setNotice("Approved-request link cleared."); }}><Text style={styles.textButtonLabel}>Clear request link</Text></Pressable> : null}
      <View style={{ height: 10 }} /><PrimaryButton label={createPurchaseOrder.isPending ? "Placing order…" : "Create purchase order"} icon="receipt-long" onPress={() => void submitOrder()} loading={createPurchaseOrder.isPending} disabled={createPurchaseOrder.isPending || !activeSuppliers.length || !draftLines.length} />
    </Card>

    <SectionTitle title="Purchase orders" action={`${orders.data?.length ?? 0} total`} />
    {orders.isLoading ? <Text style={styles.smallNote}>Loading purchase orders…</Text> : orders.error ? <Card style={styles.panelCard}><Text style={styles.errorText}>Purchase orders could not be synchronized.</Text></Card> : orders.data?.length ? <View style={styles.list}>{orders.data.map((order) => <Card key={order.id} style={styles.panelCard}><View style={styles.rowBetween}><View style={{ flex: 1 }}><Text style={styles.primary}>{order.number} · {order.supplierName}</Text><Text style={styles.secondary}>{order.items.length} goods · {order.expectedDeliveryDate ? `expected ${order.expectedDeliveryDate}` : "no expected date"}</Text></View><Text style={[styles.status, order.status === "received" ? styles.activeText : styles.pendingText]}>{orderStatus(order.status)}</Text></View><Text style={styles.secondary}>{purchaseOrderText(order)}</Text><Text style={styles.orderTotal}>{order.estimatedTotal > 0 ? `Quoted subtotal · ${money(order.estimatedTotal)}` : "Quoted cost not entered"}</Text><View style={styles.choiceRow}><Pressable onPress={() => void shareOrder(order)} style={styles.smallButton}><Text style={styles.smallButtonText}>Share vendor order</Text></Pressable>{order.status !== "received" ? <Pressable onPress={() => openReceipt(order)} style={styles.receiveButton}><Text style={styles.receiveButtonText}>Receive goods</Text></Pressable> : null}</View></Card>)}</View> : <EmptyState icon="receipt-long" title="No purchase orders" body="Create an order for an active supplier; receive deliveries here to add them to the Main warehouse." />}

    <SectionTitle title="Recent warehouse receipts" action={`${receipts.data?.length ?? 0} shown`} />
    {receipts.error ? <Card style={styles.panelCard}><Text style={styles.errorText}>Goods receipts could not be synchronized.</Text></Card> : receipts.data?.length ? <View style={styles.list}>{receipts.data.slice(0, 20).map((receipt) => <ReceiptCard key={receipt.id} receipt={receipt} />)}</View> : <Text style={styles.smallNote}>Posted receipts will show the quantity added, supplier, order and delivery reference.</Text>}

    <View style={styles.accountingNote}><Text style={styles.accountingText}>Purchase orders track quantity and optional quoted cost only; they do not post expenses or payables. Record the supplier&apos;s actual invoice separately under Accounting → Vendor bills.</Text></View>

    <Modal visible={Boolean(receivingOrder)} transparent animationType="slide" onRequestClose={() => setReceivingOrder(null)}>
      <View style={styles.modalBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setReceivingOrder(null)} />
        <View style={styles.modalSheet}><ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.rowBetween}><View style={{ flex: 1 }}><Text style={styles.cardTitle}>Receive into Main warehouse</Text><Text style={styles.smallNote}>{receivingOrder?.number} · {receivingOrder?.supplierName}</Text></View><Pressable onPress={() => setReceivingOrder(null)}><Text style={styles.closeLabel}>Close</Text></Pressable></View>
          {receivingOrder?.items.filter((line) => line.receivedQuantity < line.quantity).map((line) => <View key={line.id} style={styles.receiveLine}><Text style={styles.primary}>{line.itemName}</Text><Text style={styles.secondary}>{line.receivedQuantity}/{line.quantity} {line.unit} packs received · {line.quantity - line.receivedQuantity} outstanding · 1 {line.unit} = {line.baseUnitsPerPurchaseUnit ?? 1} {line.stockUnit ?? "unit"}</Text><Field label={`DELIVERED NOW · WHOLE ${line.unit.toUpperCase()} PACKS`} value={receiptQuantities[line.id] ?? ""} onChangeText={(value) => setReceiptQuantities((current) => ({ ...current, [line.id]: value }))} placeholder="0" keyboardType="number-pad" /></View>)}
          <Field label="DELIVERY / PACKING-SLIP REFERENCE · REQUIRED" value={receiptNote} onChangeText={setReceiptNote} placeholder="e.g. supplier docket 1042" />
          {receiptError ? <Text style={styles.errorText}>{receiptError}</Text> : null}
          <View style={{ height: 12 }} /><PrimaryButton label={receivePurchaseOrder.isPending ? "Posting receipt…" : "Post goods receipt"} icon="inventory" onPress={() => void submitReceipt()} loading={receivePurchaseOrder.isPending} disabled={receivePurchaseOrder.isPending} /><Pressable onPress={() => setReceivingOrder(null)} style={styles.textButton}><Text style={styles.textButtonLabel}>Cancel</Text></Pressable>
        </ScrollView></View>
      </View>
    </Modal>
  </View>;
}

export function CashierPurchaseRequestPanel() {
  const utils = trpc.useUtils();
  const goods = trpc.purchasing.requestableGoods.useQuery(undefined, { refetchInterval: 3_000 });
  const requests = trpc.purchasing.requests.useQuery(undefined, { refetchInterval: 3_000 });
  const createRequest = trpc.purchasing.createRequest.useMutation();
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [requestKey, setRequestKey] = useState(() => makeRequestKey("req"));
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const requestableGoods = goods.data ?? [];
  const selected = requestableGoods.find((item) => item.id === itemId) ?? requestableGoods[0];
  const selectedPackSuggestion = selected ? calculateReorderPacks(Number(selected.stockOnHand ?? 0), Number(selected.minimumStock ?? 0), Number(selected.baseUnitsPerPurchaseUnit ?? 1)) : 0;

  async function submit() {
    const amount = Number(quantity);
    if (!selected) { setError("Choose a tracked good for the purchase request."); return; }
    if (!Number.isInteger(amount) || amount <= 0) { setError("Requested quantity must be a positive whole number."); return; }
    if (!reason.trim()) { setError("Enter why the good is needed."); return; }
    setError(""); setMessage("");
    try {
      const request = await createRequest.mutateAsync({ requestId: requestKey, itemId: selected.id, quantity: amount, reason: reason.trim() });
      await utils.purchasing.requests.invalidate();
      setMessage(`Request ${request.itemName} · ${request.quantity} ${request.unit} sent to your manager.`);
      setQuantity("1"); setReason(""); setRequestKey(makeRequestKey("req"));
    } catch (err) { setError(err instanceof Error ? err.message : "Purchase request could not be submitted."); }
  }

  return <View style={{ gap: 10 }}>
    {message ? <Pressable style={styles.notice} onPress={() => setMessage("")}><Text style={styles.noticeText}>{message}</Text></Pressable> : null}
    {error ? <View style={styles.errorBanner}><Text style={styles.errorText}>{error}</Text></View> : null}
    <Card style={styles.panelCard}><Text style={styles.cardTitle}>Request goods for purchasing</Text><Text style={styles.smallNote}>Send a stock request to your workspace manager. The request does not reserve or change stock.</Text>
      {goods.isLoading ? <Text style={styles.smallNote}>Loading tracked goods…</Text> : goods.error ? <Text style={styles.errorText}>Tracked goods could not be synchronized.</Text> : requestableGoods.length ? <><Text style={styles.fieldLabel}>GOOD</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.choiceRow}>{requestableGoods.map((item) => <Pill key={item.id} label={item.name} selected={item.id === selected?.id} onPress={() => setItemId(item.id)} />)}</ScrollView>{selected ? <Text style={styles.secondary}>{selected.stockOnHand} {selected.stockUnit} in Main warehouse · minimum {selected.minimumStock} {selected.stockUnit} · 1 {selected.unit} = {selected.baseUnitsPerPurchaseUnit} {selected.stockUnit}{selected.available ? "" : " · currently hidden from POS"}</Text> : null}<Field label={`REQUESTED QTY · WHOLE ${selected?.unit.toUpperCase() ?? "UNIT"} PACKS`} value={quantity} onChangeText={setQuantity} placeholder="1" keyboardType="number-pad" />{selected ? <Pressable onPress={() => setQuantity(String(Math.max(1, selectedPackSuggestion)))} style={styles.smallButton}><Text style={styles.smallButtonText}>{selectedPackSuggestion > 0 ? `Use suggested · ${selectedPackSuggestion} ${selected.unit}` : `No shortfall · request 1 ${selected.unit} anyway`}</Text></Pressable> : null}<Field label="REASON · REQUIRED" value={reason} onChangeText={setReason} placeholder="e.g. needed for the weekend menu" /><View style={{ height: 8 }} /><PrimaryButton label={createRequest.isPending ? "Sending request…" : "Send purchase request"} icon="outbox" onPress={() => void submit()} loading={createRequest.isPending} disabled={createRequest.isPending} /></> : <EmptyState icon="inventory-2" title="No tracked goods yet" body="Ask your manager to enable stock tracking for goods before requesting them." />}
    </Card>
    <SectionTitle title="My purchase requests" action={`${requests.data?.length ?? 0} total`} />
    {requests.error ? <Card style={styles.panelCard}><Text style={styles.errorText}>Your requests are not synchronized.</Text></Card> : requests.data?.length ? <View style={styles.list}>{requests.data.map((request) => <Card key={request.id} style={styles.panelCard}><View style={styles.rowBetween}><View style={{ flex: 1 }}><Text style={styles.primary}>{request.itemName} · {request.quantity} {request.unit}</Text><Text style={styles.secondary}>{request.reason}</Text><Text style={styles.secondary}>{new Date(request.createdAt).toLocaleString()}{request.reviewNote ? ` · ${request.reviewNote}` : ""}</Text></View><Text style={[styles.status, request.status === "rejected" ? styles.inactiveText : request.status === "received" ? styles.activeText : styles.pendingText]}>{orderStatus(request.status)}</Text></View></Card>)}</View> : <EmptyState icon="assignment" title="No requests sent" body="Submit a request when you need goods replenished; your manager reviews it here." />}
    <Text style={styles.privacyNote}>Purchasing requests are private to you and workspace managers. Kitchen accounts cannot open this purchasing area.</Text>
  </View>;
}

function ReceiptCard({ receipt }: { receipt: GoodsReceipt }) {
  return <Card style={styles.panelCard}><View style={styles.rowBetween}><View style={{ flex: 1 }}><Text style={styles.primary}>{receipt.number} · {receipt.purchaseOrderNumber}</Text><Text style={styles.secondary}>{receipt.supplierName} · {new Date(receipt.receivedAt).toLocaleString()}</Text></View><Text style={styles.status}>POSTED</Text></View><Text style={styles.secondary}>{receipt.lines.map((line) => `+${line.quantity} ${line.unit} ${line.itemName} = ${line.baseQuantity ?? line.quantity} ${line.stockUnit ?? line.unit} · balance ${line.quantityBefore} → ${line.quantityAfter} ${line.stockUnit ?? line.unit}`).join(" · ")}</Text><Text style={styles.secondary}>Delivery reference: {receipt.note}</Text></Card>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <Card style={styles.metric}><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></Card>;
}

function Field({ label, value, onChangeText, placeholder, keyboardType }: { label: string; value: string; onChangeText: (value: string) => void; placeholder: string; keyboardType?: "default" | "decimal-pad" | "number-pad" | "email-address" | "phone-pad" }) {
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor="#99A39B" keyboardType={keyboardType ?? "default"} autoCapitalize={keyboardType === "email-address" ? "none" : "sentences"} style={styles.input} /></View>;
}

const styles = StyleSheet.create({
  list: { gap: 7 },
  metricRow: { flexDirection: "row", gap: 7 },
  metric: { flex: 1, padding: 10 },
  metricValue: { color: palette.evergreen, fontSize: 17, fontWeight: "900" },
  metricLabel: { color: palette.muted, fontSize: 7, fontWeight: "900", letterSpacing: 0.45, marginTop: 3 },
  panelCard: { padding: 12 },
  cardTitle: { color: palette.ink, fontSize: 12, fontWeight: "900" },
  smallNote: { color: palette.muted, fontSize: 9, lineHeight: 14, marginTop: 5 },
  primary: { color: palette.ink, fontSize: 10, fontWeight: "900" },
  secondary: { color: palette.muted, fontSize: 8, lineHeight: 13, marginTop: 3 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  choiceRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", paddingVertical: 7 },
  field: { marginTop: 9 },
  fieldLabel: { color: palette.muted, fontSize: 7, fontWeight: "900", letterSpacing: 0.65, marginBottom: 4 },
  input: { minHeight: 39, borderRadius: 10, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, paddingHorizontal: 10, color: palette.ink, fontSize: 10 },
  inlineFields: { flexDirection: "row", gap: 8 },
  orderLines: { gap: 7, marginTop: 9, padding: 9, backgroundColor: "#F3F3EC", borderRadius: 10 },
  removeLabel: { color: palette.coral, fontSize: 8, fontWeight: "800", padding: 5 },
  smallButton: { alignSelf: "flex-start", borderWidth: 1, borderColor: palette.line, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 7, backgroundColor: "#FBFAF5" },
  smallButtonText: { color: palette.evergreen, fontSize: 8, fontWeight: "900" },
  receiveButton: { alignSelf: "flex-start", borderRadius: 8, paddingHorizontal: 9, paddingVertical: 7, backgroundColor: palette.evergreenSoft },
  receiveButtonText: { color: palette.evergreen, fontSize: 8, fontWeight: "900" },
  status: { color: palette.evergreen, fontSize: 7, fontWeight: "900", letterSpacing: 0.5 },
  activeText: { color: palette.evergreen },
  inactiveText: { color: palette.coral },
  pendingText: { color: "#98661F" },
  warningText: { color: "#98661F", fontSize: 9, marginTop: 7 },
  errorBanner: { backgroundColor: palette.coralSoft, padding: 9, borderRadius: 10 },
  errorText: { color: palette.coral, fontSize: 9, lineHeight: 14 },
  notice: { flexDirection: "row", alignItems: "center", gap: 8, padding: 9, borderRadius: 10, backgroundColor: palette.evergreenSoft },
  noticeText: { flex: 1, color: palette.evergreen, fontSize: 9, lineHeight: 14, fontWeight: "700" },
  dismissMark: { color: palette.evergreen, fontSize: 16, fontWeight: "900" },
  textButton: { padding: 7, alignSelf: "flex-start" },
  textButtonLabel: { color: palette.coral, fontSize: 8, fontWeight: "800" },
  orderTotal: { color: palette.evergreen, fontSize: 8, fontWeight: "900", marginTop: 7 },
  receiveLine: { padding: 9, backgroundColor: "#F3F3EC", borderRadius: 10, marginTop: 8 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(17,36,30,0.46)", justifyContent: "flex-end", padding: 10 },
  modalSheet: { maxHeight: "90%", borderRadius: 18, backgroundColor: palette.background, padding: 15 },
  closeLabel: { color: palette.evergreen, fontSize: 9, fontWeight: "900", padding: 8 },
  accountingNote: { padding: 10, borderRadius: 10, borderWidth: 1, borderColor: "#E6D7B8", backgroundColor: "#F7F1E4" },
  accountingText: { color: "#806028", fontSize: 8, lineHeight: 13 },
  privacyNote: { color: palette.muted, fontSize: 8, lineHeight: 13, textAlign: "center", marginTop: 5 },
});
