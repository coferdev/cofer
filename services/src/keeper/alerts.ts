/**
 * Staff alerts. Each problem has a key; an alert is sent once when the problem starts and once when
 * it clears ("🟢 CLEARED · <name>"), never on every keeper run. It always goes to the log,
 * and to the staff chat when OPS_CHAT_ID is set. Never to a group chat. Every message is built by
 * core/alertFormat.ts: a name, what happened, who acts, and no full addresses.
 *
 * With ALERT_BOT_TOKEN, alerts go straight from this process through that separate bot (so they
 * still arrive when the notifier or the main bot is down); without it, through the notifier.
 */
import { eq } from "drizzle-orm";
import { Api, GrammyError } from "grammy";
import { db, schema } from "../db/client";
import { env } from "../env";
import { logAlert, logError, redact } from "../core/errors";
import { enqueueChatMessage } from "../queues";
import { noMiniApp } from "../bot/noMiniApp";
import { addressBook, alertText, clearedText, nameFromText, scrubHex, type AddressBook, type AlertMessage, type Roles } from "../core/alertFormat";
import { factoryAbi, publicClient, relayerClient } from "../chain/clients";
import { explorerFor } from "../chain/addresses";
import { rpcTrouble } from "./serverHealth";

type ChatSend = (chat: number, text: string) => Promise<void>;

/**
 * Sends through the alerts bot. A failure becomes a fixed error holding only Telegram's own error
 * code and description (e.g. "403 Forbidden: bot can't initiate conversation with a user"), never
 * the request, its URL or the token, and with no cause attached.
 */
export function alertBotSender(token: string, fetchImpl?: typeof fetch): ChatSend {
  const api = new Api(token, fetchImpl ? { fetch: fetchImpl } : undefined);
  api.config.use(noMiniApp);
  return async (chat, text) => {
    try {
      await api.sendMessage(chat, text);
    } catch (e) {
      if (e instanceof GrammyError) throw new Error(`alerts bot: Telegram said ${e.error_code} ${redact(e.description).replaceAll(token, "<token>")}`);
      throw new Error("alerts bot: could not reach Telegram");
    }
  };
}

/**
 * Log always; then the staff chat, through the alerts bot if there is one, else the notifier queue.
 * `text` is a finished message from core/alertFormat.ts (URLs already removed, except its explorer link).
 */
export async function deliver(text: string, o: { chat?: number; botSend?: ChatSend; enqueue: ChatSend }): Promise<void> {
  logAlert(text);
  if (o.chat === undefined) return;
  await (o.botSend ?? o.enqueue)(o.chat, text);
}

const BOOK_TTL_MS = 10 * 60_000;
let _book: { at: number; book: AddressBook } | undefined;

/**
 * Role names for the addresses this service knows, plus every token symbol, refreshed every 10
 * minutes. A part that cannot be read (chain or database down) is left out: that address is then
 * shown shortened, never in full.
 */
async function liveBook(): Promise<AddressBook> {
  if (_book && Date.now() - _book.at < BOOK_TTL_MS) return _book.book;
  const e = env();
  const roles: Roles = { owner: e.EXPECTED_OWNER, guardian: e.EXPECTED_GUARDIAN, feeWallet: e.EXPECTED_FEE_WALLET, factory: e.FACTORY_ADDRESS, adapter: e.ADAPTER_ADDRESS };
  try {
    roles.relayer = relayerClient().account.address; // public address only
  } catch {
    /* left out */
  }
  try {
    roles.feeRouter = await publicClient().readContract({ address: e.FACTORY_ADDRESS as `0x${string}`, abi: factoryAbi, functionName: "feeRouter" });
  } catch {
    /* left out */
  }
  const tokens: Record<string, string> = { [e.USDG_ADDRESS]: "USDG" };
  try {
    for (const a of await db().select({ address: schema.assets.address, symbol: schema.assets.symbol }).from(schema.assets)) tokens[a.address] = a.symbol;
  } catch {
    /* left out */
  }
  _book = { at: Date.now(), book: addressBook(roles, tokens) };
  return _book.book;
}

let _botSend: ChatSend | undefined;
function botSend(): ChatSend | undefined {
  const token = env().ALERT_BOT_TOKEN;
  if (!token) return undefined;
  _botSend ??= alertBotSender(token);
  return _botSend;
}

