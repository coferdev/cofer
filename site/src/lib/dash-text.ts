/**
 * Words for what the API returns: member labels, activity lines, periods and retry timing. Pure, so
 * it is tested without a browser (site/test/).
 */
import type { ActivityItem, Member } from './dash-api';
import { formatAmount } from './money';

export const POLL_MS = 20_000;

/** Wait before the next try after `failures` failed reads in a row: 5 s, 10 s, 20 s, 40 s, then 60 s. */
export function retryDelay(failures: number): number {
  if (failures <= 0) return POLL_MS;
  return Math.min(60_000, 5_000 * 2 ** Math.min(failures - 1, 4));
}

export const shortAddress = (a: string) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** "You", "@username" or a short address. */
export function memberLabel(address: string | null | undefined, members: Member[]): string {
  if (!address) return 'Unknown';
  const m = members.find((x) => x.address.toLowerCase() === address.toLowerCase());
  if (m?.you) return 'You';
  if (m?.username) return `@${m.username}`;
  return shortAddress(address);
}

/** One letter for an avatar. */
export function initial(m: Pick<Member, 'you' | 'username' | 'address'>): string {
  if (m.you) return 'Y';
  if (m.username) return m.username[0]!.toUpperCase();
  return m.address.slice(2, 3).toUpperCase();
}

export function periodText(seconds: number): string {
  if (!seconds) return 'no period';
  if (seconds === 86_400) return 'day';
  if (seconds === 604_800) return 'week';
  if (seconds === 2_592_000) return '30 days';
  if (seconds % 86_400 === 0) return `${seconds / 86_400} days`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hours`;
  return `${seconds} seconds`;
}

export function hoursText(seconds: number): string {
  if (seconds === 0) return 'no wait';
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  return `${Math.round(seconds / 60)} minutes`;
}

// Same wording as services/src/core/waitText.ts (the vote card and the signer page); keep the two in step.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A length of time in plain words: "6 hours", "30 minutes", "1 day 2 hours". Exact, never rounded. */
export function durationWords(seconds: number): string {
  let s = Math.max(0, Math.floor(seconds));
  if (s === 0) return '0 minutes';
  const days = Math.floor(s / 86400);
  s -= days * 86400;
  const hours = Math.floor(s / 3600);
  s -= hours * 3600;
  const minutes = Math.floor(s / 60);
  s -= minutes * 60;
  const parts: string[] = [];
  if (days) parts.push(unit(days, 'day'));
  if (hours) parts.push(unit(hours, 'hour'));
  if (minutes) parts.push(unit(minutes, 'minute'));
  if (s) parts.push(unit(s, 'second'));
  return parts.join(' ');
}

/**
 * "It will be done in 6 hours, at 11:06 UTC on 8 Nov 2026" for an approved vote waiting the exit
 * window. `exitWindowSec` is the group's own setting; the time is rounded up to the next minute.
 */
export function waitText(exitWindowSec: number, executeAfter: string): string {
  const d = new Date(Math.ceil(Date.parse(executeAfter) / 60_000) * 60_000);
  const at = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `It will be done in ${durationWords(exitWindowSec)}, at ${at}`;
}

type Assets = Record<string, { symbol: string; decimals: number }>;

function amountOf(raw: string | null | undefined, asset: string | null | undefined, assets: Assets): string {
  if (!asset) return '';
  const meta = Object.entries(assets).find(([a]) => a.toLowerCase() === asset.toLowerCase())?.[1];
  if (!meta) return '';
  return `${formatAmount(raw ?? null, meta.decimals, meta.decimals === 6 ? 2 : 6)} ${meta.symbol}`;
}

/** Title and detail for one activity line. */
export function describeActivity(e: ActivityItem, assets: Assets, members: Member[]): { title: string; detail: string } {
  const who = memberLabel(e.member, members);
  switch (e.type) {
    case 'created':
      return { title: 'Group account created', detail: 'On chain' };
    case 'deposit':
      return { title: 'Contribution added', detail: `${who} · ${amountOf(e.amount, e.asset, assets)}` };
    case 'exit':
      return { title: 'Member exited', detail: `${who} · took their share in kind` };
    case 'spend':
      return { title: 'Allowance spend', detail: `${who} · ${amountOf(e.amount, e.asset, assets)} to ${shortAddress(e.to ?? '')}` };
    case 'transfer':
      return { title: 'Payment sent', detail: `${amountOf(e.amount, e.asset, assets)} to ${shortAddress(e.to ?? '')}` };
    case 'swap':
      return { title: 'Swap', detail: `${amountOf(e.amountIn, e.assetIn, assets)} → ${amountOf(e.amountOut, e.assetOut, assets)}` };
    case 'member-added':
      return { title: 'Member added', detail: who };
    case 'member-removed':
      return { title: 'Member removed', detail: who };
    case 'executed':
      return { title: 'Proposal executed', detail: 'Approved by the group' };
    case 'queued':
      return { title: 'Proposal approved', detail: 'Waiting for the exit window' };
    case 'threshold':
      return { title: 'Vote threshold changed', detail: 'By group vote' };
    case 'config':
      return { title: 'Group settings changed', detail: 'By group vote' };
    case 'allowance':
      return { title: 'Allowance set', detail: `${who} · ${amountOf(e.amount, e.asset, assets)}` };
    case 'plan':
      return { title: 'Group plan paid', detail: `${e.months ?? '?'} month(s) · ${amountOf(e.amount, e.asset, assets)}` };
    case 'owed':
      return { title: 'Set aside after an exit', detail: `${who} · ${amountOf(e.amount, e.asset, assets)}, claimable later` };
    case 'claimed':
      return { title: 'Set-aside amount claimed', detail: `${who} · ${amountOf(e.amount, e.asset, assets)}` };
    default:
      return { title: 'Activity', detail: '' };
  }
}
