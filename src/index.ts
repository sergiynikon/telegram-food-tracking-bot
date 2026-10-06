import { analyzeMeal } from "./analyze.ts";
import { createBot, FOOD_COMMAND } from "./bot.ts";
import { config } from "./config.ts";

const { bot, whenIdle } = createBot({
  token: config.telegramToken,
  allowedUserIds: config.allowedUserIds,
  timezone: config.timezone,
  analyze: analyzeMeal,
});

await bot.api.setMyCommands([{ command: "start", description: "Як користуватися ботом" }], {
  scope: { type: "all_private_chats" },
});
await bot.api.setMyCommands([{ command: FOOD_COMMAND, description: "Оцінити фото їжі (підпис до фото або відповідь на фото)" }], {
  scope: { type: "all_group_chats" },
});

// Stop polling cleanly on restart: confirms received updates so Telegram doesn't
// re-deliver (and re-bill) the last photos, and lets running analyses finish.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`${signal} received, finishing running analyses…`);
    void bot.stop();
  });
}

console.log("Food tracking bot is running…");
await bot.start();
await whenIdle();
console.log("Stopped.");
