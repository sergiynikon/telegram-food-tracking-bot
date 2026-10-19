import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MealAnalysis } from "../src/analyze.ts";
import { createBot, pickPhotoSize } from "../src/bot.ts";
import { formatMealPost, guessMealType, resolveMealTime } from "../src/format.ts";
import { macrosMatchCalories } from "../src/nutrition.ts";
import { PostStore } from "../src/posts.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ME = 111;
const PARTNER = 222;
const TRAINER = 333;

const BOT_USER = { id: 999, is_bot: true, first_name: "Food Tracking Bot", username: "sn_foodtrackingbot" };
const BOT_INFO: any = {
  id: 999,
  is_bot: true,
  first_name: "Food Tracking Bot",
  username: "sn_foodtrackingbot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
};

const MEAL: MealAnalysis = {
  is_food: true,
  dish_name: "Омлет & тост",
  items: [
    { name: "Яйця", portion: "3 шт (~150 г)" },
    { name: "Тост", portion: "1 скибка (~30 г)" },
  ],
  calories_kcal: 452,
  protein_g: 25.4,
  carbs_g: 30,
  fat_g: 22,
  fiber_g: 4,
  confidence: "medium",
  notes: "Врахована олія.",
  meal_type: null,
  eaten_at: null,
  eaten_days_ago: 0,
};

// 2026-10-06 08:15 in Kyiv (breakfast time).
const BREAKFAST_TIME = Date.UTC(2026, 9, 6, 5, 15) / 1000;
// 2026-10-06 16:05 in Kyiv.
const AFTERNOON_TIME = Date.UTC(2026, 9, 6, 13, 5) / 1000;

const user = (id: number) => ({ id, is_bot: false, first_name: `User${id}` });
const dmChat = (id: number) => ({ id, type: "private", first_name: `User${id}` });
const GROUP = { id: -500, type: "group", title: "Трекінг їжі" };

let nextMessageId = 1;

function photoMessage(opts: { from: number; chat: any; caption?: string; mediaGroupId?: string; date?: number }): any {
  const id = nextMessageId++;
  const message: any = {
    message_id: id,
    date: opts.date ?? BREAKFAST_TIME,
    chat: opts.chat,
    from: user(opts.from),
    photo: [
      { file_id: `small-${id}`, file_unique_id: `s${id}`, width: 90, height: 68 },
      { file_id: `photo-${id}`, file_unique_id: `m${id}`, width: 1280, height: 960 },
      { file_id: `huge-${id}`, file_unique_id: `h${id}`, width: 2560, height: 1920 },
    ],
  };
  if (opts.mediaGroupId) message.media_group_id = opts.mediaGroupId;
  if (opts.caption) {
    message.caption = opts.caption;
    if (opts.caption.startsWith("/")) {
      message.caption_entities = [{ type: "bot_command", offset: 0, length: opts.caption.split(" ")[0].length }];
    }
  }
  return message;
}

function textMessage(opts: { from: number; chat: any; text: string; replyTo?: any }): any {
  const message: any = { message_id: nextMessageId++, date: BREAKFAST_TIME, chat: opts.chat, from: user(opts.from), text: opts.text };
  if (opts.text.startsWith("/")) {
    message.entities = [{ type: "bot_command", offset: 0, length: opts.text.split(" ")[0].length }];
  }
  if (opts.replyTo) message.reply_to_message = opts.replyTo;
  return message;
}

function documentMessage(opts: { from: number; mimeType: string; size: number }): any {
  const id = nextMessageId++;
  return {
    message_id: id,
    date: BREAKFAST_TIME,
    chat: dmChat(opts.from),
    from: user(opts.from),
    document: { file_id: `doc-${id}`, file_unique_id: `d${id}`, mime_type: opts.mimeType, file_size: opts.size },
  };
}

type Revise = (previous: MealAnalysis, correction: string) => Promise<MealAnalysis>;

