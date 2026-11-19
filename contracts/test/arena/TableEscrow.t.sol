// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArenaBase} from "./ArenaBase.sol";
import {ArenaTypes} from "../../src/arena/ArenaTypes.sol";
import {TableEscrow} from "../../src/arena/TableEscrow.sol";
import {TableFactory} from "../../src/arena/TableFactory.sol";
import {ResultRegistry} from "../../src/arena/ResultRegistry.sol";
import {ITableEscrow} from "../../src/interfaces/arena/ITableEscrow.sol";
import {MockSmartAccount} from "../../src/mocks/Mocks.sol";
import {SafeTransferLib} from "../../src/lib/SafeTransferLib.sol";

contract TableEscrowTest is ArenaBase {
    // ------------------------------------------------------------------ A18: initialisation

    function test_implementationLocked() public {
        ArenaTypes.TableParams memory p = _friend(2, 5, uint64(block.timestamp + 1 hours));
        vm.expectRevert(TableEscrow.AlreadyInitialized.selector);
        impl.initialize(p, host, host, 1, address(1));
    }

    function test_initOnce() public {
        ArenaTypes.TableParams memory p = _friend(2, 5, uint64(block.timestamp + 1 hours));
        TableEscrow t = _create(p);
        vm.expectRevert(TableEscrow.AlreadyInitialized.selector);
        t.initialize(p, address(this), address(this), 1, address(1));
        assertEq(t.host(), host);
        assertTrue(factory.isTable(address(t)));
        assertEq(address(t), factory.predictTable(host, bytes32(nextSalt)));
    }

    // ------------------------------------------------------------------ happy path

    function test_friendTableFullPath() public {
        TableEscrow t = _lockedFriend();
        assertEq(uint256(t.state()), uint256(ArenaTypes.State.Locked));
        assertEq(usdg.balanceOf(address(t)), 150e6);
        assertEq(factory.liveValue(), 150e6);
        assertEq(t.endAt(), t.lockedAt() + 24 hours);
        assertEq(t.hardDeadline(), t.endAt() + 24 hours);

        vm.warp(t.endAt());
        _post(t, _result(0, players[1], players[0]));
        assertEq(uint256(t.state()), uint256(ArenaTypes.State.Settling));
        vm.warp(t.disputeEnd());
        t.finalize();
        assertEq(uint256(t.state()), uint256(ArenaTypes.State.Settled));
        assertEq(t.owed(players[1]), 105e6);
        assertEq(t.owed(players[0]), 45e6);
        assertEq(t.owed(players[2]), 0);

        uint256 before = usdg.balanceOf(players[1]);
        vm.prank(players[1]);
        t.claim(address(0));
        assertEq(usdg.balanceOf(players[1]) - before, 105e6);
        vm.prank(players[0]);
        t.claim(address(0));
        assertEq(usdg.balanceOf(address(t)), 0);
        assertEq(factory.liveValue(), 0);
    }

    function test_sitAndGoLocksWhenFull() public {
        TableEscrow t = _create(_friend(2, 3, 0));
        _join(t, 0);
        _join(t, 1);
        assertEq(uint256(t.state()), uint256(ArenaTypes.State.Open));
        _join(t, 2);
        assertEq(uint256(t.state()), uint256(ArenaTypes.State.Locked));
        assertEq(t.lockedAt(), block.timestamp);
    }

    // ------------------------------------------------------------------ joins (A7, A14)

    function test_joinNeedsEligibility() public {
        TableEscrow t = _create(_friend(2, 5, uint64(block.timestamp + 1 hours)));
        vm.prank(players[0]);
        usdg.approve(address(t), type(uint256).max);
        // signed for another player
        bytes memory e = _elig(t, players[1], true);
        vm.prank(players[0]);
        vm.expectRevert(TableEscrow.BadEligibility.selector);
        t.join(_skh(0), "", e);
        // too long an expiry
        uint64 exp = uint64(block.timestamp + 11 minutes);
        bytes32 h = t.hashTyped(keccak256(abi.encode(t.ELIGIBILITY_TYPEHASH(), address(t), players[0], uint8(0), true, exp)));
        vm.prank(players[0]);
        vm.expectRevert(TableEscrow.BadEligibility.selector);
        t.join(_skh(0), "", abi.encode(true, exp, _sign(ELIG_KEY, h)));
        // a Friend Table needs prize eligibility
        bytes memory notPrize = _elig(t, players[0], false);
        vm.prank(players[0]);
        vm.expectRevert(TableEscrow.NotPrizeEligible.selector);
        t.join(_skh(0), "", notPrize);
    }

    function test_inviteRequiredWhenSet() public {
        ArenaTypes.TableParams memory p = _friend(2, 5, uint64(block.timestamp + 1 hours));
        p.inviteSigner = vm.addr(INVITE_KEY);
        TableEscrow t = _create(p);
        vm.prank(players[0]);
        usdg.approve(address(t), type(uint256).max);
        bytes memory e = _elig(t, players[0], true);
        bytes memory wrongInvite = _invite(t, players[1]);
        vm.prank(players[0]);
        vm.expectRevert(TableEscrow.BadInvite.selector);
        t.join(_skh(0), wrongInvite, e);
        bytes memory inv = _invite(t, players[0]);
        vm.prank(players[0]);
        t.join(_skh(0), inv, e);
        (uint16 seat,,) = t.seatOf(players[0]);
        assertEq(seat, 1);
    }

    function test_cannotJoinTwiceOrWhenFull() public {
        TableEscrow t = _create(_friend(2, 2, uint64(block.timestamp + 1 hours)));
        _join(t, 0);
        bytes memory e = _elig(t, players[0], true);
        vm.prank(players[0]);
        vm.expectRevert(TableEscrow.AlreadySeated.selector);
        t.join(_skh(9), "", e);
        _join(t, 1);
        vm.prank(players[2]);
        usdg.approve(address(t), type(uint256).max);
        bytes memory e2 = _elig(t, players[2], true);
        vm.prank(players[2]);
        vm.expectRevert(TableEscrow.Full.selector);
        t.join(_skh(2), "", e2);
    }

    function test_joinWithPermit() public {
        TableEscrow t = _create(_friend(2, 5, uint64(block.timestamp + 1 hours)));
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(usdg.PERMIT_TYPEHASH(), players[0], address(t), uint256(BUY_IN), usdg.nonces(players[0]), deadline))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(playerKeys[0], digest);
        bytes memory e = _elig(t, players[0], true);
        vm.prank(players[0]);
        t.joinWithPermit(_skh(0), "", e, deadline, v, r, s);
        assertEq(usdg.balanceOf(address(t)), BUY_IN);
    }

    function _auth(TableEscrow t, uint256 i, bytes32 skh) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 nonce = t.joinNonce(players[i], skh, "");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), keccak256(abi.encode(
            usdg.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), players[i], address(t), uint256(BUY_IN), uint256(0), block.timestamp + 1 hours, nonce))));
        (v, r, s) = vm.sign(playerKeys[i], digest);
    }

    function test_3009Join() public {
        TableEscrow t = _create(_friend(2, 5, uint64(block.timestamp + 1 hours)));
        (uint8 v, bytes32 r, bytes32 s) = _auth(t, 0, _skh(0));
        bytes memory e = _elig(t, players[0], true);
        t.joinWithAuthorization(players[0], _skh(0), "", e, 0, block.timestamp + 1 hours, v, r, s); // relayer
        (uint16 seat, bytes32 key,) = t.seatOf(players[0]);
        assertEq(seat, 1);
        assertEq(key, _skh(0));
        assertEq(usdg.balanceOf(address(t)), BUY_IN);
    }

    function test_3009NonceBindsSessionKey() public {
        TableEscrow t = _create(_friend(2, 5, uint64(block.timestamp + 1 hours)));
        (uint8 v, bytes32 r, bytes32 s) = _auth(t, 0, _skh(0));
        bytes memory e = _elig(t, players[0], true);
        // a relayer that swaps in its own session key changes the nonce, so the player's signature fails
        vm.expectRevert(bytes("InvalidSignature"));
        t.joinWithAuthorization(players[0], keccak256("relayer key"), "", e, 0, block.timestamp + 1 hours, v, r, s);
    }

    // ------------------------------------------------------------------ leave, kick, cancel (A5, A13)

    function test_leaveCutoff() public {
        TableEscrow t = _create(_friend(2, 5, uint64(block.timestamp + 1 hours)));
        _join(t, 0);
        _join(t, 1);
        uint256 before = usdg.balanceOf(players[0]);
        vm.prank(players[0]);
        t.leave();
        assertEq(usdg.balanceOf(players[0]) - before, BUY_IN);
        assertEq(factory.liveValue(), BUY_IN);
        vm.warp(t.params().lockAt - 10 minutes + 1);
        vm.prank(players[1]);
        vm.expectRevert(TableEscrow.LeaveClosed.selector);
        t.leave();
    }

    function test_kickRefundsKicked() public {
        TableEscrow t = _create(_friend(2, 5, uint64(block.timestamp + 1 hours)));
        _join(t, 0);
        _join(t, 1);
        _join(t, 2);
        vm.prank(players[0]);
        vm.expectRevert(TableEscrow.NotHost.selector);
        t.kick(players[1]);
        vm.prank(host);
        t.kick(players[0]);
        assertEq(t.owed(players[0]), BUY_IN);
        (uint16 seatMoved,,) = t.seatOf(players[2]);
        assertEq(seatMoved, 1);
        assertEq(t.seats().length, 2);
        uint256 before = usdg.balanceOf(players[0]);
        vm.prank(players[0]);
        t.claim(address(0)); // claimable at once, the table is still Open
        assertEq(usdg.balanceOf(players[0]) - before, BUY_IN);
    }

    function test_neverLockedTableCancels() public {
        TableEscrow t = _create(_friend(2, 5, uint64(block.timestamp + 1 hours)));
        _join(t, 0);
        _join(t, 1);
        vm.expectRevert(TableEscrow.CannotCancel.selector);
        t.cancel();
        vm.warp(t.params().lockAt + 1 hours);
        vm.expectRevert(TableEscrow.CannotLock.selector);
        t.lock();
        t.cancel();
        assertEq(uint256(t.state()), uint256(ArenaTypes.State.Refunded));
        assertEq(t.owed(players[0]), BUY_IN);
        assertEq(t.owed(players[1]), BUY_IN);
    }

    function test_tooFewSeatsAtLockAtCancels() public {
        TableEscrow t = _create(_friend(3, 5, uint64(block.timestamp + 1 hours)));
        _join(t, 0);
        _join(t, 1);
        vm.warp(t.params().lockAt);
        vm.expectRevert(TableEscrow.CannotLock.selector);
        t.lock();
        t.cancel();
        assertEq(uint256(t.state()), uint256(ArenaTypes.State.Refunded));
    }

    function test_partialSitAndGoCancels() public {
        TableEscrow t = _create(_friend(2, 4, 0));
        _join(t, 0);
        _join(t, 1);
        vm.expectRevert(TableEscrow.CannotCancel.selector);
        t.cancel();
        vm.warp(t.params().openUntil);
        t.cancel();
        assertEq(t.owed(players[0]), BUY_IN);
    }

    function test_hostCancelsWhenAlone() public {
        TableEscrow t = _create(_friend(2, 4, uint64(block.timestamp + 1 hours)));
        vm.prank(host);
        usdg.approve(address(t), type(uint256).max);
        bytes memory e = _elig(t, host, true);
        vm.prank(host);
        t.join(_skh(99), "", e);
        vm.prank(players[0]);
        vm.expectRevert(TableEscrow.CannotCancel.selector);
        t.cancel();
        vm.prank(host);
        t.cancel();
        assertEq(t.owed(host), BUY_IN);
    }

    // ------------------------------------------------------------------ results (A8, A9)

    function test_resultNeeds_k_of_snapshotSet() public {
        TableEscrow t = _lockedFriend();
        vm.warp(t.endAt());
        ITableEscrow.Result memory r = _result(0, players[0], players[1]);
        bytes32 d = registry.resultDigest(address(t), r);
        uint256[] memory one = new uint256[](1);
        one[0] = 2;
        bytes[] memory sigs = _sigs(d, one);
        vm.expectRevert(TableEscrow.BadSignatures.selector);
        t.postResult(r, sigs);
        // duplicates fail (not strictly ascending)
        bytes[] memory dup = new bytes[](2);
        dup[0] = _sign(signerKeys[0], d);
        dup[1] = dup[0];
        vm.expectRevert(TableEscrow.BadSignatures.selector);
        t.postResult(r, dup);
        // an outsider's key does not count
        bytes[] memory mixed = new bytes[](2);
        bytes memory a = _sign(signerKeys[0], d);
        bytes memory b = _sign(0xDEAD, d);
        (mixed[0], mixed[1]) = vm.addr(signerKeys[0]) < vm.addr(0xDEAD) ? (a, b) : (b, a);
        vm.expectRevert(TableEscrow.BadSignatures.selector);
        t.postResult(r, mixed);
        // signed for another table does not count
        TableEscrow other = _lockedFriendFrom(3);
        bytes32 dOther = registry.resultDigest(address(other), r);
        vm.expectRevert(TableEscrow.BadSignatures.selector);
        t.postResult(r, _sigs(dOther, _two()));
        t.postResult(r, _sigs(d, _two()));
    }

    function _lockedFriendFrom(uint256 first) internal returns (TableEscrow t) {
        t = _create(_friend(2, 5, uint64(block.timestamp + 1 hours)));
        _join(t, first);
        _join(t, first + 1);
        vm.warp(t.params().lockAt);
        t.lock();
    }

    function test_rotationDoesNotReachLiveTable() public {
        TableEscrow t = _lockedFriend();
        assertEq(t.signerSetId(), 1);
        address[] memory s = new address[](3);
        s[0] = vm.addr(0x7001);
        s[1] = vm.addr(0x7002);
        s[2] = vm.addr(0x7003);
        registry.queueSignerSet(s, 2);
        vm.expectRevert(ResultRegistry.TooEarly.selector);
        registry.applySignerSet();
        vm.warp(block.timestamp + 48 hours);
        registry.applySignerSet();
        assertEq(registry.currentSetId(), 2);
        vm.warp(t.endAt());
        ITableEscrow.Result memory r = _result(0, players[0], players[1]);
        bytes32 d = registry.resultDigest(address(t), r);
        uint256[] memory newKeys = new uint256[](2);
        newKeys[0] = 0x7001;
        newKeys[1] = 0x7002;
        bytes[] memory sigs = new bytes[](2);
        bytes memory a = _sign(0x7001, d);
        bytes memory b = _sign(0x7002, d);
        (sigs[0], sigs[1]) = vm.addr(0x7001) < vm.addr(0x7002) ? (a, b) : (b, a);
        vm.expectRevert(TableEscrow.BadSignatures.selector);
        t.postResult(r, sigs);
        t.postResult(r, _sigs(d, _two())); // the snapshot set still works
    }

    function test_revokedSignerDoesNotCount() public {
        TableEscrow t = _lockedFriend();
        vm.prank(guardian);
        registry.revokeSigner(vm.addr(signerKeys[0]));
        vm.warp(t.endAt());
        ITableEscrow.Result memory r = _result(0, players[0], players[1]);
        bytes32 d = registry.resultDigest(address(t), r);
        bytes[] memory sigs = _sigs(d, _two()); // keys 0 and 1
        vm.expectRevert(TableEscrow.BadSignatures.selector);
        t.postResult(r, sigs);
        uint256[] memory w = new uint256[](2);
        w[0] = 1;
        w[1] = 2;
        t.postResult(r, _sigs(d, w));
    }

    function test_noFinalizeInWindow() public {
        TableEscrow t = _lockedFriend();
        vm.warp(t.endAt() - 1);
        ITableEscrow.Result memory r = _result(0, players[0], players[1]);
        bytes32 d = registry.resultDigest(address(t), r);
        bytes[] memory sigs = _sigs(d, _two());
        vm.expectRevert(TableEscrow.TooEarly.selector);
        t.postResult(r, sigs);
        vm.warp(t.endAt());
        t.postResult(r, sigs);
        vm.warp(t.disputeEnd() - 1);
        vm.expectRevert(TableEscrow.TooEarly.selector);
        t.finalize();
        vm.warp(t.disputeEnd());
        t.finalize();
    }

    function test_podiumMustBeSeatedAndDistinct() public {
        TableEscrow t = _lockedFriend();
        vm.warp(t.endAt());
        ITableEscrow.Result memory r = _result(0, players[0], players[5]);
        bytes32 d = registry.resultDigest(address(t), r);
        bytes[] memory sigs = _sigs(d, _two());
        vm.expectRevert(TableEscrow.BadPodium.selector);
        t.postResult(r, sigs);
        r = _result(0, players[0], players[0]);
        d = registry.resultDigest(address(t), r);
        sigs = _sigs(d, _two());
        vm.expectRevert(TableEscrow.BadPodium.selector);
        t.postResult(r, sigs);
    }

    // ------------------------------------------------------------------ disputes (§3.7)

    function _disputed() internal returns (TableEscrow t) {
        t = _lockedFriend();
        vm.warp(t.endAt());
        _post(t, _result(0, players[0], players[1]));
        vm.prank(players[2]);
        t.dispute(keccak256("wrong marks"));
        assertEq(uint256(t.state()), uint256(ArenaTypes.State.Disputed));
    }

    function test_disputePullsBond() public {
        uint256 before = usdg.balanceOf(players[2]);
        TableEscrow t = _disputed();
        assertEq(before - usdg.balanceOf(players[2]), BUY_IN + 10e6); // buy-in + 20% bond
        (address who, uint256 bond) = t.dispute_();
        assertEq(who, players[2]);
        assertEq(bond, 10e6);
    }

    function test_bondForfeitedWhenPodiumUnchanged() public {
        TableEscrow t = _disputed();
        _post(t, _result(1, players[0], players[1]));
        vm.warp(t.disputeEnd());
        t.finalize();
        assertEq(t.owed(players[0]), 112e6); // (150 + 10) * 70%
        assertEq(t.owed(players[1]), 48e6);
        assertEq(t.owed(players[2]), 0);
    }

    function test_bondReturnedWhenPodiumChanged() public {
        TableEscrow t = _disputed();
        _post(t, _result(1, players[2], players[0]));
        vm.warp(t.disputeEnd());
        t.finalize();
        assertEq(t.owed(players[2]), 105e6 + 10e6);
        assertEq(t.owed(players[0]), 45e6);
    }

    function test_roundOneDisputeIsObjectionOnly() public {
        TableEscrow t = _disputed();
        _post(t, _result(1, players[0], players[1]));
        vm.prank(players[2]);
        t.dispute(keccak256("still wrong"));
        assertEq(uint256(t.state()), uint256(ArenaTypes.State.Settling));
        vm.warp(t.disputeEnd());
        t.finalize();
    }

    function test_onlySeatedCanDispute() public {
        TableEscrow t = _lockedFriend();
        vm.warp(t.endAt());
        _post(t, _result(0, players[0], players[1]));
        vm.prank(players[5]);
        vm.expectRevert(TableEscrow.NotSeated.selector);
        t.dispute(bytes32(0));
    }

    // ------------------------------------------------------------------ deadline refund (A5, A19)

    function test_refundAllWorksWithEverythingPausedOrRevoked() public {
        TableEscrow t = _lockedFriend();
        factory.setCreationPaused(true);
        for (uint256 i; i < 3; ++i) registry.revokeSigner(vm.addr(signerKeys[i]));
        vm.warp(t.hardDeadline() - 1);
        vm.expectRevert(TableEscrow.TooEarly.selector);
        t.refundAll();
        vm.warp(t.hardDeadline());
        vm.prank(address(0xBEEF)); // anyone
        t.refundAll();
        assertEq(uint256(t.state()), uint256(ArenaTypes.State.Refunded));
        for (uint256 i; i < 3; ++i) {
            vm.prank(players[i]);
            t.claim(address(0));
        }
        assertEq(usdg.balanceOf(address(t)), 0);
        assertEq(factory.liveValue(), 0);
    }

    function test_refundAllReturnsBondWhenNoRevision() public {
        TableEscrow t = _disputed();
        vm.warp(t.hardDeadline());
        t.refundAll();
        assertEq(t.owed(players[2]), BUY_IN + 10e6);
        assertEq(t.owed(players[0]), BUY_IN);
    }

    function test_refundAllCannotPreemptFinalize() public {
        TableEscrow t = _lockedFriend();
        vm.warp(t.endAt());
        _post(t, _result(0, players[0], players[1]));
        vm.warp(t.hardDeadline());
        vm.expectRevert(TableEscrow.UseFinalize.selector);
        t.refundAll();
        t.finalize();
        assertEq(uint256(t.state()), uint256(ArenaTypes.State.Settled));
    }

    function test_postTooLateReverts() public {
        TableEscrow t = _lockedFriend();
        vm.warp(t.hardDeadline() - 4 hours + 1); // less than 2 x 2 h left
        ITableEscrow.Result memory r = _result(0, players[0], players[1]);
        bytes32 d = registry.resultDigest(address(t), r);
        bytes[] memory sigs = _sigs(d, _two());
        vm.expectRevert(TableEscrow.TooLate.selector);
        t.postResult(r, sigs);
    }

    // ------------------------------------------------------------------ unanimous accept / void (A6)

    function _accounts() internal returns (TableEscrow t, MockSmartAccount acct) {
        acct = new MockSmartAccount(players[3]);
        usdg.mint(address(acct), 100e6);
        t = _create(_friend(2, 5, uint64(block.timestamp + 1 hours)));
        _join(t, 0);
        bytes memory e = _elig(t, address(acct), true);
        vm.startPrank(players[3]);
        acct.call(address(usdg), abi.encodeWithSignature("approve(address,uint256)", address(t), type(uint256).max));
        acct.call(address(t), abi.encodeCall(TableEscrow.join, (_skh(3), "", e)));
        vm.stopPrank();
    }

    function test_voidAllWithPasskeyAccount() public {
        (TableEscrow t, MockSmartAccount acct) = _accounts();
        bytes32 h = t.hashTyped(keccak256(abi.encode(t.VOID_TYPEHASH(), address(t))));
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(playerKeys[0], h);
        sigs[1] = _sign(playerKeys[3], h); // ERC-1271 account owned by player 3
        bytes[] memory bad = new bytes[](2);
        bad[0] = sigs[0];
        bad[1] = _sign(playerKeys[4], h);
        vm.expectRevert(TableEscrow.BadSignatures.selector);
        t.voidAll(bad);
        t.voidAll(sigs);
        assertEq(uint256(t.state()), uint256(ArenaTypes.State.Refunded));
        assertEq(t.owed(address(acct)), BUY_IN);
    }

    function test_acceptAllSettlesAtOnce() public {
        TableEscrow t = _lockedFriend();
        vm.warp(t.endAt());
        _post(t, _result(0, players[0], players[1]));
        (, bytes32 digest,,,) = t.currentResult();
        bytes32 h = t.hashTyped(keccak256(abi.encode(t.ACCEPT_TYPEHASH(), address(t), digest)));
        bytes[] memory sigs = new bytes[](3);
        address[] memory s = t.seats();
        for (uint256 i; i < 3; ++i) {
            for (uint256 k; k < 6; ++k) if (players[k] == s[i]) sigs[i] = _sign(playerKeys[k], h);
        }
        t.acceptAll(sigs);
        assertEq(uint256(t.state()), uint256(ArenaTypes.State.Settled));
    }

    function test_terminalStatesFinal() public {
        TableEscrow t = _lockedFriend();
        vm.warp(t.hardDeadline());
        t.refundAll();
        vm.expectRevert(TableEscrow.BadState.selector);
        t.refundAll();
        vm.expectRevert(TableEscrow.BadState.selector);
        t.finalize();
        vm.expectRevert(TableEscrow.BadState.selector);
        t.lock();
        vm.expectRevert(TableEscrow.BadState.selector);
        t.cancel();
        bytes[] memory none = new bytes[](0);
        vm.expectRevert(TableEscrow.BadState.selector);
        t.voidAll(none);
    }

    // ------------------------------------------------------------------ claims (A10, A11)

    function test_frozenClaimantDoesNotBlockOthers() public {
        TableEscrow t = _lockedFriend();
        vm.warp(t.endAt());
        _post(t, _result(0, players[0], players[1]));
        vm.warp(t.disputeEnd());
        t.finalize();
        usdg.setFrozen(players[0], true);
        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(SafeTransferLib.TransferFailed.selector, address(usdg)));
        t.claim(address(0));
        assertEq(t.owed(players[0]), 105e6);
        vm.prank(players[1]);
        t.claim(address(0));
        assertEq(t.owed(players[1]), 0);
        usdg.setFrozen(players[0], false);
        vm.prank(players[0]);
        t.claim(address(0));
    }

    function test_claimTwiceFails() public {
        TableEscrow t = _lockedFriend();
        vm.warp(t.hardDeadline());
        t.refundAll();
        vm.prank(players[0]);
        t.claim(players[5]);
        assertEq(usdg.balanceOf(players[5]), 1_000e6 + BUY_IN);
        vm.prank(players[0]);
        vm.expectRevert(TableEscrow.NothingOwed.selector);
        t.claim(address(0));
    }

    // ------------------------------------------------------------------ caps (§3.11, A12)

    function test_capsOnCreate() public {
        ArenaTypes.TableParams memory p = _friend(2, 5, uint64(block.timestamp + 1 hours));
        p.buyIn = 51e6;
        vm.expectRevert(TableFactory.BadParam.selector);
        factory.createTable(p, bytes32(0));
        p.buyIn = 50e6;
        p.maxSeats = 11;
        vm.expectRevert(TableFactory.BadParam.selector);
        factory.createTable(p, bytes32(0));
        p.maxSeats = 10;
        p.buyIn = 50e6 + 1; // 10 x 50.000001 > 500
        vm.expectRevert(TableFactory.BadParam.selector);
        factory.createTable(p, bytes32(0));
        p = _friend(2, 5, uint64(block.timestamp + 1 hours));
        p.cryptoOnly = false;
        vm.expectRevert(TableFactory.BadParam.selector);
        factory.createTable(p, bytes32(0));
        p = _friend(2, 5, uint64(block.timestamp + 1 hours));
        p.duration = 24 hours - 1;
        vm.expectRevert(TableFactory.BadParam.selector);
        factory.createTable(p, bytes32(0));
    }

    function test_liveValueCap() public {
        factory.queueCaps(50e6, 500e6, 120e6);
        vm.warp(block.timestamp + 48 hours);
        factory.applyCaps();
        TableEscrow t = _create(_friend(2, 5, uint64(block.timestamp + 1 hours)));
        _join(t, 0);
        _join(t, 1);
        vm.prank(players[2]);
        usdg.approve(address(t), type(uint256).max);
        bytes memory e = _elig(t, players[2], true);
        vm.prank(players[2]);
        vm.expectRevert(TableFactory.OverLiveCap.selector);
        t.join(_skh(2), "", e);
    }

    function test_capChangesDoNotReachLiveTables() public {
        TableEscrow t = _create(_friend(2, 5, uint64(block.timestamp + 1 hours)));
        factory.queueCaps(10e6, 100e6, 1_000e6);
        vm.warp(block.timestamp + 48 hours);
        // the table is past its lockAt now; make a fresh one to check the old params still apply
        assertEq(t.params().buyIn, BUY_IN);
        factory.applyCaps();
        assertEq(t.params().buyIn, BUY_IN);
    }

    function test_pauseStopsNewTablesOnly() public {
        TableEscrow t = _create(_friend(2, 5, uint64(block.timestamp + 1 hours)));
        vm.prank(guardian);
        factory.setCreationPaused(true);
        ArenaTypes.TableParams memory p = _friend(2, 5, uint64(block.timestamp + 1 hours));
        vm.prank(host);
        vm.expectRevert(TableFactory.Paused.selector);
        factory.createTable(p, bytes32(uint256(777)));
        _join(t, 0); // the live table keeps working
        _join(t, 1);
    }

    function test_onlyTablesTouchLiveValue() public {
        vm.expectRevert(TableFactory.NotTableErr.selector);
        factory.reserve(1);
        vm.expectRevert(TableFactory.NotTableErr.selector);
        factory.release(1);
    }

    // ------------------------------------------------------------------ fuzz (A2, A7, A10)

    function testFuzz_payoutSplitExact(uint96 buyIn, uint8 nSeats, uint16 a, uint16 b) public {
        buyIn = uint96(bound(buyIn, 1e6, 50e6));
        nSeats = uint8(bound(nSeats, 3, 6));
        a = uint16(bound(a, 1, 9_998));
        b = uint16(bound(b, 1, 9_999 - a));
        ArenaTypes.TableParams memory p = _friend(3, 6, uint64(block.timestamp + 1 hours));
        p.buyIn = buyIn;
        p.payoutBps = new uint16[](3);
        p.payoutBps[0] = a;
        p.payoutBps[1] = b;
        p.payoutBps[2] = 10_000 - a - b;
        TableEscrow t = _create(p);
        for (uint256 i; i < nSeats; ++i) _join(t, i);
        vm.warp(p.lockAt);
        t.lock();
        vm.warp(t.endAt());
        ITableEscrow.Result memory r = _result(0, players[0], players[1]);
        r.podium = new address[](3);
        r.podium[0] = players[2];
        r.podium[1] = players[0];
        r.podium[2] = players[1];
        _post(t, r);
        vm.warp(t.disputeEnd());
        t.finalize();
        uint256 total = t.owed(players[0]) + t.owed(players[1]) + t.owed(players[2]);
        assertEq(total, uint256(buyIn) * nSeats, "pot conserved");
        assertEq(usdg.balanceOf(address(t)), total, "solvent");
    }

    function testFuzz_joinBounds(uint8 n) public {
        n = uint8(bound(n, 1, 6));
        TableEscrow t = _create(_friend(2, 5, uint64(block.timestamp + 1 hours)));
        for (uint256 i; i < n && i < 5; ++i) _join(t, i);
        uint256 seated = n < 5 ? n : 5;
        assertEq(t.seats().length, seated);
        assertEq(usdg.balanceOf(address(t)), seated * BUY_IN);
        assertLe(usdg.balanceOf(address(t)), factory.maxTablePot(), "pot <= cap");
    }

    function testFuzz_doubleClaim(uint8 who) public {
        who = uint8(bound(who, 0, 2));
        TableEscrow t = _lockedFriend();
        vm.warp(t.hardDeadline());
        t.refundAll();
        vm.prank(players[who]);
        t.claim(address(0));
        vm.prank(players[who]);
        vm.expectRevert(TableEscrow.NothingOwed.selector);
        t.claim(address(0));
    }
}
