// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "../test/utils/Test.sol";
import {CoferPot} from "../src/CoferPot.sol";
import {CoferFactory} from "../src/CoferFactory.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {UniV3SwapAdapter} from "../src/SwapAdapter.sol";

/// @notice Robinhood Chain (4663) deployment. Run from a FRESH deployer key (studio rule), then
///         hand ownership to the brand multisig (2-step: the multisig calls acceptOwnership()).
///
///   DEPLOYER_KEY=0x... MULTISIG=0x... GUARDIAN=0x... SINK_WORK=0x... SINK_TREASURY=0x... \
///   SINK_PERKS=0x... SINK_BURN=0x... \
///   forge script script/Deploy.s.sol --rpc-url $RHC_RPC --broadcast
///
/// Stock Tokens are NOT listed here: run `bun run services/scripts/build-asset-list.ts`, which
/// pulls canonical addresses from the issuer's public asset API and prints the multisig batch.
contract Deploy {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Robinhood Chain mainnet (verified 2026-10-25, see INTERNAL notes)
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant USDG_USD_FEED = 0x8bEeE3503F6860D5dac4cE26b5eEe92982951c2e;
    address internal constant SWAP_ROUTER_02 = 0xCaf681a66D020601342297493863E78C959E5cb2;

    uint16 internal constant SWAP_FEE_BPS = 30; // 0.30% on group swaps/buys
    uint256 internal constant PLAN_PRICE = 9e6; // 9 USDG / 30 days, optional

    function run()
        external
        returns (CoferPot impl, FeeRouter router, CoferFactory factory, UniV3SwapAdapter adapter)
    {
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
        impl = new CoferPot();
        router = new FeeRouter(USDG, deployer, PLAN_PRICE, sinks);
        factory = new CoferFactory(address(impl), USDG, address(router), deployer, guardian, SWAP_FEE_BPS);
        router.setFactory(address(factory));
        adapter = new UniV3SwapAdapter(SWAP_ROUTER_02);

        factory.listAsset(USDG, USDG_USD_FEED, 1 days, false);
        factory.queueAdapter(address(adapter)); // multisig applies after 48h

        factory.transferOwnership(multisig);
        router.transferOwnership(multisig);
        vm.stopBroadcast();
    }
}
