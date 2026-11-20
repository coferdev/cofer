/**
 * Signing page check (keeper, every 5 minutes): loads the passkey page (/s/<test>) and the wallet page (/w/<test>)
 * from the public address, like a member's browser would, and checks:
 *   - each answers 200, with its exact security policy (content-security-policy) and x-frame-options DENY;
 *   - each loads its script, and /assets/signer.js (and /assets/wallet.js when Connect wallet is on) is byte for byte
 *     the bundle this release builds (same SHA-256);
 * Any failure opens the staff alert "signer-page-down" with the first reason; it clears when all pass.
 * The test token opens no session: the page shell renders for any token and asks the API before doing anything.
 */
import { createHash } from "node:crypto";
import { checkAlert, type AlertDeps } from "./alerts";
import { WHO } from "../core/alertFormat";

export const SIGNER_PAGE_ALERT = "signer-page-down";
export const TEST_TOKEN = "page-check";

export interface SignerCheckDeps {
  baseUrl: string; // PUBLIC_URL
  fetch: typeof fetch;
  passkeyCsp: string;
  walletCsp: string | null; // null = Connect wallet is off (the wallet page then uses the passkey policy)
  /** The SHA-256 (hex) of the bundles this release builds. */
  expected(): Promise<{ signer: string; wallet: string | null }>;
  alerts: AlertDeps;
}

export const sha256 = (b: ArrayBuffer | Uint8Array | string) => createHash("sha256").update(typeof b === "string" ? b : new Uint8Array(b as ArrayBuffer)).digest("hex");

/** The first problem found, as one plain sentence, or null when both pages are as they should be. */
export async function signerPageProblem(d: SignerCheckDeps): Promise<string | null> {
  const base = d.baseUrl.replace(/\/$/, "");
  const want = await d.expected();
  const get = async (path: string) => {
    try {
      return await d.fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000), redirect: "manual" });
    } catch {
      return null;
    }
  };
  const pages: [string, string, string, string | null][] = [
    ["passkey page", `/s/${TEST_TOKEN}`, d.passkeyCsp, "/assets/signer.js"],
    ["wallet page", `/w/${TEST_TOKEN}`, d.walletCsp ?? d.passkeyCsp, "/assets/signer.js"],
  ];
  for (const [name, path, csp, script] of pages) {
    const r = await get(path);
    if (!r) return `The ${name} did not answer.`;
    if (r.status !== 200) return `The ${name} answered ${r.status}.`;
    if (r.headers.get("content-security-policy") !== csp) return `The ${name} is served without its exact security policy.`;
    if ((r.headers.get("x-frame-options") ?? "").toUpperCase() !== "DENY") return `The ${name} can be framed by another site (x-frame-options is not DENY).`;
    const html = await r.text();
    if (script && !html.includes(`src="${script}"`)) return `The ${name} does not load ${script}.`;
    if (name === "wallet page" && d.walletCsp && !html.includes("/assets/wallet.js")) return "The wallet page does not load /assets/wallet.js while Connect wallet is on.";
  }
  const scripts: [string, string | null][] = [
    ["/assets/signer.js", want.signer],
    ["/assets/wallet.js", d.walletCsp ? want.wallet : null],
  ];
  for (const [path, hash] of scripts) {
    if (!hash) continue;
    const r = await get(path);
    if (!r || r.status !== 200) return `${path} did not load (${r ? r.status : "no answer"}).`;
    if (sha256(await r.arrayBuffer()) !== hash) return `${path} is not the script this release builds (its SHA-256 differs).`;
  }
  return null;
}

export async function signerCheck(d: SignerCheckDeps): Promise<"opened" | "cleared" | null> {
  const problem = await signerPageProblem(d);
  return checkAlert(SIGNER_PAGE_ALERT, problem === null ? null : { name: SIGNER_PAGE_ALERT, what: `${problem} Members may not be able to sign deposits, votes or exits through the site; exits from the contract itself are not affected.`, who: WHO.dev }, d.alerts);
}
