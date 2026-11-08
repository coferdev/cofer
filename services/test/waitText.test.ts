/**
 * "It will be done in <duration>, at <time> UTC on <date>": the wording every passed vote uses to say
 * when it will run (vote card, signer page, the group message for votes made outside the bot). The
 * duration is always the group's own exit window, read where the text is built.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { durationWords, passedWaitingLine, utcText, waitText } from "../src/core/waitText";
import { renderCard } from "../src/notifier/notifier";

const read = (...p: string[]) => readFileSync(join(import.meta.dir, "..", ...p), "utf8");
const ETA = Date.UTC(2026, 10, 8, 11, 6) / 1000; // 11:06 UTC on 8 Nov 2026
const card = { summary: "Send 100 USDG to @bob", approvals: 3, required: 5, delaySeconds: 21600, exitWindowSec: 21600 };

describe("duration in plain words", () => {
  test("hours, minutes, days and mixes", () => {
    expect(durationWords(21600)).toBe("6 hours");
    expect(durationWords(1800)).toBe("30 minutes");
    expect(durationWords(172800)).toBe("2 days");
    expect(durationWords(86400 + 7200)).toBe("1 day 2 hours");
    expect(durationWords(3600)).toBe("1 hour");
    expect(durationWords(60)).toBe("1 minute");
    expect(durationWords(5400)).toBe("1 hour 30 minutes");
    expect(durationWords(45)).toBe("45 seconds");
  });

  test("the time is UTC, rounded up to the next minute (never earlier than the vote can run)", () => {
    expect(utcText(ETA)).toBe("11:06 UTC on 8 Nov 2026");
    expect(waitText(21600, ETA)).toBe("It will be done in 6 hours, at 11:06 UTC on 8 Nov 2026");
    expect(waitText(21600, ETA + 1)).toBe("It will be done in 6 hours, at 11:07 UTC on 8 Nov 2026");
    expect(waitText(21600, BigInt(ETA))).toBe("It will be done in 6 hours, at 11:06 UTC on 8 Nov 2026");
  });
});

describe("vote card", () => {
  test("the owner's line, exactly", () => {
    expect(renderCard({ ...card, status: "queued", queuedEta: ETA }).split("\n")[2]).toBe(
      "Passed. It will be done in 6 hours, at 11:06 UTC on 8 Nov 2026. Disagree? /exit takes your exact share any time.",
    );
    expect(passedWaitingLine(21600, ETA)).toBe("Passed. It will be done in 6 hours, at 11:06 UTC on 8 Nov 2026. Disagree? /exit takes your exact share any time.");
  });

  test("30 minutes and 2 days", () => {
    expect(renderCard({ ...card, exitWindowSec: 1800, status: "queued", queuedEta: ETA })).toContain("Passed. It will be done in 30 minutes, at 11:06 UTC on 8 Nov 2026. Disagree?");
    expect(renderCard({ ...card, exitWindowSec: 172800, status: "queued", queuedEta: ETA })).toContain("Passed. It will be done in 2 days, at 11:06 UTC on 8 Nov 2026. Disagree?");
  });

  test("the duration is the group's own setting, not the tally's delay or a fixed number", () => {
    // a swap's tally delay is 0, but the pot still makes a non-unanimous swap wait its exit window
    expect(renderCard({ ...card, delaySeconds: 0, exitWindowSec: 5400, status: "queued", queuedEta: ETA })).toContain("It will be done in 1 hour 30 minutes, at");
    const notifier = read("src", "notifier", "notifier.ts");
    expect(notifier).toContain("exitWindowSec: s.exitWindowSec,");
    expect(notifier).not.toMatch(/Executes after|toUTCString/);
    // getSignable reads the pot's rules now (readRules -> config.guardDelay) and passes them on
    const proposals = read("src", "services", "proposals.ts");
    expect(proposals).toContain("exitWindowSec: rules.guardDelay,");
    expect(proposals).toContain("guardDelay: Number(config[0]),");
  });

  test("no time yet: the duration alone", () => {
    expect(renderCard({ ...card, status: "queued", queuedEta: null })).toContain("Passed. It will be done in 6 hours. Disagree?");
  });

  test("a vote that ran at once (unanimous) still says Done.", () => {
    expect(renderCard({ ...card, approvals: 5, delaySeconds: 0, status: "executed" })).toBe("Vote: Send 100 USDG to @bob\nApprovals: 5/5\nDone.");
  });
});

describe("signer page", () => {
  test("a passed vote that waits gets the same wording, with the group's window and the time it runs", () => {
    const client = read("src", "web", "client.ts");
    expect(client).toContain('say(r.ready ? (r.waitsUntil ? `Passed. ${waitText(r.exitWindowSec, r.waitsUntil)}.` : "Passed. Executing now.") : `Signed. ${r.approvals}/${r.required}.`);');
    expect(client).not.toContain("It executes after the exit window");
    // what the member reads, for 6 hours, 30 minutes and 2 days
    expect(`Passed. ${waitText(21600, ETA)}.`).toBe("Passed. It will be done in 6 hours, at 11:06 UTC on 8 Nov 2026.");
    expect(`Passed. ${waitText(1800, ETA)}.`).toBe("Passed. It will be done in 30 minutes, at 11:06 UTC on 8 Nov 2026.");
    expect(`Passed. ${waitText(172800, ETA)}.`).toBe("Passed. It will be done in 2 days, at 11:06 UTC on 8 Nov 2026.");
  });

  test("the API sends the pot's window and when it runs, only for a passed vote without every member", () => {
    const router = read("src", "api", "router.ts");
    expect(router).toContain("const waitsUntil = tl.ready && !tl.unanimous && tl.exitWindowSec > 0 ? Math.floor(Date.now() / 1000) + tl.exitWindowSec : null;");
    expect(read("src", "services", "proposals.ts")).toContain("return { ...t, exitWindowSec: rules.guardDelay };");
  });

  test('"You are signing" is shown exactly as before', () => {
    const client = read("src", "web", "client.ts");
    expect(client).toContain('$("body").textContent = `You are signing:\\n${v.summary}\\n\\nThe bot showed: ${pv.summary}\\n\\n${tally}`;');
    expect(client).toContain('$("body").textContent = `You are signing:\\n${pageSummary(shownExit, () => ({ symbol: "", decimals: 0 }))}`;');
  });
});

describe("no old wording left", () => {
  test("no source says 'Executes after' or 'exit window until'", () => {
    for (const f of [["src", "notifier", "notifier.ts"], ["src", "web", "client.ts"], ["src", "indexer", "unknownVotes.ts"], ["..", "site", "src", "cofer-store.tsx"]]) {
      expect(read(...f)).not.toMatch(/Executes after|exit window until|It executes after/);
    }
  });
});
