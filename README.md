# Telegram food tracking bot

Send a meal photo → Claude estimates the dish, calories and macros → the bot replies with a post like this:

- **Private chat with the bot:** every photo gets a reply right there.
- **Group with the bot in it:** send a photo with the caption `/food` (optionally `/food обід, 200 г рису`), or reply `/food` to a photo. The bot replies to the photo in the group.

```
#трекінг_їжі #сніданок

🍳 Сніданок · 06.10.2026, 08:15
🍴 Омлет з овочами та тост

🔥 Калорії: ~450 ккал
🥩 Білки: 25 г
🍞 Вуглеводи: 30 г
🧈 Жири: 22 г
🌾 Клітковина: 4 г

📋 Склад:
• Яйця — 3 шт (~150 г)
• Тост — 1 скибка (~30 г)

ℹ️ Оцінка ШІ, точність: середня. Врахована олія для смаження.
```

- Meal type comes from the time of day (before 11:00 breakfast, 11–15 lunch, 18–23 dinner, otherwise snack). You can override it with a word in the caption (`обід`) or with the buttons under the reply (only the person who asked can press them).
- Several photos sent together (an album) are analyzed as one meal. In groups this needs the bot to see all messages: make it a group admin.
- Caption text (`200 г рису, без олії`) is passed to Claude to improve the estimate and is shown in the post.
- Only user IDs in `ALLOWED_USER_IDS` can use the bot.

## Setup

Requires Node.js 24+.

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token.
2. Get an Anthropic API key at https://platform.claude.com/settings/keys.
3. `npm install`, then copy `.env.example` to `.env` and fill in `TELEGRAM_BOT_TOKEN` and `ANTHROPIC_API_KEY`.
4. `npm start`, open the bot in Telegram, and send any message. It replies with your user ID. Put it in `ALLOWED_USER_IDS`.
5. Restart with `npm start` and send a food photo. Optionally add the bot to a group (as admin, so albums work) and use `/food` there.

The bot uses long polling, so it only works while `npm start` is running. To keep it online all the time, run it on an always-on machine or a small VPS (for example with `pm2` or a systemd service).
