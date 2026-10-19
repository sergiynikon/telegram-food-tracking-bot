import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Message, PhotoSize, ReactionTypeEmoji, User, UserFromGetMe } from "grammy/types";
import type { ImageMediaType, MealAnalysis } from "./analyze.ts";
import { formatMealPost, guessMealType, isMealType, MEAL_TYPES, resolveMealTime, type MealType } from "./format.ts";
import { PostStore, type MealPost } from "./posts.ts";

// Private chat: every photo or text description is analyzed and answered right there.
// Group: only photos captioned with /food, "/food <description>", or a /food reply to a
// photo or description are analyzed; the result is posted in the group as a reply.
// Replying to a result post with a correction ("додай ще половинку авокадо") re-estimates
// the meal and edits that post.
export const FOOD_COMMAND = "food";

export interface BotOptions {
  token: string;
  allowedUserIds: Set<number>;
  timezone: string;
  /** `images` is empty when the user only described the meal in text. */
  analyze: (images: { data: string; mediaType: ImageMediaType }[], userNote: string | undefined, sentAt: Date) => Promise<MealAnalysis>;
  /** Re-estimates an analyzed meal with the user's correction. */
  revise: (previous: MealAnalysis, correction: string, originalNote: string | undefined, sentAt: Date) => Promise<MealAnalysis>;
  /** Where analyzed posts are kept; defaults to memory only. */
  store?: PostStore;
  /** Downloads a Telegram file as base64. Defaults to the Bot API file endpoint. */
  download?: (fileId: string) => Promise<string>;
  albumWaitMs?: number;
  /** Skips the getMe call on start (used by tests). */
  botInfo?: UserFromGetMe;
}

interface MealPhoto {
  fileId: string;
  mediaType: ImageMediaType;
}

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

const SUPPORTED_IMAGE_TYPES: ImageMediaType[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];
// Claude rejects images over 5 MB.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Telegram's 1280px version is plenty to recognize food; its 2560px version costs ~2.5x the
// image tokens on current models (measured on Sonnet 5.5: ~1.8k vs ~4.7k).
const MAX_IMAGE_EDGE = 1568;
// Every result post starts with this hashtag.
const POST_MARKER = "#трекінг_їжі";

/** The largest photo size within MAX_IMAGE_EDGE (or the smallest if all are bigger). */
export function pickPhotoSize(sizes: PhotoSize[]): PhotoSize {
  const bySize = [...sizes].sort((a, b) => a.width * a.height - b.width * b.height);
  const fitting = bySize.filter((s) => Math.max(s.width, s.height) <= MAX_IMAGE_EDGE);
  return fitting.at(-1) ?? bySize[0];
}

