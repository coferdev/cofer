// Alternative test runner (no Foundry needed): Hardhat 3 runs the same forge-style *.t.sol tests.
//   cd contracts && npm i && SOLC_JS=$(node -p "require.resolve('solc/soljson.js')") npx hardhat test solidity
// SOLC_JS lets Hardhat use the npm solc-js build when binaries.soliditylang.org is unreachable.
import type { HardhatUserConfig } from "hardhat/config";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    ...(process.env.SOLC_JS ? { path: process.env.SOLC_JS } : {}),
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  } as HardhatUserConfig["solidity"],
  paths: { sources: "src", tests: { solidity: "test" } },
  test: { solidity: { fuzz: { runs: 256 }, allowUnlimitedContractSize: true } } as HardhatUserConfig["test"],
};

export default config;
