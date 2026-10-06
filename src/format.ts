import type { MealAnalysis } from "./analyze.ts";

export const MEAL_TYPES = {
  breakfast: { label: "Сніданок", tag: "#сніданок", emoji: "🍳" },
  lunch: { label: "Обід", tag: "#обід", emoji: "🍲" },
  snack: { label: "Перекус", tag: "#перекус", emoji: "🍎" },
  dinner: { label: "Вечеря", tag: "#вечеря", emoji: "🍽" },
} as const;

export type MealType = keyof typeof MEAL_TYPES;

export function isMealType(value: string): value is MealType {
  return value in MEAL_TYPES;
}

const CAPTION_KEYWORDS: [RegExp, MealType][] = [
  [/сніданок|breakfast/i, "breakfast"],
  [/обід|lunch/i, "lunch"],
  [/перекус|snack/i, "snack"],
  [/вечеря|dinner|supper/i, "dinner"],
];

function hourIn(date: Date, timezone: string): number {
  return Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: timezone }).format(date));
}

/** Meal type from a keyword in the caption, otherwise from the time of day. */
export function guessMealType(date: Date, timezone: string, caption?: string): MealType {
  for (const [pattern, type] of CAPTION_KEYWORDS) {
    if (caption && pattern.test(caption)) return type;
  }
  const hour = hourIn(date, timezone);
  if (hour >= 4 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 15) return "lunch";
  if (hour >= 18 && hour < 23) return "dinner";
  return "snack";
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CONFIDENCE_LABELS: Record<MealAnalysis["confidence"], string> = {
  low: "низька",
  medium: "середня",
  high: "висока",
};

/** Builds the HTML post for the trainer group. */
export function formatMealPost(params: {
  analysis: MealAnalysis;
  mealType: MealType;
  date: Date;
  timezone: string;
  maxItems?: number;
}): string {
  const { analysis: a, mealType, date, timezone, maxItems = 8 } = params;
  const meal = MEAL_TYPES[mealType];
  const when = new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(date);

  const lines = [
    `#трекінг_їжі ${meal.tag}`,
    "",
    `${meal.emoji} <b>${meal.label}</b> · ${when}`,
    `🍴 <b>${escapeHtml(a.dish_name)}</b>`,
    "",
    `🔥 Калорії: <b>~${Math.round(a.calories_kcal)} ккал</b>`,
    `🥩 Білки: ${Math.round(a.protein_g)} г`,
    `🍞 Вуглеводи: ${Math.round(a.carbs_g)} г`,
    `🧈 Жири: ${Math.round(a.fat_g)} г`,
    `🌾 Клітковина: ${Math.round(a.fiber_g)} г`,
  ];

  if (a.items.length > 0) {
    lines.push("", "📋 <b>Склад:</b>");
    for (const item of a.items.slice(0, maxItems)) {
      lines.push(`• ${escapeHtml(item.name)} — ${escapeHtml(item.portion)}`);
    }
    if (a.items.length > maxItems) lines.push(`• …ще ${a.items.length - maxItems}`);
  }

  const notes = a.notes.trim() ? ` ${escapeHtml(a.notes.trim())}` : "";
  lines.push("", `<i>ℹ️ Оцінка ШІ, точність: ${CONFIDENCE_LABELS[a.confidence]}.${notes}</i>`);

  return lines.join("\n");
}
