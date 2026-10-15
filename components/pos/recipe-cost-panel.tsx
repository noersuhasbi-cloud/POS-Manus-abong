import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Card, EmptyState, palette, Pill, PrimaryButton, SectionTitle } from "@/components/pos/ui";
import { useWorkspace } from "@/lib/workspace-context";
import { trpc } from "@/lib/trpc";
import { formatMoney } from "@/shared/accounting";
import type { BillOfMaterialComponent, MenuItem, RecipeModifierGroup } from "@/shared/pos";
import { normalizeBaseQuantity, suggestBaseUnitsPerPurchaseUnit, INGREDIENT_BASE_UNITS, INGREDIENT_PURCHASE_UNITS, type IngredientBaseUnit, type IngredientPurchaseUnit } from "@/shared/unit-conversion";

type FieldProps = { label: string; value: string; onChangeText: (value: string) => void; placeholder?: string; keyboardType?: "default" | "number-pad" | "decimal-pad"; editable?: boolean };
function Field({ label, value, onChangeText, placeholder, keyboardType = "default", editable = true }: FieldProps) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={palette.muted} keyboardType={keyboardType} editable={editable} style={[styles.input, !editable && styles.inputDisabled]} /></View>;
}

type DropdownOption = { value: string; label: string };
function ChoiceDropdown({ label, value, options, open, setOpen, onChange }: { label: string; value: string; options: DropdownOption[]; open: boolean; setOpen: (open: boolean) => void; onChange: (value: string) => void }) {
  const selected = options.find((option) => option.value === value)?.label ?? value;
  return <View style={styles.dropdownWrap}><Text style={styles.label}>{label}</Text><Pressable onPress={() => setOpen(!open)} style={styles.dropdown} accessibilityRole="button" accessibilityState={{ expanded: open }}><Text style={styles.dropdownText}>{selected}</Text><MaterialIcons name={open ? "expand-less" : "expand-more"} size={20} color={palette.evergreen} /></Pressable>{open ? <View style={styles.dropdownOptions}>{options.map((option) => <Pressable key={option.value} onPress={() => { onChange(option.value); setOpen(false); }} style={[styles.dropdownOption, option.value === value && styles.dropdownOptionActive]}><Text style={[styles.dropdownOptionText, option.value === value && styles.dropdownOptionTextActive]}>{option.label}</Text></Pressable>)}</View> : null}</View>;
}

function makeLocalId(prefix: string) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function isBaseUnit(value: string): value is IngredientBaseUnit { return (INGREDIENT_BASE_UNITS as readonly string[]).includes(value); }
function isPurchaseUnit(value: string): value is IngredientPurchaseUnit { return (INGREDIENT_PURCHASE_UNITS as readonly string[]).includes(value); }
const baseUnitOptions: DropdownOption[] = [{ value: "g", label: "Gram (g)" }, { value: "ml", label: "Milliliter (ml)" }, { value: "piece", label: "Piece" }];
const purchaseUnitLabels: Record<IngredientPurchaseUnit, string> = { piece: "Piece", box: "Box", bag: "Bag", pack: "Pack", bottle: "Bottle", can: "Can", case: "Case", g: "Gram (g)", kg: "Kilogram (kg)", ml: "Milliliter (ml)", liter: "Liter (L)" };
const purchaseUnitOptions = INGREDIENT_PURCHASE_UNITS.map((value) => ({ value, label: purchaseUnitLabels[value] }));

