import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { businessRecords } from "../../drizzle/schema";
import { roundAmount } from "../../shared/accounting";
import { applyIngredientStockDelta, applyStockDelta, normalizeStockQuantity } from "../../shared/inventory";
import { applyPurchaseReceipt, linkedPurchaseRequestStatus } from "../../shared/purchasing";
import { convertPurchaseToBaseQuantity, isPositiveConversionFactor, normalizeBaseQuantity } from "../../shared/unit-conversion";
import type { CurrencyCode, GoodsReceipt, InventoryMovement, MenuItem, PurchaseOrder, PurchaseOrderLine, PurchaseRequest, Supplier } from "../../shared/pos";
import { lockBusinessForUpdate, saveBusinessRecord } from "../db";
import { cashierProcedure, managerProcedure, requireDatabase } from "../_core/business";
import { router } from "../_core/trpc";

const clientRequestId = z.string().min(16).max(80).regex(/^[A-Za-z0-9_-]+$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Use a valid calendar date in YYYY-MM-DD format.");

function newId() { return randomUUID(); }
function recordPayload<T>(row: { payload: Record<string, unknown> }): T { return row.payload as unknown as T; }
function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function conflict(message: string): never { throw new TRPCError({ code: "CONFLICT", message }); }

async function getRecordTx(tx: any, businessId: string, kind: string, recordId: string) {
  const rows = await tx.select().from(businessRecords)
    .where(and(eq(businessRecords.businessId, businessId), eq(businessRecords.recordKind, kind), eq(businessRecords.recordId, recordId)))
    .for("update").limit(1);
  return rows[0] ?? null;
}

async function listRecordsTx(tx: any, businessId: string, kind: string) {
  return tx.select().from(businessRecords)
    .where(and(eq(businessRecords.businessId, businessId), eq(businessRecords.recordKind, kind)))
    .for("update");
}

function dbFailure(error: unknown, fallback: string): never {
  if (error instanceof TRPCError) throw error;
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: fallback, cause: error });
}

const supplierInput = z.object({
  id: z.string().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(120),
  contactName: z.string().trim().max(120).optional(),
  email: z.string().trim().email().max(320).optional().or(z.literal("")),
  phone: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(240).optional(),
  active: z.boolean().default(true),
});

const orderLineInput = z.object({
  itemId: z.string().min(1).max(80),
  quantity: z.number().int().min(1).max(1_000_000),
  unitCost: z.number().finite().min(0).max(1_000_000_000).default(0),
});
const orderInput = z.object({
  requestId: clientRequestId,
  supplierId: z.string().min(1).max(80),
  expectedDeliveryDate: isoDate.optional(),
  purchaseRequestId: z.string().min(1).max(80).optional(),
  items: z.array(orderLineInput).min(1).max(50),
}).superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const line of value.items) {
    if (ids.has(line.itemId)) ctx.addIssue({ code: "custom", message: "Include each good once and combine its ordered quantity.", path: ["items"] });
    ids.add(line.itemId);
  }
});

const receiptInput = z.object({
  requestId: clientRequestId,
  purchaseOrderId: z.string().min(1).max(80),
  note: z.string().trim().min(1).max(200),
  items: z.array(z.object({ lineId: z.string().min(1).max(100), quantity: z.number().int().min(1).max(1_000_000) })).min(1).max(50),
}).superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const line of value.items) {
    if (ids.has(line.lineId)) ctx.addIssue({ code: "custom", message: "Receive each purchase-order line only once per delivery.", path: ["items"] });
    ids.add(line.lineId);
  }
});

