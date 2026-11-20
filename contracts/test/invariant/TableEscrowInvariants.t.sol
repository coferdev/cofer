// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "../utils/Test.sol";
import {MockERC20} from "../../src/mocks/Mocks.sol";
import {MockUSDG3009} from "../arena/ArenaMocks.sol";
import {ArenaTypes} from "../../src/arena/ArenaTypes.sol";
import {ResultRegistry} from "../../src/arena/ResultRegistry.sol";
import {TableFactory} from "../../src/arena/TableFactory.sol";
import {TableEscrow} from "../../src/arena/TableEscrow.sol";
import {ITableEscrow} from "../../src/interfaces/arena/ITableEscrow.sol";

/// @notice Drives real Friend Tables through random sequences of everything players, the host, the signers and
///         strangers can do: join, leave, kick, lock, cancel, post results (both rounds), dispute, finalize,
///         unanimous void, deadline refund and claims, with time moving. When a table reaches a final state a
///         fresh one is created. Each action records anything that breaks a rule in a flag the invariants read.
contract TableHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockUSDG3009 public usdg;
    ResultRegistry public registry;
    TableFactory public factory;
    TableEscrow public tbl;

    uint256 internal constant ELIG_KEY = 0xE11;
    uint256[3] internal signerKeys = [uint256(0x5161), 0x5162, 0x5163];
    uint256[4] internal playerKeys = [uint256(0xB1), 0xB2, 0xB3, 0xB4];
    address[4] public players;
    address public constant STRANGER = address(0x5757);
    uint256 internal salt;
    uint256 internal skhNonce;

    // per current table
    ArenaTypes.State public finalStateSeen; // first final state reached
    bool public reachedFinal;
    // rule breaks
    bool public finalStateLeft; // A6
    bool public deadlineRefundFailed; // A5
    bool public strangerPaid; // A4
    bool public overPaid; // A10: a claim paid more than the credit
    bool public potNotConserved; // A2
    uint256 public doneCount;

    constructor() {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG3009();
        MockERC20 cofr = new MockERC20("Cofer", "COFR", 18);
        address[] memory s = new address[](3);
        for (uint256 i; i < 3; ++i) s[i] = vm.addr(signerKeys[i]);
        registry = new ResultRegistry(address(this), address(0x6A), s, 2);
        TableEscrow impl = new TableEscrow();
        factory = new TableFactory(
            address(usdg), address(cofr), address(registry), address(impl), address(this), address(0x6A), vm.addr(ELIG_KEY),
            50e6, 500e6, 400e6, 0
        );
        registry.setFactory(address(factory));
        for (uint256 i; i < 4; ++i) {
            players[i] = vm.addr(playerKeys[i]);
            usdg.mint(players[i], 1_000_000e6);
        }
        _newTable(0);
    }

    function _newTable(uint256 seed) internal {
        ArenaTypes.TableParams memory p;
        p.mode = ArenaTypes.Mode.FRIEND;
        p.token = address(usdg);
        p.buyIn = uint96(1e6 + (seed % 50) * 1e6 - (seed % 50 == 49 ? 0 : 0));
        if (p.buyIn > 50e6) p.buyIn = 50e6;
        p.minSeats = 2;
        p.maxSeats = 4;
        p.lockAt = seed % 3 == 0 ? 0 : uint64(block.timestamp + 1 hours);
        p.openUntil = p.lockAt == 0 ? uint64(block.timestamp + 1 days) : 0;
        p.duration = 24 hours;
        p.disputeWindow = 2 hours;
        p.settleGrace = 24 hours;
        p.disputeBondBps = 2_000;
        p.payoutBps = new uint16[](2);
        p.payoutBps[0] = 6_667;
        p.payoutBps[1] = 3_333;
        p.rulesHash = keccak256("rules");
        p.cryptoOnly = true;
        tbl = TableEscrow(factory.createTable(p, bytes32(++salt)));
        for (uint256 i; i < 4; ++i) {
            vm.prank(players[i]);
            usdg.approve(address(tbl), type(uint256).max);
        }
        reachedFinal = false;
    }

    function _sign(uint256 key, bytes32 h) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, h);
        return abi.encodePacked(r, s, v);
    }

    function _isFinal(ArenaTypes.State s) internal pure returns (bool) {
        return s == ArenaTypes.State.Settled || s == ArenaTypes.State.Refunded;
    }

    /// @dev After every action: record a final state; a final table must never change state again.
    modifier track() {
        ArenaTypes.State before = tbl.state();
        uint256 strangerBefore = usdg.balanceOf(STRANGER);
        _;
        ArenaTypes.State afterS = tbl.state();
        if (_isFinal(before) && afterS != before) finalStateLeft = true;
        if (usdg.balanceOf(STRANGER) != strangerBefore) strangerPaid = true;
        if (_isFinal(afterS) && !reachedFinal) {
            reachedFinal = true;
            finalStateSeen = afterS;
        }
    }

    // ------------------------------------------------------------------ actions

    function join(uint256 who) external track {
        who %= 4;
        uint64 exp = uint64(block.timestamp + 5 minutes);
        bytes32 h = tbl.hashTyped(keccak256(abi.encode(tbl.ELIGIBILITY_TYPEHASH(), address(tbl), players[who], uint8(0), true, exp)));
        bytes memory e = abi.encode(true, exp, _sign(ELIG_KEY, h));
        vm.prank(players[who]);
        try tbl.join(keccak256(abi.encode(++skhNonce)), "", e) {} catch {}
    }

    function leave(uint256 who) external track {
        vm.prank(players[who % 4]);
        try tbl.leave() {} catch {}
    }

    function kick(uint256 who) external track {
        vm.prank(address(this)); // the handler is the host
        try tbl.kick(players[who % 4]) {} catch {}
    }

    function lock() external track {
        try tbl.lock() {} catch {}
    }

    function cancel() external track {
        try tbl.cancel() {} catch {}
    }

    function post(uint256 seed) external track {
        address[] memory s = tbl.seats();
        if (s.length < 2) return;
        ITableEscrow.Result memory r;
        r.round = tbl.state() == ArenaTypes.State.Disputed ? 1 : 0;
        r.logHead = keccak256(abi.encode(seed));
        r.podium = new address[](2);
        r.podium[0] = s[seed % s.length];
        r.podium[1] = s[(seed / 7 + 1 + seed % s.length) % s.length];
        if (r.podium[1] == r.podium[0]) r.podium[1] = s[(seed % s.length + 1) % s.length];
        r.logURI = "x";
        bytes32 d = registry.resultDigest(address(tbl), r);
        bytes[] memory sigs = new bytes[](2);
        (uint256 a, uint256 b) = vm.addr(signerKeys[0]) < vm.addr(signerKeys[1]) ? (signerKeys[0], signerKeys[1]) : (signerKeys[1], signerKeys[0]);
        sigs[0] = _sign(a, d);
        sigs[1] = _sign(b, d);
        try tbl.postResult(r, sigs) {} catch {}
    }

    function dispute(uint256 who) external track {
        vm.prank(players[who % 4]);
        try tbl.dispute(bytes32(who)) {} catch {}
    }

    function finalize() external track {
        ArenaTypes.State st = tbl.state();
        try tbl.finalize() {
            if (st == ArenaTypes.State.Settling) _checkConserved();
        } catch {}
    }

    function voidAll() external track {
        address[] memory s = tbl.seats();
        bytes32 h = tbl.hashTyped(keccak256(abi.encode(tbl.VOID_TYPEHASH(), address(tbl))));
        bytes[] memory sigs = new bytes[](s.length);
        for (uint256 i; i < s.length; ++i) {
            for (uint256 k; k < 4; ++k) if (players[k] == s[i]) sigs[i] = _sign(playerKeys[k], h);
        }
        try tbl.voidAll(sigs) {} catch {}
    }

    function refundAll() external track {
        ArenaTypes.State st = tbl.state();
        bool due = (st == ArenaTypes.State.Locked || st == ArenaTypes.State.Disputed) && block.timestamp >= tbl.hardDeadline();
        try tbl.refundAll() {} catch {
            if (due) deadlineRefundFailed = true;
        }
    }

    function claim(uint256 who) external track {
        address p = players[who % 4];
        uint256 credit = tbl.owed(p);
        uint256 before = usdg.balanceOf(p);
        vm.prank(p);
        try tbl.claim(address(0)) {
            if (usdg.balanceOf(p) - before != credit) overPaid = true;
        } catch {}
    }

    function warp(uint256 dt) external track {
        vm.warp(block.timestamp + (dt % 30 hours));
    }

    /// @notice Starts a new table once the current one is final and fully claimed.
    function next(uint256 seed) external {
        if (!_isFinal(tbl.state())) return;
        for (uint256 i; i < 4; ++i) {
            if (tbl.owed(players[i]) != 0) {
                vm.prank(players[i]);
                tbl.claim(address(0));
            }
        }
        ++doneCount;
        _newTable(seed);
    }

    function _checkConserved() internal {
        uint256 sum;
        for (uint256 i; i < 4; ++i) sum += tbl.owed(players[i]);
        // every credit after settling is the pot (+ bond) exactly; no unsettled buy-ins remain
        if (usdg.balanceOf(address(tbl)) != sum) potNotConserved = true;
    }

    // ------------------------------------------------------------------ views for the invariants

    function owedSum() external view returns (uint256 s) {
        for (uint256 i; i < 4; ++i) s += tbl.owed(players[i]);
    }

    function unsettled() external view returns (uint256 v) {
        ArenaTypes.State st = tbl.state();
        if (_isFinal(st)) return 0;
        v = uint256(tbl.params().buyIn) * tbl.seats().length;
        (, uint256 bond) = tbl.dispute_();
        v += bond;
    }
}

