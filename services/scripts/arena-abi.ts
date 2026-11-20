// Copies the Arena ABIs from the Foundry build into services/src/arena/chain/abi/.
//   cd contracts && forge build && cd ../services && bun scripts/arena-abi.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = join(import.meta.dir, "../../contracts/out");
const dest = join(import.meta.dir, "../src/arena/chain/abi");
for (const c of ["TableFactory", "TableEscrow", "ResultRegistry", "PrizeVault", "StakePool"]) {
  const { abi } = JSON.parse(readFileSync(join(out, `${c}.sol`, `${c}.json`), "utf8"));
  writeFileSync(join(dest, `${c}.json`), `${JSON.stringify(abi, null, 1)}\n`);
  console.log(`${c}: ${abi.length} entries`);
}
