// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArenaBase} from "./ArenaBase.sol";
import {ArenaTypes} from "../../src/arena/ArenaTypes.sol";
import {TableEscrow} from "../../src/arena/TableEscrow.sol";
import {TableFactory} from "../../src/arena/TableFactory.sol";
import {PrizeVault} from "../../src/arena/PrizeVault.sol";
import {StakePool} from "../../src/arena/StakePool.sol";
import {IStakePool} from "../../src/interfaces/arena/IStakePool.sol";
import {ITableEscrow} from "../../src/interfaces/arena/ITableEscrow.sol";

contract FreerollVaultStakeTest is ArenaBase {
    function setUp() public override {
        super.setUp();
        usdg.mint(address(vault), 5_000e6);
    }

    function _vaultFreeroll(uint96 prize) internal returns (TableEscrow t) {
        vm.prank(scheduler);
        t = TableEscrow(vault.fundFreeroll(_freeroll(prize, 100), bytes32(++nextSalt)));
    }

    function _joinFree(TableEscrow t, uint256 i, bool prizeEligible) internal {
        bytes memory e = _elig(t, players[i], prizeEligible);
        vm.prank(players[i]);
        t.join(_skh(i), "", e);
    }

    function _leaf(TableEscrow t, uint256 index, address account, uint256 amount) internal view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(t.PAYOUT_TAG(), block.chainid, address(t), index, account, amount))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev A vault Freeroll of 100 USDG with players 0, 1 (eligible) and 2 (not prize-eligible), settled with
    ///      a payout tree paying player 0 60 and player 1 30 (total 90).
    function _settledFreeroll() internal returns (TableEscrow t, bytes32 l0, bytes32 l1) {
        t = _vaultFreeroll(100e6);
        _joinFree(t, 0, true);
        _joinFree(t, 1, true);
        _joinFree(t, 2, false);
        vm.warp(t.params().lockAt);
        t.lock();
        vm.warp(t.endAt());
        l0 = _leaf(t, 0, players[0], 60e6);
        l1 = _leaf(t, 1, players[1], 30e6);
        ITableEscrow.Result memory r = _result(0, address(0), address(0));
        r.podium = new address[](0);
        r.payoutRoot = _pair(l0, l1);
        r.totalPayout = 90e6;
        _post(t, r);
        vm.warp(t.disputeEnd());
        t.finalize();
    }

    function test_vaultFundsFreerollPrizeInEscrowBeforeJoins() public {
        TableEscrow t = _vaultFreeroll(100e6);
        assertEq(usdg.balanceOf(address(t)), 100e6);
        assertEq(usdg.balanceOf(address(vault)), 4_900e6);
        assertEq(t.sponsor(), address(vault));
        assertEq(vault.spentThisWeek(address(usdg)), 100e6);
        assertEq(usdg.allowance(address(vault), address(factory)), 0);
    }

    function test_freerollPrizeClaimsAndReclaim() public {
        (TableEscrow t, bytes32 l0, bytes32 l1) = _settledFreeroll();
        bytes32[] memory p0 = new bytes32[](1);
        p0[0] = l1;
        vm.prank(players[0]);
        t.claimPrize(0, 60e6, p0, address(0));
        assertEq(usdg.balanceOf(players[0]), 1_060e6);
        // bitmap: once only
        vm.prank(players[0]);
        vm.expectRevert(TableEscrow.AlreadyClaimed.selector);
        t.claimPrize(0, 60e6, p0, address(0));
        // someone else cannot use player 1's leaf
        bytes32[] memory p1 = new bytes32[](1);
        p1[0] = l0;
        vm.prank(players[2]);
        vm.expectRevert(TableEscrow.NotPrizeEligible.selector);
        t.claimPrize(1, 30e6, p1, address(0));
        vm.prank(players[1]);
        t.claimPrize(1, 30e6, p1, address(0));
        // the sponsor (the vault) gets exactly the rest
        t.sponsorReclaim();
        assertEq(usdg.balanceOf(address(vault)), 4_910e6);
        assertEq(usdg.balanceOf(address(t)), 0);
        vm.expectRevert(TableEscrow.AlreadyClaimed.selector);
        t.sponsorReclaim();
    }

    function test_freerollNeverOverpays() public {
        TableEscrow t = _vaultFreeroll(100e6);
        _joinFree(t, 0, true);
        _joinFree(t, 1, true);
        vm.warp(t.params().lockAt);
        t.lock();
        vm.warp(t.endAt());
        ITableEscrow.Result memory r = _result(0, address(0), address(0));
        r.podium = new address[](0);
        r.totalPayout = 100e6 + 1;
        bytes32 d = registry.resultDigest(address(t), r);
        bytes[] memory sigs = _sigs(d, _two());
        vm.expectRevert(TableEscrow.OverPrize.selector);
        t.postResult(r, sigs);
    }

    function test_refundedFreerollReturnsWholePrizeToSponsor() public {
        TableEscrow t = _vaultFreeroll(100e6);
        _joinFree(t, 0, true);
        _joinFree(t, 1, true);
        vm.warp(t.params().lockAt);
        t.lock();
        vm.warp(t.hardDeadline());
        t.refundAll();
        t.sponsorReclaim();
        assertEq(usdg.balanceOf(address(vault)), 5_000e6);
    }

    function test_freerollHasNoVoidAndNoBond() public {
        TableEscrow t = _vaultFreeroll(100e6);
        _joinFree(t, 0, true);
        bytes[] memory none = new bytes[](0);
        vm.expectRevert(TableEscrow.FriendOnly.selector);
        t.voidAll(none);
    }

    function test_vaultWeeklyCap() public {
        _vaultFreeroll(1_500e6);
        ArenaTypes.TableParams memory p = _freeroll(501e6, 100);
        vm.prank(scheduler);
        vm.expectRevert(PrizeVault.OverWeeklyCap.selector);
        vault.fundFreeroll(p, bytes32(uint256(991)));
        vm.warp(block.timestamp + 7 days);
        assertEq(vault.spentThisWeek(address(usdg)), 0);
        p = _freeroll(501e6, 100);
        vm.prank(scheduler);
        vault.fundFreeroll(p, bytes32(uint256(992)));
    }

    function test_vaultOnlySchedulerAndOnlyFreerolls() public {
        ArenaTypes.TableParams memory p = _freeroll(10e6, 100);
        vm.expectRevert(PrizeVault.NotScheduler.selector);
        vault.fundFreeroll(p, bytes32(0));
        ArenaTypes.TableParams memory f = _friend(2, 5, uint64(block.timestamp + 1 hours));
        vm.prank(scheduler);
        vm.expectRevert(PrizeVault.BadParam.selector);
        vault.fundFreeroll(f, bytes32(0));
    }

    function test_weeklyCapTimelock() public {
        vault.queueWeeklyCap(address(usdg), 10e6);
        vm.expectRevert(PrizeVault.TooEarly.selector);
        vault.applyWeeklyCap(address(usdg));
        vm.warp(block.timestamp + 48 hours);
        vault.applyWeeklyCap(address(usdg));
        assertEq(vault.weeklyCap(address(usdg)), 10e6);
    }

    // ------------------------------------------------------------------ host bond (non-vault Freerolls)

    function test_publicFreerollNeedsHostBond() public {
        ArenaTypes.TableParams memory p = _freeroll(100e6, 50);
        vm.prank(host);
        usdg.approve(address(factory), type(uint256).max);
        vm.prank(host);
        vm.expectRevert(TableFactory.NeedHostBond.selector);
        factory.createTable(p, bytes32(uint256(1)));

        cofr.mint(host, 2_000e18);
        vm.startPrank(host);
        cofr.approve(address(pool), type(uint256).max);
        uint256 id = pool.stake(1_000e18, IStakePool.Term.D7);
        pool.markBond(id);
        TableEscrow t = TableEscrow(factory.createTable(p, bytes32(uint256(1))));
        vm.stopPrank();
        assertEq(t.sponsor(), host);
        assertEq(usdg.balanceOf(address(t)), 100e6);
        uint64 until = pool.bondUntil(host);
        assertGe(until, p.lockAt + p.duration + 30 days, "bond held 30 days after the event");

        vm.warp(block.timestamp + 8 days); // past the stake's own unlock
        vm.prank(host);
        vm.expectRevert(StakePool.StillLocked.selector);
        pool.unstake(id);
        vm.warp(until);
        vm.prank(host);
        pool.unstake(id);
        assertEq(cofr.balanceOf(host), 2_000e18);
    }

    // ------------------------------------------------------------------ StakePool (A16)

    function test_stakeUnstakeExact() public {
        cofr.mint(players[0], 100e18);
        vm.startPrank(players[0]);
        cofr.approve(address(pool), type(uint256).max);
        uint256 id = pool.stake(100e18, IStakePool.Term.D30);
        assertEq(pool.weightOf(players[0]), 200e18);
        vm.expectRevert(StakePool.StillLocked.selector);
        pool.unstake(id);
        vm.warp(block.timestamp + 30 days);
        pool.unstake(id);
        vm.stopPrank();
        assertEq(cofr.balanceOf(players[0]), 100e18);
        assertEq(pool.weightOf(players[0]), 0);
    }

    function test_pledgeGoesToVaultForGood() public {
        cofr.mint(players[0], 100e18);
        vm.startPrank(players[0]);
        cofr.approve(address(pool), type(uint256).max);
        uint256 id = pool.stake(100e18, IStakePool.Term.D90);
        pool.pledge(id, 40e18);
        vm.warp(block.timestamp + 90 days);
        pool.unstake(id);
        vm.stopPrank();
        assertEq(cofr.balanceOf(address(vault)), 40e18);
        assertEq(cofr.balanceOf(players[0]), 60e18);
    }

    function test_unstakeNeverPausable() public {
        cofr.mint(players[0], 10e18);
        vm.startPrank(players[0]);
        cofr.approve(address(pool), type(uint256).max);
        uint256 id = pool.stake(10e18, IStakePool.Term.D7);
        vm.stopPrank();
        factory.setCreationPaused(true); // the only pause in the arena
        vm.warp(block.timestamp + 7 days);
        vm.prank(players[1]);
        vm.expectRevert(StakePool.NotPositionOwner.selector);
        pool.unstake(id);
        vm.prank(players[0]);
        pool.unstake(id);
        assertEq(cofr.balanceOf(players[0]), 10e18);
    }

    function test_onlyFactoryNotesHosts() public {
        vm.expectRevert(StakePool.NotFactory.selector);
        pool.noteHosted(host, uint64(block.timestamp));
    }
}
