// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MockERC20} from "../../src/mocks/Mocks.sol";
import {MockUSDG3009} from "../arena/ArenaMocks.sol";
import {ArenaBase} from "../arena/ArenaBase.sol";
import {ResultRegistry} from "../../src/arena/ResultRegistry.sol";
import {TableFactory} from "../../src/arena/TableFactory.sol";
import {TableEscrow} from "../../src/arena/TableEscrow.sol";
import {PrizeVault} from "../../src/arena/PrizeVault.sol";
import {StakePool} from "../../src/arena/StakePool.sol";
import {ArenaParams} from "../../script/ArenaParams.sol";
import {IERC20} from "../../src/interfaces/IExternal.sol";

/// @notice Fork-only cheatcodes (kept out of the shared Vm subset so offline runners are unaffected).
interface VmArenaFork {
    function record() external;
    function accesses(address) external returns (bytes32[] memory reads, bytes32[] memory writes);
    function load(address, bytes32) external view returns (bytes32);
    function store(address, bytes32, bytes32) external;
}

/// @title The Arena on a local fork of Robinhood Chain mainnet
/// @notice Fresh Arena contracts on the fork with the real USDG. A full Friend Table (join, lock, result, dispute
///         window, finalize, claims) runs, and A17 is checked: the deployed CoferFactory, CoferPot implementation,
///         FeeRouter and swap adapter keep their code hash and see no storage write. Run with
///         `forge test --match-path test/fork/ArenaFork.t.sol --fork-url https://rpc.mainnet.chain.robinhood.com`
///         (public RPC, no secret). Without a 4663 fork every test returns at once, so plain `forge test` stays offline.
contract ArenaForkTest is ArenaBase {
    VmArenaFork internal constant fvm = VmArenaFork(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    // contracts/deployments/4663.json
    address internal constant COFER_FACTORY = 0x5d03d53A5630ceCC545Be46635779094A11E47D7;
    address internal constant FEE_ROUTER = 0x3a90EC4e5107BC2e86ACC1a4d576A2daE1478527;
    address internal constant POT_IMPLEMENTATION = 0xA44Fc8063291d1eFAbC8dd0D4ADd0aAe37F55BdF;
    address internal constant SWAP_ADAPTER = 0x88A44903842fB76C83Ba1569E0F546BB32ffE817;

    bytes32 internal constant EIP1967_IMPLEMENTATION = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bool internal forked;

    function setUp() public override {
        forked = block.chainid == 4663 && USDG.code.length > 0;
        if (!forked) return;
        usdg = MockUSDG3009(USDG); // the real token; only approve / transfer / balanceOf are called on it
        cofr = new MockERC20("Cofer", "COFR", 18);
        address[] memory s = new address[](3);
        for (uint256 i; i < 3; ++i) s[i] = vm.addr(signerKeys[i]);
        registry = new ResultRegistry(address(this), guardian, s, ArenaParams.RESULT_K);
        impl = new TableEscrow();
        factory = new TableFactory(
            USDG, address(cofr), address(registry), address(impl), address(this), guardian, vm.addr(ELIG_KEY),
            ArenaParams.MAX_BUY_IN, ArenaParams.MAX_TABLE_POT, ArenaParams.MAX_LIVE_VALUE, ArenaParams.MIN_HOST_BOND
        );
        registry.setFactory(address(factory));
        pool = new StakePool(address(cofr), address(factory));
        factory.setStakePool(address(pool));
        address[] memory toks = new address[](1);
        toks[0] = USDG;
        uint256[] memory caps = new uint256[](1);
        caps[0] = ArenaParams.VAULT_WEEKLY_CAP_USDG;
        vault = new PrizeVault(address(factory), address(this), scheduler, toks, caps);
        factory.setPrizeVault(address(vault));
        host = vm.addr(HOST_KEY);
        for (uint256 i; i < 6; ++i) {
            players[i] = vm.addr(playerKeys[i]);
            _fund(players[i], 1_000e6);
        }
        _fund(host, 1_000e6);
    }

    /// @dev Set a USDG balance by finding the slot balanceOf reads (works through the token's proxy).
    function _fund(address who, uint256 amount) internal {
        fvm.record();
        IERC20(USDG).balanceOf(who);
        (bytes32[] memory reads,) = fvm.accesses(USDG);
        for (uint256 i; i < reads.length; ++i) {
            if (reads[i] == EIP1967_IMPLEMENTATION) continue; // the proxy's own pointer, not a balance
            bytes32 before = fvm.load(USDG, reads[i]);
            fvm.store(USDG, reads[i], bytes32(amount));
            if (IERC20(USDG).balanceOf(who) == amount) return;
            fvm.store(USDG, reads[i], before);
        }
        fail("could not find the USDG balance slot");
    }

    function _codeHashes() internal view returns (bytes32[4] memory h) {
        h[0] = COFER_FACTORY.codehash;
        h[1] = POT_IMPLEMENTATION.codehash;
        h[2] = FEE_ROUTER.codehash;
        h[3] = SWAP_ADAPTER.codehash;
    }

    function test_existingContractsUntouched() public {
        if (!forked) return;
        bytes32[4] memory before = _codeHashes();
        for (uint256 i; i < 4; ++i) assertTrue(before[i] != bytes32(0) && before[i] != keccak256(""), "a Cofer contract is missing on the fork");

        fvm.record();
        // a full Friend Table on the real USDG
        TableEscrow t = _lockedFriend();
        vm.warp(t.endAt());
        _post(t, _result(0, players[0], players[1]));
        vm.warp(t.disputeEnd());
        t.finalize();
        uint256 b0 = IERC20(USDG).balanceOf(players[0]);
        vm.prank(players[0]);
        t.claim(address(0));
        vm.prank(players[1]);
        t.claim(address(0));
        assertTrue(IERC20(USDG).balanceOf(players[0]) > b0, "the winner was paid in real USDG");
        assertEq(IERC20(USDG).balanceOf(address(t)), 0, "the escrow is empty after both claims");

        address[4] memory existing = [COFER_FACTORY, POT_IMPLEMENTATION, FEE_ROUTER, SWAP_ADAPTER];
        for (uint256 i; i < 4; ++i) {
            (, bytes32[] memory writes) = fvm.accesses(existing[i]);
            assertEq(writes.length, 0, "A17: an existing Cofer contract's storage was written");
        }
        bytes32[4] memory afterHashes = _codeHashes();
        for (uint256 i; i < 4; ++i) assertEq(afterHashes[i], before[i]);
    }

    function test_realUsdgJoinAndRefund() public {
        if (!forked) return;
        TableEscrow t = _lockedFriend();
        assertEq(IERC20(USDG).balanceOf(address(t)), 3 * uint256(BUY_IN));
        vm.warp(t.hardDeadline());
        t.refundAll();
        for (uint256 i; i < 3; ++i) {
            vm.prank(players[i]);
            t.claim(address(0));
            assertEq(IERC20(USDG).balanceOf(players[i]), 1_000e6, "refund returns the exact buy-in");
        }
    }
}
