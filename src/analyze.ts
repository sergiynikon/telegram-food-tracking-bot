import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config.ts";

const MealAnalysisSchema = z.object({
  is_food: z.boolean().describe("false if the photo does not show food or drink"),
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
});

export type MealAnalysis = z.infer<typeof MealAnalysisSchema>;

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const SYSTEM_PROMPT = `You are a sports nutritionist assistant. The user photographs their meals so their gym trainer can review their diet.
Identify the food in the photo, estimate portion sizes from visual cues (plate size, utensils, hands, packaging), and estimate the nutrition of the whole portion shown.
Account for likely hidden calories such as cooking oil, butter, dressings and sauces. If the user adds a note (weights, ingredients, how much they ate), trust it over your visual estimate.
Round calories to the nearest 10 and grams to whole numbers. Write all human-readable text in Ukrainian.`;

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export async function analyzeMeal(
  images: { data: string; mediaType: ImageMediaType }[],
  userNote: string | undefined,
): Promise<MealAnalysis> {
  const multiPhotoHint =
    images.length > 1
      ? `These ${images.length} photos show ONE meal (different angles or different parts of it). Count each food item only once and give the total for the whole meal.\n`
      : "";

  const startedAt = Date.now();
  const response = await client.beta.messages.parse({
    model: config.claudeModel,
    max_tokens: 16000,
    output_config: { effort: config.claudeEffort, format: betaZodOutputFormat(MealAnalysisSchema) },
    // If a safety classifier declines, the API retries on a recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          ...images.map((image) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
          })),
          {
            type: "text",
            text: multiPhotoHint + (userNote ? `Note from the user: ${userNote}` : "Estimate the nutrition of this meal."),
          },
        ],
      },
    ],
  });

  const { input_tokens, output_tokens } = response.usage;
  console.log(
    `Claude ${response.model} (${config.claudeEffort}): ${images.length} photo(s), ` +
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
