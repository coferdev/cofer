// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CoferBase} from "./utils/CoferBase.sol";
import {ICoferPot} from "../src/interfaces/ICoferPot.sol";
import {CoferPot} from "../src/CoferPot.sol";
import {MockSmartAccount} from "../src/mocks/Mocks.sol";

contract CoferPotTest is CoferBase {
    uint8 constant TRANSFER = 0;
    uint8 constant SWAP = 1;
    uint8 constant ADD_MEMBER = 2;
    uint8 constant REMOVE_MEMBER = 3;
    uint8 constant SET_ALLOWANCE = 4;
    uint8 constant SET_THRESHOLD = 5;
    uint8 constant SET_CONFIG = 6;
    uint8 constant PAY_PLAN = 7;

    // ------------------------------------------------------------ setup / threshold

    function test_initialState() public view {
        assertEq(pot.memberCount(), 5);
        assertEq(pot.requiredVotes(), 3, "60% of 5 rounds up to 3");
        assertEq(pot.heldAssets().length, 1);
        assertEq(pot.heldAssets()[0], address(usdg));
    }

    function test_cannotReinitialize() public {
        address[] memory list = new address[](1);
        list[0] = address(this);
        vm.expectRevert(ICoferPot.AlreadyInitialized.selector);
        pot.initialize(address(usdg), list, 1, 0, ICoferPot.Config(0, 100, 0, true));
    }

    function test_implementationLocked() public {
        address[] memory list = new address[](1);
        list[0] = address(this);
        vm.expectRevert(ICoferPot.AlreadyInitialized.selector);
        impl.initialize(address(usdg), list, 1, 0, ICoferPot.Config(0, 100, 0, true));
    }

    // ------------------------------------------------------------ deposits

    function test_depositMintsSharesProRata() public {
        uint256 s0 = _deposit(0, 100e6);
        assertEq(s0, 100e6 * 1e12, "first deposit: 1 USDG = 1e18 shares");
        uint256 s1 = _deposit(1, 50e6);
        // (50e6 * (100e18 + 1e12)) / (100e6 + 1) -> just under 50e18, rounds in favour of the pot
        assertLe(s1, 50e18, "second deposit never over-mints");
        assertGe(s1, 50e18 - 1e12, "second deposit close to fair");
        assertEq(pot.totalShares(), s0 + s1);
    }

    function test_depositClosedByGroupConfig() public {
        bytes memory cfg = abi.encode(uint32(6 hours), uint16(300), uint16(50), false);
        assertTrue(_exec(SET_CONFIG, cfg, 1, _all()), "unanimous skips delay");
        vm.prank(m[0]);
        vm.expectRevert(ICoferPot.DepositsClosed.selector);
        pot.deposit(1e6);
    }

    function test_depositClosedByFactoryPause() public {
        vm.prank(guardian);
        factory.setDepositsPaused(true);
        vm.prank(m[0]);
        vm.expectRevert(ICoferPot.DepositsClosed.selector);
        pot.deposit(1e6);
    }

    function test_nonMemberCannotDeposit() public {
        usdg.mint(address(this), 10e6);
        usdg.approve(address(pot), 10e6);
        vm.expectRevert(ICoferPot.NotMember.selector);
        pot.deposit(10e6);
    }

    function test_depositWithPermit() public {
        uint256 amt = 25e6;
        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(m[2]);
        usdg.approve(address(pot), 0);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdg.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(usdg.PERMIT_TYPEHASH(), m[2], address(pot), amt, usdg.nonces(m[2]), deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[2], digest);
        vm.prank(m[2]);
        uint256 shares = pot.depositWithPermit(amt, deadline, v, r, s);
        assertEq(shares, amt * 1e12);
    }

    function test_entrySpreadAppliesWhenStocksHeld() public {
        _deposit(0, 500e6);
        _buyTsla(200e6);
        (uint256 nav,) = pot.navUsdg();
        uint256 supply = pot.totalShares();
        uint256 s = _deposit(1, 100e6);
        uint256 fair = (100e6 * (supply + 1e12)) / (nav + 1);
        assertLe(s, (fair * 9950) / 10000 + 1, "0.5% entry spread stays in the pot");
    }

    function test_depositRevertsOnStaleFeedWhileStocksHeld() public {
        _deposit(0, 500e6);
        _buyTsla(200e6);
        vm.warp(block.timestamp + 5 days);
        usdgFeed.set(1e8); // USDG fresh, TSLA stale
        vm.prank(m[1]);
        vm.expectRevert();
        pot.deposit(10e6);
    }

    // ------------------------------------------------------------ exits

    function test_exitInKindProRata() public {
        _deposit(0, 600e6);
        _deposit(1, 400e6);
        _buyTsla(500e6);
        uint256 potUsdg = usdg.balanceOf(address(pot));
        uint256 potTsla = tsla.balanceOf(address(pot));
        uint256 s1 = pot.memberInfo(m[1]).shares;
        uint256 supply = pot.totalShares();
        uint256 u0 = usdg.balanceOf(m[1]);

        vm.prank(m[1]);
        pot.exit(s1, m[1]);

        assertEq(usdg.balanceOf(m[1]) - u0, (potUsdg * s1) / supply, "exact USDG share");
        assertEq(tsla.balanceOf(m[1]), (potTsla * s1) / supply, "exact TSLA share, in kind");
        assertEq(pot.memberInfo(m[1]).shares, 0);
    }

    function test_exitNeverGatedByPausesOrStaleFeeds() public {
        _deposit(0, 300e6);
        _buyTsla(100e6);
        vm.startPrank(owner);
        factory.setDepositsPaused(true);
        factory.setCreationPaused(true);
        factory.setBuyable(address(tsla), false);
        vm.stopPrank();
        vm.warp(block.timestamp + 30 days); // every feed stale
        uint256 s = pot.memberInfo(m[0]).shares;
        vm.prank(m[0]);
        pot.exit(s, m[0]);
        assertEq(pot.totalShares(), 0);
        assertGe(tsla.balanceOf(m[0]), 1, "got stock back in kind");
    }

    function test_exitWithPausedTokenCreditsOwedAndOthersStillPaid() public {
        _deposit(0, 300e6);
        _deposit(1, 300e6);
        _buyTsla(300e6);
        tsla.setPaused(true);
        uint256 s = pot.memberInfo(m[0]).shares;
        uint256 before = usdg.balanceOf(m[0]);
        vm.prank(m[0]);
        pot.exit(s, m[0]);
        assertGe(usdg.balanceOf(m[0]) - before, 1, "USDG leg still paid");
        uint256 owedAmt = pot.owed(address(tsla), m[0]);
        assertGe(owedAmt, 1, "TSLA leg credited");
        assertEq(pot.reserved(address(tsla)), owedAmt);

        // reserved stock is excluded from the remaining member's share
        uint256 s1 = pot.memberInfo(m[1]).shares;
        (, uint256[] memory amts) = pot.previewExit(s1);
        assertEq(amts[1], tsla.balanceOf(address(pot)) - owedAmt);

        tsla.setPaused(false);
        pot.claimOwed(address(tsla), m[0]); // anyone can trigger; pays m[0]
        assertEq(tsla.balanceOf(m[0]), owedAmt);
        assertEq(pot.reserved(address(tsla)), 0);
    }

    function test_exitRoundsDownInFavourOfPot() public {
        _deposit(0, 1e6);
        _deposit(1, 2e6);
        usdg.mint(address(pot), 1); // NAV 3_000_001: m0's 1/3 share is 1_000_000.33
        uint256 before = usdg.balanceOf(m[0]);
        vm.prank(m[0]);
        pot.exit(1e18, m[0]);
        assertEq(usdg.balanceOf(m[0]) - before, 1_000_000, "floor, never ceil");
    }

    function test_exitMoreThanSharesReverts() public {
        _deposit(0, 10e6);
        vm.prank(m[0]);
        vm.expectRevert(ICoferPot.InsufficientShares.selector);
        pot.exit(11e18, m[0]);
    }

    function test_leaveExitsAndRemoves() public {
        _deposit(3, 100e6);
        vm.prank(m[3]);
        pot.leave();
        assertEq(pot.memberCount(), 4);
        assertEq(pot.requiredVotes(), 3, "60% of 4 rounds up to 3");
        assertEq(usdg.balanceOf(m[3]), 1_000e6, "got everything back");
    }

    function testFuzz_depositsAndExitsNeverOverpay(uint96 a, uint96 b, uint256 frac) public {
        uint256 amtA = bound(a, 1e6, 1_000e6);
        uint256 amtB = bound(b, 1e6, 1_000e6);
        _deposit(0, amtA);
        _deposit(1, amtB);
        uint256 sA = pot.memberInfo(m[0]).shares;
        uint256 part = bound(frac, 1, sA);
        vm.prank(m[0]);
        pot.exit(part, m[0]);
        uint256 sB = pot.memberInfo(m[1]).shares;
        vm.prank(m[1]);
        pot.exit(sB, m[1]);
        uint256 rest = pot.memberInfo(m[0]).shares;
        if (rest > 0) {
            vm.prank(m[0]);
            pot.exit(rest, m[0]);
        }
        uint256 paid = (usdg.balanceOf(m[0]) + usdg.balanceOf(m[1])) - 2_000e6 + amtA + amtB;
        assertLe(paid, amtA + amtB, "never pays out more than went in");
        assertEq(pot.totalShares(), 0);
    }

    // ------------------------------------------------------------ allowances

    function test_allowanceSpendNoVoteAndWeeklyReset() public {
        _deposit(0, 500e6);
        assertFalse(_exec(SET_ALLOWANCE, abi.encode(m[1], uint128(50e6), uint32(7 days)), 1, _idx(0, 1, 2)));
        vm.warp(block.timestamp + 6 hours);
        assertTrue(_exec(SET_ALLOWANCE, abi.encode(m[1], uint128(50e6), uint32(7 days)), 1, _idx(0, 1, 2)));

        address shop = address(0x5409);
        vm.prank(m[1]);
        pot.spend(shop, 30e6, bytes32("dinner"));
        assertEq(usdg.balanceOf(shop), 30e6);
        assertEq(pot.allowanceLeft(m[1]), 20e6);

        vm.prank(m[1]);
        vm.expectRevert(ICoferPot.AllowanceExceeded.selector);
        pot.spend(shop, 21e6, bytes32(0));

        vm.warp(block.timestamp + 7 days);
        assertEq(pot.allowanceLeft(m[1]), 50e6, "window rolled");
        vm.prank(m[1]);
        pot.spend(shop, 50e6, bytes32(0));
    }

    function test_spendWithoutAllowanceReverts() public {
        _deposit(0, 10e6);
        vm.prank(m[0]);
        vm.expectRevert(ICoferPot.NoAllowance.selector);
        pot.spend(address(1), 1e6, bytes32(0));
    }

    // ------------------------------------------------------------ votes

    function test_transferNeedsThresholdAndWaitsGuardDelay() public {
        _deposit(0, 500e6);
        bytes memory data = abi.encode(address(usdg), address(0xF00D), uint256(100e6));
        uint64 deadline = uint64(block.timestamp + 3 days);
        bytes32 d = pot.hashProposal(TRANSFER, data, 7, 0, deadline);

        vm.expectRevert(abi.encodeWithSelector(ICoferPot.NotEnoughVotes.selector, 2, 3));
        pot.execute(TRANSFER, data, 7, 0, deadline, _votes(d, _idx2(0, 1)));

        ICoferPot.Vote[] memory v = _votes(d, _idx(0, 1, 2));
        assertFalse(pot.execute(TRANSFER, data, 7, 0, deadline, v), "queued, not executed");
        vm.expectRevert(abi.encodeWithSelector(ICoferPot.TooEarly.selector, uint64(block.timestamp + 6 hours)));
        pot.execute(TRANSFER, data, 7, 0, deadline, v);

        vm.warp(block.timestamp + 6 hours);
        vm.prank(address(0xDEAD)); // anyone can execute
        assertTrue(pot.execute(TRANSFER, data, 7, 0, deadline, v));
        assertEq(usdg.balanceOf(address(0xF00D)), 100e6);

        vm.expectRevert(ICoferPot.NonceUsed.selector);
        pot.execute(TRANSFER, data, 7, 0, deadline, v);
    }

    function test_dissenterCanExitDuringGuardDelay() public {
        _deposit(0, 100e6);
        _deposit(4, 100e6);
        bytes memory data = abi.encode(address(usdg), address(0xF00D), uint256(150e6));
        uint64 deadline = uint64(block.timestamp + 3 days);
        bytes32 d = pot.hashProposal(TRANSFER, data, 9, 0, deadline);
        ICoferPot.Vote[] memory v = _votes(d, _idx(0, 1, 2));
        pot.execute(TRANSFER, data, 9, 0, deadline, v); // queued
        uint256 s4 = pot.memberInfo(m[4]).shares;
        vm.prank(m[4]);
        pot.exit(s4, m[4]); // m[4] did not sign: leaves with exact share first
        assertGe(usdg.balanceOf(m[4]), 1_000e6 - 1, "dissenter made whole");
        vm.warp(block.timestamp + 6 hours);
        vm.expectRevert(ICoferPot.InsufficientBalance.selector);
        pot.execute(TRANSFER, data, 9, 0, deadline, v); // drain now exceeds what's left
    }

    function test_unanimousSkipsDelay() public {
        _deposit(0, 100e6);
        assertTrue(_exec(TRANSFER, abi.encode(address(usdg), address(0xF00D), uint256(10e6)), 1, _all()));
    }

    function test_unsortedOrDuplicateSignersRevert() public {
        bytes memory data = abi.encode(m[0], uint128(1e6), uint32(1 days));
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 d = pot.hashProposal(SET_ALLOWANCE, data, 1, 0, deadline);
        ICoferPot.Vote[] memory v = _votes(d, _idx(0, 1, 2));
        v[2] = v[1]; // duplicate
        vm.expectRevert(ICoferPot.UnsortedOrDuplicateSigner.selector);
        pot.execute(SET_ALLOWANCE, data, 1, 0, deadline, v);
    }

    function test_nonMemberSignerReverts() public {
        bytes memory data = abi.encode(m[0], uint128(1e6), uint32(1 days));
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 d = pot.hashProposal(SET_ALLOWANCE, data, 1, 0, deadline);
        ICoferPot.Vote[] memory v = new ICoferPot.Vote[](1);
        uint256 outsider = 0x0BAD;
        v[0] = ICoferPot.Vote(vm.addr(outsider), _sig(outsider, d));
        vm.expectRevert(abi.encodeWithSelector(ICoferPot.SignerNotMember.selector, vm.addr(outsider)));
        pot.execute(SET_ALLOWANCE, data, 1, 0, deadline, v);
    }

    function test_signatureForOtherProposalRejected() public {
        bytes memory data = abi.encode(m[0], uint128(1e6), uint32(1 days));
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 other = pot.hashProposal(SET_ALLOWANCE, data, 2, 0, deadline); // different nonce
        ICoferPot.Vote[] memory v = _votes(other, _idx(0, 1, 2));
        vm.expectRevert(); // InvalidSignature(first signer)
        pot.execute(SET_ALLOWANCE, data, 1, 0, deadline, v);
    }

    function test_revokedVoteDoesNotCount() public {
        bytes memory data = abi.encode(m[0], uint128(1e6), uint32(1 days));
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 d = pot.hashProposal(SET_ALLOWANCE, data, 1, 0, deadline);
        ICoferPot.Vote[] memory v = _votes(d, _idx(0, 1, 2));
        vm.prank(m[1]);
        pot.revokeVote(d);
        vm.expectRevert(abi.encodeWithSelector(ICoferPot.NotEnoughVotes.selector, 2, 3));
        pot.execute(SET_ALLOWANCE, data, 1, 0, deadline, v);
    }

    function test_expiredProposalReverts() public {
        bytes memory data = abi.encode(m[0], uint128(1e6), uint32(1 days));
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 d = pot.hashProposal(SET_ALLOWANCE, data, 1, 0, deadline);
        ICoferPot.Vote[] memory v = _votes(d, _all());
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(ICoferPot.Expired.selector);
        pot.execute(SET_ALLOWANCE, data, 1, 0, deadline, v);
    }

    function test_epochBumpInvalidatesPendingProposals() public {
        bytes memory data = abi.encode(m[0], uint128(1e6), uint32(1 days));
        uint64 deadline = uint64(block.timestamp + 3 days);
        bytes32 d = pot.hashProposal(SET_ALLOWANCE, data, 5, 0, deadline);
        ICoferPot.Vote[] memory v = _votes(d, _idx(0, 1, 2));

        assertTrue(_exec(ADD_MEMBER, abi.encode(address(0x6E1)), 6, _all()));
        assertEq(pot.epoch(), 1);
        assertEq(pot.memberCount(), 6);
        vm.expectRevert(ICoferPot.StaleEpoch.selector);
        pot.execute(SET_ALLOWANCE, data, 5, 0, deadline, v);
    }

    function test_removeMemberForceExitsExactShare() public {
        _deposit(2, 200e6);
        _deposit(0, 200e6);
        assertTrue(_exec(REMOVE_MEMBER, abi.encode(m[2]), 1, _all()));
        assertFalse(pot.memberInfo(m[2]).active);
        assertEq(usdg.balanceOf(m[2]), 1_000e6, "removed member made whole, never confiscated");
    }

    function test_setThresholdFixedCount() public {
        assertTrue(_exec(SET_THRESHOLD, abi.encode(uint8(4), uint16(0)), 1, _all()));
        assertEq(pot.requiredVotes(), 4);
    }

    function test_smartAccountMemberVotesViaErc1271() public {
        uint256 ownerKey = 0x5AFE;
        MockSmartAccount acct = new MockSmartAccount(vm.addr(ownerKey));
        assertTrue(_exec(ADD_MEMBER, abi.encode(address(acct)), 1, _all()));
        // now 6 members, 60% -> 4 votes; use 3 EOAs + the smart account
        bytes memory data = abi.encode(m[0], uint128(5e6), uint32(1 days));
        uint64 deadline = uint64(block.timestamp + 3 days);
        bytes32 d = pot.hashProposal(SET_ALLOWANCE, data, 2, 1, deadline);
        ICoferPot.Vote[] memory base = _votes(d, _idx(0, 1, 2));
        ICoferPot.Vote[] memory v = new ICoferPot.Vote[](4);
        ICoferPot.Vote memory sa = ICoferPot.Vote(address(acct), _sig(ownerKey, d));
        uint256 k;
        bool placed;
        for (uint256 i; i < 3; ++i) {
            if (!placed && address(acct) < base[i].signer) {
                v[k++] = sa;
                placed = true;
            }
            v[k++] = base[i];
        }
        if (!placed) v[k] = sa;
        assertFalse(pot.execute(SET_ALLOWANCE, data, 2, 1, deadline, v), "4 of 6 queues");
    }

    // ------------------------------------------------------------ swaps

    function _buyTsla(uint256 usdgIn) internal {
        uint256 fee = (usdgIn * 30) / 10000;
        uint256 expected = factory.quote(address(usdg), address(tsla), usdgIn - fee);
        bytes memory data = _swapData(address(usdg), address(tsla), usdgIn, (expected * 99) / 100);
        assertTrue(_exec(SWAP, data, uint256(keccak256(abi.encode(usdgIn, block.timestamp))), _idx(0, 1, 2)));
    }

    function test_swapBuysStockTakesFeeNoDelay() public {
        _deposit(0, 1_000e6);
        _buyTsla(1_000e6);
        assertEq(usdg.balanceOf(address(feeRouter)), 3e6, "0.30% fee");
        assertEq(tsla.balanceOf(address(pot)), (997e6 * 4e27) / 1e18);
        assertEq(pot.heldAssets().length, 2);
        (uint256 nav, uint256 other) = pot.navUsdg();
        assertEq(other, 997e6, "valued with feed answer only (no multiplier re-applied)");
        assertEq(nav, 997e6);
    }

    function test_swapRejectsLooseMinOut() public {
        _deposit(0, 100e6);
        bytes memory data = _swapData(address(usdg), address(tsla), 100e6, 1);
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 d = pot.hashProposal(SWAP, data, 1, 0, deadline);
        vm.expectRevert();
        pot.execute(SWAP, data, 1, 0, deadline, _votes(d, _idx(0, 1, 2)));
    }

    function test_swapRevertsIfPoolPaysLessThanMinOut() public {
        _deposit(0, 100e6);
        router.setSkimBps(500); // bad pool: 5% short
        uint256 expected = factory.quote(address(usdg), address(tsla), 100e6 - 0.3e6);
        bytes memory data = _swapData(address(usdg), address(tsla), 100e6, (expected * 98) / 100);
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 d = pot.hashProposal(SWAP, data, 1, 0, deadline);
        vm.expectRevert();
        pot.execute(SWAP, data, 1, 0, deadline, _votes(d, _idx(0, 1, 2)));
    }

    function test_swapRevertsOnStaleFeed() public {
        _deposit(0, 100e6);
        bytes memory data = _swapData(address(usdg), address(tsla), 100e6, 1e17);
        vm.warp(block.timestamp + 5 days);
        usdgFeed.set(1e8);
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 d = pot.hashProposal(SWAP, data, 1, 0, deadline);
        vm.expectRevert();
        pot.execute(SWAP, data, 1, 0, deadline, _votes(d, _idx(0, 1, 2)));
    }

    function test_swapToUnlistedAssetReverts() public {
        _deposit(0, 100e6);
        bytes memory data = abi.encode(address(adapter), address(usdg), address(0xBEEF), uint256(10e6), uint256(1), _path(address(usdg), address(0xBEEF)));
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 d = pot.hashProposal(SWAP, data, 1, 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(ICoferPot.AssetNotBuyable.selector, address(0xBEEF)));
        pot.execute(SWAP, data, 1, 0, deadline, _votes(d, _idx(0, 1, 2)));
    }

    function test_sellStockBackAndAssetPruned() public {
        _deposit(0, 500e6);
        _buyTsla(250e6);
        uint256 bal = tsla.balanceOf(address(pot));
        uint256 expected = factory.quote(address(tsla), address(usdg), bal - (bal * 30) / 10000);
        bytes memory data = _swapData(address(tsla), address(usdg), bal, (expected * 99) / 100);
        assertTrue(_exec(SWAP, data, 99, _idx(0, 1, 2)));
        assertEq(tsla.balanceOf(address(pot)), 0);
        assertEq(pot.heldAssets().length, 1, "TSLA pruned from held list");
    }

    function test_payPlan() public {
        _deposit(0, 100e6);
        assertTrue(_exec(PAY_PLAN, abi.encode(uint8(3)), 1, _all()));
        assertEq(usdg.balanceOf(address(feeRouter)), 30e6);
        assertEq(feeRouter.planPaidUntil(address(pot)), block.timestamp + 90 days);
    }
}