contract TableEscrowInvariants is Test {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    TableHandler internal h;

    function setUp() public {
        h = new TableHandler();
    }

    function targetContracts() public view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(h);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory s) {
        bytes4[] memory sel = new bytes4[](14);
        sel[0] = TableHandler.join.selector;
        sel[1] = TableHandler.join.selector;
        sel[2] = TableHandler.leave.selector;
        sel[3] = TableHandler.kick.selector;
        sel[4] = TableHandler.lock.selector;
        sel[5] = TableHandler.cancel.selector;
        sel[6] = TableHandler.post.selector;
        sel[7] = TableHandler.dispute.selector;
        sel[8] = TableHandler.finalize.selector;
        sel[9] = TableHandler.voidAll.selector;
        sel[10] = TableHandler.refundAll.selector;
        sel[11] = TableHandler.claim.selector;
        sel[12] = TableHandler.warp.selector;
        sel[13] = TableHandler.next.selector;
        s = new FuzzSelector[](1);
        s[0] = FuzzSelector(address(h), sel);
    }

    /// A1: the table always holds every credit plus every unsettled buy-in and bond; after Settled it holds
    /// exactly the credits.
    function invariant_solvent() public view {
        TableEscrow t = h.tbl();
        uint256 bal = h.usdg().balanceOf(address(t));
        assertGe(bal, h.owedSum() + h.unsettled(), "A1 solvent");
        if (t.state() == ArenaTypes.State.Settled || t.state() == ArenaTypes.State.Refunded) {
            assertEq(bal, h.owedSum(), "A1 exact after final");
        }
    }

    /// A2: a Friend Table settles to exactly buy-in x seats (+ forfeited bond).
    function invariant_potConserved() public view {
        assertFalse(h.potNotConserved(), "A2 pot conserved");
    }

    /// A4: no money ever reaches anyone who did not sit at the table.
    function invariant_noForeignRecipient() public view {
        assertFalse(h.strangerPaid(), "A4 foreign recipient");
    }

    /// A5: after the deadline a Locked or Disputed table can always be refunded.
    function invariant_deadlineRefundAlwaysAvailable() public view {
        assertFalse(h.deadlineRefundFailed(), "A5 refund available");
    }

    /// A6: Settled and Refunded are final.
    function invariant_terminalStatesFinal() public view {
        assertFalse(h.finalStateLeft(), "A6 final");
    }

    /// A10: a claim pays exactly the credit.
    function invariant_claimExact() public view {
        assertFalse(h.overPaid(), "A10 claim exact");
    }

    /// Every rule above in one campaign of 1,000 runs x 100 calls (the launch gate's size; the separate checks
    /// above keep the default size).
    /// forge-config: default.invariant.runs = 1000
    /// forge-config: default.invariant.depth = 100
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_friendTableHolds_1000x100() public view {
        invariant_solvent();
        invariant_potConserved();
        invariant_noForeignRecipient();
        invariant_deadlineRefundAlwaysAvailable();
        invariant_terminalStatesFinal();
        invariant_claimExact();
        invariant_liveValueBounded();
    }

    /// A12: the live value never exceeds the cap.
    function invariant_liveValueBounded() public view {
        assertLe(h.factory().liveValue(), h.factory().maxLiveValue(), "A12 live value");
    }
}
