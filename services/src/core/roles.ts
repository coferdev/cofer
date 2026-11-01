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
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The alert text while roles differ from what is expected, else null. Unset expectations are not checked. */
export function roleProblem(s: RoleState, expected: { owner?: string; guardian?: string }): string | null {
  const p: string[] = [];
  if (expected.owner && !same(s.factoryOwner, expected.owner)) p.push(`factory owner is ${s.factoryOwner}, expected ${expected.owner}`);
  if (expected.owner && !same(s.routerOwner, expected.owner)) p.push(`fee router owner is ${s.routerOwner}, expected ${expected.owner}`);
  if (expected.guardian && !same(s.guardian, expected.guardian)) p.push(`guardian is ${s.guardian}, expected ${expected.guardian}`);
  if (!same(s.factoryPendingOwner, zeroAddress)) p.push(`a factory ownership transfer to ${s.factoryPendingOwner} is pending`);
  if (!same(s.routerPendingOwner, zeroAddress)) p.push(`a fee router ownership transfer to ${s.routerPendingOwner} is pending`);
  return p.length ? `Roles changed: ${p.join("; ")}. Check the owner Safe; see docs/runbook.md.` : null;
}
