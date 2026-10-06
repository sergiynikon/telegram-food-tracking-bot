import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Message, User } from "grammy/types";
import { analyzeMeal, type ImageMediaType, type MealAnalysis } from "./analyze.ts";
import { config } from "./config.ts";
import { formatMealPost, guessMealType, isMealType, MEAL_TYPES, type MealType } from "./format.ts";

// Private chat: every photo is analyzed and answered right there.
// Group: only photos captioned with /food, or a /food reply to a photo, are analyzed;
// the result is posted in the group as a reply to the photo.
const FOOD_COMMAND = "food";

interface MealPhoto {
  fileId: string;
  mediaType: ImageMediaType;
}

interface MealPost {
  analysis: MealAnalysis;
  mealType: MealType;
  date: Date;
  ownerId: number;
}

// Analyzed meals whose meal type can still be changed with the buttons.
// In memory: after a restart the buttons on older posts stop working.
const posts = new Map<string, MealPost>();
let nextPostId = 1;

// Photos sent together arrive as separate messages sharing a media_group_id.
// Collect them for a moment, then analyze them as one meal.
interface PendingAlbum {
  ctx: Context;
  firstMessage: Message;
  photos: MealPhoto[];
  userNote?: string;
  // Who asked for the analysis; undefined while no photo in a group album carried /food.
  requestedBy?: User;
  timer: NodeJS.Timeout;
}
const pendingAlbums = new Map<string, PendingAlbum>();
const ALBUM_WAIT_MS = 1500;

