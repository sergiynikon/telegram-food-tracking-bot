interface Macros {
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

/** Calories implied by the macros (Atwater factors: 4/4/9 kcal per gram). */
export function caloriesFromMacros(m: Macros): number {
  return 4 * m.protein_g + 4 * m.carbs_g + 9 * m.fat_g;
}

/** How far the stated calories are from what the macros imply (0 = exact). */
export function macroMismatch(m: Macros): number {
  return Math.abs(caloriesFromMacros(m) - m.calories_kcal);
}

/**
 * Whether stated calories agree with the macros. Catches model slips like 378 g of carbs
 * instead of 37.8 g. Generous enough for fiber and rounding; alcohol (7 kcal/g, not a macro)
 * can trip it, which only costs one retry.
 */
export function macrosMatchCalories(m: Macros): boolean {
  return macroMismatch(m) <= Math.max(60, 0.25 * m.calories_kcal);
}
