import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { businessRecords } from "../../drizzle/schema";
import { assertBalanced, makeJournalLine, roundAmount } from "../../shared/accounting";
import { aggregateStockDemand, applyIngredientStockDelta, applyStockDelta, calculateIngredientStockCount, calculateStockCount, normalizeStockQuantity } from "../../shared/inventory";
import { planRecipeConsumption } from "../../shared/recipes";
import { calculateLoyaltyRedemption, reverseLoyaltyPoints } from "../../shared/loyalty";
import { evaluatePromotionAtCheckout, isPromotionActiveAt } from "../../shared/promotions";
import { isSafeTransactionRecordId } from "../../shared/legacy";
import { INGREDIENT_BASE_UNITS, INGREDIENT_PURCHASE_UNITS, isPositiveConversionFactor, normalizeBaseQuantity } from "../../shared/unit-conversion";
import { projectKitchenOrder, type BillOfMaterial, type CurrencyCode, type InventoryMovement, type JournalEntry, type JournalLine, type MenuItem, type OrderLine, type OrderStatus, type PaymentMethod, type PosOrder, type Promotion, type RecipeSaleCost, type RecipeSaleCostLine, type Transaction } from "../../shared/pos";
import { saveBusinessRecord } from "../db";
import { cashierProcedure, kitchenProcedure, managerProcedure, requireDatabase, workspaceProcedure } from "../_core/business";
import { router } from "../_core/trpc";

const paymentSchema = z.enum(["Cash", "Card", "QRIS", "Other", "Gift Card"]);
const menuModifierSchema = z.object({ id: z.string().min(1).max(80), label: z.string().trim().min(1).max(120), price: z.number().finite().min(0).max(1_000_000_000) });
const lineInputSchema = z.object({ id: z.string().min(1).max(80), menuItemId: z.string().min(1).max(80), quantity: z.number().int().min(1).max(99), modifierId: z.string().max(80).optional(), modifierIds: z.array(z.string().min(1).max(80)).max(24).optional(), note: z.string().max(120).optional() }).superRefine((line, issue) => { if (line.modifierIds && new Set(line.modifierIds).size !== line.modifierIds.length) issue.addIssue({ code: "custom", message: "A modifier option cannot be selected twice.", path: ["modifierIds"] }); });
const baseQuantityInput = z.number().finite().min(0).max(1_000_000_000).refine((value) => { try { normalizeBaseQuantity(value); return true; } catch { return false; } }, "Use no more than three decimal places.");
const positiveBaseQuantityInput = baseQuantityInput.refine((value) => value > 0, "Quantity must be greater than zero.");
const transactionKind = z.enum(["order", "transaction", "journalEntry", "menuItem", "promotion", "coupon", "giftCard", "loyaltyAccount", "loyaltySettings", "legacyImport"]);
const giftCardHash = (code: string) => createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
const legacyLineSchema = z.object({ id: z.string().min(1).max(80), menuItemId: z.string().min(1).max(80), name: z.string().trim().min(1).max(120), category: z.string().trim().min(1).max(60), unitPrice: z.number().finite().min(0).max(1_000_000_000), quantity: z.number().int().min(1).max(99), modifier: z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(120), price: z.number().finite().min(0).max(1_000_000_000) }).optional(), note: z.string().max(120).optional() });
const legacyMoney = z.number().finite().min(0).max(1_000_000_000);
const validDateText = z.string().refine((value) => Number.isFinite(Date.parse(value)), "Use an ISO date.");
const legacyOrderSchema = z.object({ id: z.string().min(1).max(60), number: z.string().min(1).max(40), createdAt: validDateText, updatedAt: validDateText, items: z.array(legacyLineSchema).min(1).max(80), subtotal: legacyMoney, discountPercent: z.number().finite().min(0).max(100), discount: legacyMoney, tax: legacyMoney, total: legacyMoney, paymentMethod: z.enum(["Cash", "Card", "QRIS", "Other"]), status: z.enum(["new", "preparing", "ready", "completed", "cancelled"]), cashierName: z.string().max(160).optional(), customerName: z.string().max(120).optional(), customerPhone: z.string().max(40).optional() });
const legacyTransactionSchema = z.object({ id: z.string().min(1).max(60), orderId: z.string().min(1).max(60), orderNumber: z.string().min(1).max(40), createdAt: validDateText, items: z.array(legacyLineSchema).min(1).max(80), subtotal: legacyMoney, discount: legacyMoney, tax: legacyMoney, total: legacyMoney, paymentMethod: z.enum(["Cash", "Card", "QRIS", "Other"]), status: z.enum(["paid", "refunded", "voided"]), refundedAt: validDateText.optional(), voidedAt: validDateText.optional(), cashierName: z.string().max(160).optional(), customerName: z.string().max(120).optional(), customerPhone: z.string().max(40).optional() });
const LEGACY_IMPORT_MARKER_ID = "legacy-v1";
const transactionRecordId = z.string().refine(isSafeTransactionRecordId, "Invalid transaction ID.");

function makeId() { return randomUUID(); }
function roundFor(input: number, currency: CurrencyCode) { return roundAmount(input, currency); }
function normalizePayload<T>(value: Record<string, unknown>) { return value as unknown as T; }
async function saveStockMovement(tx: any, businessId: string, actorOpenId: string, movement: Omit<InventoryMovement, "id" | "actorOpenId">) {
  if (typeof movement.reference !== "string" || !movement.reference.trim()) throw new Error("Every stock movement requires an audit reference.");
  const movementId = makeId();
  const payload: InventoryMovement = { ...movement, id: movementId, actorOpenId };
  await saveBusinessRecord(tx, { businessId, recordKind: "stockMovement", recordId: movementId, payload: payload as unknown as Record<string, unknown>, actorOpenId });
}
function isDuplicateKey(error: unknown) {
  const candidate = error as { code?: string; cause?: { code?: string } } | null;
  return candidate?.code === "ER_DUP_ENTRY" || candidate?.cause?.code === "ER_DUP_ENTRY";
}

async function getRecordTx(tx: any, businessId: string, kind: string, id: string) {
  const rows = await tx.select().from(businessRecords).where(and(eq(businessRecords.businessId, businessId), eq(businessRecords.recordKind, kind), eq(businessRecords.recordId, id))).for("update").limit(1);
  return rows[0] ?? null;
}

async function listRecordsTx(tx: any, businessId: string, kind: string) {
  return tx.select().from(businessRecords).where(and(eq(businessRecords.businessId, businessId), eq(businessRecords.recordKind, kind))).for("update");
}

async function postJournal(tx: any, businessId: string, actorOpenId: string, currency: CurrencyCode, input: { date: string; reference: string; description: string; lines: JournalLine[]; entryId?: string }) {
  assertBalanced(input.lines, currency);
  const entry: JournalEntry = { id: input.entryId ?? makeId(), date: input.date, reference: input.reference, description: input.description, lines: input.lines, createdBy: actorOpenId };
  await saveBusinessRecord(tx, { businessId, recordKind: "journalEntry", recordId: entry.id, payload: entry as unknown as Record<string, unknown>, actorOpenId });
  return entry;
}

function getTenderAccount(method: PaymentMethod, giftCardName = "Gift card liability") {
  if (method === "Cash") return { code: "1000", name: "Cash on hand" };
  if (method === "Gift Card") return { code: "2200", name: giftCardName };
  return { code: "1010", name: method === "QRIS" ? "QRIS clearing" : method === "Card" ? "Card clearing" : "Other tender clearing" };
}

function addSaleLines(subtotal: number, discount: number, tax: number, total: number, method: PaymentMethod, currency: CurrencyCode): JournalLine[] {
  const tender = getTenderAccount(method);
  const lines = [
    makeJournalLine(tender.code, tender.name, total, 0, currency),
    makeJournalLine("4100", "Sales discounts & returns", discount, 0, currency),
    makeJournalLine("4000", "Sales revenue", 0, subtotal, currency),
    makeJournalLine("2100", "Tax payable", 0, tax, currency),
  ];
  return lines;
}