const SUPPORTED_IMAGE_TYPES: ImageMediaType[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const bot = new Bot(config.telegramToken);

function isAllowed(user: User | undefined): user is User {
  return user !== undefined && config.allowedUserIds.has(user.id);
}

function noAccessText(user: User): string {
  return `⛔️ Немає доступу. Ваш Telegram ID: <code>${user.id}</code>\nДодайте його в ALLOWED_USER_IDS у файлі .env і перезапустіть бота.`;
}

const dm = bot.chatType("private");
const groups = bot.chatType(["group", "supergroup"]);

dm.use(async (ctx, next) => {
  if (isAllowed(ctx.from)) return next();
  await ctx.reply(noAccessText(ctx.from), { parse_mode: "HTML" });
});

const HELP_PRIVATE = [
  "📸 Надішліть фото їжі — я оціню калорії та БЖВ і відповім тут.",
  "",
  "Кілька фото, надіслані разом (альбомом), рахуються як один прийом їжі.",
  "У підписі до фото можна уточнити: вагу, склад або тип прийому їжі (сніданок, обід, перекус, вечеря).",
  "",
  `У групі: надішліть фото з підписом /${FOOD_COMMAND} або відповідайте /${FOOD_COMMAND} на фото.`,
].join("\n");

const HELP_GROUP = [
  `📸 Надішліть фото їжі з підписом /${FOOD_COMMAND} (можна додати уточнення: /${FOOD_COMMAND} обід, 200 г рису)`,
  `або відповідайте /${FOOD_COMMAND} на вже надіслане фото.`,
].join("\n");

dm.command(["start", "help"], (ctx) => ctx.reply(HELP_PRIVATE));
groups.command(["start", "help"], (ctx) => ctx.reply(HELP_GROUP));

/** Photo or image file from a message; "unsupported" for other files. */
function extractPhoto(message: Message): MealPhoto | "unsupported" | undefined {
  if (message.photo) return { fileId: message.photo.at(-1)!.file_id, mediaType: "image/jpeg" };
  if (message.document) {
    const mediaType = SUPPORTED_IMAGE_TYPES.find((type) => type === message.document!.mime_type);
    return mediaType ? { fileId: message.document.file_id, mediaType } : "unsupported";
  }
  return undefined;
}

/** If the caption starts with /food (or /food@thisbot), returns the rest of it; otherwise undefined. */
function captionAfterFoodCommand(message: Message): string | undefined {
  const caption = message.caption ?? "";
  const first = message.caption_entities?.[0];
  if (first?.type !== "bot_command" || first.offset !== 0) return undefined;
  const [name, username] = caption.slice(1, first.length).split("@");
  if (name.toLowerCase() !== FOOD_COMMAND) return undefined;
  if (username && username.toLowerCase() !== bot.botInfo.username.toLowerCase()) return undefined;
  return caption.slice(first.length).trim();
}

bot.on(["message:photo", "message:document"], async (ctx) => {
  const message = ctx.message;
  const isPrivate = ctx.chat.type === "private";

  // In private chats every photo counts (access is already checked); in groups only /food ones.
  const commandRest = captionAfterFoodCommand(message);
  const requested = isPrivate || commandRest !== undefined;
  const userNote = (commandRest ?? (isPrivate ? message.caption?.trim() : undefined)) || undefined;

  if (requested && !isAllowed(ctx.from)) {
    await ctx.reply(noAccessText(ctx.from), { parse_mode: "HTML", reply_parameters: { message_id: message.message_id } });
    return;
  }

  const photo = extractPhoto(message);
  if (photo === "unsupported") {
    if (requested) await ctx.reply("Цей формат не підтримується. Надішліть, будь ласка, як звичайне фото (JPEG/PNG/WebP).");
    return;
  }
  if (!photo) return;

  const groupId = message.media_group_id;
  if (!groupId) {
    // Run in the background so a slow analysis doesn't block other updates.
    if (requested) void analyzeAndReply(ctx, message, [photo], ctx.from, userNote);
    return;
  }

  // In groups the bot only sees the other album photos if it can read all messages (admin or privacy mode off).
  const key = `${ctx.chat.id}:${groupId}`;
  const album = pendingAlbums.get(key);
  if (album) {
    album.photos.push(photo);
    album.userNote ??= userNote;
    if (requested) album.requestedBy ??= ctx.from;
    album.timer.refresh();
    return;
  }

  const timer = setTimeout(() => {
    const done = pendingAlbums.get(key)!;
    pendingAlbums.delete(key);
    if (done.requestedBy) void analyzeAndReply(done.ctx, done.firstMessage, done.photos, done.requestedBy, done.userNote);
  }, ALBUM_WAIT_MS);
  pendingAlbums.set(key, {
    ctx,
    firstMessage: message,
    photos: [photo],
    userNote,
    requestedBy: requested ? ctx.from : undefined,
    timer,
  });
});

// "/food" sent as a reply to a photo (or in private chat without a photo).
bot.command(FOOD_COMMAND, async (ctx) => {
  const target = ctx.message?.reply_to_message;
  const photo = target && extractPhoto(target);
  if (!target || !photo) {
    await ctx.reply(ctx.chat.type === "private" ? HELP_PRIVATE : HELP_GROUP);
    return;
  }
  if (!isAllowed(ctx.from)) {
    if (ctx.from) await ctx.reply(noAccessText(ctx.from), { parse_mode: "HTML" });
    return;
  }
  if (photo === "unsupported") {
    await ctx.reply("Цей формат не підтримується. Потрібне фото (JPEG/PNG/WebP).");
    return;
  }
  void analyzeAndReply(ctx, target, [photo], ctx.from, ctx.match.trim() || target.caption?.trim() || undefined);
});

dm.on("message:text", (ctx) => ctx.reply("Надішліть фото їжі 📸"));

async function downloadAsBase64(fileId: string): Promise<string> {
  const file = await bot.api.getFile(fileId);
  const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}

async function analyzeAndReply(
  ctx: Context,
  photoMessage: Message,
  photos: MealPhoto[],
  requestedBy: User,
  userNote?: string,
): Promise<void> {
  const what = photos.length > 1 ? `${photos.length} фото` : "фото";
  const status = await ctx.api.sendMessage(photoMessage.chat.id, `⏳ Аналізую ${what}…`, {
    reply_parameters: { message_id: photoMessage.message_id },
  });

  try {
    const images = await Promise.all(
      photos.map(async (photo) => ({ data: await downloadAsBase64(photo.fileId), mediaType: photo.mediaType })),
    );

    const analysis = await analyzeMeal(images, userNote);
    if (!analysis.is_food) {
      await ctx.api.editMessageText(status.chat.id, status.message_id, "🤔 Не бачу їжі на фото. Спробуйте інше фото.");
      return;
    }

    const date = new Date(photoMessage.date * 1000);
    const id = (nextPostId++).toString(36);
    const post: MealPost = {
      analysis,
      date,
      ownerId: requestedBy.id,
      mealType: guessMealType(date, config.timezone, userNote),
    };
    posts.set(id, post);

    await ctx.api.editMessageText(status.chat.id, status.message_id, renderPost(post), {
      parse_mode: "HTML",
      reply_markup: mealTypeKeyboard(id, post.mealType),
    });
  } catch (err) {
    console.error("Meal analysis failed:", err);
    await ctx.api
      .editMessageText(status.chat.id, status.message_id, "❌ Не вдалося проаналізувати фото. Спробуйте ще раз.")
      .catch(() => {});
  }
}

function renderPost(post: MealPost): string {
  return formatMealPost({ ...post, timezone: config.timezone });
}

function mealTypeKeyboard(id: string, selected: MealType): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [type, meal] of Object.entries(MEAL_TYPES)) {
    keyboard.text(`${type === selected ? "✅ " : ""}${meal.label}`, `meal:${id}:${type}`);
  }
  return keyboard;
}

bot.callbackQuery(/^meal:(\w+):(\w+)$/, async (ctx) => {
  const [, id, type] = ctx.match;
  const post = posts.get(id);
  if (!post || !isMealType(type)) return ctx.answerCallbackQuery("Цей пост уже не можна змінити.");
  if (ctx.from.id !== post.ownerId) return ctx.answerCallbackQuery("Змінити може лише автор фото.");
  if (post.mealType !== type) {
    post.mealType = type;
    await ctx.editMessageText(renderPost(post), { parse_mode: "HTML", reply_markup: mealTypeKeyboard(id, type) });
  }
  await ctx.answerCallbackQuery();
});

bot.catch((err) => console.error("Unhandled bot error:", err.error));

await bot.api.setMyCommands([{ command: "start", description: "Як користуватися ботом" }], {
  scope: { type: "all_private_chats" },
});
await bot.api.setMyCommands([{ command: FOOD_COMMAND, description: "Оцінити фото їжі (підпис до фото або відповідь на фото)" }], {
  scope: { type: "all_group_chats" },
});
console.log("Food tracking bot is running…");
await bot.start();
