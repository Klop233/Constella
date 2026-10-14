import webpush from "web-push";
import { newId, nowIso } from "./config.ts";
import { kvGet, kvSet, type Db } from "./db.ts";
import type { EventStore } from "./events.ts";

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/** Web Push to every subscribed device, Telegram as an optional fallback, plus an in-app inbox. */
export class Notifier {
  #db: Db;
  #events: EventStore;
  #telegram: () => TelegramConfig | null;
  #quiet: () => boolean;
  readonly publicKey: string;

  constructor(
    db: Db,
    events: EventStore,
    vapid: { publicKey: string; privateKey: string; subject: string },
    telegram: () => TelegramConfig | null,
    quiet: () => boolean = () => false,
  ) {
    this.#db = db;
    this.#events = events;
    this.#telegram = telegram;
    this.#quiet = quiet;
    let keys = vapid.publicKey && vapid.privateKey ? { publicKey: vapid.publicKey, privateKey: vapid.privateKey } : null;
    if (!keys) {
      const stored = kvGet(db, "vapid");
      keys = stored ? JSON.parse(stored) : webpush.generateVAPIDKeys();
      kvSet(db, "vapid", JSON.stringify(keys));
    }
    webpush.setVapidDetails(vapid.subject, keys!.publicKey, keys!.privateKey);
    this.publicKey = keys!.publicKey;
  }

  subscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, device: string): void {
    this.#db
      .prepare(
        "INSERT INTO push_subscriptions (endpoint, keys, device, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys, device = excluded.device",
      )
      .run(sub.endpoint, JSON.stringify(sub.keys), device, nowIso());
  }

  unsubscribe(endpoint: string): void {
    this.#db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  subscriptions(): { endpoint: string; device: string; created_at: string }[] {
    return this.#db.prepare("SELECT endpoint, device, created_at FROM push_subscriptions ORDER BY created_at").all() as any[];
  }

  /**
   * Fire-and-forget; returns per-channel delivery counts for callers that care (schedules, tests).
   * `push: false` only records it in the in-app inbox. In quiet hours pushes arrive silently and Telegram
   * stays out of it, unless the notification is urgent (reminders the user scheduled).
   */
  async send(title: string, body: string, url = "/", opts: { urgent?: boolean; push?: boolean } = {}): Promise<{ push: number; telegram: boolean }> {
    const id = newId("nt");
    this.#db.prepare("INSERT INTO notifications (id, title, body, url, created_at) VALUES (?, ?, ?, ?, ?)").run(id, title, body, url, nowIso());
    this.#events.publish("notification", { id, title, body, url });
    if (opts.push === false) return { push: 0, telegram: false };
    const quiet = !opts.urgent && this.#quiet();
    const payload = JSON.stringify({ id, title, body, url, ...(quiet ? { silent: true } : {}) });
    const subs = this.#db.prepare("SELECT endpoint, keys FROM push_subscriptions").all() as { endpoint: string; keys: string }[];
    let push = 0;
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, payload, {
            TTL: 3600,
            urgency: opts.urgent ? "high" : "normal",
          });
          push++;
        } catch (err: any) {
          if (err?.statusCode === 404 || err?.statusCode === 410) this.unsubscribe(s.endpoint);
          else console.error("web push failed", err?.statusCode ?? err);
        }
      }),
    );
    let telegram = false;
    const tg = this.#telegram();
    if (tg && (opts.urgent || (push === 0 && !quiet))) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: tg.chatId, text: `${title}\n${body}` }),
          signal: AbortSignal.timeout(15_000),
        });
        telegram = res.ok;
      } catch (err) {
        console.error("telegram failed", err);
      }
    }
    return { push, telegram };
  }

  inbox(limit = 50): unknown[] {
    return this.#db.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?").all(limit);
  }

  markRead(): void {
    this.#db.prepare("UPDATE notifications SET read = 1 WHERE read = 0").run();
  }
}
