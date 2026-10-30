// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "../test/utils/Test.sol";
import {CoferPot} from "../src/CoferPot.sol";
import {CoferFactory} from "../src/CoferFactory.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {UniV3SwapAdapter} from "../src/SwapAdapter.sol";
import {MockUSDG, MockStockToken, MockAggregator, MockSwapRouter} from "../src/mocks/Mocks.sol";

/// @notice Robinhood Chain TESTNET (46630) deployment with the repo's own mocks. Same steps as
///         Deploy.s.sol, but USDG, the two Stock Tokens, their feeds and the swap router are mocks.
///         Reverts on any other chain.
///
///   DEPLOYER_KEY=0x... MULTISIG=0x... GUARDIAN=0x... SINK_WORK=0x... SINK_TREASURY=0x... \
///   SINK_PERKS=0x... SINK_BURN=0x... \
///   forge script script/DeployTestnet.s.sol --rpc-url robinhood_testnet --broadcast
///
/// Mock feeds are fresh at deploy only. MockAggregator.set(answer) is open to anyone and resets
/// updatedAt; call it before USDG_STALENESS / STOCK_STALENESS runs out or prices read as stale.
contract DeployTestnet {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant TESTNET_CHAIN_ID = 46630;

    uint16 internal constant SWAP_FEE_BPS = 30; // 0.30% on group swaps/buys
    uint256 internal constant PLAN_PRICE = 9e6; // 9 USDG / 30 days, optional

    uint32 internal constant USDG_STALENESS = 1 days;
    uint32 internal constant STOCK_STALENESS = 4 days; // factory cap, covers a weekend

    struct Deployed {
        CoferPot impl;
        FeeRouter router;
        CoferFactory factory;
        UniV3SwapAdapter adapter;
        MockSwapRouter swapRouter;
        MockUSDG usdg;
        MockAggregator usdgFeed;
        MockStockToken stockA;
        MockAggregator stockAFeed;
        MockStockToken stockB;
        MockAggregator stockBFeed;
    }

    function run() external returns (Deployed memory d) {
        require(block.chainid == TESTNET_CHAIN_ID, "DeployTestnet: chain 46630 only");

        uint256 key = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(key);
        address multisig = vm.envAddress("MULTISIG");
        address guardian = vm.envOr("GUARDIAN", multisig);
        address[4] memory sinks = [
            vm.envAddress("SINK_WORK"),
            vm.envAddress("SINK_TREASURY"),
            vm.envAddress("SINK_PERKS"),
            vm.envAddress("SINK_BURN")
        ];

        vm.startBroadcast(key);
        // Mocks (8-decimal feeds, like Chainlink USD feeds)
        d.usdg = new MockUSDG();
        d.usdgFeed = new MockAggregator(8, 1e8);
        d.stockA = new MockStockToken("Test Stock A", "TSTA");
        d.stockAFeed = new MockAggregator(8, 250e8);
        d.stockB = new MockStockToken("Test Stock B", "TSTB");
        d.stockBFeed = new MockAggregator(8, 100e8);
        d.swapRouter = new MockSwapRouter();

        d.impl = new CoferPot();
        d.router = new FeeRouter(address(d.usdg), deployer, PLAN_PRICE, sinks);
        d.factory =
            new CoferFactory(address(d.impl), address(d.usdg), address(d.router), deployer, guardian, SWAP_FEE_BPS);
        d.router.setFactory(address(d.factory));
        d.adapter = new UniV3SwapAdapter(address(d.swapRouter));

        d.factory.listAsset(address(d.usdg), address(d.usdgFeed), USDG_STALENESS, false);
        d.factory.listAsset(address(d.stockA), address(d.stockAFeed), STOCK_STALENESS, true);
        d.factory.listAsset(address(d.stockB), address(d.stockBFeed), STOCK_STALENESS, true);
        d.factory.setBuyable(address(d.stockA), true);
        d.factory.setBuyable(address(d.stockB), true);
        d.factory.queueAdapter(address(d.adapter)); // multisig applies after 48h

        d.factory.transferOwnership(multisig);
        d.router.transferOwnership(multisig);
        vm.stopBroadcast();
    }
}
