import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config.ts";
import { caloriesFromMacros, macroMismatch, macrosMatchCalories } from "./nutrition.ts";

const MealAnalysisSchema = z.object({
  is_food: z.boolean().describe("false if the photo or description is not about food or drink the user had"),
  dish_name: z.string().describe("Short dish name in Ukrainian"),
  items: z
    .array(
      z.object({
        name: z.string().describe("Ingredient or component in Ukrainian"),
        portion: z.string().describe('Estimated amount in Ukrainian, e.g. "~150 г", "2 шт (~100 г)"'),
      }),
    )
    .describe("Visible components of the meal with estimated portions"),
  calories_kcal: z.number(),
  protein_g: z.number(),
  carbs_g: z.number(),
  fat_g: z.number(),
  fiber_g: z.number(),
  confidence: z.enum(["low", "medium", "high"]),
  notes: z
    .string()
    .describe("One short sentence in Ukrainian on key assumptions (hidden oil, sauce, portion size). Empty if none."),
  meal_type: z
    .enum(["breakfast", "lunch", "snack", "dinner"])
    .nullable()
    .describe('Only if the user\'s note says or clearly implies which meal it was ("снідав", "на обід", "перекусив"); otherwise null'),
  eaten_at: z
    .string()
    .nullable()
    .describe(
      'Local time the user says they ate, as 24-hour "HH:MM", if the note states or implies it ("о 13", "о пів на дев\'яту", "годину тому"); otherwise null',
    ),
  eaten_days_ago: z
    .number()
    .int()
    .describe('0 if eaten on the day the message was sent, 1 for "вчора", 2 for "позавчора"; 0 if not stated'),
});

export type MealAnalysis = z.infer<typeof MealAnalysisSchema>;

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const SYSTEM_PROMPT = `You are a sports nutritionist assistant. The user logs their meals so their gym trainer can review their diet.
They send a photo of the meal, a text description, or both. Identify the food, estimate portion sizes from visual cues (plate size, utensils, hands, packaging) or from the description, and estimate the nutrition of the whole portion.
Account for likely hidden calories such as cooking oil, butter, dressings and sauces. If the user's note gives weights, ingredients or how much they ate, trust it over your visual estimate. Without a photo and without amounts, assume typical portions and lower your confidence.
The note may also say when they ate or which meal it was; report that in meal_type, eaten_at and eaten_days_ago, working out relative times ("годину тому") from the time the message was sent.
Round calories to the nearest 10 and grams to whole numbers. Before answering, check that calories ≈ 4 × protein + 4 × carbs + 9 × fat.
Write all human-readable text in Ukrainian.`;

const client = new Anthropic({ apiKey: config.anthropicApiKey });

type Images = { data: string; mediaType: ImageMediaType }[];
type Content = Anthropic.Beta.BetaContentBlockParam[];

function localTime(date: Date): string {
  return new Intl.DateTimeFormat("uk-UA", { dateStyle: "full", timeStyle: "short", timeZone: config.timezone }).format(date);
}

/** Analyzes a meal from photos, a text description, or both (`images` may be empty). */
export async function analyzeMeal(images: Images, userNote: string | undefined, sentAt: Date): Promise<MealAnalysis> {
  const lines = [`Message sent: ${localTime(sentAt)}.`];
  if (images.length === 0) {
    lines.push("No photo: estimate from the description only.");
  } else if (images.length > 1) {
    lines.push(
      `These ${images.length} photos show ONE meal (different angles or different parts of it). Count each food item only once and give the total for the whole meal.`,
    );
  }
  lines.push(userNote ? `Note from the user: ${userNote}` : "Estimate the nutrition of this meal.");

  const content: Content = [
    ...images.map((image) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
    })),
    { type: "text", text: lines.join("\n") },
  ];
  return withMacroCheck(() => requestAnalysis(content, `${images.length} photo(s)`));
}

/**
 * Updates an earlier analysis with the user's correction ("додай ще половинку авокадо",
 * "хліба не було", "це був обід о 14"). The photos aren't sent again: the previous analysis
 * already describes them.
 */
export async function reviseMeal(
  previous: MealAnalysis,
  correction: string,
  originalNote: string | undefined,
  sentAt: Date,
): Promise<MealAnalysis> {
  const lines = [
    `Message sent: ${localTime(sentAt)}.`,
    "You already analyzed this meal and the user now sends a correction. Return the full updated analysis: apply the correction (add, remove or change items and portions, or the time or meal if they mention it) and keep everything else as it was, including meal_type, eaten_at and eaten_days_ago unless the correction changes them. If the message changes nothing about the meal, return the previous analysis unchanged.",
  ];
  if (originalNote) lines.push(`Original note from the user: ${originalNote}`);
  lines.push(`Previous analysis: ${JSON.stringify(previous)}`, `Correction from the user: ${correction}`);
  return withMacroCheck(() => requestAnalysis([{ type: "text", text: lines.join("\n") }], "correction"));
}

async function withMacroCheck(request: () => Promise<MealAnalysis>): Promise<MealAnalysis> {
  const first = await request();
  if (!first.is_food || macrosMatchCalories(first)) return first;

  // The model occasionally slips on one number (e.g. 378 g of carbs instead of 37.8). One retry fixes it.
  console.warn(
    `Calories (${first.calories_kcal}) don't match macros (${caloriesFromMacros(first)} kcal from P${first.protein_g} C${first.carbs_g} F${first.fat_g}), retrying`,
  );
  const second = await request();
  return macroMismatch(second) < macroMismatch(first) ? second : first;
}

async function requestAnalysis(content: Content, label: string): Promise<MealAnalysis> {
  const startedAt = Date.now();
  const response = await client.beta.messages.parse({
    model: config.claudeModel,
    max_tokens: 16000,
    output_config: { effort: config.claudeEffort, format: betaZodOutputFormat(MealAnalysisSchema) },
    // If a safety classifier declines, the API retries on a recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });

  const { input_tokens, output_tokens } = response.usage;
  console.log(
    `Claude ${response.model} (${config.claudeEffort}): ${label}, ` +
      `${input_tokens} in / ${output_tokens} out tokens, ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );

  if (response.stop_reason === "refusal") {
    throw new Error(`Analysis was declined (${response.stop_details?.category ?? "unknown"})`);
  }
  if (!response.parsed_output) {
    throw new Error(`Could not parse analysis (stop_reason: ${response.stop_reason})`);
  }
  return response.parsed_output;
}
