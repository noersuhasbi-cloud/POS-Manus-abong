import type { BillOfMaterial, BillOfMaterialComponent, MenuItem, OrderLine, RecipeModifierOption, RecipeSaleCostComponent, RecipeSaleCostLine } from "./pos";
import { normalizeBaseQuantity } from "./unit-conversion";

export type RecipeSaleCostDraft = Omit<RecipeSaleCostLine, "quantity" | "grossSales" | "discountAllocated" | "netSales">;
export type RecipeConsumptionPlan = { ingredientDemand: Map<string, number>; lines: RecipeSaleCostDraft[] };
const MAX_BASE_QUANTITY = 1_000_000_000;

type PlannedComponent = { component: BillOfMaterialComponent; sourceLabel?: string };

function validateComponents(components: BillOfMaterialComponent[], itemName: string, sourceLabel?: string): PlannedComponent[] {
  const seen = new Set<string>();
  return components.map((component) => {
    const quantity = Number(component.quantity);
    if (!component.ingredientItemId || !Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_BASE_QUANTITY) throw new RangeError(`The ${sourceLabel ? `${sourceLabel} ` : ""}BOM for ${itemName} has an invalid ingredient quantity.`);
    try { normalizeBaseQuantity(quantity, "Recipe base-unit quantity"); }
    catch { throw new RangeError(`The ${sourceLabel ? `${sourceLabel} ` : ""}BOM for ${itemName} must use no more than three decimal places.`); }
    if (seen.has(component.ingredientItemId)) throw new RangeError(`The ${sourceLabel ? `${sourceLabel} ` : ""}BOM for ${itemName} repeats an ingredient; combine it into one component.`);
    seen.add(component.ingredientItemId);
    return { component: { ingredientItemId: component.ingredientItemId, quantity }, sourceLabel };
  });
}

/** Build a validated, sale-time BOM plan before the database transaction applies stock deltas. */
export function planRecipeConsumption(lines: OrderLine[], recipes: BillOfMaterial[], inventoryItems: MenuItem[]): RecipeConsumptionPlan {
  const recipeByMenuItem = new Map<string, BillOfMaterial>();
  for (const recipe of recipes) {
    if (recipeByMenuItem.has(recipe.menuItemId)) throw new RangeError("A menu item cannot have duplicate BOM records.");
    recipeByMenuItem.set(recipe.menuItemId, recipe);
  }
  const itemsById = new Map(inventoryItems.map((item) => [item.id, item]));
  const ingredientDemand = new Map<string, number>();
  const costLines = lines.map((line): RecipeSaleCostDraft => {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) throw new RangeError("POS recipe demand requires a positive whole menu quantity.");
    const recipe = recipeByMenuItem.get(line.menuItemId);
    const groups = recipe?.modifierGroups ?? [];
    const selectedIds = line.selectedModifierIds ?? [];
    if (new Set(selectedIds).size !== selectedIds.length) throw new RangeError(`The ticket repeats a modifier option for ${line.name}.`);
    const selectedOptions: { groupName: string; option: RecipeModifierOption }[] = [];
    const selectedByGroup = new Map<string, number>();
    for (const optionId of selectedIds) {
      const match = groups.flatMap((group) => group.options.map((option) => ({ group, option }))).find(({ option }) => option.id === optionId);
      if (!match) throw new RangeError(`A selected modifier for ${line.name} is no longer available.`);
      selectedByGroup.set(match.group.id, (selectedByGroup.get(match.group.id) ?? 0) + 1);
      selectedOptions.push({ groupName: match.group.name, option: match.option });
    }
    for (const group of groups) {
      const count = selectedByGroup.get(group.id) ?? 0;
      if (count < group.minSelections || count > group.maxSelections) throw new RangeError(`${line.name} requires ${group.minSelections === 0 ? "at most" : "exactly or at least"} ${group.minSelections === group.maxSelections ? group.minSelections : `${group.minSelections}–${group.maxSelections}`} choice(s) in ${group.name}.`);
    }
    if (!recipe && selectedIds.length) throw new RangeError(`The modifier configuration for ${line.name} is unavailable. Refresh the register.`);

    const allComponents: PlannedComponent[] = [];
    if (recipe?.components?.length) allComponents.push(...validateComponents(recipe.components, line.name));
    for (const selected of selectedOptions) {
      allComponents.push(...validateComponents(selected.option.components ?? [], line.name, `${selected.groupName} · ${selected.option.label}`));
    }
    if (!allComponents.length) return { menuItemId: line.menuItemId, menuItemName: line.name, recipeCosted: false, recipeUnitCost: 0, recipeCost: 0, ingredients: [] };

    const ingredients: RecipeSaleCostComponent[] = allComponents.map(({ component, sourceLabel }) => {
      const ingredient = itemsById.get(component.ingredientItemId);
      if (!ingredient || ingredient.ingredientOnly !== true || ingredient.stockTracked !== true) throw new RangeError(`The BOM for ${line.name} references an unavailable tracked ingredient.`);
      const unitCost = Number(ingredient.unitCost ?? 0);
      if (!Number.isFinite(unitCost) || unitCost < 0) throw new RangeError(`The unit cost for ingredient ${ingredient.name} is invalid.`);
      const quantityUsed = normalizeBaseQuantity(component.quantity * line.quantity, "Combined recipe quantity");
      const combinedDemand = normalizeBaseQuantity((ingredientDemand.get(ingredient.id) ?? 0) + quantityUsed, "Combined ingredient demand");
      if (quantityUsed > MAX_BASE_QUANTITY || combinedDemand > MAX_BASE_QUANTITY) throw new RangeError(`The combined BOM quantity for ${ingredient.name} exceeds the stock limit.`);
      ingredientDemand.set(ingredient.id, combinedDemand);
      return { ingredientItemId: ingredient.id, ingredientName: ingredient.name, unit: ingredient.stockUnit ?? "unit", quantityPerItem: component.quantity, quantityUsed, unitCost, totalCost: unitCost * quantityUsed, sourceLabel };
    });
    const rawCost = ingredients.reduce((sum, ingredient) => sum + ingredient.totalCost, 0);
    return { menuItemId: line.menuItemId, menuItemName: line.name, recipeCosted: true, recipeUnitCost: rawCost / line.quantity, recipeCost: rawCost, ingredients };
  });
  return { ingredientDemand, lines: costLines };
}