export interface AlertDeps {
  /** Records the alert as open; false if it was already open. */
  open(key: string, text: string): Promise<boolean>;
  /** Removes an open alert and returns its text, or null if it was not open. */
  close(key: string): Promise<string | null>;
  /** Delivers one finished message (log, plus the staff chat if set). */
  send(text: string): Promise<void>;
  /** Builds the message; default: alertText with no address book (addresses shortened). */
  format?(m: AlertMessage): Promise<string> | string;
  /** True while the chain RPC is failing or just recovered (see keeper/serverHealth.ts); unset = never. */
  rpcTrouble?(): Promise<boolean>;
}

export function alertDeps(): AlertDeps {
  return {
    async open(key, text) {
      const rows = await db().insert(schema.alerts).values({ key, text }).onConflictDoNothing().returning({ key: schema.alerts.key });
      return rows.length > 0;
    },
    async close(key) {
      const rows = await db().delete(schema.alerts).where(eq(schema.alerts.key, key)).returning({ text: schema.alerts.text });
      return rows[0]?.text ?? null;
    },
    send: (text) => deliver(text, { chat: env().OPS_CHAT_ID, botSend: botSend(), enqueue: enqueueChatMessage }),
    format: async (m) => alertText(m, { book: await liveBook(), explorer: explorerFor(env().CHAIN_ID, env().EXPLORER_URL) }),
    rpcTrouble: () => rpcTrouble().catch(() => false), // Redis unreachable: never hold an alert back
  };
}

/** The finished message for `m`. */
export async function formatAlert(m: AlertMessage, deps: Pick<AlertDeps, "format"> = alertDeps()): Promise<string> {
  return deps.format ? deps.format(m) : alertText(m);
}

/** Posts a one-off message (no open/cleared tracking). Throws if it could not be delivered. */
export async function postAlert(m: AlertMessage, deps: AlertDeps = alertDeps()): Promise<void> {
  await deps.send(await formatAlert(m, deps));
}

/**
 * Opens an alert for an event the indexer handles once. Nothing if it is already open; if delivery
 * fails it is closed again and the error is thrown, so the indexer handles the event again.
 */
export async function openAlertOrThrow(key: string, m: AlertMessage, deps: AlertDeps = alertDeps()): Promise<void> {
  const text = await formatAlert(m, deps);
  if (!(await deps.open(key, text))) return;
  try {
    await deps.send(text);
  } catch (e) {
    await deps.close(key);
    throw e;
  }
}

/** The alert's name from its stored text; alerts stored before this format fall back to the key. */
function storedName(text: string, key: string): string {
  return nameFromText(text) ?? scrubHex(redact(key));
}

/**
 * Reports the current state of one problem: `problem` is its message while it holds, null when it
 * does not. Returns what was sent ("opened" / "cleared") or null when nothing changed. The first
 * message is kept unchanged while the problem lasts (one alert per problem).
 * `clearedNote` says why it cleared ("🟢 CLEARED · vote-stuck (it executed)").
 * If delivery fails, the change is undone (so the next run sends it again) and the failure is
 * logged; it never throws, so one failed message does not stop the checks after it.
 */
export async function checkAlert(key: string, problem: AlertMessage | null, deps: AlertDeps = alertDeps(), clearedNote?: string): Promise<"opened" | "cleared" | null> {
  if (problem !== null) {
    // during an RPC outage, rpc-down is the one alert; this one waits (an open one stays open)
    if (problem.rpcRelated && !problem.emergency && deps.rpcTrouble && (await deps.rpcTrouble())) {
      logAlert(`held back while the chain RPC is failing: ${problem.name}`);
      return null;
    }
    const text = await formatAlert(problem, deps);
    if (!(await deps.open(key, text))) return null;
    try {
      await deps.send(text);
    } catch (e) {
      logError("alerts", e);
      await deps.close(key);
      return null;
    }
    return "opened";
  }
  const was = await deps.close(key);
  if (was === null) return null;
  try {
    await deps.send(clearedText(storedName(was, key), clearedNote));
  } catch (e) {
    logError("alerts", e);
    await deps.open(key, was);
    return null;
  }
  return "cleared";
}
