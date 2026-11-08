/**
 * How a passed vote that waits the exit window tells people when it will run:
 *   "It will be done in 6 hours, at 11:06 UTC on 8 Nov 2026"
 * The duration is always the group's own exit window (the pot's guardDelay, read where the text is
 * built), never a fixed number. A vote that runs at once does not use this text (the card says "Done.").
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A length of time in plain words: "6 hours", "30 minutes", "1 day 2 hours", "2 days". Exact, never rounded. */
export function durationWords(seconds: number): string {
  let s = Math.max(0, Math.floor(seconds));
  if (s === 0) return "0 minutes";
  const parts: string[] = [];
  const days = Math.floor(s / 86400);
  s -= days * 86400;
  const hours = Math.floor(s / 3600);
  s -= hours * 3600;
  const minutes = Math.floor(s / 60);
  s -= minutes * 60;
  if (days) parts.push(unit(days, "day"));
  if (hours) parts.push(unit(hours, "hour"));
  if (minutes) parts.push(unit(minutes, "minute"));
  if (s) parts.push(unit(s, "second"));
  return parts.join(" ");
}

/** "14:05 UTC on 2 Nov 2026" (minutes cut, not rounded). */
export function utcText(unixSeconds: bigint | number): string {
  const d = new Date(Number(unixSeconds) * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * "It will be done in 6 hours, at 11:06 UTC on 8 Nov 2026" (no full stop).
 * The time is rounded up to the next whole minute, so it is never earlier than the vote can run.
 * @param exitWindowSec the group's exit window (pot guardDelay); null when it could not be read.
 * @param runsAtSec when the vote can run (on-chain eta); null when not known yet.
 */
export function waitText(exitWindowSec: number | null, runsAtSec: number | bigint | null): string {
  const at = runsAtSec === null ? null : utcText(Math.ceil(Number(runsAtSec) / 60) * 60);
  if (exitWindowSec === null && at === null) return "It will be done after the group's exit window";
  if (exitWindowSec === null) return `It will be done at ${at}`;
  if (at === null) return `It will be done in ${durationWords(exitWindowSec)}`;
  return `It will be done in ${durationWords(exitWindowSec)}, at ${at}`;
}

/** The line on a vote card once the vote has passed and waits the exit window. */
export function passedWaitingLine(exitWindowSec: number | null, runsAtSec: number | bigint | null): string {
  return `Passed. ${waitText(exitWindowSec, runsAtSec)}. Disagree? /exit takes your exact share any time.`;
}
