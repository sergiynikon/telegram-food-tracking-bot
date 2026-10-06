import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

function parseEffort(value: string | undefined): (typeof EFFORTS)[number] {
  const effort = value?.trim() || "low";
  const match = EFFORTS.find((e) => e === effort);
  if (!match) throw new Error(`CLAUDE_EFFORT must be one of: ${EFFORTS.join(", ")}`);
  return match;
}

export const config = {
  telegramToken: required("TELEGRAM_BOT_TOKEN"),
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  claudeModel: process.env.CLAUDE_MODEL?.trim() || "claude-sonnet-5-5",
  claudeEffort: parseEffort(process.env.CLAUDE_EFFORT),
  // Only these Telegram user IDs may use the bot (each photo costs an API call).
  allowedUserIds: new Set(
    (process.env.ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map(Number),
  ),
  timezone: process.env.TIMEZONE?.trim() || "Europe/Kyiv",
};