function setup(
  analyze?: (images: any[], note?: string) => Promise<MealAnalysis>,
  opts: { revise?: Revise; store?: PostStore } = {},
) {
  const calls: { method: string; payload: any }[] = [];
  const analyzeCalls: { images: any[]; note?: string; sentAt: Date }[] = [];
  const reviseCalls: { previous: MealAnalysis; correction: string; originalNote?: string; sentAt: Date }[] = [];
  const { bot, whenIdle } = createBot({
    token: "test-token",
    allowedUserIds: new Set([ME, PARTNER]),
    timezone: "Europe/Kyiv",
    botInfo: BOT_INFO,
    albumWaitMs: 30,
    store: opts.store,
    download: async (fileId) => `base64-of-${fileId}`,
    analyze: async (images, note, sentAt) => {
      analyzeCalls.push({ images, note, sentAt });
      return analyze ? analyze(images, note) : MEAL;
    },
    revise: async (previous, correction, originalNote, sentAt) => {
      reviseCalls.push({ previous, correction, originalNote, sentAt });
      return opts.revise ? opts.revise(previous, correction) : previous;
    },
  });

  let sentId = 5000;
  bot.api.config.use(async (_prev, method, payload: any) => {
    calls.push({ method, payload });
    const result =
      method === "sendMessage"
        ? { message_id: sentId++, date: BREAKFAST_TIME, chat: { id: payload.chat_id, type: "private" }, text: payload.text }
        : true;
    return { ok: true, result } as any;
  });

  let updateId = 1;
  const send = async (message: any) => {
    await bot.handleUpdate({ update_id: updateId++, message } as any);
  };
  const click = async (from: number, data: string, message: any) => {
    await bot.handleUpdate({
      update_id: updateId++,
      callback_query: { id: `cb${updateId}`, from: user(from), chat_instance: "ci", data, message },
    } as any);
  };
  const callsOf = (method: string) => calls.filter((c) => c.method === method).map((c) => c.payload);
  /** The bot's result post as a Telegram message (from its first edit), to reply to or click on. */
  const resultPost = () => {
    const edit = callsOf("editMessageText")[0];
    const chat = edit.chat_id < 0 ? GROUP : dmChat(edit.chat_id);
    return { message_id: edit.message_id, date: BREAKFAST_TIME, chat, from: BOT_USER, text: edit.text, reply_markup: edit.reply_markup };
  };
  /** Emoji reactions the bot set on a message, in order ("" = cleared). */
  const reactionsOn = (messageId: number) =>
    callsOf("setMessageReaction")
      .filter((r) => r.message_id === messageId)
      .map((r) => r.reaction[0]?.emoji ?? "");
  return { send, click, whenIdle, calls, callsOf, analyzeCalls, reviseCalls, resultPost, reactionsOn };
}

describe("pickPhotoSize", () => {
  test("picks Telegram's 1280px version, not 2560px", () => {
    const sizes: any[] = [
      { file_id: "a", width: 90, height: 68 },
      { file_id: "b", width: 1280, height: 960 },
      { file_id: "c", width: 2560, height: 1920 },
    ];
    assert.equal(pickPhotoSize(sizes).file_id, "b");
  });

  test("falls back to the smallest when every size is too big", () => {
    const sizes: any[] = [
      { file_id: "big", width: 2000, height: 1600 },
      { file_id: "bigger", width: 4000, height: 3000 },
    ];
    assert.equal(pickPhotoSize(sizes).file_id, "big");
  });
});

describe("guessMealType", () => {
  const at = (hourUtc: number) => new Date(Date.UTC(2026, 9, 6, hourUtc, 15));
  test("uses Kyiv time of day", () => {
    assert.equal(guessMealType(at(5), "Europe/Kyiv"), "breakfast"); // 08:15
    assert.equal(guessMealType(at(10), "Europe/Kyiv"), "lunch"); // 13:15
    assert.equal(guessMealType(at(13), "Europe/Kyiv"), "snack"); // 16:15
    assert.equal(guessMealType(at(17), "Europe/Kyiv"), "dinner"); // 20:15
    assert.equal(guessMealType(at(21), "Europe/Kyiv"), "snack"); // 00:15
  });

});

