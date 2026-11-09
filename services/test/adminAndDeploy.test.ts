import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zeroAddress, type Abi, type Address, type Hex } from "viem";
import { adapterAlertKey, adminDecision, adminGroupText, HISTORY_AGE_SEC, onAdminEvent, ROUTER_FACTORY_ALERT, SINKS_ALERT, type AdminEvent, type AdminEventDeps } from "../src/indexer/adminEvents";
import { addressBook, alertText, type AlertMessage } from "../src/core/alertFormat";
import { roleProblem, ROLES_ALERT, type RoleState } from "../src/core/roles";
import { checkRoles } from "../src/keeper/keeper";
import { codeMatches, manifestProblems, maskImmutables, runDeployChecks, type Artifact, type ChainReader, type Manifest } from "../src/core/deployCheck";
import type { AlertDeps } from "../src/keeper/alerts";

const TX = `0x${"11".repeat(32)}` as Hex;
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const ETA = 1_793_628_300n; // 2 Nov 2026 14:05 UTC

// ================================================================ admin-change alerts

const SAFE_X = A(0x5afe);
const GUARD_X = A(0x9a);
const FEE_WALLET = A(0xfee);
const ADAPTER = A(0xad);
const FACTORY = A(0xf0);
const NOW = 1_793_600_000; // before ETA

function fakeAdminDeps(chats = [-1, -2]) {
  const posts: AlertMessage[] = [];
  const opened: [string, AlertMessage][] = [];
  const cleared: [string, string][] = [];
  const logs: string[] = [];
  const groups: [number, string][] = [];
  const deps: AdminEventDeps = {
    expected: { owner: SAFE_X, guardian: GUARD_X, feeWallet: FEE_WALLET, adapter: ADAPTER, factory: FACTORY },
    now: () => NOW,
    post: async (m) => void posts.push(m),
    openAlert: async (k, m) => void opened.push([k, m]),
    clearAlert: async (k, n) => void cleared.push([k, n]),
    log: (t) => void logs.push(t),
    groupChats: async () => chats,
    sendGroup: async (c, t) => void groups.push([c, t]),
    symbolOf: async (a) => (a === A(0x75) ? "TSLA" : null),
  };
  return { deps, posts, opened, cleared, logs, groups };
}
const ev = (name: string, args: Record<string, unknown>, source: AdminEvent["source"] = "factory"): AdminEvent => ({ source, name, args, txHash: TX });

