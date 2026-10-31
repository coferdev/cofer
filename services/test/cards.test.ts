import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DelayedError } from "bullmq";
import { GrammyError } from "grammy";
import { retryAfterMs, updateCard, type CardDeps } from "../src/notifier/notifier";
import { safeError } from "../src/core/errors";

const ID = "0x" + "ab".repeat(32);
const CHAT = -1001;
const tgError = (code: number, description: string, retry_after?: number) =>
  new GrammyError(`Call to 'editMessageText' failed! (${code}: ${description})`, { ok: false, error_code: code, description, parameters: retry_after ? { retry_after } : {} }, "editMessageText", {});

/** A stand-in database and Telegram. `locking` false skips the lock, to show the race it prevents. */
function world(opts: { locking?: boolean; editFails?: unknown } = {}) {
  let messageId: number | null = null;
  let nextId = 100;
  const posted: number[] = [];
  const edits: number[] = [];
  let chain = Promise.resolve();
  const d: CardDeps = {
    withLock: (_id, fn) => {
      if (opts.locking === false) return fn();
      const run = chain.then(fn);
      chain = run.then(
        () => {},
        () => {},
      );
      return run;
    },
    load: async () => ({ chatId: CHAT, messageId, text: "Vote: Buy TSLA", open: true }),
    send: async () => {
      await Bun.sleep(5); // Telegram takes a moment
      const id = nextId++;
      posted.push(id);
      return id;
    },
    edit: async (_c, mid) => {
      if (opts.editFails) throw opts.editFails;
      edits.push(mid);
    },
    saveMessageId: async (_id, mid) => {
      messageId = mid;
    },
  };
  return { d, posted, edits, messageId: () => messageId };
}

describe("one card per vote", () => {
  test("first update posts, the next ones edit that same card", async () => {
    const w = world();
    expect(await updateCard(ID, w.d)).toBe("posted");
    expect(await updateCard(ID, w.d)).toBe("edited");
    expect(await updateCard(ID, w.d)).toBe("edited");
    expect(w.posted).toEqual([100]);
    expect(w.edits).toEqual([100, 100]);
  });

  test("two updates at the same moment: still one card (with the lock)", async () => {
    const w = world();
    const r = await Promise.all([updateCard(ID, w.d), updateCard(ID, w.d)]);
    expect(r.sort()).toEqual(["edited", "posted"]);
    expect(w.posted).toEqual([100]);
  });

  test("the race the lock prevents: without it, two cards are posted", async () => {
    const w = world({ locking: false });
    await Promise.all([updateCard(ID, w.d), updateCard(ID, w.d)]);
    expect(w.posted.length).toBe(2);
  });

  test("a card deleted by an admin is posted again, and later edits go to the new one", async () => {
    const w = world();
    await updateCard(ID, w.d);
    w.d.edit = async () => Promise.reject(tgError(400, "Bad Request: message to edit not found"));
    expect(await updateCard(ID, w.d)).toBe("reposted");
    expect(w.posted).toEqual([100, 101]);
    expect(w.messageId()).toBe(101);
  });

  test("a card that can no longer be edited is posted again", async () => {
    const w = world();
    await updateCard(ID, w.d);
    w.d.edit = async () => Promise.reject(tgError(400, "Bad Request: message can't be edited"));
    expect(await updateCard(ID, w.d)).toBe("reposted");
  });

  test("nothing changed: no new card, no error", async () => {
    const w = world();
    await updateCard(ID, w.d);
    w.d.edit = async () => Promise.reject(tgError(400, "Bad Request: message is not modified: specified new message content is the same"));
    expect(await updateCard(ID, w.d)).toBe("unchanged");
    expect(w.posted).toEqual([100]);
  });

  test("any other error is not mistaken for a deleted card (no duplicate), it fails the job", async () => {
    const w = world();
    await updateCard(ID, w.d);
    w.d.edit = async () => Promise.reject(tgError(429, "Too Many Requests: retry after 7", 7));
    await expect(updateCard(ID, w.d)).rejects.toBeInstanceOf(GrammyError);
    expect(w.posted).toEqual([100]);
  });

  test("a vote that no longer exists: nothing sent", async () => {
    const w = world();
    w.d.load = async () => null;
    expect(await updateCard(ID, w.d)).toBe("gone");
    expect(w.posted).toEqual([]);
  });
});

describe("updates that change nothing send nothing (they merge without using the group's budget)", () => {
  test("same text and buttons as last shown: no call; a real change: one edit", async () => {
    const w = world();
    w.d.lastShown = new Map();
    await updateCard(ID, w.d); // posted
    expect(await updateCard(ID, w.d)).toBe("unchanged");
    expect(await updateCard(ID, w.d)).toBe("unchanged");
    expect(w.edits).toEqual([]);
    w.d.load = async () => ({ chatId: CHAT, messageId: w.messageId(), text: "Vote: Buy TSLA (2/3)", open: true });
    expect(await updateCard(ID, w.d)).toBe("edited");
    expect(w.edits).toEqual([100]);
  });

  test("the real notifier remembers what each card showed", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "notifier", "notifier.ts"), "utf8");
    expect(src).toContain("lastShown,");
    expect(src).toContain('if (c.messageId && d.lastShown?.get(proposalId) === shown) return "unchanged";');
  });
});

describe("Telegram's 'too many requests'", () => {
  test("the wait Telegram asks for, in ms; anything else is not a 429", () => {
    expect(retryAfterMs(tgError(429, "Too Many Requests: retry after 7", 7))).toBe(7000);
    expect(retryAfterMs(tgError(429, "Too Many Requests"))).toBe(5000); // no hint: 5 s
    expect(retryAfterMs(tgError(400, "Bad Request"))).toBeNull();
    expect(retryAfterMs(new Error("network"))).toBeNull();
  });

  test("the job waits it out instead of failing: moved to delayed, then BullMQ's DelayedError", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "notifier", "notifier.ts"), "utf8");
    expect(src).toMatch(/const wait = retryAfterMs\(e\);\s*if \(wait !== null && token\) \{\s*await job\.moveToDelayed\(Date\.now\(\) \+ wait, token\);\s*throw new DelayedError\(\);/);
  });

  test("BullMQ still recognises the delay after our safe-error wrapper (it checks the name)", () => {
    expect(safeError(new DelayedError()).name).toBe("DelayedError");
  });
});

describe("wiring", () => {
  test("the real lock is a Postgres lock per vote", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "notifier", "notifier.ts"), "utf8");
    expect(src).toContain("select pg_advisory_xact_lock(hashtextextended(${id}, 0))");
    expect(src).toContain("else await updateCard(job.data.proposalId, deps);");
  });
});
