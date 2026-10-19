# Telegram food tracking bot

Send a meal photo → Claude estimates the dish, calories and macros → the bot replies with a post like this:

- **Private chat with the bot:** every photo or text description gets a reply right there.
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

- No photo? Describe the meal in text instead: any message in private chat, or `/food 2 яйця і тост` (or `/food` in reply to a description) in a group.
- The caption or description can say when and which meal it was: `снідав о 9`, `вчора ввечері`, `обідав годину тому`. Otherwise the time is when you sent it, and the meal type follows the time of day (before 11:00 breakfast, 11–15 lunch, 18–23 dinner, otherwise snack). The buttons under the reply change the meal type (only the person who asked can press them).
- Reply to a result post to correct it: `додай ще половинку авокадо`, `хліба не було`, `це був обід о 14`. The bot re-estimates the meal and edits that post (✍ while working, 👌 when done, 🤷 if nothing changed). Only the person who logged the meal can correct it; anyone else replying (e.g. the trainer) is ignored. Posts are saved to `$STATE_DIRECTORY/posts.json` (`./data` locally), so buttons and corrections keep working after restarts.
- Several photos sent together (an album) are analyzed as one meal. In groups this needs the bot to see all messages: make it a group admin.
- Caption text (`200 г рису, без олії`) is passed to Claude to improve the estimate (it isn't printed in the post).
- Only user IDs in `ALLOWED_USER_IDS` can use the bot.

## Setup

Requires Node.js 24+.

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token.
2. Get an Anthropic API key at https://platform.claude.com/settings/keys.
3. `npm install`, then copy `.env.example` to `.env` and fill in `TELEGRAM_BOT_TOKEN` and `ANTHROPIC_API_KEY`.
4. `npm start`, open the bot in Telegram, and send any message. It replies with your user ID. Put it in `ALLOWED_USER_IDS`.
5. Restart with `npm start` and send a food photo. Optionally add the bot to a group (as admin, so albums work) and use `/food` there.

`npm test` runs the bot against simulated Telegram updates (no Telegram or Claude calls). `npm run typecheck` checks types.

The bot uses long polling, so it only works while `npm start` is running. To keep it online all the time, run it on an always-on Linux machine:

## Deploying on a Linux server (Debian/Ubuntu)

As root, with Node.js 24+ and git installed:

```bash
useradd --system --home /opt/food-bot --shell /usr/sbin/nologin foodbot
git clone https://github.com/sergiynikon/telegram-food-tracking-bot.git /opt/food-bot
cd /opt/food-bot
cp .env.example .env && chmod 600 .env   # then fill it in
chown -R foodbot:foodbot /opt/food-bot
runuser -u foodbot -- env HOME=/opt/food-bot npm ci --omit=dev
install -m 644 deploy/*.service deploy/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now food-bot food-bot-update.timer
```

`food-bot-update.timer` checks GitHub every 5 minutes and, when `main` has new commits, pulls them, reinstalls dependencies if the lock file changed, and restarts the bot. Run `bash /opt/food-bot/deploy/update.sh` to update right away. Logs: `journalctl -u food-bot` and `journalctl -u food-bot-update`.