function addReversalLines(transaction: Transaction, currency: CurrencyCode): JournalLine[] {
  const tender = getTenderAccount(transaction.paymentMethod);
  return [
    makeJournalLine("4000", "Sales revenue", transaction.subtotal, 0, currency),
    makeJournalLine("2100", "Tax payable", transaction.tax, 0, currency),
    makeJournalLine(tender.code, tender.name, 0, transaction.total, currency),
    makeJournalLine("4100", "Sales discounts & returns", 0, transaction.discount, currency),
  ];
}

function activeAt(record: Record<string, unknown>, now: number, timeZone: string) {
  return isPromotionActiveAt(record as unknown as Promotion, now, timeZone);
}

function recipeAvailability(components: Array<{ ingredientItemId: string; quantity: number }>, ingredients: Map<string, MenuItem>) {
  const warnings = new Set<string>();
  let unavailable = false;
  for (const component of components) {
    const ingredient = ingredients.get(component.ingredientItemId);
    if (!ingredient || ingredient.stockTracked !== true) { unavailable = true; warnings.add("Recipe ingredient unavailable"); continue; }
    const onHand = Number(ingredient.stockOnHand ?? 0);
    if (onHand < component.quantity) unavailable = true;
    if (onHand <= Number(ingredient.lowStockThreshold ?? 0)) warnings.add(ingredient.name);
  }
  return { unavailable, warnings: [...warnings] };
}

async function reverseSalePrograms(tx: any, businessId: string, actorOpenId: string, transaction: Transaction, at: string, reason: "refund" | "void", currency: CurrencyCode) {
  if (transaction.giftCardId) {
    const card = await getRecordTx(tx, businessId, "giftCard", transaction.giftCardId);
    if (!card) throw new TRPCError({ code: "NOT_FOUND", message: "The gift card on this sale could not be found; no refund was posted." });
    const restored = roundFor(Number(transaction.giftCardAmount ?? transaction.total), currency);
    const balance = roundFor(Number(card.payload.balance) + restored, currency);
    await saveBusinessRecord(tx, { businessId, recordKind: "giftCard", recordId: transaction.giftCardId, payload: { ...card.payload, balance, status: balance > 0 ? "active" : "redeemed" }, actorOpenId });
    await saveBusinessRecord(tx, { businessId, recordKind: "giftCardMovement", recordId: makeId(), payload: { giftCardId: transaction.giftCardId, transactionId: transaction.id, orderId: transaction.orderId, kind: "reversal", reason, amount: restored, at }, actorOpenId });
  }
  if (transaction.loyaltyAccountId && (Number(transaction.loyaltyPointsEarned ?? 0) > 0 || Number(transaction.loyaltyPointsRedeemed ?? 0) > 0)) {
    const accountRow = await getRecordTx(tx, businessId, "loyaltyAccount", transaction.loyaltyAccountId);
    if (!accountRow) throw new TRPCError({ code: "NOT_FOUND", message: "The loyalty account on this sale could not be found; no refund was posted." });
    const earned = Number(transaction.loyaltyPointsEarned ?? 0);
    const redeemed = Number(transaction.loyaltyPointsRedeemed ?? 0);
    const reversal = reverseLoyaltyPoints(Number(accountRow.payload.pointsBalance ?? 0), earned, redeemed);
    await saveBusinessRecord(tx, { businessId, recordKind: "loyaltyAccount", recordId: transaction.loyaltyAccountId, payload: { ...accountRow.payload, pointsBalance: reversal.balance }, actorOpenId });
    await saveBusinessRecord(tx, { businessId, recordKind: "loyaltyMovement", recordId: makeId(), payload: { accountId: transaction.loyaltyAccountId, orderId: transaction.orderId, transactionId: transaction.id, kind: "reversal", reason, earned: -reversal.pointsDebited, earnedPointsUnavailable: reversal.earnedPointsUnavailable, redeemed: -reversal.pointsRestored, pointsChange: reversal.pointsChange, at }, actorOpenId });
  }
  if (transaction.promotionId) {
    const redemptionId = `${transaction.promotionId}:${transaction.orderId}`;
    const redemption = await getRecordTx(tx, businessId, "promotionRedemption", redemptionId);
    if (redemption && !redemption.payload.reversedAt) {
      const promotion = await getRecordTx(tx, businessId, "promotion", transaction.promotionId);
      if (promotion) await saveBusinessRecord(tx, { businessId, recordKind: "promotion", recordId: transaction.promotionId, payload: { ...promotion.payload, redemptionCount: Math.max(0, Number(promotion.payload.redemptionCount ?? 0) - 1) }, actorOpenId });
      await saveBusinessRecord(tx, { businessId, recordKind: "promotionRedemption", recordId: redemptionId, payload: { ...redemption.payload, reversedAt: at, reversalKind: reason }, actorOpenId });
      const audit = await getRecordTx(tx, businessId, "promotionAudit", redemptionId);
      if (audit) await saveBusinessRecord(tx, { businessId, recordKind: "promotionAudit", recordId: redemptionId, payload: { ...audit.payload, reversedAt: at, reversalKind: reason }, actorOpenId });
    }
  }
}

