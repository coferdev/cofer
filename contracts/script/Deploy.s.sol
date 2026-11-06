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
/// Dry run with no key (simulation only; prints the gas estimate; refuses --broadcast):
///
///   MULTISIG=0x... GUARDIAN=0x... SINK_WORK=0x... SINK_TREASURY=0x... SINK_PERKS=0x... SINK_BURN=0x... \
///   forge script script/Deploy.s.sol --rpc-url $RHC_RPC --sender <deployer address>
///
/// Refuses any chain other than Robinhood Chain mainnet (4663).
///
/// Stock Tokens are NOT listed here: run `bun run services/scripts/build-asset-list.ts`, which
/// pulls canonical addresses from the issuer's public asset API and prints the multisig batch.

/// The two cheatcodes this script needs beyond the shared test helpers (signatures as in forge-std).
interface ScriptVm {
    function startBroadcast() external;
    function isContext(uint8 context) external view returns (bool);
}

contract Deploy {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    ScriptVm internal constant svm = ScriptVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant MAINNET_CHAIN_ID = 4663;
    // Foundry's ForgeContext values (forge-std Vm.sol): 6 = `forge script --broadcast`, 7 = `--resume`.
    uint8 internal constant CONTEXT_SCRIPT_BROADCAST = 6;
    uint8 internal constant CONTEXT_SCRIPT_RESUME = 7;
    // The sender forge uses when no --sender is given.
    address internal constant FORGE_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

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
        require(block.chainid == MAINNET_CHAIN_ID, "Deploy: chain 4663 only");

        // With DEPLOYER_KEY: the real deploy. Without it: a simulation as the --sender address only.
        uint256 key = vm.envOr("DEPLOYER_KEY", uint256(0));
        address deployer;
        if (key == 0) {
            require(
                !svm.isContext(CONTEXT_SCRIPT_BROADCAST) && !svm.isContext(CONTEXT_SCRIPT_RESUME),
                "Deploy: no DEPLOYER_KEY, so simulation only: run without --broadcast"
            );
            require(msg.sender != FORGE_DEFAULT_SENDER, "Deploy: no DEPLOYER_KEY: pass --sender <deployer address>");
            deployer = msg.sender;
        } else {
            deployer = vm.addr(key);
        }
        address multisig = vm.envAddress("MULTISIG");
        address guardian = vm.envOr("GUARDIAN", multisig);
        address[4] memory sinks = [
            vm.envAddress("SINK_WORK"),
            vm.envAddress("SINK_TREASURY"),
            vm.envAddress("SINK_PERKS"),
            vm.envAddress("SINK_BURN")
        ];

        if (key == 0) svm.startBroadcast(); // records the transactions as --sender, for the simulation
        else vm.startBroadcast(key);
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