export function RecipeCostPanel() {
  const { workspace } = useWorkspace();
  const utils = trpc.useUtils();
  const catalog = trpc.pos.recipeCatalog.useQuery(undefined, { refetchInterval: 3_000 });
  const saveIngredient = trpc.pos.saveIngredient.useMutation();
  const saveRecipe = trpc.pos.saveRecipe.useMutation();
  const [selectedProductId, setSelectedProductId] = useState("");
  const [selectedIngredientId, setSelectedIngredientId] = useState("");
  const [quantityPerItem, setQuantityPerItem] = useState("1");
  const [draftComponents, setDraftComponents] = useState<BillOfMaterialComponent[]>([]);
  const [componentQuantityDrafts, setComponentQuantityDrafts] = useState<Record<string, string>>({});
  const [draftModifierGroups, setDraftModifierGroups] = useState<RecipeModifierGroup[]>([]);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupRequired, setNewGroupRequired] = useState(true);
  const [modifierComponentDrafts, setModifierComponentDrafts] = useState<Record<string, { ingredientId: string; quantity: string }>>({});
  const [editingRecipe, setEditingRecipe] = useState(false);
  const [editingIngredientId, setEditingIngredientId] = useState<string | null>(null);
  const [ingredientName, setIngredientName] = useState("");
  const [ingredientUnit, setIngredientUnit] = useState<IngredientBaseUnit>("g");
  const [purchaseUnit, setPurchaseUnit] = useState<IngredientPurchaseUnit>("kg");
  const [conversionFactor, setConversionFactor] = useState("1000");
  const [unitDropdown, setUnitDropdown] = useState<"base" | "purchase" | null>(null);
  const [ingredientUnitCost, setIngredientUnitCost] = useState("");
  const [ingredientOpeningStock, setIngredientOpeningStock] = useState("0");
  const [ingredientMinimum, setIngredientMinimum] = useState("0");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const products = catalog.data?.menuItems ?? [];
  const ingredients = useMemo(() => catalog.data?.ingredients ?? [], [catalog.data?.ingredients]);
  const selectedProduct = products.find((item) => item.id === selectedProductId) ?? products[0];
  const savedRecipe = catalog.data?.recipes.find((item) => item.menuItemId === selectedProduct?.id);
  const components = editingRecipe ? draftComponents : savedRecipe?.components ?? [];
  const modifierGroups = editingRecipe ? draftModifierGroups : savedRecipe?.modifierGroups ?? [];
  const resolvedIngredientId = ingredients.some((item) => item.id === selectedIngredientId) ? selectedIngredientId : ingredients[0]?.id ?? "";
  const currency = workspace?.currency ?? "IDR";
  const money = (value: number) => formatMoney(value, currency);
  const recipeCost = components.reduce((sum, component) => {
    const ingredient = ingredients.find((item) => item.id === component.ingredientItemId);
    return sum + Number(ingredient?.unitCost ?? 0) * component.quantity;
  }, 0);
  const optionCost = (option: RecipeModifierGroup["options"][number]) => option.components.reduce((sum, component) => sum + Number(ingredients.find((item) => item.id === component.ingredientItemId)?.unitCost ?? 0) * component.quantity, 0);

  function resetIngredientForm() {
    setEditingIngredientId(null); setIngredientName(""); setIngredientUnit("g"); setPurchaseUnit("kg"); setConversionFactor("1000"); setIngredientUnitCost(""); setIngredientOpeningStock("0"); setIngredientMinimum("0"); setUnitDropdown(null);
  }

  function editIngredient(item: MenuItem) {
    const base = isBaseUnit(item.stockUnit ?? "") ? item.stockUnit as IngredientBaseUnit : "g";
    const purchase = isPurchaseUnit(item.purchaseUnit ?? "") ? item.purchaseUnit as IngredientPurchaseUnit : base;
    setEditingIngredientId(item.id); setIngredientName(item.name); setIngredientUnit(base); setPurchaseUnit(purchase); setConversionFactor(String(item.baseUnitsPerPurchaseUnit ?? suggestBaseUnitsPerPurchaseUnit(purchase, base) ?? 1)); setIngredientUnitCost(String(item.unitCost ?? 0)); setIngredientOpeningStock("0"); setIngredientMinimum(String(item.lowStockThreshold ?? 0)); setUnitDropdown(null); setError(""); setNotice("");
  }

  function changeBaseUnit(value: string) {
    if (!isBaseUnit(value)) return;
    setIngredientUnit(value);
    const suggestion = suggestBaseUnitsPerPurchaseUnit(purchaseUnit, value);
    if (suggestion !== null) setConversionFactor(String(suggestion));
  }

  function changePurchaseUnit(value: string) {
    if (!isPurchaseUnit(value)) return;
    setPurchaseUnit(value);
    const suggestion = suggestBaseUnitsPerPurchaseUnit(value, ingredientUnit);
    setConversionFactor(suggestion === null ? "1" : String(suggestion));
  }

  async function submitIngredient() {
    const cost = Number(ingredientUnitCost);
    const opening = Number(ingredientOpeningStock);
    const minimum = Number(ingredientMinimum);
    const factor = Number(conversionFactor);
    try {
      if (!ingredientName.trim() || !Number.isFinite(cost) || cost < 0 || !Number.isFinite(factor) || factor <= 0) throw new Error("Enter a name, a non-negative per-base-unit cost and a positive pack conversion factor.");
      normalizeBaseQuantity(opening, "Opening stock"); normalizeBaseQuantity(minimum, "Minimum stock"); normalizeBaseQuantity(factor, "Pack conversion factor");
    } catch (err) { setError(err instanceof Error ? err.message : "Check ingredient quantities and conversion."); return; }
    setError(""); setNotice("");
    try {
      const item = await saveIngredient.mutateAsync({ id: editingIngredientId ?? undefined, name: ingredientName.trim(), unit: ingredientUnit, purchaseUnit, baseUnitsPerPurchaseUnit: factor, unitCost: cost, openingStock: editingIngredientId ? 0 : opening, lowStockThreshold: minimum });
      await Promise.all([utils.pos.recipeCatalog.invalidate(), utils.pos.inventory.invalidate(), utils.pos.menu.invalidate(), utils.purchasing.requestableGoods.invalidate(), utils.purchasing.requests.invalidate()]);
      setNotice(`${item.name} saved · ${money(item.unitCost ?? 0)} per ${item.stockUnit} · 1 ${item.purchaseUnit} = ${item.baseUnitsPerPurchaseUnit} ${item.stockUnit}.`); resetIngredientForm();
    } catch (err) { setError(err instanceof Error ? err.message : "Ingredient could not be saved."); }
  }

  function chooseProduct(item: MenuItem) {
    const recipe = catalog.data?.recipes.find((candidate) => candidate.menuItemId === item.id);
    setSelectedProductId(item.id); setDraftComponents(recipe?.components ?? []); setComponentQuantityDrafts({}); setDraftModifierGroups(recipe?.modifierGroups ?? []); setEditingRecipe(true); setError(""); setNotice("");
  }

  function addComponent() {
    let quantity: number;
    try { quantity = normalizeBaseQuantity(Number(quantityPerItem), "Recipe quantity"); }
    catch { setError("Ingredient usage must be positive and precise to at most 0.001 of its base unit."); return; }
    if (!selectedProduct) { setError("Create or choose a sellable menu item first."); return; }
    if (!resolvedIngredientId) { setError("Create an inventory ingredient before building a recipe."); return; }
    if (quantity <= 0) { setError("Ingredient usage must be positive."); return; }
    const current = editingRecipe ? draftComponents : savedRecipe?.components ?? [];
    if (current.some((component) => component.ingredientItemId === resolvedIngredientId)) { setError("That ingredient is already in this recipe; edit its quantity instead."); return; }
    setDraftComponents([...current, { ingredientItemId: resolvedIngredientId, quantity }]); setEditingRecipe(true); setQuantityPerItem("1"); setError("");
  }

  function commitComponentQuantity(ingredientItemId: string, text: string) {
    try {
      const quantity = normalizeBaseQuantity(Number(text), "Recipe quantity");
      if (quantity <= 0) throw new Error("Use a positive ingredient quantity.");
      setDraftComponents((current) => current.map((component) => component.ingredientItemId === ingredientItemId ? { ...component, quantity } : component)); setComponentQuantityDrafts((current) => ({ ...current, [ingredientItemId]: String(quantity) })); setEditingRecipe(true); setError("");
    } catch (err) { setComponentQuantityDrafts((current) => ({ ...current, [ingredientItemId]: String(components.find((component) => component.ingredientItemId === ingredientItemId)?.quantity ?? 1) })); setError(err instanceof Error ? err.message : "Enter a positive amount with up to three decimal places."); }
  }

  function removeComponent(ingredientItemId: string) {
    setDraftComponents((current) => current.filter((component) => component.ingredientItemId !== ingredientItemId)); setEditingRecipe(true); setError("");
  }

  function addModifierGroup() {
    const name = newGroupName.trim();
    if (!name) { setError("Name the modifier group first."); return; }
    const group: RecipeModifierGroup = { id: makeLocalId("group"), name, minSelections: newGroupRequired ? 1 : 0, maxSelections: 1, options: [{ id: makeLocalId("option"), label: "New option", price: 0, components: [] }] };
    setDraftModifierGroups((current) => [...current, group]); setNewGroupName(""); setEditingRecipe(true); setError("");
  }

  function updateGroup(groupId: string, patch: Partial<Pick<RecipeModifierGroup, "name" | "minSelections" | "maxSelections">>) {
    setDraftModifierGroups((current) => current.map((group) => group.id === groupId ? { ...group, ...patch } : group)); setEditingRecipe(true);
  }

  function removeGroup(groupId: string) {
    setDraftModifierGroups((current) => current.filter((group) => group.id !== groupId)); setEditingRecipe(true);
  }

  function addModifierOption(groupId: string) {
    setDraftModifierGroups((current) => current.map((group) => group.id === groupId ? { ...group, options: [...group.options, { id: makeLocalId("option"), label: `Option ${group.options.length + 1}`, price: 0, components: [] }] } : group)); setEditingRecipe(true);
  }

  function updateModifierOption(groupId: string, optionId: string, patch: Partial<Pick<RecipeModifierGroup["options"][number], "label" | "price">>) {
    setDraftModifierGroups((current) => current.map((group) => group.id === groupId ? { ...group, options: group.options.map((option) => option.id === optionId ? { ...option, ...patch } : option) } : group)); setEditingRecipe(true);
  }

  function removeModifierOption(groupId: string, optionId: string) {
    setDraftModifierGroups((current) => current.map((group) => {
      if (group.id !== groupId || group.options.length <= 1) return group;
      const options = group.options.filter((option) => option.id !== optionId);
      const maxSelections = Math.min(group.maxSelections, options.length);
      return { ...group, options, maxSelections, minSelections: Math.min(group.minSelections, maxSelections) };
    })); setEditingRecipe(true);
  }

  function modifierDraftKey(groupId: string, optionId: string) { return `${groupId}:${optionId}`; }

  function addModifierIngredient(groupId: string, optionId: string) {
    const key = modifierDraftKey(groupId, optionId);
    const draft = modifierComponentDrafts[key] ?? { ingredientId: ingredients[0]?.id ?? "", quantity: "50" };
    let quantity: number;
    try { quantity = normalizeBaseQuantity(Number(draft.quantity), "Modifier ingredient quantity"); }
    catch { setError("Modifier ingredient usage must be positive and have at most three decimal places."); return; }
    if (!draft.ingredientId || quantity <= 0) { setError("Choose an ingredient and enter a positive base-unit quantity."); return; }
    setDraftModifierGroups((current) => current.map((group) => group.id === groupId ? { ...group, options: group.options.map((option) => option.id === optionId ? { ...option, components: option.components.some((component) => component.ingredientItemId === draft.ingredientId) ? option.components.map((component) => component.ingredientItemId === draft.ingredientId ? { ...component, quantity } : component) : [...option.components, { ingredientItemId: draft.ingredientId, quantity }] } : option) } : group));
    setModifierComponentDrafts((current) => ({ ...current, [key]: { ...draft, quantity: "50" } })); setEditingRecipe(true); setError("");
  }

  function removeModifierIngredient(groupId: string, optionId: string, ingredientId: string) {
    setDraftModifierGroups((current) => current.map((group) => group.id === groupId ? { ...group, options: group.options.map((option) => option.id === optionId ? { ...option, components: option.components.filter((component) => component.ingredientItemId !== ingredientId) } : option) } : group)); setEditingRecipe(true);
  }

  async function submitRecipe() {
    if (!selectedProduct) { setError("Choose a sellable menu item first."); return; }
    const next = editingRecipe ? draftComponents : savedRecipe?.components ?? [];
    const nextGroups = editingRecipe ? draftModifierGroups : savedRecipe?.modifierGroups ?? [];
    if (nextGroups.some((group) => !group.name.trim() || group.options.length === 0 || group.options.some((option) => !option.label.trim() || !Number.isFinite(option.price) || option.price < 0))) { setError("Every modifier group and option needs a name and valid price."); return; }
    setError(""); setNotice("");
    try {
      await saveRecipe.mutateAsync({ menuItemId: selectedProduct.id, components: next, modifierGroups: nextGroups });
      await Promise.all([utils.pos.recipeCatalog.invalidate(), utils.pos.menu.invalidate(), utils.accounting.report.invalidate()]);
      setEditingRecipe(false); setNotice(`${selectedProduct.name} recipe saved · ${money(recipeCost)} estimated base cost per item.`);
    } catch (err) { setError(err instanceof Error ? err.message : "Bill of materials could not be saved."); }
  }

  if (catalog.error) return <Card style={styles.card}><Text style={styles.errorText}>Recipes & costs are not synchronized. Reconnect before editing ingredient or recipe data.</Text></Card>;

  return <View style={styles.container}>
    <Card style={styles.intro}><Text style={styles.eyebrow}>INGREDIENT COSTING</Text><Text style={styles.introTitle}>Build recipes from stockable ingredients.</Text><Text style={styles.introNote}>Buy in supplier packs, count and consume in precise base units, then see recipe cost captured with each paid ticket.</Text></Card>

    <SectionTitle title="Ingredient inventory" action={`${ingredients.length} saved`} />
    {catalog.isLoading ? <Text style={styles.note}>Loading shared ingredients…</Text> : ingredients.length ? <View style={styles.chips}>{ingredients.map((ingredient) => {
      const low = Number(ingredient.stockOnHand ?? 0) <= Number(ingredient.lowStockThreshold ?? 0);
      return <Pressable key={ingredient.id} onPress={() => editIngredient(ingredient)} style={[styles.ingredientChip, low && styles.ingredientChipLow]}><Text style={styles.ingredientName}>{ingredient.name}</Text><Text style={styles.ingredientMeta}>{ingredient.stockOnHand ?? 0} / min {ingredient.lowStockThreshold ?? 0} {ingredient.stockUnit} · {money(ingredient.unitCost ?? 0)}/{ingredient.stockUnit}{low ? " · LOW" : ""}</Text><Text style={styles.ingredientMeta}>Purchased in {purchaseUnitLabels[(isPurchaseUnit(ingredient.purchaseUnit ?? "") ? ingredient.purchaseUnit : ingredient.stockUnit ?? "piece") as IngredientPurchaseUnit]} · {ingredient.baseUnitsPerPurchaseUnit ?? 1} {ingredient.stockUnit}/{ingredient.purchaseUnit ?? ingredient.stockUnit}</Text></Pressable>;
    })}</View> : <EmptyState icon="grain" title="No ingredients yet" body="Add a stock ingredient below. It will also be available for purchase requests and Main warehouse receiving." />}
    <Card style={styles.card}><Text style={styles.cardTitle}>{editingIngredientId ? "Update ingredient cost or minimum" : "Add an ingredient"}</Text><Field label="INGREDIENT NAME" value={ingredientName} onChangeText={setIngredientName} placeholder="e.g. Oat milk" />
      <View style={styles.unitMatrix}><ChoiceDropdown label="PURCHASED IN" value={purchaseUnit} options={purchaseUnitOptions} open={unitDropdown === "purchase"} setOpen={(open) => setUnitDropdown(open ? "purchase" : null)} onChange={changePurchaseUnit} /><View style={styles.matrixArrow}><MaterialIcons name="arrow-forward" size={18} color={palette.evergreen} /></View><ChoiceDropdown label="CONSUMED IN" value={ingredientUnit} options={baseUnitOptions} open={unitDropdown === "base"} setOpen={(open) => setUnitDropdown(open ? "base" : null)} onChange={changeBaseUnit} /></View>
      <View style={styles.inline}><Field label="BASE UNITS PER PURCHASE PACK · CONFIRM CONTENT" value={conversionFactor} onChangeText={setConversionFactor} placeholder="e.g. 750" keyboardType="decimal-pad" /><Field label={`COST PER ${ingredientUnit.toUpperCase()} · ${currency}`} value={ingredientUnitCost} onChangeText={setIngredientUnitCost} placeholder="e.g. 65" keyboardType="decimal-pad" /></View>
      <Text style={styles.conversionNote}>1 {purchaseUnit} = {conversionFactor || "…"} {ingredientUnit}. Common suggestion: {suggestBaseUnitsPerPurchaseUnit(purchaseUnit, ingredientUnit) ?? "enter the pack's confirmed contents"} base units. The suggested pack factor is always manager-confirmed.</Text>
      <View style={styles.inline}><Field label={`OPENING STOCK · ${ingredientUnit} (≤0.001)`} value={ingredientOpeningStock} onChangeText={setIngredientOpeningStock} placeholder="0" keyboardType="decimal-pad" editable={!editingIngredientId} /><Field label={`MINIMUM STOCK · ${ingredientUnit} (≤0.001)`} value={ingredientMinimum} onChangeText={setIngredientMinimum} placeholder="0" keyboardType="decimal-pad" /></View>
      <Text style={styles.note}>{editingIngredientId ? "Current balance is protected. Adjust it with Inventory receiving or stock opname; purchase receipts update weighted-average cost." : "Enter stock in the consumed base unit. Later purchase-pack receipts convert into that unit and update weighted-average cost."}</Text>
      <View style={styles.buttonRow}><PrimaryButton label={saveIngredient.isPending ? "Saving…" : editingIngredientId ? "Save ingredient" : "Add ingredient"} icon="inventory-2" onPress={() => void submitIngredient()} loading={saveIngredient.isPending} disabled={saveIngredient.isPending} />{editingIngredientId ? <Pressable onPress={resetIngredientForm} style={styles.textButton}><Text style={styles.textButtonText}>Cancel</Text></Pressable> : null}</View>
    </Card>

    <SectionTitle title="Bill of materials" action="Per menu item" />
    {products.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>{products.map((product) => <Pill key={product.id} label={`${product.name}${catalog.data?.recipes.some((recipe) => recipe.menuItemId === product.id && (recipe.components.length > 0 || Boolean(recipe.modifierGroups?.length))) ? " · BOM" : " · not costed"}`} selected={selectedProduct?.id === product.id} onPress={() => chooseProduct(product)} />)}</ScrollView> : <EmptyState icon="restaurant-menu" title="No sellable menu items" body="Create a sellable menu item before attaching its ingredient recipe." />}
    {selectedProduct ? <Card style={styles.card}><Text style={styles.cardTitle}>{selectedProduct.name} · base recipe</Text><Text style={styles.note}>Quantities are consumed in the ingredient&apos;s base unit and allow 0.001 precision. Modifiers configured below consume additional stock in the same atomic checkout.</Text>
      {components.length ? <View style={styles.componentList}>{components.map((component) => {
        const ingredient = ingredients.find((item) => item.id === component.ingredientItemId);
        const quantityText = componentQuantityDrafts[component.ingredientItemId] ?? String(component.quantity);
        return <View key={component.ingredientItemId} style={styles.componentRow}><View style={{ flex: 1 }}><Text style={styles.ingredientName}>{ingredient?.name ?? "Missing ingredient"}</Text><Text style={styles.ingredientMeta}>{Number(ingredient?.stockOnHand ?? 0)} {ingredient?.stockUnit ?? "unit"} on hand · {money(Number(ingredient?.unitCost ?? 0) * component.quantity)} per menu item</Text></View><TextInput value={quantityText} onChangeText={(value) => setComponentQuantityDrafts((current) => ({ ...current, [component.ingredientItemId]: value }))} onEndEditing={(event) => commitComponentQuantity(component.ingredientItemId, event.nativeEvent.text)} keyboardType="decimal-pad" style={styles.quantityInput} accessibilityLabel={`${ingredient?.name ?? "Ingredient"} quantity per menu item`} /><Text style={styles.unitText}>{ingredient?.stockUnit}</Text><Pressable onPress={() => removeComponent(component.ingredientItemId)} style={styles.remove}><Text style={styles.removeText}>Remove</Text></Pressable></View>;
      })}</View> : <Text style={styles.note}>No base recipe saved yet. Products without a recipe appear as uncosted in the accounting report.</Text>}
      {ingredients.length ? <><Text style={styles.label}>ADD A BASE INGREDIENT</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>{ingredients.map((ingredient) => <Pill key={ingredient.id} label={`${ingredient.name} · ${ingredient.stockUnit}`} selected={resolvedIngredientId === ingredient.id} onPress={() => setSelectedIngredientId(ingredient.id)} />)}</ScrollView><View style={styles.inline}><Field label={`USAGE PER ${selectedProduct.name.toUpperCase()} · ${ingredients.find((item) => item.id === resolvedIngredientId)?.stockUnit ?? "BASE UNIT"}`} value={quantityPerItem} onChangeText={setQuantityPerItem} placeholder="e.g. 18" keyboardType="decimal-pad" /><Pressable onPress={addComponent} style={styles.addButton}><Text style={styles.addText}>＋ Add ingredient</Text></Pressable></View></> : null}

      <View style={styles.modifierSection}><Text style={styles.cardTitle}>Deep-linked modifier groups</Text><Text style={styles.note}>Example: choose “Oat milk” and map it to 50 ml. The option&apos;s ingredient quantity and price are revalidated at checkout and sent to the kitchen ticket.</Text>
        {modifierGroups.map((group) => <View key={group.id} style={styles.groupCard}>
          <View style={styles.groupTitleRow}><TextInput value={group.name} onChangeText={(value) => updateGroup(group.id, { name: value })} style={[styles.input, { flex: 1 }]} placeholder="Group name" /><Pressable onPress={() => removeGroup(group.id)} style={styles.remove}><Text style={styles.removeText}>Remove group</Text></Pressable></View>
          <View style={styles.groupSettings}><View style={styles.requirementPills}><Pill label="Required" selected={group.minSelections > 0} onPress={() => updateGroup(group.id, { minSelections: 1 })} /><Pill label="Optional" selected={group.minSelections === 0} onPress={() => updateGroup(group.id, { minSelections: 0 })} /></View><Field label="MAX CHOICES" value={String(group.maxSelections)} onChangeText={(value) => updateGroup(group.id, { maxSelections: Math.max(1, Math.min(group.options.length, Math.floor(Number(value) || 1))) })} keyboardType="number-pad" /></View>
          {group.options.map((option) => {
            const key = modifierDraftKey(group.id, option.id);
            const currentDraft = modifierComponentDrafts[key] ?? { ingredientId: ingredients[0]?.id ?? "", quantity: "50" };
            return <View key={option.id} style={styles.optionCard}>
              <View style={styles.optionTitleRow}><TextInput value={option.label} onChangeText={(value) => updateModifierOption(group.id, option.id, { label: value })} style={[styles.input, { flex: 1 }]} placeholder="Option label" /><Field label={`PRICE · ${currency}`} value={String(option.price)} onChangeText={(value) => updateModifierOption(group.id, option.id, { price: Number(value) || 0 })} keyboardType="decimal-pad" /><Pressable disabled={group.options.length <= 1} onPress={() => removeModifierOption(group.id, option.id)} style={[styles.remove, group.options.length <= 1 && styles.disabled]}><Text style={styles.removeText}>×</Text></Pressable></View>
              <Text style={styles.label}>LINK OPTION TO INGREDIENT CONSUMPTION</Text>
              {option.components.map((component) => {
                const ingredient = ingredients.find((item) => item.id === component.ingredientItemId);
                return <View key={component.ingredientItemId} style={styles.linkedComponent}><Text style={styles.linkedComponentText}>{ingredient?.name ?? "Missing ingredient"} · {component.quantity} {ingredient?.stockUnit ?? "unit"}</Text><Pressable onPress={() => removeModifierIngredient(group.id, option.id, component.ingredientItemId)}><Text style={styles.removeText}>Remove</Text></Pressable></View>;
              })}
              {ingredients.length ? <><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>{ingredients.map((ingredient) => <Pill key={ingredient.id} label={`${ingredient.name} · ${ingredient.stockUnit}`} selected={currentDraft.ingredientId === ingredient.id} onPress={() => setModifierComponentDrafts((current) => ({ ...current, [key]: { ...currentDraft, ingredientId: ingredient.id } }))} />)}</ScrollView><View style={styles.inline}><Field label={`OPTION USAGE · ${ingredients.find((item) => item.id === currentDraft.ingredientId)?.stockUnit ?? "BASE UNIT"}`} value={currentDraft.quantity} onChangeText={(value) => setModifierComponentDrafts((current) => ({ ...current, [key]: { ...currentDraft, quantity: value } }))} keyboardType="decimal-pad" placeholder="50" /><Pressable onPress={() => addModifierIngredient(group.id, option.id)} style={styles.addButton}><Text style={styles.addText}>＋ Add usage</Text></Pressable></View></> : <Text style={styles.note}>Add a tracked ingredient before mapping this modifier.</Text>}
              <Text style={styles.optionCost}>Estimated option ingredient cost: {money(optionCost(option))}</Text>
            </View>;
          })}
          <Pressable onPress={() => addModifierOption(group.id)} style={styles.textButton}><Text style={styles.textButtonText}>＋ Add option</Text></Pressable>
        </View>)}
        <View style={styles.inline}><Field label="NEW GROUP · e.g. Milk choice" value={newGroupName} onChangeText={setNewGroupName} placeholder="Milk choice" /><View style={styles.requirementPills}><Pill label="Required" selected={newGroupRequired} onPress={() => setNewGroupRequired(true)} /><Pill label="Optional" selected={!newGroupRequired} onPress={() => setNewGroupRequired(false)} /></View><Pressable onPress={addModifierGroup} style={styles.addButton}><Text style={styles.addText}>＋ Add group</Text></Pressable></View>
      </View>

      <View style={styles.costPreview}><Text style={styles.costLabel}>ESTIMATED BASE INGREDIENT COST / ITEM</Text><Text style={styles.costValue}>{money(recipeCost)}</Text><Text style={styles.ingredientMeta}>Menu price before discounts {money(selectedProduct.price)} · base margin {money(selectedProduct.price - recipeCost)} · add-on option cost shown above</Text></View>
      <PrimaryButton label={saveRecipe.isPending ? "Saving BOM…" : "Save bill of materials & modifiers"} icon="save" onPress={() => void submitRecipe()} loading={saveRecipe.isPending} disabled={saveRecipe.isPending || ingredients.length === 0} />
    </Card> : null}
    {error ? <View style={styles.errorBanner}><Text style={styles.errorText}>{error}</Text></View> : null}
    {notice ? <Pressable onPress={() => setNotice("")} style={styles.notice}><Text style={styles.noticeText}>{notice}</Text><Text style={styles.close}>×</Text></Pressable> : null}
    <Card style={styles.disclaimer}><Text style={styles.disclaimerTitle}>Accounting treatment</Text><Text style={styles.note}>Recipe COGS is a sale-time estimate for operational margin analysis. It does not post a journal expense. The separate P&amp;L and General Ledger keep posted vendor bills as the accounting source, preventing a second expense for the same stock.</Text></Card>
  </View>;
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  intro: { backgroundColor: palette.evergreen, padding: 17 },
  eyebrow: { color: palette.amber, fontSize: 10, letterSpacing: 1.5, fontWeight: "900" },
  introTitle: { color: palette.white, fontSize: 18, fontWeight: "900", marginTop: 7 },
  introNote: { color: "#DCE8DC", fontSize: 11, lineHeight: 17, marginTop: 6 },
  note: { color: palette.muted, fontSize: 11, lineHeight: 16, marginTop: 5 },
  card: { gap: 11, padding: 14 },
  cardTitle: { color: palette.ink, fontSize: 14, fontWeight: "900" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 7, paddingVertical: 4 },
  ingredientChip: { minWidth: 160, flexGrow: 1, borderRadius: 14, backgroundColor: palette.evergreenSoft, padding: 11 },
  ingredientChipLow: { backgroundColor: palette.coralSoft },
  ingredientName: { color: palette.ink, fontSize: 12, fontWeight: "800" },
  ingredientMeta: { color: palette.muted, fontSize: 10, lineHeight: 15, marginTop: 3 },
  field: { flex: 1, gap: 5, minWidth: 95 },
  label: { color: palette.muted, fontSize: 8, fontWeight: "900", letterSpacing: 0.55 },
  input: { minHeight: 40, borderWidth: 1, borderColor: palette.line, borderRadius: 10, backgroundColor: "#FFFFFF", paddingHorizontal: 10, color: palette.ink, fontSize: 12 },
  inputDisabled: { backgroundColor: "#F1F0E9", color: palette.muted },
  inline: { flexDirection: "row", alignItems: "flex-end", gap: 8, flexWrap: "wrap" },
  unitMatrix: { flexDirection: "row", alignItems: "flex-end", gap: 8, zIndex: 5 },
  dropdownWrap: { flex: 1, minWidth: 125, gap: 5, position: "relative" },
  dropdown: { minHeight: 41, borderWidth: 1, borderColor: palette.line, borderRadius: 10, backgroundColor: "#FFFFFF", paddingHorizontal: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  dropdownText: { color: palette.ink, fontSize: 11, fontWeight: "700" },
  dropdownOptions: { position: "absolute", zIndex: 20, elevation: 8, top: 60, left: 0, right: 0, maxHeight: 220, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 11, overflow: "scroll" },
  dropdownOption: { minHeight: 36, paddingHorizontal: 10, justifyContent: "center", borderBottomWidth: 1, borderBottomColor: palette.line },
  dropdownOptionActive: { backgroundColor: palette.evergreenSoft },
  dropdownOptionText: { color: palette.ink, fontSize: 11 },
  dropdownOptionTextActive: { color: palette.evergreen, fontWeight: "900" },
  matrixArrow: { height: 41, justifyContent: "center" },
  conversionNote: { color: palette.evergreen, fontSize: 10, lineHeight: 15, backgroundColor: palette.evergreenSoft, borderRadius: 9, padding: 9 },
  buttonRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  textButton: { padding: 9 },
  textButtonText: { color: palette.evergreen, fontWeight: "800", fontSize: 10 },
  componentList: { gap: 7 },
  componentRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, borderBottomWidth: 1, borderColor: palette.line },
  quantityInput: { width: 70, height: 39, textAlign: "center", borderWidth: 1, borderColor: palette.line, borderRadius: 9, color: palette.ink, fontWeight: "800", fontSize: 12 },
  unitText: { color: palette.muted, fontSize: 10, minWidth: 20 },
  remove: { paddingVertical: 7, paddingHorizontal: 4 },
  removeText: { color: palette.coral, fontSize: 9, fontWeight: "800" },
  addButton: { backgroundColor: palette.evergreenSoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11 },
  addText: { color: palette.evergreen, fontSize: 10, fontWeight: "900" },
  modifierSection: { gap: 10, borderTopWidth: 1, borderColor: palette.line, paddingTop: 13 },
  groupCard: { borderWidth: 1, borderColor: palette.line, borderRadius: 13, backgroundColor: palette.background, padding: 10, gap: 8 },
  groupTitleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  groupSettings: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  requirementPills: { flexDirection: "row", flexWrap: "wrap", gap: 5, paddingVertical: 4 },
  optionCard: { borderRadius: 11, backgroundColor: palette.surface, padding: 8, gap: 7 },
  optionTitleRow: { flexDirection: "row", alignItems: "flex-end", gap: 6 },
  linkedComponent: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderRadius: 8, backgroundColor: palette.evergreenSoft, padding: 7 },
  linkedComponentText: { color: palette.ink, fontSize: 9, fontWeight: "700" },
  optionCost: { color: palette.evergreen, fontSize: 9, fontWeight: "800" },
  disabled: { opacity: 0.4 },
  costPreview: { borderRadius: 13, backgroundColor: palette.amberSoft, padding: 12 },
  costLabel: { color: "#98661F", fontSize: 8, letterSpacing: 0.65, fontWeight: "900" },
  costValue: { color: palette.ink, fontSize: 23, fontWeight: "900", marginTop: 4 },
  errorBanner: { borderRadius: 11, backgroundColor: palette.coralSoft, padding: 11 },
  errorText: { color: palette.coral, fontSize: 11, fontWeight: "700" },
  notice: { backgroundColor: palette.evergreenSoft, borderRadius: 11, padding: 11, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  noticeText: { color: palette.evergreen, fontSize: 11, fontWeight: "700", flex: 1 },
  close: { color: palette.muted, fontSize: 20, paddingHorizontal: 5 },
  disclaimer: { borderColor: palette.amber, backgroundColor: "#FFF9EB", gap: 4 },
  disclaimerTitle: { color: "#98661F", fontSize: 11, fontWeight: "900" },
});