export const posRouter = router({
  menu: cashierProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const [rows, recipeRows] = await Promise.all([
      db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "menuItem"))).orderBy(desc(businessRecords.createdAt)),
      db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "billOfMaterial"))),
    ]);
    const allItems = rows.map((row) => normalizePayload<MenuItem>(row.payload));
    const ingredients = new Map(allItems.filter((item) => item.ingredientOnly === true).map((item) => [item.id, item]));
    const recipes = new Map(recipeRows.map((row) => { const recipe = normalizePayload<BillOfMaterial>(row.payload); return [recipe.menuItemId, recipe] as const; }));
    const sellable = allItems.filter((item) => item.ingredientOnly !== true);
    const visible = ctx.member.role === "cashier" ? sellable.filter((item) => item.available !== false) : sellable;
    return visible.map((item) => {
      const recipe = recipes.get(item.id);
      if (!recipe) return item;
      const availability = recipeAvailability(recipe.components ?? [], ingredients);
      const modifierGroups = (recipe.modifierGroups ?? []).map((group) => ({
        id: group.id, name: group.name, minSelections: group.minSelections, maxSelections: group.maxSelections,
        options: group.options.map((option) => {
          const optionAvailability = recipeAvailability(option.components ?? [], ingredients);
          return { id: option.id, label: option.label, price: option.price, unavailable: optionAvailability.unavailable, ingredientWarnings: optionAvailability.warnings };
        }),
      }));
      return { ...item, ingredientWarnings: availability.warnings, recipeUnavailable: availability.unavailable, modifierGroups };
    });
  }),

  inventory: managerProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const [menuRows, movementRows] = await Promise.all([
      db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "menuItem"))).orderBy(desc(businessRecords.createdAt)),
      db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "stockMovement"))).orderBy(desc(businessRecords.createdAt)).limit(100),
    ]);
    const items = menuRows.map((row) => normalizePayload<MenuItem>(row.payload)).filter((item) => item.stockTracked === true);
    const movements = movementRows.map((row) => normalizePayload<InventoryMovement>(row.payload));
    return { items, movements };
  }),

  recipeCatalog: managerProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const [menuRows, recipeRows] = await Promise.all([
      db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "menuItem"))).orderBy(desc(businessRecords.createdAt)),
      db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "billOfMaterial"))).orderBy(desc(businessRecords.createdAt)),
    ]);
    const items = menuRows.map((row) => normalizePayload<MenuItem>(row.payload));
    return {
      menuItems: items.filter((item) => item.ingredientOnly !== true),
      ingredients: items.filter((item) => item.ingredientOnly === true && item.stockTracked === true),
      recipes: recipeRows.map((row) => normalizePayload<BillOfMaterial>(row.payload)),
    };
  }),

  saveIngredient: managerProcedure.input(z.object({
    id: z.string().trim().min(1).max(80).optional(),
    name: z.string().trim().min(1).max(120),
    unit: z.enum(INGREDIENT_BASE_UNITS),
    purchaseUnit: z.enum(INGREDIENT_PURCHASE_UNITS),
    baseUnitsPerPurchaseUnit: z.number().finite().positive().max(1_000_000_000).refine(isPositiveConversionFactor, "Use a positive conversion factor with no more than three decimal places."),
    unitCost: z.number().finite().min(0).max(1_000_000_000),
    lowStockThreshold: baseQuantityInput,
    openingStock: baseQuantityInput.default(0),
  })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    return db.transaction(async (tx) => {
      const rows = await listRecordsTx(tx, ctx.member.businessId, "menuItem");
      const existing = input.id ? rows.find((row: any) => row.recordId === input.id) ?? null : null;
      if (input.id && !existing) throw new TRPCError({ code: "NOT_FOUND", message: "Ingredient not found in this workspace." });
      const previous = existing ? normalizePayload<MenuItem>(existing.payload) : undefined;
      if (previous && previous.ingredientOnly !== true) throw new TRPCError({ code: "BAD_REQUEST", message: "Sellable menu goods cannot be changed into ingredients. Create a separate inventory ingredient." });
      if (previous && previous.stockUnit !== input.unit) throw new TRPCError({ code: "BAD_REQUEST", message: "An ingredient's base unit cannot be changed after its opening balance; create a new ingredient and reconcile the old one." });
      const duplicate = rows.find((row: any) => row.recordId !== (existing?.recordId ?? "") && String(row.payload.name ?? "").trim().toLocaleLowerCase() === input.name.trim().toLocaleLowerCase());
      if (duplicate) throw new TRPCError({ code: "CONFLICT", message: "A good or ingredient with that name already exists in this workspace." });
      const openingStock = normalizeBaseQuantity(input.openingStock, "Opening ingredient stock");
      const stockOnHand = previous ? normalizeBaseQuantity(Number(previous.stockOnHand ?? 0), "Ingredient stock") : openingStock;
      const item: MenuItem = {
        id: existing?.recordId ?? makeId(), name: input.name.trim(), description: "Inventory ingredient · BOM cost per base unit",
        category: "Ingredients", price: 0, icon: "inventory-2", color: previous?.color ?? "#E8E9DC", available: false,
        modifiers: [], stockTracked: true, stockOnHand, stockUnit: input.unit, lowStockThreshold: normalizeBaseQuantity(input.lowStockThreshold, "Ingredient minimum stock"),
        purchaseUnit: input.purchaseUnit, baseUnitsPerPurchaseUnit: normalizeBaseQuantity(input.baseUnitsPerPurchaseUnit, "Purchase conversion factor"),
        ingredientOnly: true, unitCost: input.unitCost,
      };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "menuItem", recordId: item.id, payload: item as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      if (!previous) await saveStockMovement(tx, ctx.member.businessId, ctx.user.openId, { itemId: item.id, itemName: item.name, unit: item.stockUnit!, kind: "opening", quantityDelta: stockOnHand, quantityBefore: 0, quantityAfter: stockOnHand, reason: "Ingredient opening balance", reference: `INGREDIENT OPENING ${item.id}`, at: new Date().toISOString() });
      return item;
    });
  }),

  saveRecipe: managerProcedure.input(z.object({
    menuItemId: z.string().min(1).max(80),
    components: z.array(z.object({ ingredientItemId: z.string().min(1).max(80), quantity: positiveBaseQuantityInput })).max(40),
    modifierGroups: z.array(z.object({
      id: z.string().min(1).max(80), name: z.string().trim().min(1).max(80), minSelections: z.number().int().min(0).max(12), maxSelections: z.number().int().min(1).max(12),
      options: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().trim().min(1).max(120), price: z.number().finite().min(0).max(1_000_000_000), components: z.array(z.object({ ingredientItemId: z.string().min(1).max(80), quantity: positiveBaseQuantityInput })).max(40) })).min(1).max(12),
    }).superRefine((group, issue) => { if (group.minSelections > group.maxSelections || group.maxSelections > group.options.length) issue.addIssue({ code: "custom", message: "Modifier selection limits must fit the available options." }); })).max(12).default([]),
  }).superRefine((value, issue) => {
    const ids = new Set<string>();
    for (const component of value.components) { if (ids.has(component.ingredientItemId)) issue.addIssue({ code: "custom", message: "Include each ingredient once and combine its per-item quantity.", path: ["components"] }); ids.add(component.ingredientItemId); }
    const groupIds = new Set<string>();
    const optionIds = new Set<string>();
    for (const [groupIndex, group] of value.modifierGroups.entries()) {
      if (groupIds.has(group.id)) issue.addIssue({ code: "custom", message: "Modifier group IDs must be unique.", path: ["modifierGroups", groupIndex, "id"] });
      groupIds.add(group.id);
      for (const [optionIndex, option] of group.options.entries()) {
        if (optionIds.has(option.id)) issue.addIssue({ code: "custom", message: "Modifier option IDs must be unique across all groups.", path: ["modifierGroups", groupIndex, "options", optionIndex, "id"] });
        optionIds.add(option.id);
        const componentIds = new Set<string>();
        for (const [componentIndex, component] of option.components.entries()) {
          if (componentIds.has(component.ingredientItemId)) issue.addIssue({ code: "custom", message: "Combine repeated ingredients in this modifier option.", path: ["modifierGroups", groupIndex, "options", optionIndex, "components", componentIndex] });
          componentIds.add(component.ingredientItemId);
        }
      }
    }
  })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    return db.transaction(async (tx) => {
      const menuRows = await listRecordsTx(tx, ctx.member.businessId, "menuItem");
      const productRow = menuRows.find((row: any) => row.recordId === input.menuItemId);
      if (!productRow) throw new TRPCError({ code: "NOT_FOUND", message: "Sellable menu item not found in this workspace." });
      const product = normalizePayload<MenuItem>(productRow.payload);
      if (product.ingredientOnly === true) throw new TRPCError({ code: "BAD_REQUEST", message: "An ingredient-only record cannot have a sellable menu recipe." });
      const items = new Map<string, MenuItem>(menuRows.map((row: any) => [row.recordId, normalizePayload<MenuItem>(row.payload)] as [string, MenuItem]));
      const allComponents = [...input.components, ...input.modifierGroups.flatMap((group) => group.options.flatMap((option) => option.components))];
      for (const component of allComponents) {
        const ingredient = items.get(component.ingredientItemId);
        if (!ingredient || ingredient.ingredientOnly !== true || ingredient.stockTracked !== true) throw new TRPCError({ code: "BAD_REQUEST", message: "Recipes can use only active, tracked ingredient records from this workspace." });
      }
      const recipe: BillOfMaterial = { menuItemId: product.id, components: input.components, modifierGroups: input.modifierGroups, updatedAt: new Date().toISOString() };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "billOfMaterial", recordId: product.id, payload: recipe as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      return recipe;
    });
  }),

  saveMenuItem: managerProcedure.input(z.object({ id: z.string().trim().min(1).max(80).optional(), name: z.string().trim().min(1).max(120), description: z.string().trim().max(240), category: z.string().trim().min(1).max(60), price: z.number().finite().min(0).max(1_000_000_000), available: z.boolean(), stockTracked: z.boolean().default(false), stockUnit: z.string().trim().min(1).max(24).default("unit"), lowStockThreshold: z.number().int().min(0).max(1_000_000_000).default(0), openingStock: z.number().int().min(0).max(1_000_000_000).default(0) })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const currency = ctx.member.business.currency as CurrencyCode;
    return db.transaction(async (tx) => {
      const rows = await listRecordsTx(tx, ctx.member.businessId, "menuItem");
      const existing = input.id ? rows.find((row: any) => row.recordId === input.id) ?? null : null;
      if (input.id && !existing) throw new TRPCError({ code: "NOT_FOUND", message: "Menu item not found." });
      if (existing?.payload.ingredientOnly === true) throw new TRPCError({ code: "BAD_REQUEST", message: "Inventory ingredients must be edited in Recipes & costs, not the sellable menu editor." });
      const duplicate = rows.find((row: any) => row.recordId !== (existing?.recordId ?? "") && String(row.payload.name ?? "").trim().toLocaleLowerCase() === input.name.trim().toLocaleLowerCase());
      if (duplicate) throw new TRPCError({ code: "CONFLICT", message: "A menu item with that name already exists in this workspace." });
      const previous = existing ? normalizePayload<MenuItem>(existing.payload) : undefined;
      const previouslyTracked = previous?.stockTracked === true;
      if (previouslyTracked && input.stockUnit.trim() !== String(previous?.stockUnit ?? "unit").trim()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The stock unit cannot be changed after tracking begins; create a new menu item with the correct unit so the existing balance remains auditable." });
      }
      const stockTracked = previouslyTracked || input.stockTracked;
      const openingStock = normalizeStockQuantity(input.openingStock);
      const stockOnHand = stockTracked ? previouslyTracked ? normalizeStockQuantity(Number(previous?.stockOnHand ?? 0)) : openingStock : undefined;
      const item: MenuItem = { id: existing?.recordId ?? makeId(), name: input.name.trim(), description: input.description.trim(), category: input.category.trim(), price: roundFor(input.price, currency), icon: previous?.icon ?? "restaurant-menu", color: previous?.color ?? "#E8E9DC", modifiers: previous?.modifiers, available: input.available, stockTracked: stockTracked || undefined, stockOnHand, stockUnit: stockTracked ? input.stockUnit.trim() || previous?.stockUnit || "unit" : undefined, lowStockThreshold: stockTracked ? normalizeStockQuantity(input.lowStockThreshold) : undefined };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "menuItem", recordId: item.id, payload: item as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      if (stockTracked && !previouslyTracked) await saveStockMovement(tx, ctx.member.businessId, ctx.user.openId, { itemId: item.id, itemName: item.name, unit: item.stockUnit ?? "unit", kind: "opening", quantityDelta: stockOnHand ?? 0, quantityBefore: 0, quantityAfter: stockOnHand ?? 0, reason: "Opening stock balance", reference: `OPENING ${item.id}`, at: new Date().toISOString() });
      return item;
    });
  }),

  receiveStock: managerProcedure.input(z.object({ itemId: z.string().min(1).max(80), quantity: positiveBaseQuantityInput, reason: z.string().trim().min(1).max(160) })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    return db.transaction(async (tx) => {
      const row = await getRecordTx(tx, ctx.member.businessId, "menuItem", input.itemId);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Goods not found." });
      const item = normalizePayload<MenuItem>(row.payload);
      if (item.stockTracked !== true) throw new TRPCError({ code: "BAD_REQUEST", message: "Enable stock tracking for this good before receiving stock." });
      const ingredientOnly = item.ingredientOnly === true;
      const before = ingredientOnly ? normalizeBaseQuantity(Number(item.stockOnHand ?? 0), "Current ingredient stock") : normalizeStockQuantity(Number(item.stockOnHand ?? 0));
      const quantity = ingredientOnly ? normalizeBaseQuantity(input.quantity, "Receipt quantity") : normalizeStockQuantity(input.quantity);
      let after: number;
      try { after = ingredientOnly ? applyIngredientStockDelta(before, quantity) : applyStockDelta(before, quantity); }
      catch { throw new TRPCError({ code: "BAD_REQUEST", message: ingredientOnly ? "The resulting ingredient balance must be non-negative and use no more than three decimal places." : "The resulting stock balance must be a whole quantity no greater than one billion." }); }
      const at = new Date().toISOString();
      const updated = { ...item, stockOnHand: after };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "menuItem", recordId: item.id, payload: updated as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      await saveStockMovement(tx, ctx.member.businessId, ctx.user.openId, { itemId: item.id, itemName: item.name, unit: item.stockUnit ?? "unit", kind: "receipt", quantityDelta: quantity, quantityBefore: before, quantityAfter: after, reason: input.reason, reference: `RECEIPT ${item.id}`, at });
      return updated;
    });
  }),

  stockOpname: managerProcedure.input(z.object({ itemId: z.string().min(1).max(80), countedQuantity: baseQuantityInput, reason: z.string().trim().min(1).max(160) })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    return db.transaction(async (tx) => {
      const row = await getRecordTx(tx, ctx.member.businessId, "menuItem", input.itemId);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Goods not found." });
      const item = normalizePayload<MenuItem>(row.payload);
      if (item.stockTracked !== true) throw new TRPCError({ code: "BAD_REQUEST", message: "Enable stock tracking for this good before stock opname." });
      let count: ReturnType<typeof calculateStockCount> | ReturnType<typeof calculateIngredientStockCount>;
      try { count = item.ingredientOnly === true ? calculateIngredientStockCount(Number(item.stockOnHand ?? 0), input.countedQuantity) : calculateStockCount(Number(item.stockOnHand ?? 0), input.countedQuantity); }
      catch { throw new TRPCError({ code: "BAD_REQUEST", message: item.ingredientOnly === true ? "Ingredient count must be non-negative and use no more than three decimal places." : "Direct goods require a whole-unit stock count." }); }
      const at = new Date().toISOString();
      const updated = { ...item, stockOnHand: count.after };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "menuItem", recordId: item.id, payload: updated as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      await saveStockMovement(tx, ctx.member.businessId, ctx.user.openId, { itemId: item.id, itemName: item.name, unit: item.stockUnit ?? "unit", kind: "opname", quantityDelta: count.variance, quantityBefore: count.before, quantityAfter: count.after, reason: input.reason, reference: `OPNAME ${item.id}`, at });
      return { ...updated, variance: count.variance };
    });
  }),

  orders: workspaceProcedure.query(async ({ ctx }) => {
    const db = await requireDatabase();
    const rows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "order"))).orderBy(desc(businessRecords.createdAt)).limit(300);
    const orderMap = new Map<string, PosOrder>(rows.map((row) => [row.recordId, normalizePayload<PosOrder>(row.payload)]));
    if (ctx.member.role !== "kitchen") return [...orderMap.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(projectKitchenOrder);
    const activeRows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "order"), sql`JSON_UNQUOTE(JSON_EXTRACT(${businessRecords.payload}, '$.status')) IN ('new', 'preparing', 'ready')`)).orderBy(desc(businessRecords.createdAt));
    for (const row of activeRows) orderMap.set(row.recordId, normalizePayload<PosOrder>(row.payload));
    const orders = [...orderMap.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return orders.map(projectKitchenOrder);
  }),

  transactions: cashierProcedure.input(z.object({ cursor: z.object({ createdAt: z.string().datetime(), id: z.string().uuid() }).nullable().optional() }).default({})).query(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const cursorDate = input.cursor ? new Date(input.cursor.createdAt) : undefined;
    const cursorCondition = input.cursor && cursorDate
      ? or(
        lt(businessRecords.createdAt, cursorDate),
        and(eq(businessRecords.createdAt, cursorDate), lt(businessRecords.id, input.cursor.id)),
      )
      : undefined;
    const rows = await db.select().from(businessRecords)
      .where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "transaction"), cursorCondition))
      .orderBy(desc(businessRecords.createdAt), desc(businessRecords.id)).limit(101);
    const pageRows = rows.slice(0, 100);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((row) => normalizePayload<Transaction>(row.payload)),
      nextCursor: rows.length > 100 && last ? { createdAt: new Date(last.createdAt).toISOString(), id: last.id } : null,
    };
  }),

  checkoutStatus: cashierProcedure.input(z.object({ requestId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const marker = await db.transaction((tx) => getRecordTx(tx, ctx.member.businessId, "checkoutRequest", input.requestId));
    if (!marker) return { status: "missing" as const };
    if (marker.createdByOpenId !== ctx.user.openId) throw new TRPCError({ code: "NOT_FOUND", message: "Checkout attempt not found." });
    if (marker.payload.state === "failed") return { status: "failed" as const };
    const orderId = typeof marker.payload.orderId === "string" ? marker.payload.orderId : "";
    if (!orderId) return { status: "processing" as const };
    const orderRows = await db.select().from(businessRecords).where(and(eq(businessRecords.businessId, ctx.member.businessId), eq(businessRecords.recordKind, "order"), eq(businessRecords.recordId, orderId))).limit(1);
    const row = orderRows[0];
    if (!row) return { status: "processing" as const };
    return { status: "complete" as const, order: normalizePayload<PosOrder>(row.payload) };
  }),

  createOrder: cashierProcedure.input(z.object({
    requestId: z.string().uuid(),
    lines: z.array(lineInputSchema).min(1).max(80),
    paymentMethod: paymentSchema,
    discountCode: z.string().trim().max(40).optional(),
    promotionId: z.string().optional(),
    giftCardCode: z.string().trim().max(40).optional(),
    loyaltyAccountId: z.string().optional(),
    loyaltyRedeemPoints: z.number().int().min(0).default(0),
    customerName: z.string().trim().max(120).optional(),
    customerPhone: z.string().trim().max(40).optional(),
    qrisVerified: z.boolean().default(false),
  })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const currency = ctx.member.business.currency as CurrencyCode;
    const taxRate = ctx.member.business.taxRateBasisPoints / 10_000;
    const now = new Date();
    const orderId = makeId();
    const orderNumber = `#${randomBytes(3).toString("hex").toUpperCase()}`;
    const fingerprint = createHash("sha256").update(JSON.stringify({ lines: input.lines, paymentMethod: input.paymentMethod, discountCode: input.discountCode, promotionId: input.promotionId, giftCardCode: input.giftCardCode, loyaltyAccountId: input.loyaltyAccountId, loyaltyRedeemPoints: input.loyaltyRedeemPoints, customerName: input.customerName, customerPhone: input.customerPhone, qrisVerified: input.qrisVerified })).digest("hex");

    try {
      await db.insert(businessRecords).values({ id: makeId(), businessId: ctx.member.businessId, recordKind: "checkoutRequest", recordId: input.requestId, payload: { fingerprint, state: "processing", startedAt: now.toISOString() }, createdByOpenId: ctx.user.openId });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }

    let result: PosOrder;
    try {
      await db.transaction(async (tx) => {
        const marker = await getRecordTx(tx, ctx.member.businessId, "checkoutRequest", input.requestId);
        if (!marker || marker.createdByOpenId !== ctx.user.openId || marker.payload.fingerprint !== fingerprint) throw new TRPCError({ code: "CONFLICT", message: "This checkout request could not be safely resumed. Check its status before trying again." });
        if (marker.payload.state === "failed") await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "checkoutRequest", recordId: input.requestId, payload: { ...marker.payload, state: "processing", retryStartedAt: new Date().toISOString() }, actorOpenId: ctx.user.openId });
      });
      result = await db.transaction(async (tx) => {
      const marker = await getRecordTx(tx, ctx.member.businessId, "checkoutRequest", input.requestId);
      if (!marker || marker.createdByOpenId !== ctx.user.openId) throw new TRPCError({ code: "CONFLICT", message: "This checkout request could not be safely claimed. Check its status before trying again." });
      if (marker.payload.fingerprint !== fingerprint) throw new TRPCError({ code: "CONFLICT", message: "The pending checkout differs from this ticket. Check the earlier attempt before retrying." });
      const priorOrderId = typeof marker.payload.orderId === "string" ? marker.payload.orderId : "";
      if (marker.payload.state === "complete" || priorOrderId) {
        const priorOrder = priorOrderId ? await getRecordTx(tx, ctx.member.businessId, "order", priorOrderId) : null;
        if (!priorOrder) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The checkout marker completed but its order is not available. Do not submit another ticket." });
        return normalizePayload<PosOrder>(priorOrder.payload);
      }
      const menuRows = await listRecordsTx(tx, ctx.member.businessId, "menuItem");
      const menu = new Map<string, MenuItem>();
      for (const row of menuRows as any[]) menu.set(row.recordId, normalizePayload<MenuItem>(row.payload));
      const recipeRows = await listRecordsTx(tx, ctx.member.businessId, "billOfMaterial");
      const recipes = new Map<string, BillOfMaterial>();
      for (const row of recipeRows as any[]) { const recipe = normalizePayload<BillOfMaterial>(row.payload); recipes.set(recipe.menuItemId, recipe); }
      const items: OrderLine[] = input.lines.map((line) => {
        const menuItem = menu.get(line.menuItemId);
        if (!menuItem || menuItem.available === false || menuItem.ingredientOnly === true) throw new TRPCError({ code: "BAD_REQUEST", message: "A menu item is no longer available. Refresh the register and try again." });
        const legacyModifier = line.modifierId ? menuItem.modifiers?.find((candidate) => candidate.id === line.modifierId) : undefined;
        if (line.modifierId && !legacyModifier) throw new TRPCError({ code: "BAD_REQUEST", message: "A selected modifier is no longer available." });
        const recipe = recipes.get(menuItem.id);
        const selectedIds = line.modifierIds ?? [];
        const optionMatches = (recipe?.modifierGroups ?? []).flatMap((group) => group.options.filter((option) => selectedIds.includes(option.id)).map((option) => ({ group, option })));
        if (optionMatches.length !== selectedIds.length) throw new TRPCError({ code: "BAD_REQUEST", message: "A selected modifier is no longer available. Refresh the register and try again." });
        const groupedModifiers = optionMatches.map(({ option }) => ({ id: option.id, label: option.label, price: option.price }));
        const modifiers = [...(legacyModifier ? [legacyModifier] : []), ...groupedModifiers];
        return { id: line.id, menuItemId: menuItem.id, name: menuItem.name, category: menuItem.category, unitPrice: menuItem.price, quantity: line.quantity, modifier: legacyModifier, modifiers: modifiers.length ? modifiers : undefined, selectedModifierIds: selectedIds, note: line.note?.trim() || undefined };
      });
      const stockDemand = aggregateStockDemand(items.map((line) => ({ menuItemId: line.menuItemId, quantity: line.quantity })));
      for (const [menuItemId, quantity] of stockDemand) {
        const menuItem = menu.get(menuItemId);
        if (!menuItem || menuItem.stockTracked !== true) continue;
        const before = normalizeStockQuantity(Number(menuItem.stockOnHand ?? 0));
        let after: number;
        try { after = applyStockDelta(before, -quantity); }
        catch { throw new TRPCError({ code: "BAD_REQUEST", message: `Insufficient stock for ${menuItem.name}. ${before} ${menuItem.stockUnit ?? "unit"} available; reduce the ticket quantity or refresh the register.` }); }
        const updated = { ...menuItem, stockOnHand: after };
        await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "menuItem", recordId: menuItem.id, payload: updated as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
        menu.set(menuItemId, updated);
        await saveStockMovement(tx, ctx.member.businessId, ctx.user.openId, { itemId: menuItem.id, itemName: menuItem.name, unit: menuItem.stockUnit ?? "unit", kind: "sale", quantityDelta: -quantity, quantityBefore: before, quantityAfter: after, reason: `POS sale ${orderNumber}`, reference: `POS ${orderNumber}`, at: now.toISOString() });
      }
      let recipePlan: ReturnType<typeof planRecipeConsumption>;
      try { recipePlan = planRecipeConsumption(items, [...recipes.values()], [...menu.values()]); }
      catch (error) { throw new TRPCError({ code: "PRECONDITION_FAILED", message: error instanceof Error ? error.message : "The BOM could not be validated. Ask a manager to review Recipes & costs." }); }
      for (const [ingredientId, quantity] of [...recipePlan.ingredientDemand.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const ingredient = menu.get(ingredientId)!;
        const before = normalizeBaseQuantity(Number(ingredient.stockOnHand ?? 0), "Current ingredient stock");
        let after: number;
        try { after = applyIngredientStockDelta(before, -quantity); }
        catch { throw new TRPCError({ code: "BAD_REQUEST", message: `Insufficient ingredient stock for ${ingredient.name}. ${before} ${ingredient.stockUnit ?? "unit"} available; refresh the register or ask a manager to receive stock.` }); }
        const updated = { ...ingredient, stockOnHand: after };
        await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "menuItem", recordId: ingredient.id, payload: updated as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
        menu.set(ingredient.id, updated);
        await saveStockMovement(tx, ctx.member.businessId, ctx.user.openId, { itemId: ingredient.id, itemName: ingredient.name, unit: ingredient.stockUnit ?? "unit", kind: "recipe", quantityDelta: -quantity, quantityBefore: before, quantityAfter: after, reason: `Recipe consumption ${orderNumber}`, reference: `POS ${orderNumber}`, at: now.toISOString() });
      }
      const subtotal = roundFor(items.reduce((sum, line) => sum + (line.unitPrice + (line.modifiers ?? (line.modifier ? [line.modifier] : [])).reduce((modifierTotal, modifier) => modifierTotal + modifier.price, 0)) * line.quantity, 0), currency);
      let discount = 0;
      let offerDiscount = 0;
      let loyaltyDiscount = 0;
      let loyaltyCurrencyStep = currency === "IDR" ? 10000 : 1;
      let loyaltyEarnPerStep = 1;
      let loyaltyValuePerPoint = currency === "IDR" ? 100 : 0.01;
      let couponCode: string | undefined;
      let promotionId: string | undefined;
      let promotionRow: any;
      const nowMs = now.getTime();
      const businessTimezone = ctx.member.business.timezone ?? "Asia/Jakarta";
      if (input.promotionId && input.discountCode) throw new TRPCError({ code: "BAD_REQUEST", message: "Apply either one offer or one coupon, not both." });
      if (input.promotionId) {
        promotionRow = await getRecordTx(tx, ctx.member.businessId, "promotion", input.promotionId);
        if (!promotionRow || !activeAt(promotionRow.payload, nowMs, businessTimezone)) throw new TRPCError({ code: "BAD_REQUEST", message: "That promotion is not currently active." });
        if (promotionRow.payload.code) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter this promotion's coupon code to apply it." });
      } else if (input.discountCode) {
        const offers = await listRecordsTx(tx, ctx.member.businessId, "promotion");
        const matches = offers.filter((row: any) => String(row.payload.code ?? "").trim().toUpperCase() === input.discountCode!.trim().toUpperCase());
        if (matches.length > 1) throw new TRPCError({ code: "CONFLICT", message: "This coupon code is assigned to multiple offers. A manager must resolve the duplicate before checkout." });
        promotionRow = matches[0];
        if (!promotionRow || !activeAt(promotionRow.payload, nowMs, businessTimezone)) throw new TRPCError({ code: "BAD_REQUEST", message: "That coupon is invalid or expired." });
        couponCode = String(promotionRow.payload.code);
      }
      if (promotionRow) {
        const offer = promotionRow.payload as Record<string, unknown>;
        const redemptionCount = Number(offer.redemptionCount ?? 0);
        if (offer.maxRedemptions && redemptionCount >= Number(offer.maxRedemptions)) throw new TRPCError({ code: "BAD_REQUEST", message: "This offer has reached its redemption limit." });
        const eligibility = evaluatePromotionAtCheckout(
          offer as unknown as Promotion,
          items.map((line) => ({ menuItemId: line.menuItemId, quantity: line.quantity, unitPrice: line.unitPrice })),
          subtotal,
          currency,
          now,
          businessTimezone,
        );
        if (!eligibility.eligible) throw new TRPCError({ code: "BAD_REQUEST", message: eligibility.reason === "inactive" ? "That offer is not active in the business timezone." : "That offer does not apply to the items or quantities in this ticket." });
        offerDiscount = eligibility.discount;
        discount = offerDiscount;
        promotionId = promotionRow.recordId;
        await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "promotion", recordId: promotionRow.recordId, payload: { ...offer, redemptionCount: redemptionCount + 1 } as Record<string, unknown>, actorOpenId: ctx.user.openId });
        await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "promotionRedemption", recordId: `${promotionRow.recordId}:${orderId}`, payload: { promotionId: promotionRow.recordId, orderId, orderNumber, at: now.toISOString(), cashierOpenId: ctx.user.openId }, actorOpenId: ctx.user.openId });
      }

      let loyaltyAccount: Record<string, unknown> | undefined;
      let loyaltyRecordId: string | undefined;
      let redeemedPoints = input.loyaltyRedeemPoints;
      let loyaltyPointsEarned = 0;
      let giftCardRow: any;
      let giftCardCodeHash: string | undefined;
      if (input.loyaltyAccountId) {
        const row = await getRecordTx(tx, ctx.member.businessId, "loyaltyAccount", input.loyaltyAccountId);
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Loyalty account not found." });
        const account = row.payload as Record<string, unknown>;
        loyaltyAccount = account;
        loyaltyRecordId = row.recordId;
        const pointsBalance = Math.max(0, Math.floor(Number(account.pointsBalance ?? 0)));
        if (redeemedPoints > pointsBalance) throw new TRPCError({ code: "BAD_REQUEST", message: "There are not enough points for that redemption." });
        const settingsRow = await getRecordTx(tx, ctx.member.businessId, "loyaltySettings", "default");
        const settings = settingsRow?.payload ?? { currencyStep: loyaltyCurrencyStep, earnPerCurrencyStep: 1, redemptionValuePerPoint: loyaltyValuePerPoint };
        loyaltyCurrencyStep = Number(settings.currencyStep ?? loyaltyCurrencyStep);
        loyaltyEarnPerStep = Number(settings.earnPerCurrencyStep ?? 1);
        loyaltyValuePerPoint = Number(settings.redemptionValuePerPoint ?? loyaltyValuePerPoint);
        const redemption = calculateLoyaltyRedemption(redeemedPoints, subtotal - discount, loyaltyValuePerPoint, currency);
        if (!redemption) throw new TRPCError({ code: "BAD_REQUEST", message: "That points redemption exceeds the remaining ticket value. Reduce the points and try again." });
        redeemedPoints = redemption.points;
        loyaltyDiscount = redemption.discount;
        discount = roundFor(discount + loyaltyDiscount, currency);
      } else if (redeemedPoints > 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Select a loyalty account before using points." });
      }

      const tax = roundFor((subtotal - discount) * taxRate, currency);
      const total = roundFor(subtotal - discount + tax, currency);
      let discountAllocatedSoFar = 0;
      const recipeCostLines: RecipeSaleCostLine[] = recipePlan.lines.map((draft, index) => {
        const line = items[index]!;
        const modifiers = line.modifiers ?? (line.modifier ? [line.modifier] : []);
        const grossSales = roundFor((line.unitPrice + modifiers.reduce((sum, modifier) => sum + modifier.price, 0)) * line.quantity, currency);
        const discountRemaining = Math.max(0, roundFor(discount - discountAllocatedSoFar, currency));
        const discountAllocated = index === recipePlan.lines.length - 1
          ? Math.min(grossSales, discountRemaining)
          : Math.min(grossSales, discountRemaining, roundFor(subtotal > 0 ? discount * grossSales / subtotal : 0, currency));
        discountAllocatedSoFar = roundFor(discountAllocatedSoFar + discountAllocated, currency);
        return { ...draft, recipeUnitCost: roundFor(draft.recipeUnitCost, currency), recipeCost: roundFor(draft.recipeCost, currency), ingredients: draft.ingredients.map((component) => ({ ...component, totalCost: roundFor(component.totalCost, currency) })), quantity: line.quantity, grossSales, discountAllocated, netSales: roundFor(Math.max(0, grossSales - discountAllocated), currency) };
      });
      if (loyaltyAccount && (!Number.isFinite(loyaltyCurrencyStep) || loyaltyCurrencyStep <= 0)) throw new TRPCError({ code: "BAD_REQUEST", message: "The workspace loyalty spend threshold is invalid; update the loyalty rules before checkout." });
      loyaltyPointsEarned = loyaltyAccount ? Math.floor(Math.max(0, subtotal - discount) / loyaltyCurrencyStep) * Math.max(0, loyaltyEarnPerStep) : 0;
      if (input.paymentMethod === "QRIS" && !input.qrisVerified) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Verify the payment in your QRIS merchant app before recording this ticket as paid." });
      let giftCardId: string | undefined;
      if (input.paymentMethod === "Gift Card") {
        if (!input.giftCardCode) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a gift card code." });
        const cards = await listRecordsTx(tx, ctx.member.businessId, "giftCard");
        giftCardCodeHash = giftCardHash(input.giftCardCode);
        giftCardRow = cards.find((row: any) => row.payload.codeHash === giftCardCodeHash && row.payload.status === "active");
        if (!giftCardRow) throw new TRPCError({ code: "NOT_FOUND", message: "Gift card not found or inactive." });
        if (Number(giftCardRow.payload.balance) < total) throw new TRPCError({ code: "BAD_REQUEST", message: "Gift card balance is less than this ticket. Split tender is not available yet." });
        giftCardId = giftCardRow.recordId;
      }

      const paymentMethod = input.paymentMethod as PaymentMethod;
      const journal = await postJournal(tx, ctx.member.businessId, ctx.user.openId, currency, { date: now.toISOString(), reference: `POS ${orderNumber}`, description: `Cashier sale ${orderNumber}`, lines: addSaleLines(subtotal, roundFor(discount, currency), tax, total, paymentMethod, currency) });
      const order: PosOrder = {
        id: orderId,
        number: orderNumber,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        items,
        subtotal,
        discountPercent: subtotal > 0 ? roundFor(discount / subtotal * 100, currency) : 0,
        discount: roundFor(discount, currency),
        tax,
        total,
        paymentMethod,
        status: "new",
        cashierName: ctx.member.displayName || ctx.user.name || "Cashier",
        customerName: input.customerName || undefined,
        customerPhone: input.customerPhone || undefined,
        couponCode,
        promotionId,
        offerDiscount,
        loyaltyDiscount,
        loyaltyAccountId: loyaltyRecordId,
        loyaltyPointsEarned,
        loyaltyPointsRedeemed: redeemedPoints,
        giftCardId,
        giftCardAmount: giftCardRow ? total : undefined,
      } as PosOrder;
      const transaction = { ...order, orderId: order.id, orderNumber: order.number, status: "paid", journalEntryId: journal.id, qrisVerifiedAt: paymentMethod === "QRIS" ? now.toISOString() : undefined, giftCardId } as unknown as Transaction;
      const recipeSaleCost: RecipeSaleCost = { transactionId: transaction.id, orderId: order.id, orderNumber: order.number, at: now.toISOString(), currency, totalRecipeCogs: roundFor(recipeCostLines.reduce((sum, line) => sum + line.recipeCost, 0), currency), lines: recipeCostLines };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "order", recordId: order.id, payload: order as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "transaction", recordId: transaction.id, payload: transaction as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "recipeSaleCost", recordId: transaction.id, payload: recipeSaleCost as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "checkoutRequest", recordId: input.requestId, payload: { fingerprint, state: "complete", orderId: order.id, completedAt: now.toISOString() }, actorOpenId: ctx.user.openId });

      if (giftCardRow) {
        const remaining = roundFor(Number(giftCardRow.payload.balance) - total, currency);
        await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "giftCard", recordId: giftCardRow.recordId, payload: { ...giftCardRow.payload, balance: remaining, status: remaining <= 0 ? "redeemed" : "active", lastRedeemedAt: now.toISOString() }, actorOpenId: ctx.user.openId });
        await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "giftCardMovement", recordId: makeId(), payload: { giftCardId: giftCardRow.recordId, orderId, transactionId: transaction.id, kind: "redeem", amount: -total, at: now.toISOString(), cashierOpenId: ctx.user.openId }, actorOpenId: ctx.user.openId });
      }
      if (loyaltyAccount && loyaltyRecordId) {
        const account = loyaltyAccount;
        const newPoints = Math.max(0, Math.floor(Number(account.pointsBalance ?? 0))) - redeemedPoints + loyaltyPointsEarned;
        await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "loyaltyAccount", recordId: loyaltyRecordId, payload: { ...account, pointsBalance: newPoints, customerName: account.customerName || input.customerName, phone: account.phone || input.customerPhone }, actorOpenId: ctx.user.openId });
        if (redeemedPoints > 0 || loyaltyPointsEarned > 0) await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "loyaltyMovement", recordId: makeId(), payload: { accountId: loyaltyRecordId, orderId, orderNumber, kind: "sale", earned: loyaltyPointsEarned, redeemed: redeemedPoints, pointsChange: loyaltyPointsEarned - redeemedPoints, at: now.toISOString() }, actorOpenId: ctx.user.openId });
      }
      if (promotionId) {
        await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "promotionAudit", recordId: `${promotionId}:${orderId}`, payload: { promotionId, couponCode, discount: offerDiscount, loyaltyDiscount, orderId, at: now.toISOString() }, actorOpenId: ctx.user.openId });
      }
      return order;
      });
    } catch (error) {
      try {
        await db.transaction(async (tx) => {
          const failedMarker = await getRecordTx(tx, ctx.member.businessId, "checkoutRequest", input.requestId);
          if (!failedMarker || failedMarker.createdByOpenId !== ctx.user.openId || failedMarker.payload.fingerprint !== fingerprint || failedMarker.payload.state === "complete") return;
          await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "checkoutRequest", recordId: input.requestId, payload: { ...failedMarker.payload, state: "failed", failedAt: new Date().toISOString() }, actorOpenId: ctx.user.openId });
        });
      } catch {
        // Keep the durable processing marker; the same request ID can safely resume after connectivity returns.
      }
      throw error;
    }
    return result;
  }),

  advanceOrder: kitchenProcedure.input(z.object({ orderId: z.string().uuid(), status: z.enum(["preparing", "ready", "completed"]) })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    return db.transaction(async (tx) => {
      const row = await getRecordTx(tx, ctx.member.businessId, "order", input.orderId);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Kitchen ticket not found." });
      const order = normalizePayload<PosOrder>(row.payload);
      const allowed: Record<OrderStatus, OrderStatus[]> = { new: ["preparing"], preparing: ["ready"], ready: ["completed"], completed: [], cancelled: [] };
      if (!allowed[order.status].includes(input.status)) throw new TRPCError({ code: "BAD_REQUEST", message: "Move the ticket through the kitchen stages in order." });
      const next = { ...order, status: input.status, updatedAt: new Date().toISOString() };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "order", recordId: order.id, payload: next as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      return projectKitchenOrder(next);
    });
  }),

  refund: managerProcedure.input(z.object({ transactionId: transactionRecordId })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const currency = ctx.member.business.currency as CurrencyCode;
    return db.transaction(async (tx) => {
      const row = await getRecordTx(tx, ctx.member.businessId, "transaction", input.transactionId);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Transaction not found." });
      const transaction = normalizePayload<Transaction & { giftCardId?: string }>(row.payload);
      if (transaction.status === "refunded" && transaction.refundJournalEntryId) return transaction;
      if (transaction.status !== "paid") throw new TRPCError({ code: "BAD_REQUEST", message: "Only a paid ticket can be refunded." });
      const now = new Date().toISOString();
      const reversal = await postJournal(tx, ctx.member.businessId, ctx.user.openId, currency, { date: now, reference: `REFUND ${transaction.orderNumber}`, description: `Full refund for ${transaction.orderNumber}`, lines: addReversalLines(transaction, currency) });
      const updated = { ...transaction, status: "refunded" as const, refundedAt: now, refundJournalEntryId: reversal.id };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "transaction", recordId: transaction.id, payload: updated as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      await reverseSalePrograms(tx, ctx.member.businessId, ctx.user.openId, transaction, now, "refund", currency);
      const orderRow = await getRecordTx(tx, ctx.member.businessId, "order", transaction.orderId);
      if (orderRow) {
        const order = normalizePayload<PosOrder>(orderRow.payload);
        if (order.status !== "completed") await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "order", recordId: order.id, payload: { ...order, status: "cancelled", updatedAt: now } as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      }
      return updated;
    });
  }),

  voidSale: managerProcedure.input(z.object({ transactionId: transactionRecordId })).mutation(async ({ ctx, input }) => {
    const db = await requireDatabase();
    const currency = ctx.member.business.currency as CurrencyCode;
    return db.transaction(async (tx) => {
      const row = await getRecordTx(tx, ctx.member.businessId, "transaction", input.transactionId);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Transaction not found." });
      const transaction = normalizePayload<Transaction & { giftCardId?: string }>(row.payload);
      if (transaction.status === "voided" && transaction.voidJournalEntryId) return transaction;
      if (transaction.status !== "paid") throw new TRPCError({ code: "BAD_REQUEST", message: "Only a paid ticket can be voided." });
      const now = new Date().toISOString();
      const reversal = await postJournal(tx, ctx.member.businessId, ctx.user.openId, currency, { date: now, reference: `VOID ${transaction.orderNumber}`, description: `Void ${transaction.orderNumber}`, lines: addReversalLines(transaction, currency) });
      const updated = { ...transaction, status: "voided" as const, voidedAt: now, voidJournalEntryId: reversal.id };
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "transaction", recordId: transaction.id, payload: updated as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      await reverseSalePrograms(tx, ctx.member.businessId, ctx.user.openId, transaction, now, "void", currency);
      const orderRow = await getRecordTx(tx, ctx.member.businessId, "order", transaction.orderId);
      if (orderRow) {
        const order = normalizePayload<PosOrder>(orderRow.payload);
        if (order.status !== "completed") await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "order", recordId: order.id, payload: { ...order, status: "cancelled", updatedAt: now } as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
      }
      return updated;
    });
  }),

  importLegacy: managerProcedure.input(z.object({ ownerOpenId: z.string().min(1).max(191), currencyConfirmed: z.boolean(), orders: z.array(legacyOrderSchema).max(1000), transactions: z.array(legacyTransactionSchema).max(1000) })).mutation(async ({ ctx, input }) => {
    if (input.ownerOpenId !== ctx.user.openId) throw new TRPCError({ code: "FORBIDDEN", message: "These local register records belong to a different signed-in account." });
    if (!input.currencyConfirmed) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Confirm that the workspace currency matches the unchanged local amounts before importing." });
    const db = await requireDatabase();
    const currency = ctx.member.business.currency as CurrencyCode;
    const importId = createHash("sha256").update(JSON.stringify({ orders: input.orders, transactions: input.transactions })).digest("hex");
    return db.transaction(async (tx) => {
      try {
        await tx.insert(businessRecords).values({ id: makeId(), businessId: ctx.member.businessId, recordKind: "legacyImport", recordId: LEGACY_IMPORT_MARKER_ID, payload: { importId, status: "processing" }, createdByOpenId: ctx.user.openId });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        const prior = await getRecordTx(tx, ctx.member.businessId, "legacyImport", LEGACY_IMPORT_MARKER_ID);
        if (prior?.payload.status === "complete") return { imported: 0, alreadyImported: true, importId: String(prior.payload.importId ?? "") };
        throw new TRPCError({ code: "CONFLICT", message: "A local register import is already being processed." });
      }
      let imported = 0;
      for (const raw of input.orders) {
        const payload = raw as PosOrder;
        const lineSubtotal = roundFor(payload.items.reduce((sum, line) => sum + (line.unitPrice + (line.modifier?.price ?? 0)) * line.quantity, 0), currency);
        const expectedTotal = roundFor(payload.subtotal - payload.discount + payload.tax, currency);
        if (lineSubtotal !== roundFor(payload.subtotal, currency) || payload.discount > payload.subtotal || expectedTotal !== roundFor(payload.total, currency)) throw new TRPCError({ code: "BAD_REQUEST", message: `Legacy order ${payload.number} has inconsistent totals and was not imported.` });
        const orderId = `legacy-${payload.id}`;
        const existingOrder = await getRecordTx(tx, ctx.member.businessId, "order", orderId);
        if (existingOrder) continue;
        await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "order", recordId: orderId, payload: { ...payload, id: orderId, cashierName: payload.cashierName || "Imported local sale" } as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
        imported += 1;
      }
      for (const raw of input.transactions) {
        const payload = raw as Transaction;
        const lineSubtotal = roundFor(payload.items.reduce((sum, line) => sum + (line.unitPrice + (line.modifier?.price ?? 0)) * line.quantity, 0), currency);
        const expectedTotal = roundFor(payload.subtotal - payload.discount + payload.tax, currency);
        if (lineSubtotal !== roundFor(payload.subtotal, currency) || payload.discount > payload.subtotal || expectedTotal !== roundFor(payload.total, currency)) throw new TRPCError({ code: "BAD_REQUEST", message: `Legacy transaction ${payload.orderNumber} has inconsistent totals and was not imported.` });
        const transactionId = `legacy-${payload.id}`;
        if (await getRecordTx(tx, ctx.member.businessId, "transaction", transactionId)) continue;
        const saleJournalId = `legacy-sale-${payload.id}`;
        const existingSaleJournal = await getRecordTx(tx, ctx.member.businessId, "journalEntry", saleJournalId);
        const saleJournal = existingSaleJournal ? normalizePayload<JournalEntry>(existingSaleJournal.payload) : await postJournal(tx, ctx.member.businessId, ctx.user.openId, currency, { date: payload.createdAt, reference: `IMPORT ${payload.orderNumber}`, description: "Imported legacy POS sale", lines: addSaleLines(payload.subtotal, payload.discount, payload.tax, payload.total, payload.paymentMethod, currency), entryId: saleJournalId });
        let reversalJournalId: string | undefined;
        let reversalDate: string | undefined;
        if (payload.status === "refunded" || payload.status === "voided") {
          const reason = payload.status === "refunded" ? "refund" : "void";
          reversalDate = payload.status === "refunded" ? payload.refundedAt || payload.createdAt : payload.voidedAt || payload.createdAt;
          reversalJournalId = `legacy-${reason}-${payload.id}`;
          const existingReversal = await getRecordTx(tx, ctx.member.businessId, "journalEntry", reversalJournalId);
          if (!existingReversal) await postJournal(tx, ctx.member.businessId, ctx.user.openId, currency, { date: reversalDate, reference: `${reason === "refund" ? "REFUND" : "VOID"} ${payload.orderNumber}`, description: `${reason === "refund" ? "Refund" : "Void"} imported legacy sale ${payload.orderNumber}`, lines: addReversalLines(payload, currency), entryId: reversalJournalId });
        }
        const transaction: Transaction = { ...payload, id: transactionId, orderId: `legacy-${payload.orderId}`, orderNumber: payload.orderNumber, cashierName: payload.cashierName || "Imported local sale", journalEntryId: saleJournal.id, refundedAt: payload.status === "refunded" ? reversalDate : payload.refundedAt, voidedAt: payload.status === "voided" ? reversalDate : payload.voidedAt, refundJournalEntryId: payload.status === "refunded" ? reversalJournalId : undefined, voidJournalEntryId: payload.status === "voided" ? reversalJournalId : undefined };
        await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "transaction", recordId: transaction.id, payload: transaction as unknown as Record<string, unknown>, actorOpenId: ctx.user.openId });
        imported += 1;
      }
      await saveBusinessRecord(tx, { businessId: ctx.member.businessId, recordKind: "legacyImport", recordId: LEGACY_IMPORT_MARKER_ID, payload: { importId, sourceFingerprint: importId, imported, status: "complete", at: new Date().toISOString() }, actorOpenId: ctx.user.openId });
      return { imported, alreadyImported: false, importId };
    });
  }),
});
