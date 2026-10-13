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

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** The date and time a clock in `timezone` shows at `date`. */
function wallClock(date: Date, timezone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    timeZone: timezone,
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** The moment a clock in `timezone` shows the given time. Day overflow (e.g. day 0) rolls over. */
function fromWallClock(c: WallClock, timezone: string): Date {
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute);
  const offsetAt = (t: number) => {
    const w = wallClock(new Date(t), timezone);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(t / 60_000) * 60_000;
  };
  // Second pass corrects for a DST switch between the guess and the answer.
  const guess = asUtc - offsetAt(asUtc);
  return new Date(asUtc - offsetAt(guess));
}

/** Meal type from the time of day. */
export function guessMealType(date: Date, timezone: string): MealType {
  const { hour } = wallClock(date, timezone);
  if (hour >= 4 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 15) return "lunch";
  if (hour >= 18 && hour < 23) return "dinner";
  return "snack";
}

// A stated time this far after the message was sent is taken to mean the previous day
// ("вечеряв о 23", sent at 00:30).
const FUTURE_TOLERANCE_MS = 60 * 60 * 1000;

/**
 * When the meal was eaten: the time the user stated ("HH:MM", `daysAgo` days before the
 * message), or the time the message was sent if they didn't say.
 */
export function resolveMealTime(sentAt: Date, eatenAt: string | null, daysAgo: number, timezone: string): Date {
  const match = eatenAt?.match(/^(\d{1,2}):(\d{2})$/);
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  const validTime = hour <= 23 && minute <= 59;
  const days = Number.isInteger(daysAgo) && daysAgo > 0 && daysAgo <= 7 ? daysAgo : 0;
  if (!validTime && days === 0) return sentAt;

  const sent = wallClock(sentAt, timezone);
  const at = (dayShift: number) =>
    fromWallClock(
      {
        ...sent,
        day: sent.day - dayShift,
        hour: validTime ? hour : sent.hour,
        minute: validTime ? minute : sent.minute,
      },
      timezone,
    );

  const eaten = at(days);
  if (days === 0 && eaten.getTime() - sentAt.getTime() > FUTURE_TOLERANCE_MS) return at(1);
  return eaten;
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