describe("admin-change alerts", () => {
  test("a pause: one info line, says exits are not affected and who acts, with the transaction", async () => {
    const f = fakeAdminDeps();
    expect(await onAdminEvent(f.deps, ev("DepositsPaused", { paused: true }), true)).toBe("alerted");
    expect(f.posts).toEqual([{ name: "admin-change", what: "Deposits are paused in every pot. Exits are not affected.", who: "Tell the groups. If nobody planned this pause, tell the owner and the dev at once.", tx: TX }]);
    expect(f.groups).toHaveLength(0);
    const text = alertText(f.posts[0]!, { explorer: "https://robinhoodchain.blockscout.com" });
    expect(text).toStartWith("🟡 ALERT · admin-change\n");
    expect(text).toEndWith(`https://robinhoodchain.blockscout.com/tx/${TX}`);
  });

  test("listing and buyable flags are routine setup: logged, never posted", async () => {
    const f = fakeAdminDeps();
    expect(await onAdminEvent(f.deps, ev("AssetListed", { asset: A(0x75), feed: A(0xfe), maxStaleness: 345600, isStock: true }), true)).toBe("logged");
    expect(await onAdminEvent(f.deps, ev("AssetBuyable", { asset: A(0x75), buyable: true }), true)).toBe("logged");
    expect(f.posts).toHaveLength(0);
    expect(f.logs).toHaveLength(2);
  });

  test("a queued feed change: one info line, and every group is told with the symbol and when it can apply", async () => {
    const f = fakeAdminDeps();
    await onAdminEvent(f.deps, ev("FeedQueued", { asset: A(0x75), feed: A(0xfe), maxStaleness: 345600, eta: ETA }), true);
    expect(f.groups.map(([c]) => c)).toEqual([-1, -2]);
    expect(f.groups[0]![1]).toContain(`new price feed for TSLA (${A(0x75)})`);
    expect(f.groups[0]![1]).toContain("after 14:05 UTC on 2 Nov 2026");
    expect(f.groups[0]![1]).toContain("/exit");
    expect(f.posts[0]!.what).toBe("A new price feed for TSLA was queued (staleness limit 96h). It can apply after 14:05 UTC on 2 Nov 2026. The groups were told.");
  });

  test("queued adapter and swap fee changes reach the groups too; applied changes do not", async () => {
    expect(adminGroupText(ev("AdapterQueued", { adapter: A(9), eta: ETA }))).toContain("new swap adapter");
    expect(adminGroupText(ev("SwapFeeQueued", { bps: 40, eta: ETA }))).toContain("swap fee change to 0.4%");
    for (const name of ["FeedApplied", "AdapterSet", "SwapFeeSet", "DepositsPaused", "GuardianSet", "OwnershipTransferred"]) {
      expect(adminGroupText(ev(name, { paused: true, adapter: A(9), allowed: true, bps: 40, asset: A(1), feed: A(2), maxStaleness: 1, guardian: A(3), from: A(4), to: A(5) }))).toBeNull();
    }
  });

  test("expected roles and settings: info lines only", () => {
    const x = fakeAdminDeps().deps.expected;
    const level = (e: AdminEvent) => adminDecision(e, x)?.level;
    expect(level(ev("OwnershipTransferStarted", { from: A(1), to: SAFE_X }))).toBe("info");
    expect(level(ev("OwnershipTransferred", { from: A(1), to: SAFE_X }))).toBe("info");
    expect(level(ev("GuardianSet", { guardian: GUARD_X }))).toBe("info");
    expect(level(ev("AdapterQueued", { adapter: ADAPTER, eta: ETA }))).toBe("info");
    expect(level(ev("AdapterSet", { adapter: ADAPTER, allowed: true }))).toBe("info");
    expect(level(ev("SinksSet", { sinks: [FEE_WALLET, FEE_WALLET, FEE_WALLET, FEE_WALLET], bps: [8000, 1000, 500, 500] }, "feeRouter"))).toBe("info");
    expect(level(ev("FactorySet", { factory: FACTORY }, "feeRouter"))).toBe("log");
    expect(adminDecision(ev("PlanPriceSet", { pricePerMonth: 9_000_000n }, "feeRouter"), x)!.what).toContain("9 USDG a month");
  });

  test("a role moved to an unexpected address: role-changed, as an emergency", async () => {
    const f = fakeAdminDeps();
    await onAdminEvent(f.deps, ev("GuardianSet", { guardian: A(0xbad) }), true);
    await onAdminEvent(f.deps, ev("OwnershipTransferStarted", { from: SAFE_X, to: A(0xbad) }), true);
    await onAdminEvent(f.deps, ev("AdapterQueued", { adapter: A(0xbad), eta: ETA }), true);
    await onAdminEvent(f.deps, ev("SinksSet", { sinks: [FEE_WALLET, A(0xbad), FEE_WALLET, FEE_WALLET], bps: [8000, 1000, 500, 500] }, "feeRouter"), true);
    await onAdminEvent(f.deps, ev("FactorySet", { factory: A(0xbad) }, "feeRouter"), true);
    expect(f.opened.map(([k]) => k)).toEqual([ROLES_ALERT, ROLES_ALERT, adapterAlertKey(A(0xbad)), SINKS_ALERT, ROUTER_FACTORY_ALERT]);
    for (const [, m] of f.opened) expect(m).toMatchObject({ name: "role-changed", emergency: true, who: "Tell the owner and the dev at once.", tx: TX });
    expect(f.posts).toHaveLength(0);
    const text = alertText(f.opened[0]![1], { book: addressBook({ guardian: GUARD_X }) });
    expect(text).toStartWith("🔴 ALERT · role-changed\n\nWhat happened: The guardian was changed to 0x0000…0bad, which is not the expected guardian.");
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  test("putting the expected value back clears the emergency", async () => {
    const f = fakeAdminDeps();
    await onAdminEvent(f.deps, ev("AdapterSet", { adapter: A(0xbad), allowed: false }), true);
    await onAdminEvent(f.deps, ev("SinksSet", { sinks: [FEE_WALLET, FEE_WALLET, FEE_WALLET, FEE_WALLET], bps: [8000, 1000, 500, 500] }, "feeRouter"), true);
    expect(f.cleared).toEqual([
      [adapterAlertKey(A(0xbad)), "that adapter was removed"],
      [SINKS_ALERT, "the fee sinks are the fee wallet again"],
    ]);
  });

  test("without expected owner, guardian or fee wallet, those are not judged (info, not emergency)", () => {
    const x = { adapter: ADAPTER, factory: FACTORY };
    expect(adminDecision(ev("GuardianSet", { guardian: A(0xbad) }), x)!.level).toBe("info");
    expect(adminDecision(ev("SinksSet", { sinks: [A(1), A(1), A(1), A(1)], bps: [8000, 1000, 500, 500] }, "feeRouter"), x)!.level).toBe("info");
  });

  test("history (first start, or catching up on old blocks): logged, never posted", async () => {
    const f = fakeAdminDeps();
    expect(await onAdminEvent(f.deps, ev("GuardianSet", { guardian: A(0xbad) }), true, true)).toBe("logged");
    expect(await onAdminEvent(f.deps, ev("DepositsPaused", { paused: true }), true, true)).toBe("logged");
    expect(f.posts).toHaveLength(0);
    expect(f.opened).toHaveLength(0);
    expect(f.logs[0]).toStartWith("admin event (history): The guardian was changed to");
  });

  test("history: a queued change still ahead is told to the groups; one already past is not", async () => {
    const f = fakeAdminDeps();
    await onAdminEvent(f.deps, ev("SwapFeeQueued", { bps: 40, eta: BigInt(NOW + 3600) }), true, true);
    await onAdminEvent(f.deps, ev("SwapFeeQueued", { bps: 40, eta: BigInt(NOW - 3600) }), true, true);
    expect(f.groups).toHaveLength(2); // the first event, to both groups
    expect(f.posts).toHaveLength(0);
  });

  test("every admin event has a decision; non-admin events have none", () => {
    const x = fakeAdminDeps().deps.expected;
    const factoryAdmin = ["OwnershipTransferStarted", "OwnershipTransferred", "GuardianSet", "DepositsPaused", "CreationPaused", "AssetListed", "AssetBuyable", "FeedQueued", "FeedApplied", "AdapterQueued", "AdapterSet", "SwapFeeQueued", "SwapFeeSet"];
    const args = { from: A(1), to: A(2), guardian: A(3), paused: false, asset: A(4), feed: A(5), maxStaleness: 3600, isStock: true, buyable: true, eta: ETA, adapter: A(6), allowed: false, bps: 30 };
    for (const n of factoryAdmin) expect(adminDecision(ev(n, args), x)).not.toBeNull();
    expect(adminDecision(ev("PotCreated", {}), x)).toBeNull();
    expect(adminDecision(ev("PlanPaid", {}, "feeRouter"), x)).toBeNull();
    expect(adminDecision(ev("Distributed", {}, "feeRouter"), x)).toBeNull();
  });

  test("an event seen again (indexer re-run) sends nothing; a non-admin event sends nothing", async () => {
    const f = fakeAdminDeps();
    expect(await onAdminEvent(f.deps, ev("GuardianSet", { guardian: A(3) }), false)).toBe("skipped");
    expect(await onAdminEvent(f.deps, ev("PotCreated", {}), true)).toBe("skipped");
    expect(f.posts).toHaveLength(0);
    expect(f.opened).toHaveLength(0);
  });

  test("the indexer reads fee-router logs, treats a first run or an old block as history, and retries a failed send", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "indexer", "indexer.ts"), "utf8");
    expect(src).toContain("for (const log of routerLogs) await handleFeeRouterLog(log, firstRun);");
    expect(src.match(/await alertAdmin\(log, \{ source: "(factory|feeRouter)"/g)).toHaveLength(2);
    expect(src).toContain("const firstRun = !cur;");
    expect(src).toContain("> HISTORY_AGE_SEC");
    expect(src).toMatch(/async function alertAdmin[\s\S]*?catch \(e\) \{\s*await unrecord\(log\);\s*throw e;/);
    expect(HISTORY_AGE_SEC).toBe(600);
  });
});

// ================================================================ role drift (keeper)

const SAFE = A(0x5afe);
const GUARD = A(0x9a);
const good: RoleState = { factoryOwner: SAFE, factoryPendingOwner: zeroAddress, guardian: GUARD, routerOwner: SAFE, routerPendingOwner: zeroAddress };

describe("role drift check", () => {
  test("roles as expected: no problem", () => {
    expect(roleProblem(good, { owner: SAFE, guardian: GUARD })).toBeNull();
    expect(roleProblem({ ...good, factoryOwner: SAFE.toUpperCase().replace("0X", "0x") }, { owner: SAFE })).toBeNull();
  });

  test("each kind of drift is named, including the fee router (which emits no ownership events)", () => {
    const p = roleProblem({ ...good, routerOwner: A(0xbad), guardian: A(0xbad2), routerPendingOwner: A(0xbad3) }, { owner: SAFE, guardian: GUARD })!;
    expect(p).toContain("fee router owner is");
    expect(p).toContain("guardian is");
    expect(p).toContain("fee router ownership transfer");
    expect(p).toContain("docs/runbook.md");
  });

  test("without expected values, a pending ownership transfer still alerts", () => {
    expect(roleProblem(good, {})).toBeNull();
    expect(roleProblem({ ...good, factoryPendingOwner: A(1) }, {})).toContain("factory ownership transfer");
  });

  test("a transfer pending to the owner Safe is the planned hand-off, not a problem", () => {
    expect(roleProblem({ ...good, factoryOwner: A(0xde), routerOwner: SAFE, factoryPendingOwner: SAFE }, { owner: SAFE })).toBe(
      `Roles changed: factory owner is ${A(0xde)}, expected ${SAFE}. Check the owner Safe; see docs/runbook.md.`,
    );
    expect(roleProblem({ ...good, routerPendingOwner: SAFE }, { owner: SAFE })).toBeNull();
  });

  test("the keeper opens the alert on drift, clears it when fixed, and a failed read changes nothing", async () => {
    const open = new Map<string, string>();
    const sent: string[] = [];
    const alerts: AlertDeps = {
      open: async (k, t) => (open.has(k) ? false : (open.set(k, t), true)),
      close: async (k) => {
        const t = open.get(k) ?? null;
        open.delete(k);
        return t;
      },
      send: async (t) => void sent.push(t),
    };
    let state: RoleState = { ...good, guardian: A(0xbad) };
    const deps = { read: async () => state, expected: { owner: SAFE, guardian: GUARD }, alerts };
    expect(await checkRoles(deps)).toBe(false);
    expect(open.has(ROLES_ALERT)).toBe(true);
    state = good;
    expect(await checkRoles(deps)).toBe(true);
    expect(open.has(ROLES_ALERT)).toBe(false);
    expect(sent).toHaveLength(2); // opened once, cleared once
    expect(await checkRoles({ ...deps, read: async () => Promise.reject(new Error("rpc down")) })).toBeNull();
    expect(sent).toHaveLength(2);
  });
});

// ================================================================ post-deploy check

const C = { factory: A(0xf0), feeRouter: A(0xfe), implementation: A(0x1b), adapter: A(0xad) };
const USDG = A(0x05d6);
const ROUTER02 = A(0x0002);
const STOCK = A(0x75);
const FEED = A(0xfeed);

function manifest(): Manifest {
  return {
    chainId: 4663,
    contracts: { ...C },
    expected: {
      owner: SAFE,
      safe: { threshold: 2, owners: 3 },
      guardian: GUARD,
      sinks: [GUARD, GUARD, GUARD, GUARD],
      sinkBps: [8000, 1000, 500, 500],
      usdg: USDG,
      swapRouter: ROUTER02,
      swapFeeBps: 30,
      planPricePerMonth: "9000000",
      depositsPaused: false,
      creationPaused: false,
      assets: [{ address: STOCK, feed: FEED, maxStaleness: 345600, buyable: true, isStock: true }],
    },
  };
}

// a contract whose bytes 2..3 hold an immutable
const art = (body: string): Artifact => ({ object: `0x${body}` as Hex, immutableReferences: { "7": [{ start: 2, length: 2 }] } });
const ARTS = { implementation: art("60010000ff"), factory: art("60020000ee"), feeRouter: art("60030000dd"), adapter: art("60040000cc") };
const LIVE: Record<string, Hex> = { [C.implementation]: "0x6001abcdff", [C.factory]: "0x60021234ee", [C.feeRouter]: "0x60039999dd", [C.adapter]: "0x60047777cc" };

function chain(over: Record<string, unknown> = {}, code: Record<string, Hex> = LIVE, initRevert: string | null = "AlreadyInitialized"): ChainReader {
  const v: Record<string, unknown> = {
    [`${C.factory}.implementation`]: C.implementation,
    [`${C.factory}.usdg`]: USDG,
    [`${C.factory}.feeRouter`]: C.feeRouter,
    [`${C.feeRouter}.factory`]: C.factory,
    [`${C.feeRouter}.usdg`]: USDG,
    [`${C.adapter}.router`]: ROUTER02,
    [`${C.factory}.owner`]: SAFE,
    [`${C.factory}.pendingOwner`]: zeroAddress,
    [`${C.factory}.guardian`]: GUARD,
    [`${C.feeRouter}.owner`]: SAFE,
    [`${C.feeRouter}.pendingOwner`]: zeroAddress,
    [`${SAFE}.getThreshold`]: 2n,
    [`${SAFE}.getOwners`]: [A(1), A(2), A(3)],
    [`${C.feeRouter}.sinks`]: GUARD,
    [`${C.feeRouter}.bps.0`]: 8000,
    [`${C.feeRouter}.bps.1`]: 1000,
    [`${C.feeRouter}.bps.2`]: 500,
    [`${C.feeRouter}.bps.3`]: 500,
    [`${C.factory}.swapFeeBps`]: 30,
    [`${C.factory}.pendingSwapFeeEta`]: 0n,
    [`${C.feeRouter}.planPricePerMonth`]: 9_000_000n,
    [`${C.factory}.depositsPaused`]: false,
    [`${C.factory}.creationPaused`]: false,
    [`${C.factory}.isAdapter`]: true,
    [`${C.factory}.assetInfo`]: { listed: true, buyable: true, isStock: true, maxStaleness: 345600, feed: FEED },
    ...over,
  };
  return {
    chainId: async () => 4663,
    code: async (a) => code[a],
    read: async (a: Address, _abi: Abi, fn: string, args?: readonly unknown[]) => {
      const indexed = `${a}.${fn}.${args?.[0]}`;
      const key = indexed in v ? indexed : `${a}.${fn}`;
      if (!(key in v)) throw new Error(`no fake value for ${key} at https://rpc.example/KEY123`);
      return v[key];
    },
    revertName: async () => initRevert,
  };
}

const failures = (r: { ok: boolean; name: string }[]) => r.filter((x) => !x.ok).map((x) => x.name);

describe("post-deploy check", () => {
  test("masking ignores immutables but nothing else", () => {
    expect(maskImmutables("0x6001abcdff", { "7": [{ start: 2, length: 2 }] })).toBe("60010000ff");
    expect(codeMatches("0x6001abcdff", ARTS.implementation)).toBe(true);
    expect(codeMatches("0x6001abcdfe", ARTS.implementation)).toBe(false); // a changed byte outside the immutable
    expect(codeMatches("0x6001abcdff00", ARTS.implementation)).toBe(false); // different length
    expect(codeMatches(undefined, ARTS.implementation)).toBe(false); // nothing deployed
    expect(codeMatches("0x", ARTS.implementation)).toBe(false);
  });

  test("everything as expected: every check passes", async () => {
    const r = await runDeployChecks(chain(), manifest(), ARTS);
    expect(failures(r)).toEqual([]);
    expect(r.length).toBeGreaterThan(25);
  });

  test("a swap-fee change already queued fails by name and says what is queued", async () => {
    const r = await runDeployChecks(chain({ [`${C.factory}.pendingSwapFeeEta`]: 1_800_172_800n, [`${C.factory}.pendingSwapFeeBps`]: 100 }), manifest(), ARTS);
    expect(failures(r)).toEqual(["factory: no swap-fee change pending"]);
    expect(r.find((x) => x.name === "factory: no swap-fee change pending")!.detail).toBe(
      "a change to 100 bps is queued, applicable from 2027-01-17T08:00:00.000Z (expected none)",
    );
    const ok = await runDeployChecks(chain(), manifest(), ARTS);
    expect(ok.find((x) => x.name === "factory: no swap-fee change pending")).toEqual({ name: "factory: no swap-fee change pending", ok: true, detail: "pendingSwapFeeEta is 0" });
  });

  test("wrong code, a pending owner, a 1-of-3 Safe, a changed sink, an unlocked implementation, a wrong feed: each fails by name", async () => {
    const r = await runDeployChecks(
      chain(
        { [`${C.factory}.pendingOwner`]: A(0xbad), [`${SAFE}.getThreshold`]: 1n, [`${C.feeRouter}.bps.3`]: 499, [`${C.factory}.assetInfo`]: { listed: true, buyable: true, isStock: true, maxStaleness: 345600, feed: A(0xbad) } },
        { ...LIVE, [C.factory]: "0x60021234ef" },
        null,
      ),
      manifest(),
      ARTS,
    );
    expect(failures(r).sort()).toEqual(
      ["code: factory matches the local build", "factory.pendingOwner is empty", "Safe threshold", "feeRouter.bps[3]", "implementation refuses initialize (locked)", `asset ${STOCK}`].sort(),
    );
  });

  test("a failed read is a FAIL line that never shows the RPC address", async () => {
    const r = await runDeployChecks(chain({ [`${C.factory}.owner`]: undefined }), manifest(), ARTS);
    const reader = chain();
    const broken: ChainReader = { ...reader, read: (a, abi, fn, args) => (fn === "owner" ? Promise.reject(new Error("HTTP request failed at https://rpc.example/SECRETKEY")) : reader.read(a, abi, fn, args)) };
    const r2 = await runDeployChecks(broken, manifest(), ARTS);
    const line = r2.find((x) => x.name === "factory.owner is the Safe")!;
    expect(line.ok).toBe(false);
    expect(line.detail).not.toContain("SECRETKEY");
    expect(line.detail).toContain("<url>");
    expect(r.length).toBe(r2.length);
  });

  test("the example manifest is refused until every placeholder is filled in", () => {
    const ex = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "contracts", "deployments", "4663.example.json"), "utf8")) as Manifest;
    const p = manifestProblems(ex);
    expect(p.some((x) => x.startsWith("contracts.factory"))).toBe(true);
    expect(p.some((x) => x.startsWith("expected.guardian"))).toBe(true);
    expect(ex.expected.owner).toBe("0x5ACD09eAe4f160e2f2e2356e6eF0496EF6f0f064");
    expect(manifestProblems(manifest())).toEqual([]);
  });

  test("the script is read-only: no wallet, no signing, no sending", () => {
    const src = readFileSync(join(import.meta.dir, "..", "scripts", "check-deploy.ts"), "utf8");
    for (const banned of ["createWalletClient", "privateKeyToAccount", "writeContract", "sendTransaction", "sendRawTransaction", "signTransaction"]) {
      expect(src).not.toContain(banned);
    }
    expect(src).toContain("process.exit(failed ? 1 : 0)");
  });
});