describe("resolveMealTime", () => {
  const TZ = "Europe/Kyiv";
  const sent = new Date(AFTERNOON_TIME * 1000); // 06.10 16:05 Kyiv
  const kyiv = (d: Date) =>
    new Intl.DateTimeFormat("uk-UA", { dateStyle: "short", timeStyle: "short", timeZone: TZ }).format(d);

  test("no stated time keeps the send time", () => {
    assert.equal(resolveMealTime(sent, null, 0, TZ), sent);
  });

  test("a stated time earlier the same day", () => {
    assert.equal(kyiv(resolveMealTime(sent, "13:00", 0, TZ)), "06.10.26, 13:00");
    assert.equal(kyiv(resolveMealTime(sent, "9:30", 0, TZ)), "06.10.26, 09:30");
  });

  test("a time well after sending means the previous day", () => {
    const afterMidnight = new Date(Date.UTC(2026, 9, 6, 21, 30)); // 07.10 00:30 Kyiv
    assert.equal(kyiv(resolveMealTime(afterMidnight, "23:00", 0, TZ)), "06.10.26, 23:00");
  });

  test("a time slightly after sending stays on the same day", () => {
    assert.equal(kyiv(resolveMealTime(sent, "16:30", 0, TZ)), "06.10.26, 16:30");
  });

  test("days ago, with or without a time", () => {
    assert.equal(kyiv(resolveMealTime(sent, "20:00", 1, TZ)), "05.10.26, 20:00");
    assert.equal(kyiv(resolveMealTime(sent, null, 2, TZ)), "04.10.26, 16:05");
  });

  test("across the switch from summer to winter time", () => {
    // Kyiv leaves summer time (UTC+3 → UTC+2) on 25.10.2026 at 04:00.
    const sentAfterSwitch = new Date(Date.UTC(2026, 9, 25, 8, 0)); // 25.10 10:00 UTC+2
    const yesterday22 = resolveMealTime(sentAfterSwitch, "22:00", 1, TZ);
    assert.equal(kyiv(yesterday22), "24.10.26, 22:00");
    assert.equal(yesterday22.toISOString(), "2026-10-24T19:00:00.000Z"); // still UTC+3 then
    // 02:30 that night is just before the switch, still UTC+3.
    assert.equal(resolveMealTime(sentAfterSwitch, "02:30", 0, TZ).toISOString(), "2026-10-24T23:30:00.000Z");
  });

  test("ignores nonsense times", () => {
    assert.equal(resolveMealTime(sent, "25:99", 0, TZ), sent);
    assert.equal(resolveMealTime(sent, "about noon", 0, TZ), sent);
  });
});

