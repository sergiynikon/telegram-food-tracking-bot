import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MealAnalysis } from "../src/analyze.ts";
import { createBot, pickPhotoSize } from "../src/bot.ts";
import { formatMealPost, guessMealType } from "../src/format.ts";

const ME = 111;
const PARTNER = 222;
const TRAINER = 333;

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
};

// 2026-10-06 08:15 in Kyiv (breakfast time).
const BREAKFAST_TIME = Date.UTC(2026, 9, 6, 5, 15) / 1000;

const user = (id: number) => ({ id, is_bot: false, first_name: `User${id}` });
const dmChat = (id: number) => ({ id, type: "private", first_name: `User${id}` });
const GROUP = { id: -500, type: "group", title: "Трекінг їжі" };

let nextMessageId = 1;

function photoMessage(opts: { from: number; chat: any; caption?: string; mediaGroupId?: string }): any {
  const id = nextMessageId++;
  const message: any = {
    message_id: id,
    date: BREAKFAST_TIME,
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

function setup(analyze?: (images: any[], note?: string) => Promise<MealAnalysis>) {
  const calls: { method: string; payload: any }[] = [];
  const analyzeCalls: { images: any[]; note?: string }[] = [];
  const { bot, whenIdle } = createBot({
    token: "test-token",
    allowedUserIds: new Set([ME, PARTNER]),
    timezone: "Europe/Kyiv",
    botInfo: BOT_INFO,
    albumWaitMs: 30,
    download: async (fileId) => `base64-of-${fileId}`,
    analyze: async (images, note) => {
      analyzeCalls.push({ images, note });
      return analyze ? analyze(images, note) : MEAL;
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
  return { send, click, whenIdle, calls, callsOf, analyzeCalls };
}

describe("pickPhotoSize", () => {
  test("picks the largest size Claude doesn't downscale", () => {
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

  test("a keyword in the caption wins over the time", () => {
    assert.equal(guessMealType(at(5), "Europe/Kyiv", "вечеря вчорашня"), "dinner");
    assert.equal(guessMealType(at(17), "Europe/Kyiv", "Обід, 200 г"), "lunch");
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
    const t = setup();
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

  test("text gets a hint instead of an analysis", async () => {
    const t = setup();
    await t.send(textMessage({ from: ME, chat: dmChat(ME), text: "привіт" }));
    assert.equal(t.callsOf("sendMessage")[0].text, "Надішліть фото їжі 📸");
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
    const t = setup();
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

  test("/food without a photo explains how to use it", async () => {
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