export function createBot(options: BotOptions) {
  const { allowedUserIds, timezone, analyze, revise, albumWaitMs = 1500, store = new PostStore() } = options;
  const bot = new Bot(options.token, { botInfo: options.botInfo });

  // Corrections to the same post run one after another, each on top of the previous one.
  const correctionQueues = new Map<string, Promise<void>>();
  const pendingAlbums = new Map<string, PendingAlbum>();
  // Analyses running in the background, so shutdown (and tests) can wait for them.
  const running = new Set<Promise<void>>();

  function inBackground(task: Promise<void>): void {
    running.add(task);
    void task.finally(() => running.delete(task));
  }

  /** Resolves once no album is being collected and no analysis is running. */
  async function whenIdle(): Promise<void> {
    while (pendingAlbums.size > 0 || running.size > 0) {
      if (running.size > 0) await Promise.allSettled(running);
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  const download =
    options.download ??
    (async (fileId: string) => {
      const file = await bot.api.getFile(fileId);
      const res = await fetch(`https://api.telegram.org/file/bot${options.token}/${file.file_path}`);
      if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer()).toString("base64");
    });

  function isAllowed(user: User | undefined): user is User {
    return user !== undefined && allowedUserIds.has(user.id);
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
    "📸 Надішліть фото їжі або просто опишіть, що з'їли, — я оціню калорії та БЖВ і відповім тут.",
    "",
    "Кілька фото, надіслані разом (альбомом), рахуються як один прийом їжі.",
    "У підписі до фото можна уточнити вагу, склад, коли ви їли й що це за прийом їжі: «снідав о 9, 200 г вівсянки».",
    "Щоб виправити оцінку, відповідайте на моє повідомлення: «додай ще половинку авокадо», «хліба не було».",
    "",
    `У групі: фото з підписом /${FOOD_COMMAND}, опис після команди (/${FOOD_COMMAND} 2 яйця і тост) або /${FOOD_COMMAND} у відповідь на фото чи опис.`,
  ].join("\n");

  const HELP_GROUP = [
    `📸 Надішліть фото їжі з підписом /${FOOD_COMMAND} (можна з уточненням: /${FOOD_COMMAND} обідав о 13, 200 г рису),`,
    `опишіть страву після команди (/${FOOD_COMMAND} 2 яйця і тост з маслом)`,
    `або відповідайте /${FOOD_COMMAND} на вже надіслане фото чи опис.`,
    "Щоб виправити оцінку, відповідайте на моє повідомлення: «додай ще половинку авокадо».",
  ].join("\n");

  const UNSUPPORTED_TEXT = "Цей файл не підходить. Надішліть, будь ласка, як звичайне фото (JPEG/PNG/WebP, до 5 МБ).";

  dm.command(["start", "help"], (ctx) => ctx.reply(HELP_PRIVATE));
  groups.command(["start", "help"], (ctx) => ctx.reply(HELP_GROUP));

  /** Photo or image file from a message; "unsupported" for other or too large files. */
  function extractPhoto(message: Message): MealPhoto | "unsupported" | undefined {
    if (message.photo) return { fileId: pickPhotoSize(message.photo).file_id, mediaType: "image/jpeg" };
    if (message.document) {
      const { mime_type, file_size = 0, file_id } = message.document;
      const mediaType = SUPPORTED_IMAGE_TYPES.find((type) => type === mime_type);
      return mediaType && file_size <= MAX_IMAGE_BYTES ? { fileId: file_id, mediaType } : "unsupported";
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
      if (requested) await ctx.reply(UNSUPPORTED_TEXT);
      return;
    }
    if (!photo) return;

    const groupId = message.media_group_id;
    if (!groupId) {
      // Run in the background so a slow analysis doesn't block other updates.
      if (requested) inBackground(analyzeAndReply(ctx, message, [photo], ctx.from, userNote));
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
      if (done.requestedBy) {
        inBackground(analyzeAndReply(done.ctx, done.firstMessage, done.photos, done.requestedBy, done.userNote));
      }
    }, albumWaitMs);
    pendingAlbums.set(key, {
      ctx,
      firstMessage: message,
      photos: [photo],
      userNote,
      requestedBy: requested ? ctx.from : undefined,
      timer,
    });
  });

  // A reply to one of the bot's result posts is a correction to that meal.
  bot.on("message:text", async (ctx, next) => {
    const message = ctx.message;
    const target = message.reply_to_message;
    if (!target || target.from?.id !== bot.botInfo.id || message.text.startsWith("/")) return next();

    const post = store.get(ctx.chat.id, target.message_id);
    if (!post) {
      if (!target.text?.startsWith(POST_MARKER)) return next(); // e.g. answering "describe the dish"
      if (isAllowed(ctx.from)) {
        await ctx.reply("Цей пост уже не можна змінити. Надішліть страву заново.", {
          reply_parameters: { message_id: message.message_id },
        });
      }
      return;
    }
    // Only the author corrects their meal; anyone else replying (e.g. the trainer) is just talking.
    if (ctx.from.id !== post.ownerId) return;
    queueCorrection(ctx, message, target.message_id, message.text.trim());
  });

  // "/food <description>", or "/food" as a reply to a photo or a description.
  bot.command(FOOD_COMMAND, async (ctx) => {
    const message = ctx.message!;
    const args = ctx.match.trim();
    const target = message.reply_to_message;
    // "/food <correction>" as a reply to a result post works like a plain reply.
    if (target && store.get(ctx.chat.id, target.message_id)?.ownerId === ctx.from?.id && args) {
      queueCorrection(ctx, message, target.message_id, args);
      return;
    }
    const photo = target && extractPhoto(target);
    const targetText = target?.text?.trim();
    if (!photo && !targetText && !args) {
      await ctx.reply(ctx.chat.type === "private" ? HELP_PRIVATE : HELP_GROUP);
      return;
    }
    if (!isAllowed(ctx.from)) {
      if (ctx.from) await ctx.reply(noAccessText(ctx.from), { parse_mode: "HTML" });
      return;
    }
    if (photo === "unsupported") {
      await ctx.reply(UNSUPPORTED_TEXT);
      return;
    }
    if (photo) {
      inBackground(analyzeAndReply(ctx, target!, [photo], ctx.from, args || target!.caption?.trim() || undefined));
    } else if (targetText) {
      // Description written earlier; anything after /food adds to it ("вечеряв о 20").
      inBackground(analyzeAndReply(ctx, target!, [], ctx.from, args ? `${targetText}\n${args}` : targetText));
    } else {
      inBackground(analyzeAndReply(ctx, message, [], ctx.from, args));
    }
  });

  // Registered here, after corrections and /food: `dm` filters at the point where it was created
  // (the top), so `dm.on(...)` would run before them and swallow replies and commands.
  bot.chatType("private").on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) {
      await ctx.reply(HELP_PRIVATE);
      return;
    }
    inBackground(analyzeAndReply(ctx, ctx.message, [], ctx.from, text));
  });

  /** Analyzes `photos` (or, if empty, the text `userNote`) and replies to `sourceMessage` with the result. */
  async function analyzeAndReply(
    ctx: Context,
    sourceMessage: Message,
    photos: MealPhoto[],
    requestedBy: User,
    userNote?: string,
  ): Promise<void> {
    const what = photos.length === 0 ? "опис" : photos.length > 1 ? `${photos.length} фото` : "фото";
    const status = await ctx.api.sendMessage(sourceMessage.chat.id, `⏳ Аналізую ${what}…`, {
      reply_parameters: { message_id: sourceMessage.message_id },
    });

    try {
      const images = await Promise.all(
        photos.map(async (photo) => ({ data: await download(photo.fileId), mediaType: photo.mediaType })),
      );

      const sentAt = new Date(sourceMessage.date * 1000);
      const analysis = await analyze(images, userNote, sentAt);
      if (!analysis.is_food) {
        const notFood =
          photos.length > 0
            ? "🤔 Не бачу їжі на фото. Спробуйте інше фото."
            : "🤔 Не зрозумів, що ви їли. Опишіть страву, наприклад: «2 яйця, тост з маслом, кава з молоком».";
        await ctx.api.editMessageText(status.chat.id, status.message_id, notFood);
        return;
      }

      // The note can say when the meal was eaten ("снідав о 9") and which meal it was.
      const date = resolveMealTime(sentAt, analysis.eaten_at, analysis.eaten_days_ago, timezone);
      const mealType = analysis.meal_type ?? guessMealType(date, timezone);
      const post: MealPost = { analysis, date, sentAt, mealType, ownerId: requestedBy.id, userNote };

      await ctx.api.editMessageText(status.chat.id, status.message_id, renderPost(post), {
        parse_mode: "HTML",
        reply_markup: mealTypeKeyboard(post.mealType),
      });
      store.set(status.chat.id, status.message_id, post);
    } catch (err) {
      console.error("Meal analysis failed:", err);
      await ctx.api
        .editMessageText(status.chat.id, status.message_id, "❌ Не вдалося проаналізувати фото. Спробуйте ще раз.")
        .catch(() => {});
    }
  }

  function renderPost(post: MealPost): string {
    return formatMealPost({ ...post, timezone });
  }

  function mealTypeKeyboard(selected: MealType): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    for (const [type, meal] of Object.entries(MEAL_TYPES)) {
      keyboard.text(`${type === selected ? "✅ " : ""}${meal.label}`, `meal:${type}`);
    }
    return keyboard;
  }

  // The post is found by the message the button is on. Also accepts the older "meal:<id>:<type>".
  bot.callbackQuery(/^meal:(?:\w+:)?(\w+)$/, async (ctx) => {
    const type = ctx.match[1];
    const message = ctx.callbackQuery.message;
    const post = message && store.get(message.chat.id, message.message_id);
    if (!message || !post || !isMealType(type)) return ctx.answerCallbackQuery("Цей пост уже не можна змінити.");
    if (ctx.from.id !== post.ownerId) return ctx.answerCallbackQuery("Змінити може лише автор фото.");
    if (post.mealType !== type) {
      const updated = { ...post, mealType: type };
      await ctx.editMessageText(renderPost(updated), { parse_mode: "HTML", reply_markup: mealTypeKeyboard(type) });
      store.set(message.chat.id, message.message_id, updated);
    }
    await ctx.answerCallbackQuery();
  });

  function react(message: Message, emoji?: ReactionTypeEmoji["emoji"]): Promise<unknown> {
    // Reactions can be turned off in a group; they're only a progress hint, so ignore failures.
    return bot.api
      .setMessageReaction(message.chat.id, message.message_id, emoji ? [{ type: "emoji", emoji }] : [])
      .catch(() => {});
  }

  function queueCorrection(ctx: Context, correction: Message, postMessageId: number, text: string): void {
    const key = `${correction.chat.id}:${postMessageId}`;
    const task = (correctionQueues.get(key) ?? Promise.resolve()).then(() =>
      reviseAndEdit(ctx, correction, postMessageId, text),
    );
    correctionQueues.set(key, task);
    inBackground(task.finally(() => correctionQueues.get(key) === task && correctionQueues.delete(key)));
  }

  /** Re-estimates the meal in post `postMessageId` with the user's correction and edits the post. */
  async function reviseAndEdit(ctx: Context, correction: Message, postMessageId: number, text: string): Promise<void> {
    const chatId = correction.chat.id;
    const post = store.get(chatId, postMessageId);
    if (!post) return;
    await react(correction, "✍");

    try {
      const revised = await revise(post.analysis, text, post.userNote, post.sentAt);
      const updated = applyRevision(post, revised);
      if (!revised.is_food || renderPost(updated) === renderPost(post)) {
        await react(correction, "🤷");
        return;
      }
      await ctx.api.editMessageText(chatId, postMessageId, renderPost(updated), {
        parse_mode: "HTML",
        reply_markup: mealTypeKeyboard(updated.mealType),
      });
      store.set(chatId, postMessageId, updated);
      await react(correction, "👌");
    } catch (err) {
      console.error("Meal correction failed:", err);
      await react(correction);
      await ctx.api
        .sendMessage(chatId, "❌ Не вдалося перерахувати. Спробуйте ще раз.", {
          reply_parameters: { message_id: correction.message_id },
        })
        .catch(() => {});
    }
  }

  /**
   * The post after a correction. Time and meal type only change if the correction changed them:
   * a meal type picked with the buttons survives "додай ще авокадо".
   */
  function applyRevision(post: MealPost, revised: MealAnalysis): MealPost {
    const previous = post.analysis;
    const timeChanged = revised.eaten_at !== previous.eaten_at || revised.eaten_days_ago !== previous.eaten_days_ago;
    const date = timeChanged ? resolveMealTime(post.sentAt, revised.eaten_at, revised.eaten_days_ago, timezone) : post.date;
    let mealType = post.mealType;
    if (revised.meal_type && revised.meal_type !== previous.meal_type) mealType = revised.meal_type;
    else if (timeChanged && !revised.meal_type) mealType = guessMealType(date, timezone);
    return { ...post, analysis: revised, date, mealType };
  }

  bot.catch((err) => console.error("Unhandled bot error:", err.error));

  return { bot, whenIdle };
}
