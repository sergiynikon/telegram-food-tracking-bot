import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MealAnalysis } from "./analyze.ts";
import type { MealType } from "./format.ts";

export interface MealPost {
  analysis: MealAnalysis;
  mealType: MealType;
  /** When the meal was eaten (shown in the post). */
  date: Date;
  /** When the user sent the meal; relative times in corrections are counted from it. */
  sentAt: Date;
  ownerId: number;
  userNote?: string;
}

// Older posts are forgotten: their buttons and corrections stop working.
const MAX_POSTS = 1000;

type StoredPost = Omit<MealPost, "date" | "sentAt"> & { date: string; sentAt: string };

/**
 * Analyzed meals, keyed by the bot message that shows them. Saved to `file` (if given)
 * so meal-type buttons and corrections keep working after a restart.
 */
export class PostStore {
  private readonly posts = new Map<string, MealPost>();
  private readonly file?: string;

  constructor(file?: string) {
    this.file = file;
    if (!file || !existsSync(file)) return;
    try {
      const stored: [string, StoredPost][] = JSON.parse(readFileSync(file, "utf8"));
      for (const [key, post] of stored) {
        this.posts.set(key, { ...post, date: new Date(post.date), sentAt: new Date(post.sentAt) });
      }
    } catch (err) {
      console.error(`Could not read ${file}, starting with no saved posts:`, err);
    }
  }

  get(chatId: number, messageId: number): MealPost | undefined {
    return this.posts.get(`${chatId}:${messageId}`);
  }

  set(chatId: number, messageId: number, post: MealPost): void {
    const key = `${chatId}:${messageId}`;
    this.posts.delete(key); // re-insert so the most recently changed posts are kept longest
    this.posts.set(key, post);
    if (this.posts.size > MAX_POSTS) this.posts.delete(this.posts.keys().next().value!);
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    const stored: [string, StoredPost][] = [...this.posts].map(([key, post]) => [
      key,
      { ...post, date: post.date.toISOString(), sentAt: post.sentAt.toISOString() },
    ]);
    // Write then rename, so a crash mid-write never leaves a half-written file.
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(stored));
    renameSync(tmp, this.file);
  }
}
