/**
 * Role drift check (keeper, every 5 minutes). FeeRouter's ownership functions emit no events, so
 * reading the roles directly is the only way to see a change there. Pure.
 */
import { zeroAddress } from "viem";

export const ROLES_ALERT = "roles-drift";

export interface RoleState {
  factoryOwner: string;
  factoryPendingOwner: string;
  guardian: string;
  routerOwner: string;
  routerPendingOwner: string;
  /** The owner Safe's signers (read only when EXPECTED_SAFE_SIGNERS is set). */
  safeSigners?: readonly string[];
  /** The four fee sinks (read only when EXPECTED_FEE_SINKS is set; judged by sinksProblem, not roleProblem). */
  sinks?: readonly string[];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The alert text while roles differ from what is expected, else null. Unset expectations are not checked. */
export function roleProblem(s: RoleState, expected: { owner?: string; guardian?: string; signers?: readonly string[] }): string | null {
  const p: string[] = [];
  if (expected.owner && !same(s.factoryOwner, expected.owner)) p.push(`factory owner is ${s.factoryOwner}, expected ${expected.owner}`);
  if (expected.owner && !same(s.routerOwner, expected.owner)) p.push(`fee router owner is ${s.routerOwner}, expected ${expected.owner}`);
  if (expected.guardian && !same(s.guardian, expected.guardian)) p.push(`guardian is ${s.guardian}, expected ${expected.guardian}`);
  // a transfer pending to the expected owner is the planned hand-off; any other is a problem
  const odd = (pending: string) => !same(pending, zeroAddress) && !(expected.owner && same(pending, expected.owner));
  if (odd(s.factoryPendingOwner)) p.push(`a factory ownership transfer to ${s.factoryPendingOwner} is pending`);
  if (odd(s.routerPendingOwner)) p.push(`a fee router ownership transfer to ${s.routerPendingOwner} is pending`);
  if (expected.signers && s.safeSigners) {
    const has = (l: readonly string[], a: string) => l.some((b) => same(a, b));
    const added = s.safeSigners.filter((a) => !has(expected.signers!, a));
    const gone = expected.signers.filter((a) => !has(s.safeSigners!, a));
    if (added.length) p.push(`the owner Safe has an unexpected signer ${added.join(", ")}`);
    if (gone.length) p.push(`the owner Safe no longer has signer ${gone.join(", ")}`);
  }
  return p.length ? `Roles changed: ${p.join("; ")}. Check the owner Safe; see docs/runbook.md.` : null;
}

/** The alert key for fee sinks that are not the expected ones (shared with the indexer's SinksSet alert). */
export const SINKS_ALERT_KEY = "role-changed:sinks";

/** The alert text while the live fee sinks differ from the expected four (in order), else null. */
export function sinksProblem(sinks: readonly string[], expected: readonly string[]): string | null {
  const names = ["work", "treasury", "perks", "burn"];
  const p = expected.map((e, i) => (sinks[i] && same(sinks[i]!, e) ? null : `${names[i]} sink is ${sinks[i] ?? "missing"}, expected ${e}`)).filter((x) => x !== null);
  return p.length ? `Fee sinks changed: ${p.join("; ")}. Check the owner Safe; see docs/runbook.md.` : null;
}