describe("formatMealPost", () => {
  const post = formatMealPost({ analysis: MEAL, mealType: "breakfast", date: new Date(BREAKFAST_TIME * 1000), timezone: "Europe/Kyiv" });

  test("has hashtags, time, macros and ingredients", () => {
    assert.match(post, /^#трекінг_їжі #сніданок/);
    assert.match(post, /06\.10\.2026, 08:15/);
    assert.match(post, /~452 ккал/);
    assert.match(post, /Білки: 25 г/);
    assert.match(post, /• Яйця — 3 шт \(~150 г\)/);
  });

  test("escapes HTML from the model", () => {
    assert.match(post, /Омлет &amp; тост/);
  });

  test("lists at most 8 ingredients", () => {
    const many = { ...MEAL, items: Array.from({ length: 11 }, (_, i) => ({ name: `Item${i}`, portion: "1" })) };
    const text = formatMealPost({ analysis: many, mealType: "lunch", date: new Date(), timezone: "Europe/Kyiv" });
    assert.match(text, /Item7/);
    assert.doesNotMatch(text, /Item8/);
    assert.match(text, /…ще 3/);
  });
});

describe("private chat", () => {
  test("a photo is analyzed and answered in the same chat", async () => {
    const t = setup();
    const photo = photoMessage({ from: ME, chat: dmChat(ME), caption: "200 г" });
    await t.send(photo);
    await t.whenIdle();

    assert.equal(t.analyzeCalls.length, 1);
    assert.deepEqual(t.analyzeCalls[0].images, [{ data: `base64-of-photo-${photo.message_id}`, mediaType: "image/jpeg" }]);
    assert.equal(t.analyzeCalls[0].note, "200 г");

    const [status] = t.callsOf("sendMessage");
    assert.equal(status.chat_id, ME);
    assert.equal(status.text, "⏳ Аналізую фото…");
    assert.equal(status.reply_parameters.message_id, photo.message_id);

    const [edit] = t.callsOf("editMessageText");
    assert.match(edit.text, /#трекінг_їжі #сніданок/);
    assert.doesNotMatch(edit.text, /200 г\n/, "the user's caption is not printed in the post");
    const buttons = edit.reply_markup.inline_keyboard.flat().map((b: any) => b.text);
    assert.deepEqual(buttons, ["✅ Сніданок", "Обід", "Перекус", "Вечеря"]);
  });

  test("someone not in ALLOWED_USER_IDS gets their ID and nothing is analyzed", async () => {
    const t = setup();
    await t.send(photoMessage({ from: TRAINER, chat: dmChat(TRAINER) }));
    await t.whenIdle();
    assert.equal(t.analyzeCalls.length, 0);
    assert.match(t.callsOf("sendMessage")[0].text, /Немає доступу.*333/s);
  });

  test("an album is analyzed once, as one meal", async () => {
    const t = setup(async () => ({ ...MEAL, meal_type: "lunch" }));
    await t.send(photoMessage({ from: ME, chat: dmChat(ME), mediaGroupId: "album1" }));
    await t.send(photoMessage({ from: ME, chat: dmChat(ME), mediaGroupId: "album1", caption: "обід" }));
    await t.send(photoMessage({ from: ME, chat: dmChat(ME), mediaGroupId: "album1" }));
    await t.whenIdle();

    assert.equal(t.analyzeCalls.length, 1);
    assert.equal(t.analyzeCalls[0].images.length, 3);
    assert.equal(t.analyzeCalls[0].note, "обід");
    assert.equal(t.callsOf("sendMessage")[0].text, "⏳ Аналізую 3 фото…");
    assert.match(t.callsOf("editMessageText")[0].text, /#обід/);
  });

  test("a PNG sent as a file is analyzed; oversized or non-image files are refused", async () => {
    const t = setup();
    await t.send(documentMessage({ from: ME, mimeType: "image/png", size: 2_000_000 }));
    await t.send(documentMessage({ from: ME, mimeType: "image/png", size: 8_000_000 }));
    await t.send(documentMessage({ from: ME, mimeType: "application/pdf", size: 1000 }));
    await t.whenIdle();

    assert.equal(t.analyzeCalls.length, 1);
    assert.equal(t.analyzeCalls[0].images[0].mediaType, "image/png");
    const refusals = t.callsOf("sendMessage").filter((m) => /не підходить/.test(m.text));
    assert.equal(refusals.length, 2);
  });

  test("a text description is analyzed without a photo", async () => {
    const t = setup();
    const text = textMessage({ from: ME, chat: dmChat(ME), text: "2 яйця, тост з маслом, кава з молоком" });
    await t.send(text);
    await t.whenIdle();

    assert.equal(t.analyzeCalls.length, 1);
    assert.deepEqual(t.analyzeCalls[0].images, []);
    assert.equal(t.analyzeCalls[0].note, "2 яйця, тост з маслом, кава з молоком");
    assert.equal(t.analyzeCalls[0].sentAt.getTime(), BREAKFAST_TIME * 1000);
    const [status] = t.callsOf("sendMessage");
    assert.equal(status.text, "⏳ Аналізую опис…");
    assert.equal(status.reply_parameters.message_id, text.message_id);
    assert.match(t.callsOf("editMessageText")[0].text, /#трекінг_їжі #сніданок/);
  });

  test("text that isn't about food asks for a description", async () => {
    const t = setup(async () => ({ ...MEAL, is_food: false }));
    await t.send(textMessage({ from: ME, chat: dmChat(ME), text: "привіт" }));
    await t.whenIdle();
    assert.match(t.callsOf("editMessageText")[0].text, /Не зрозумів, що ви їли/);
  });

  test("unknown commands get the help text, not an analysis", async () => {
    const t = setup();
    await t.send(textMessage({ from: ME, chat: dmChat(ME), text: "/whatever" }));
    await t.whenIdle();
    assert.equal(t.analyzeCalls.length, 0);
    assert.match(t.callsOf("sendMessage")[0].text, /опишіть, що з'їли/);
  });

  test("the caption sets when the meal was eaten and which meal it was", async () => {
    // Sent at 16:05 with "снідав о 13": Claude reports the time and meal from the note.
    const t = setup(async () => ({ ...MEAL, meal_type: "breakfast", eaten_at: "13:00" }));
    await t.send(photoMessage({ from: ME, chat: dmChat(ME), caption: "снідав о 13", date: AFTERNOON_TIME }));
    await t.whenIdle();

    const post = t.callsOf("editMessageText")[0].text;
    assert.match(post, /#трекінг_їжі #сніданок/);
    assert.match(post, /Сніданок<\/b> · 06\.10\.2026, 13:00/);
  });

  test("without a stated meal, the meal type follows the stated time", async () => {
    // Sent at 08:15 but "вчора о 20" -> yesterday 20:00 -> dinner.
    const t = setup(async () => ({ ...MEAL, eaten_at: "20:00", eaten_days_ago: 1 }));
    await t.send(photoMessage({ from: ME, chat: dmChat(ME), caption: "вчора о 20" }));
    await t.whenIdle();
    assert.match(t.callsOf("editMessageText")[0].text, /#вечеря[\s\S]*05\.10\.2026, 20:00/);
  });

  test("a photo without food says so", async () => {
    const t = setup(async () => ({ ...MEAL, is_food: false }));
    await t.send(photoMessage({ from: ME, chat: dmChat(ME) }));
    await t.whenIdle();
    assert.match(t.callsOf("editMessageText")[0].text, /Не бачу їжі/);
  });

  test("a failed analysis tells the user to retry", async () => {
    const t = setup(async () => {
      throw new Error("API down");
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      await t.send(photoMessage({ from: ME, chat: dmChat(ME) }));
      await t.whenIdle();
    } finally {
      console.error = originalError;
    }
    assert.match(t.callsOf("editMessageText")[0].text, /Не вдалося проаналізувати/);
  });
});

describe("group", () => {
  test("photos without /food are ignored", async () => {
    const t = setup();
    await t.send(photoMessage({ from: ME, chat: GROUP }));
    await t.send(photoMessage({ from: ME, chat: GROUP, caption: "смачно" }));
    await t.whenIdle();
    assert.equal(t.analyzeCalls.length, 0);
    assert.equal(t.calls.length, 0);
  });

  test("a photo captioned /food is analyzed and the reply goes to that photo", async () => {
    const t = setup(async () => ({ ...MEAL, meal_type: "lunch" }));
    const photo = photoMessage({ from: ME, chat: GROUP, caption: "/food обід, 200 г рису" });
    await t.send(photo);
    await t.whenIdle();

    assert.equal(t.analyzeCalls.length, 1);
    assert.equal(t.analyzeCalls[0].note, "обід, 200 г рису");
    const [status] = t.callsOf("sendMessage");
    assert.equal(status.chat_id, GROUP.id);
    assert.equal(status.reply_parameters.message_id, photo.message_id);
    assert.match(t.callsOf("editMessageText")[0].text, /#обід/);
  });

  test("/food@thisbot works, /food@otherbot is ignored", async () => {
    const t = setup();
    await t.send(photoMessage({ from: ME, chat: GROUP, caption: "/food@SN_FoodTrackingBot" }));
    await t.send(photoMessage({ from: ME, chat: GROUP, caption: "/food@other_bot" }));
    await t.whenIdle();
    assert.equal(t.analyzeCalls.length, 1);
  });

  test("/food as a reply to a photo analyzes that photo", async () => {
    const t = setup();
    const photo = photoMessage({ from: PARTNER, chat: GROUP, caption: "кола зеро" });
    await t.send(textMessage({ from: PARTNER, chat: GROUP, text: "/food", replyTo: photo }));
    await t.whenIdle();

    assert.equal(t.analyzeCalls.length, 1);
    assert.equal(t.analyzeCalls[0].images[0].data, `base64-of-photo-${photo.message_id}`);
    assert.equal(t.analyzeCalls[0].note, "кола зеро", "falls back to the photo's caption");
    assert.equal(t.callsOf("sendMessage")[0].reply_parameters.message_id, photo.message_id);
  });

  test("/food with a description analyzes the text and replies to the command", async () => {
    const t = setup();
    const command = textMessage({ from: ME, chat: GROUP, text: "/food 2 яйця і тост" });
    await t.send(command);
    await t.whenIdle();

    assert.equal(t.analyzeCalls.length, 1);
    assert.deepEqual(t.analyzeCalls[0].images, []);
    assert.equal(t.analyzeCalls[0].note, "2 яйця і тост");
    assert.equal(t.callsOf("sendMessage")[0].reply_parameters.message_id, command.message_id);
  });

  test("/food as a reply to a description analyzes it, adding anything after /food", async () => {
    const t = setup();
    const description = textMessage({ from: PARTNER, chat: GROUP, text: "салат цезар і кола" });
    await t.send(textMessage({ from: PARTNER, chat: GROUP, text: "/food вечеряла о 20", replyTo: description }));
    await t.whenIdle();

    assert.equal(t.analyzeCalls.length, 1);
    assert.deepEqual(t.analyzeCalls[0].images, []);
    assert.equal(t.analyzeCalls[0].note, "салат цезар і кола\nвечеряла о 20");
    assert.equal(t.callsOf("sendMessage")[0].reply_parameters.message_id, description.message_id);
  });

  test("plain text in a group is ignored", async () => {
    const t = setup();
    await t.send(textMessage({ from: ME, chat: GROUP, text: "2 яйця і тост" }));
    await t.whenIdle();
    assert.equal(t.analyzeCalls.length, 0);
    assert.equal(t.calls.length, 0);
  });

  test("/food without a photo or description explains how to use it", async () => {
    const t = setup();
    await t.send(textMessage({ from: ME, chat: GROUP, text: "/food" }));
    assert.match(t.callsOf("sendMessage")[0].text, /підписом \/food/);
    assert.equal(t.analyzeCalls.length, 0);
  });

  test("the trainer can't trigger an analysis", async () => {
    const t = setup();
    await t.send(photoMessage({ from: TRAINER, chat: GROUP, caption: "/food" }));
    const photo = photoMessage({ from: ME, chat: GROUP });
    await t.send(textMessage({ from: TRAINER, chat: GROUP, text: "/food", replyTo: photo }));
    await t.whenIdle();
    assert.equal(t.analyzeCalls.length, 0);
    assert.equal(t.callsOf("sendMessage").filter((m) => /Немає доступу/.test(m.text)).length, 2);
  });

  test("an album with /food on one photo is analyzed as one meal; an album without it is ignored", async () => {
    const t = setup();
    await t.send(photoMessage({ from: ME, chat: GROUP, mediaGroupId: "g1" }));
    await t.send(photoMessage({ from: ME, chat: GROUP, mediaGroupId: "g1", caption: "/food вечеря" }));
    await t.send(photoMessage({ from: ME, chat: GROUP, mediaGroupId: "g2" }));
    await t.send(photoMessage({ from: ME, chat: GROUP, mediaGroupId: "g2" }));
    await t.whenIdle();

    assert.equal(t.analyzeCalls.length, 1);
    assert.equal(t.analyzeCalls[0].images.length, 2);
    assert.equal(t.analyzeCalls[0].note, "вечеря");
  });
});

describe("meal type buttons", () => {
  async function analyzedPost() {
    const t = setup();
    await t.send(photoMessage({ from: ME, chat: GROUP, caption: "/food" }));
    await t.whenIdle();
    const edit = t.callsOf("editMessageText")[0];
    const callbackFor = (label: string) =>
      edit.reply_markup.inline_keyboard.flat().find((b: any) => b.text.endsWith(label)).callback_data;
    const botMessage = { message_id: edit.message_id, date: BREAKFAST_TIME, chat: GROUP, text: edit.text };
    return { t, callbackFor, botMessage };
  }

  test("the author can change the meal type", async () => {
    const { t, callbackFor, botMessage } = await analyzedPost();
    await t.click(ME, callbackFor("Вечеря"), botMessage);

    const edits = t.callsOf("editMessageText");
    assert.equal(edits.length, 2);
    assert.match(edits[1].text, /#трекінг_їжі #вечеря/);
    assert.ok(edits[1].reply_markup.inline_keyboard.flat().some((b: any) => b.text === "✅ Вечеря"));
  });

  test("other people can't change it", async () => {
    const { t, callbackFor, botMessage } = await analyzedPost();
    await t.click(PARTNER, callbackFor("Вечеря"), botMessage);

    assert.equal(t.callsOf("editMessageText").length, 1);
    assert.match(t.callsOf("answerCallbackQuery")[0].text, /лише автор/);
  });

  test("pressing the already selected type changes nothing", async () => {
    const { t, callbackFor, botMessage } = await analyzedPost();
    await t.click(ME, callbackFor("Сніданок"), botMessage);
    assert.equal(t.callsOf("editMessageText").length, 1);
  });
});

describe("macrosMatchCalories", () => {
  // Real answers from a live run on Wikimedia photos.
  test("accepts consistent estimates", () => {
    assert.ok(macrosMatchCalories({ calories_kcal: 550, protein_g: 25, carbs_g: 45, fat_g: 30 })); // Big Mac
    assert.ok(macrosMatchCalories({ calories_kcal: 110, protein_g: 1, carbs_g: 28, fat_g: 0 })); // banana
    assert.ok(macrosMatchCalories({ calories_kcal: 660, protein_g: 38, carbs_g: 34, fat_g: 40 })); // full English
    assert.ok(macrosMatchCalories({ calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 })); // cola zero
  });

  test("rejects a slipped digit", () => {
    // Same full English, but the model wrote 378 g of carbs instead of ~38.
    assert.equal(macrosMatchCalories({ calories_kcal: 660, protein_g: 38, carbs_g: 378, fat_g: 38 }), false);
  });
});

describe("corrections (replying to a result post)", () => {
  const WITH_AVOCADO: MealAnalysis = {
    ...MEAL,
    items: [...MEAL.items, { name: "Авокадо", portion: "½ шт (~70 г)" }],
    calories_kcal: 560,
    protein_g: 27,
    carbs_g: 36,
    fat_g: 32,
  };

  async function analyzedMeal(chat: any, opts: Parameters<typeof setup>[1] = {}) {
    const t = setup(undefined, opts);
    await t.send(photoMessage({ from: ME, chat, caption: chat.type === "private" ? "омлет" : "/food омлет" }));
    await t.whenIdle();
    return { t, post: t.resultPost() };
  }

  test("re-estimates the meal and edits the replied post in place", async () => {
    const { t, post } = await analyzedMeal(dmChat(ME), { revise: async () => WITH_AVOCADO });
    const reply = textMessage({ from: ME, chat: dmChat(ME), text: "додай ще половинку авокадо", replyTo: post });
    await t.send(reply);
    await t.whenIdle();

    assert.equal(t.analyzeCalls.length, 1, "no new meal is created");
    assert.equal(t.reviseCalls.length, 1);
    assert.deepEqual(t.reviseCalls[0].previous, MEAL);
    assert.equal(t.reviseCalls[0].correction, "додай ще половинку авокадо");
    assert.equal(t.reviseCalls[0].originalNote, "омлет");
    assert.equal(t.reviseCalls[0].sentAt.getTime(), BREAKFAST_TIME * 1000);

    const edits = t.callsOf("editMessageText");
    assert.equal(edits.length, 2);
    assert.equal(edits[1].message_id, post.message_id, "the same post is edited");
    assert.match(edits[1].text, /~560 ккал/);
    assert.match(edits[1].text, /Авокадо — ½ шт/);
    assert.doesNotMatch(edits[1].text, /додай/, "the correction itself isn't printed");
    assert.equal(t.callsOf("sendMessage").length, 1, "only the original status message, no chatter");
    assert.deepEqual(t.reactionsOn(reply.message_id), ["✍", "👌"]);
  });

  test("works in a group too, also as /food <correction>", async () => {
    const { t, post } = await analyzedMeal(GROUP, { revise: async () => WITH_AVOCADO });
    await t.send(textMessage({ from: ME, chat: GROUP, text: "/food додай авокадо", replyTo: post }));
    await t.whenIdle();
    assert.equal(t.reviseCalls[0]?.correction, "додай авокадо");
    assert.match(t.callsOf("editMessageText")[1].text, /~560 ккал/);
  });

  test("replies from anyone but the author are ignored (e.g. the trainer commenting)", async () => {
    const { t, post } = await analyzedMeal(GROUP, { revise: async () => WITH_AVOCADO });
    await t.send(textMessage({ from: TRAINER, chat: GROUP, text: "менше хліба!", replyTo: post }));
    await t.send(textMessage({ from: PARTNER, chat: GROUP, text: "додай авокадо", replyTo: post }));
    await t.whenIdle();
    assert.equal(t.reviseCalls.length, 0);
    assert.equal(t.callsOf("editMessageText").length, 1);
    assert.equal(t.callsOf("setMessageReaction").length, 0);
    assert.equal(t.callsOf("sendMessage").length, 1);
  });

  test("a reply that changes nothing gets 🤷 and no edit", async () => {
    const { t, post } = await analyzedMeal(dmChat(ME)); // revise returns the previous analysis
    const reply = textMessage({ from: ME, chat: dmChat(ME), text: "дякую", replyTo: post });
    await t.send(reply);
    await t.whenIdle();
    assert.equal(t.callsOf("editMessageText").length, 1);
    assert.deepEqual(t.reactionsOn(reply.message_id), ["✍", "🤷"]);
  });

  test("a correction can move the meal time; the meal type then follows the new time", async () => {
    // Sent at 08:15 (breakfast); the correction moves it to yesterday 13:30.
    const { t, post } = await analyzedMeal(dmChat(ME), {
      revise: async (prev) => ({ ...prev, eaten_at: "13:30", eaten_days_ago: 1 }),
    });
    await t.send(textMessage({ from: ME, chat: dmChat(ME), text: "це було вчора о пів на другу", replyTo: post }));
    await t.whenIdle();
    const edited = t.callsOf("editMessageText")[1].text;
    assert.match(edited, /#трекінг_їжі #обід/);
    assert.match(edited, /05\.10\.2026, 13:30/);
  });

  test("a meal type picked with the buttons survives a correction that doesn't mention it", async () => {
    const { t, post } = await analyzedMeal(dmChat(ME), { revise: async () => WITH_AVOCADO });
    const dinner = post.reply_markup.inline_keyboard.flat().find((b: any) => b.text.endsWith("Вечеря")).callback_data;
    await t.click(ME, dinner, post);
    await t.send(textMessage({ from: ME, chat: dmChat(ME), text: "додай авокадо", replyTo: post }));
    await t.whenIdle();
    assert.match(t.callsOf("editMessageText").at(-1).text, /#вечеря[\s\S]*~560 ккал/);
  });

  test("quick successive corrections build on each other", async () => {
    const { t, post } = await analyzedMeal(dmChat(ME), {
      // Slow enough that the second reply arrives while the first is still being estimated.
      revise: async (prev, correction) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { ...prev, calories_kcal: prev.calories_kcal + 100, notes: correction };
      },
    });
    await t.send(textMessage({ from: ME, chat: dmChat(ME), text: "+1", replyTo: post }));
    await t.send(textMessage({ from: ME, chat: dmChat(ME), text: "+2", replyTo: post }));
    await t.whenIdle();
    assert.equal(t.reviseCalls[1].previous.calories_kcal, 552, "the second correction sees the first one's result");
    assert.match(t.callsOf("editMessageText").at(-1).text, /~652 ккал/);
  });

  test("a failed correction says so and clears the ✍", async () => {
    const { t, post } = await analyzedMeal(dmChat(ME), {
      revise: async () => {
        throw new Error("API down");
      },
    });
    const reply = textMessage({ from: ME, chat: dmChat(ME), text: "додай авокадо", replyTo: post });
    const originalError = console.error;
    console.error = () => {};
    try {
      await t.send(reply);
      await t.whenIdle();
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(t.reactionsOn(reply.message_id), ["✍", ""]);
    assert.match(t.callsOf("sendMessage").at(-1).text, /Не вдалося перерахувати/);
  });

  test("answering the bot's 'describe the dish' message is a new description, not a correction", async () => {
    const t = setup(async (_images, note) => (note === "привіт" ? { ...MEAL, is_food: false } : MEAL));
    await t.send(textMessage({ from: ME, chat: dmChat(ME), text: "привіт" }));
    await t.whenIdle();
    const question = t.resultPost(); // "🤔 Не зрозумів, що ви їли…"
    await t.send(textMessage({ from: ME, chat: dmChat(ME), text: "2 яйця і тост", replyTo: question }));
    await t.whenIdle();
    assert.equal(t.analyzeCalls.length, 2);
    assert.equal(t.analyzeCalls[1].note, "2 яйця і тост");
    assert.equal(t.reviseCalls.length, 0);
  });

  test("a post the bot no longer remembers can't be corrected", async () => {
    const t = setup();
    const oldPost = { message_id: 42, date: BREAKFAST_TIME, chat: dmChat(ME), from: BOT_USER, text: "#трекінг_їжі #обід\n…" };
    await t.send(textMessage({ from: ME, chat: dmChat(ME), text: "додай авокадо", replyTo: oldPost }));
    await t.whenIdle();
    assert.equal(t.analyzeCalls.length, 0, "not mistaken for a new meal");
    assert.match(t.callsOf("sendMessage")[0].text, /уже не можна змінити/);
  });
});

describe("saved posts", () => {
  test("buttons and corrections keep working after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "food-bot-"));
    try {
      const file = join(dir, "posts.json");
      const before = setup(undefined, { store: new PostStore(file) });
      await before.send(photoMessage({ from: ME, chat: dmChat(ME), caption: "омлет" }));
      await before.whenIdle();
      const post = before.resultPost();

      // "Restart": a new bot reading the same file.
      const after = setup(undefined, {
        store: new PostStore(file),
        revise: async (prev) => ({ ...prev, calories_kcal: 600, protein_g: 30, carbs_g: 40, fat_g: 34 }),
      });
      const lunch = post.reply_markup.inline_keyboard.flat().find((b: any) => b.text.endsWith("Обід")).callback_data;
      await after.click(ME, lunch, post);
      await after.send(textMessage({ from: ME, chat: dmChat(ME), text: "більше сиру", replyTo: post }));
      await after.whenIdle();

      assert.equal(after.reviseCalls[0].originalNote, "омлет");
      assert.equal(after.reviseCalls[0].sentAt.getTime(), BREAKFAST_TIME * 1000, "dates survive the round trip");
      const edits = after.callsOf("editMessageText");
      assert.equal(edits.length, 2);
      assert.match(edits[1].text, /#обід[\s\S]*~600 ккал/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("/food <description> in private chat is analyzed, not answered with help", async () => {
  const t = setup();
  await t.send(textMessage({ from: ME, chat: dmChat(ME), text: "/food 2 яйця і тост" }));
  await t.whenIdle();
  assert.equal(t.analyzeCalls.length, 1);
  assert.equal(t.analyzeCalls[0].note, "2 яйця і тост");
});