export const purchasingRouter = router({
  suppliers: managerProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const rows = await db.select().from(businessRecords)
      .where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "supplier")))
      .orderBy(desc(businessRecords.createdAt));
    return rows.map((row) => recordPayload<Supplier>(row));
  }),

  saveSupplier: managerProcedure.input(supplierInput).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    return db.transaction(async (tx) => {
      const rows = await listRecordsTx(tx, ctx.member.businessId, "supplier");
      const existing = input.id ? rows.find((row: any) => row.recordId === input.id) ?? null : null;
      if (input.id && !existing) throw new TRPCError({ code: "NOT_FOUND", message: "Supplier not found in this workspace." });
      const duplicate = rows.find((row: any) => row.recordId !== (existing?.recordId ?? "") && String(row.payload.name ?? "").trim().toLocaleLowerCase() === input.name.toLocaleLowerCase());
      if (duplicate) throw new TRPCError({ code: "CONFLICT", message: "A supplier with that name already exists in this workspace." });
      const now = new Date().toISOString();
      const supplier: Supplier = {
        id: existing?.recordId ?? newId(),
        name: input.name,
        contactName: input.contactName || undefined,
        email: input.email || undefined,
        phone: input.phone || undefined,
        notes: input.notes || undefined,
        active: input.active,
        createdAt: existing ? String(existing.payload.createdAt ?? now) : now,
        updatedAt: now,
      };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "supplier", recordId: supplier.id, payload: supplier as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      return supplier;
    });
  }),

  requests: cashierProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const requestConditions = ctx.member.role === "manager"
      ? and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "purchaseRequest"))
      : and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "purchaseRequest"), eq(businessRecords.createdByOpenId, ctx.user.openId));
    const rows = await db.select().from(businessRecords).where(requestConditions).orderBy(desc(businessRecords.createdAt));
    const requests = rows.map((row) => recordPayload<PurchaseRequest>(row));
    return requests;
  }),

  requestableGoods: cashierProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const rows = await db.select().from(businessRecords)
      .where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "menuItem")))
      .orderBy(desc(businessRecords.createdAt));
    return rows.map((row) => recordPayload<MenuItem>(row)).filter((item) => item.stockTracked === true).map((item) => ({
      id: item.id,
      name: item.name,
      unit: item.purchaseUnit ?? item.stockUnit ?? "unit",
      stockUnit: item.stockUnit ?? "unit",
      baseUnitsPerPurchaseUnit: Number(item.baseUnitsPerPurchaseUnit ?? 1),
      stockOnHand: item.ingredientOnly === true ? normalizeBaseQuantity(Number(item.stockOnHand ?? 0)) : normalizeStockQuantity(Number(item.stockOnHand ?? 0)),
      minimumStock: item.ingredientOnly === true ? normalizeBaseQuantity(Number(item.lowStockThreshold ?? 0)) : normalizeStockQuantity(Number(item.lowStockThreshold ?? 0)),
      ingredientOnly: item.ingredientOnly === true,
      available: item.available !== false,
    }));
  }),

  createRequest: cashierProcedure.input(z.object({
    requestId: clientRequestId,
    itemId: z.string().min(1).max(80),
    quantity: z.number().int().min(1).max(1_000_000),
    reason: z.string().trim().min(1).max(240),
  })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const requestFingerprint = fingerprint({ itemId: input.itemId, quantity: input.quantity, reason: input.reason });
    return db.transaction(async (tx) => {
      const itemRow = await getRecordTx(tx, ctx.member.businessId, "menuItem", input.itemId);
      if (!itemRow) throw new TRPCError({ code: "NOT_FOUND", message: "Good not found in this workspace." });
      const item = recordPayload<MenuItem>(itemRow);
      if (item.stockTracked !== true) throw new TRPCError({ code: "BAD_REQUEST", message: "Purchase requests can be made only for goods with stock tracking enabled." });
      const conversion = Number(item.baseUnitsPerPurchaseUnit ?? 1);
      if (!isPositiveConversionFactor(conversion)) throw new TRPCError({ code: "BAD_REQUEST", message: `${item.name} has an invalid purchase-unit conversion; ask a manager to review Recipes & costs.` });
      const existing = await getRecordTx(tx, ctx.member.businessId, "purchaseRequest", input.requestId);
      if (existing) {
        const prior = recordPayload<PurchaseRequest & { requestFingerprint?: string }>(existing);
        if (existing.createdByOpenId !== ctx.user.openId || prior.requestFingerprint !== requestFingerprint) conflict("This purchase request key was already used for a different request.");
        return prior;
      }
      const request: PurchaseRequest & { requestFingerprint: string } = {
        id: input.requestId,
        itemId: item.id,
        itemName: item.name,
        unit: item.purchaseUnit ?? item.stockUnit ?? "unit",
        quantity: input.quantity,
        reason: input.reason,
        stockOnHandAtRequest: item.ingredientOnly === true ? normalizeBaseQuantity(Number(item.stockOnHand ?? 0)) : normalizeStockQuantity(Number(item.stockOnHand ?? 0)),
        minimumStockAtRequest: item.ingredientOnly === true ? normalizeBaseQuantity(Number(item.lowStockThreshold ?? 0)) : normalizeStockQuantity(Number(item.lowStockThreshold ?? 0)),
        status: "requested",
        createdByOpenId: ctx.user.openId,
        createdAt: new Date().toISOString(),
        stockUnit: item.stockUnit ?? "unit",
        baseUnitsPerPurchaseUnit: conversion,
        requestFingerprint,
      };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "purchaseRequest", recordId: request.id, payload: request as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      return request;
    });
  }),

  reviewRequest: managerProcedure.input(z.object({ id: z.string().min(1).max(80), decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(240).optional() })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    return db.transaction(async (tx) => {
      const row = await getRecordTx(tx, ctx.member.businessId, "purchaseRequest", input.id);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Purchase request not found in this workspace." });
      const request = recordPayload<PurchaseRequest>(row);
      if (request.status !== "requested") throw new TRPCError({ code: "BAD_REQUEST", message: "Only a waiting purchase request can be approved or rejected." });
      const updated: PurchaseRequest = { ...request, status: input.decision, reviewedByOpenId: ctx.user.openId, reviewedAt: new Date().toISOString(), reviewNote: input.note || undefined };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "purchaseRequest", recordId: request.id, payload: updated as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      return updated;
    });
  }),

  purchaseOrders: managerProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const rows = await db.select().from(businessRecords)
      .where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "purchaseOrder")))
      .orderBy(desc(businessRecords.createdAt));
    return rows.map((row) => recordPayload<PurchaseOrder>(row));
  }),

  createPurchaseOrder: managerProcedure.input(orderInput).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const currency = ctx.member.business.currency as CurrencyCode;
    const orderFingerprint = fingerprint({ supplierId: input.supplierId, expectedDeliveryDate: input.expectedDeliveryDate, purchaseRequestId: input.purchaseRequestId, items: input.items });
    return db.transaction(async (tx) => {
      const supplierRow = await getRecordTx(tx, ctx.member.businessId, "supplier", input.supplierId);
      if (!supplierRow) throw new TRPCError({ code: "NOT_FOUND", message: "Choose a supplier saved in this workspace." });
      const supplier = recordPayload<Supplier>(supplierRow);
      if (!supplier.active) throw new TRPCError({ code: "BAD_REQUEST", message: "This supplier is inactive and cannot receive a new purchase order." });
      const existing = await getRecordTx(tx, ctx.member.businessId, "purchaseOrder", input.requestId);
      if (existing) {
        const prior = recordPayload<PurchaseOrder>(existing);
        if (existing.createdByOpenId !== ctx.user.openId || prior.requestFingerprint !== orderFingerprint) conflict("This purchase-order request key was already used for a different order.");
        return prior;
      }

      let requestRow: any = null;
      if (input.purchaseRequestId) {
        requestRow = await getRecordTx(tx, ctx.member.businessId, "purchaseRequest", input.purchaseRequestId);
        if (!requestRow) throw new TRPCError({ code: "NOT_FOUND", message: "Purchase request not found in this workspace." });
        const request = recordPayload<PurchaseRequest>(requestRow);
        if (request.status !== "approved") throw new TRPCError({ code: "BAD_REQUEST", message: "Approve the purchase request before creating its purchase order." });
        const matchingLine = input.items.find((line) => line.itemId === request.itemId);
        if (!matchingLine || matchingLine.quantity < request.quantity) throw new TRPCError({ code: "BAD_REQUEST", message: "The purchase order must cover the approved requested good and quantity." });
      }

      const menuItems = new Map<string, MenuItem>();
      for (const line of [...input.items].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
        const itemRow = await getRecordTx(tx, ctx.member.businessId, "menuItem", line.itemId);
        if (!itemRow) throw new TRPCError({ code: "NOT_FOUND", message: "A selected good no longer exists in this workspace." });
        const item = recordPayload<MenuItem>(itemRow);
        if (item.stockTracked !== true) throw new TRPCError({ code: "BAD_REQUEST", message: `${item.name} must have stock tracking enabled before it can be ordered.` });
        const factor = Number(item.baseUnitsPerPurchaseUnit ?? 1);
        if (!isPositiveConversionFactor(factor)) throw new TRPCError({ code: "BAD_REQUEST", message: `${item.name} has an invalid purchase-unit conversion; correct it before placing an order.` });
        if (requestRow) {
          const request = recordPayload<PurchaseRequest>(requestRow);
          if (request.itemId === item.id && ((request.unit && request.unit !== (item.purchaseUnit ?? item.stockUnit ?? "unit")) || (request.baseUnitsPerPurchaseUnit !== undefined && Math.abs(request.baseUnitsPerPurchaseUnit - factor) > 1e-9))) {
            throw new TRPCError({ code: "CONFLICT", message: `The purchase unit for ${item.name} changed after its request was submitted. Refresh the request before ordering.` });
          }
        }
        menuItems.set(line.itemId, item);
      }

      const orderId = input.requestId;
      const now = new Date().toISOString();
      const number = `PO-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
      const items: PurchaseOrderLine[] = input.items.map((line) => {
        const item = menuItems.get(line.itemId)!;
        return { id: newId(), itemId: item.id, itemName: item.name, unit: item.purchaseUnit ?? item.stockUnit ?? "unit", quantity: line.quantity, receivedQuantity: 0, unitCost: roundAmount(line.unitCost, currency), stockUnit: item.stockUnit ?? "unit", baseUnitsPerPurchaseUnit: Number(item.baseUnitsPerPurchaseUnit ?? 1) };
      });
      const estimatedTotal = roundAmount(items.reduce((sum, line) => sum + line.quantity * line.unitCost, 0), currency);
      const order: PurchaseOrder = {
        id: orderId,
        number,
        supplierId: supplier.id,
        supplierName: supplier.name,
        status: "ordered",
        items,
        estimatedTotal,
        expectedDeliveryDate: input.expectedDeliveryDate,
        purchaseRequestId: input.purchaseRequestId,
        createdByOpenId: ctx.user.openId,
        createdAt: now,
        updatedAt: now,
        requestFingerprint: orderFingerprint,
      };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "purchaseOrder", recordId: order.id, payload: order as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      if (requestRow) {
        const request = recordPayload<PurchaseRequest>(requestRow);
        const updated: PurchaseRequest = { ...request, status: "ordered", purchaseOrderId: order.id, reviewedByOpenId: request.reviewedByOpenId ?? ctx.user.openId, reviewedAt: request.reviewedAt ?? now };
        await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "purchaseRequest", recordId: request.id, payload: updated as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      }
      return order;
    });
  }),

  receivePurchaseOrder: managerProcedure.input(receiptInput).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const canonicalItems = [...input.items].sort((a, b) => a.lineId.localeCompare(b.lineId));
    const receiptFingerprint = fingerprint({ purchaseOrderId: input.purchaseOrderId, note: input.note, items: canonicalItems });
    return db.transaction(async (tx) => {
      await lockBusinessForUpdate(tx, ctx.member.businessId);
      const existingReceipt = await getRecordTx(tx, ctx.member.businessId, "goodsReceipt", input.requestId);
      if (existingReceipt) {
        const prior = recordPayload<GoodsReceipt>(existingReceipt);
        if (prior.purchaseOrderId !== input.purchaseOrderId || prior.requestFingerprint !== receiptFingerprint) conflict("This receipt request key was already used for a different delivery.");
        const existingOrderRow = await getRecordTx(tx, ctx.member.businessId, "purchaseOrder", prior.purchaseOrderId);
        if (!existingOrderRow) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The purchase order linked to this receipt is missing." });
        return { receipt: prior, purchaseOrder: recordPayload<PurchaseOrder>(existingOrderRow) };
      }
      const orderRow = await getRecordTx(tx, ctx.member.businessId, "purchaseOrder", input.purchaseOrderId);
      if (!orderRow) throw new TRPCError({ code: "NOT_FOUND", message: "Purchase order not found in this workspace." });
      const order = recordPayload<PurchaseOrder>(orderRow);
      if (order.status === "received") throw new TRPCError({ code: "BAD_REQUEST", message: "This purchase order has already been fully received." });
      const next = (() => {
        try { return applyPurchaseReceipt(order, canonicalItems); }
        catch (error) { throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "The received quantities are invalid." }); }
      })();

      const quantitiesByLine = new Map(canonicalItems.map((line) => [line.lineId, line.quantity]));
      const affectedLines = order.items.filter((line) => quantitiesByLine.has(line.id)).sort((a, b) => a.itemId.localeCompare(b.itemId));
      const goodsReceiptLines: GoodsReceipt["lines"] = [];
      const now = new Date().toISOString();
      const receiptNumber = `GR-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;

      for (const line of affectedLines) {
        const quantity = quantitiesByLine.get(line.id)!;
        const itemRow = await getRecordTx(tx, ctx.member.businessId, "menuItem", line.itemId);
        if (!itemRow) throw new TRPCError({ code: "NOT_FOUND", message: `${line.itemName} was removed from this workspace; no receipt was posted.` });
        const item = recordPayload<MenuItem>(itemRow);
        if (item.stockTracked !== true) throw new TRPCError({ code: "BAD_REQUEST", message: `Stock tracking was disabled for ${item.name}; no receipt was posted.` });
        const receiptStockUnit = line.stockUnit ?? item.stockUnit ?? line.unit;
        if (line.stockUnit && item.stockUnit && line.stockUnit.trim() !== item.stockUnit.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: `The stock unit for ${item.name} no longer matches this purchase-order snapshot. Reconcile the item before receiving; no receipt was posted.` });
        const factor = Number(line.baseUnitsPerPurchaseUnit ?? 1);
        if (!isPositiveConversionFactor(factor)) throw new TRPCError({ code: "BAD_REQUEST", message: `The saved purchase conversion for ${line.itemName} is invalid; no receipt was posted.` });
        const baseQuantity = convertPurchaseToBaseQuantity(quantity, factor);
        if (item.ingredientOnly !== true && factor !== 1) throw new TRPCError({ code: "BAD_REQUEST", message: `Only ingredient inventory supports multi-base-unit purchase conversions; no receipt was posted for ${item.name}.` });
        const before = item.ingredientOnly === true ? normalizeBaseQuantity(Number(item.stockOnHand ?? 0), "Current ingredient stock") : normalizeStockQuantity(Number(item.stockOnHand ?? 0));
        let after: number;
        try { after = item.ingredientOnly === true ? applyIngredientStockDelta(before, baseQuantity) : applyStockDelta(before, baseQuantity); }
        catch { throw new TRPCError({ code: "BAD_REQUEST", message: `Receiving ${quantity} ${line.unit} (${baseQuantity} ${line.stockUnit ?? item.stockUnit ?? "unit"}) would exceed the supported stock balance for ${item.name}.` }); }
        let unitCost = Number(item.unitCost ?? 0);
        if (item.ingredientOnly === true && line.unitCost > 0 && after > 0) {
          const receivedCostPerBaseUnit = line.unitCost / factor;
          unitCost = Math.round(((before * unitCost + baseQuantity * receivedCostPerBaseUnit) / after) * 1_000_000) / 1_000_000;
        }
        const updatedItem = { ...item, stockOnHand: after, unitCost };
        await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "menuItem", recordId: item.id, payload: updatedItem as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
        goodsReceiptLines.push({ lineId: line.id, itemId: item.id, itemName: item.name, unit: line.unit, quantity, quantityBefore: before, quantityAfter: after, stockUnit: receiptStockUnit, baseQuantity, baseUnitsPerPurchaseUnit: factor });
        const movementId = newId();
        const movement: InventoryMovement = {
          id: movementId,
          itemId: item.id,
          itemName: item.name,
          unit: receiptStockUnit,
          kind: "receipt",
          quantityDelta: baseQuantity,
          quantityBefore: before,
          quantityAfter: after,
          reason: `Purchase order ${order.number} · ${input.note}`,
          reference: receiptNumber,
          at: now,
          actorOpenId: ctx.user.openId,
          purchaseQuantity: quantity,
          purchaseUnit: line.unit,
          purchaseOrderId: order.id,
          purchaseOrderLineId: line.id,
          goodsReceiptId: input.requestId,
          baseUnitsPerPurchaseUnit: factor,
        };
        await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "stockMovement", recordId: movementId, payload: movement as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      }

      const updatedOrder: PurchaseOrder = { ...order, items: next.items, status: next.status, updatedAt: now };
      const receipt: GoodsReceipt = {
        id: input.requestId,
        number: receiptNumber,
        purchaseOrderId: order.id,
        purchaseOrderNumber: order.number,
        supplierName: order.supplierName,
        lines: goodsReceiptLines,
        note: input.note,
        receivedAt: now,
        receivedByOpenId: ctx.user.openId,
        requestFingerprint: receiptFingerprint,
      };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "purchaseOrder", recordId: order.id, payload: updatedOrder as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "goodsReceipt", recordId: receipt.id, payload: receipt as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      if (order.purchaseRequestId) {
        const requestRow = await getRecordTx(tx, ctx.member.businessId, "purchaseRequest", order.purchaseRequestId);
        if (!requestRow) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The purchase request linked to this order is missing; receipt was not posted." });
        const request = recordPayload<PurchaseRequest>(requestRow);
        const linkedLine = updatedOrder.items.find((line) => line.itemId === request.itemId);
        if (!linkedLine) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The linked request's good is missing from its purchase order; receipt was not posted." });
        const updatedRequest: PurchaseRequest = { ...request, status: linkedPurchaseRequestStatus(request.quantity, linkedLine.receivedQuantity) };
        await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "purchaseRequest", recordId: request.id, payload: updatedRequest as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      }
      return { receipt, purchaseOrder: updatedOrder };
    });
  }),

  receipts: managerProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const rows = await db.select().from(businessRecords)
      .where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "goodsReceipt")))
      .orderBy(desc(businessRecords.createdAt)).limit(100);
    return rows.map((row) => recordPayload<GoodsReceipt>(row));
  }),
});
