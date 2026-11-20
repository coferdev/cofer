// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "../utils/Test.sol";
import {MockERC20} from "../../src/mocks/Mocks.sol";
import {MockUSDG3009} from "../arena/ArenaMocks.sol";
import {ArenaTypes} from "../../src/arena/ArenaTypes.sol";
import {ResultRegistry} from "../../src/arena/ResultRegistry.sol";
import {TableFactory} from "../../src/arena/TableFactory.sol";
import {TableEscrow} from "../../src/arena/TableEscrow.sol";
import {PrizeVault} from "../../src/arena/PrizeVault.sol";
import {ITableEscrow} from "../../src/interfaces/arena/ITableEscrow.sol";

/// @notice Drives real Freerolls (funded by the PrizeVault) through random sequences: joins with and without prize
///         eligibility, lock, cancel, results with a 4-leaf payout tree (including ones over the prize), disputes,
///         finalize, deadline refunds, prize claims (right, repeated, wrong amount, someone else's leaf), sponsor
///         reclaims and time moving. A fresh table starts when one is final and fully paid out.
contract FreerollHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockUSDG3009 public usdg;
    ResultRegistry public registry;
    TableFactory public factory;
    PrizeVault public vault;
    TableEscrow public tbl;

    address public constant SCHEDULER = address(0x5C4E);
    address public constant STRANGER = address(0x5757);
    uint256 internal constant ELIG_KEY = 0xE11;
    uint256[3] internal signerKeys = [uint256(0x5161), 0x5162, 0x5163];
    address[4] public players = [address(0xB1), address(0xB2), address(0xB3), address(0xB4)];
    uint256 internal salt;

    // the current table's payout tree (4 leaves, index i pays leafTo[i] leafAmt[i])
    address[4] public leafTo;
    uint256[4] public leafAmt;
    bytes32[4] internal leaf;
    bool public hasTree;

    // ghosts for the current table
    uint256 public prize;
    uint256 public paid; // prize claims paid
    uint256 public reclaimed; // paid to the sponsor
    bool public reachedFinal;
    // rule breaks
    bool public overPaid; // A3: claims beyond totalPayout, or a claim not equal to its leaf
    bool public sponsorWrong; // A3: the sponsor got other than the rest
    bool public notEligiblePaid; // only prize-eligible seats are paid
    bool public strangerPaid; // A4
    bool public finalLeft; // A6
    bool public refundFailed; // A5
    uint256 public freerolls;
    uint256 public claimsOk; // successful prize claims (coverage)
    uint256 public reclaimsOk; // successful sponsor reclaims (coverage)

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
            50e6, 500e6, 25_000e6, 0
        );
        registry.setFactory(address(factory));
        address[] memory toks = new address[](1);
        toks[0] = address(usdg);
        uint256[] memory caps = new uint256[](1);
        caps[0] = type(uint128).max;
        vault = new PrizeVault(address(factory), address(this), SCHEDULER, toks, caps);
        factory.setPrizeVault(address(vault));
        usdg.mint(address(vault), 1e15);
        _newTable(0);
    }

    function _newTable(uint256 seed) internal {
        ArenaTypes.TableParams memory p;
        p.mode = ArenaTypes.Mode.FREEROLL;
        p.token = address(usdg);
        p.prize = uint96(1e6 + (seed % 1000) * 1e6);
        p.minSeats = 2;
        p.maxSeats = 4;
        p.lockAt = uint64(block.timestamp + 1 hours);
        p.duration = 2 hours;
        p.disputeWindow = 24 hours;
        p.settleGrace = 72 hours;
        p.rulesHash = keccak256("rules");
        vm.prank(SCHEDULER);
        tbl = TableEscrow(vault.fundFreeroll(p, bytes32(++salt)));
        prize = p.prize;
        paid = 0;
        reclaimed = 0;
        hasTree = false;
        reachedFinal = false;
        ++freerolls;
    }

    function _sign(uint256 key, bytes32 h) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, h);
        return abi.encodePacked(r, s, v);
    }

    function _final(ArenaTypes.State s) internal pure returns (bool) {
        return s == ArenaTypes.State.Settled || s == ArenaTypes.State.Refunded;
    }

    modifier track() {
        ArenaTypes.State before = tbl.state();
        uint256 sb = usdg.balanceOf(STRANGER);
        _;
        ArenaTypes.State a = tbl.state();
        if (_final(before) && a != before) finalLeft = true;
        if (usdg.balanceOf(STRANGER) != sb) strangerPaid = true;
        if (_final(a)) reachedFinal = true;
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    // ------------------------------------------------------------------ actions

    function join(uint256 who, bool eligible) external track {
        address p = players[who % 4];
        uint64 exp = uint64(block.timestamp + 5 minutes);
        bytes32 h = tbl.hashTyped(keccak256(abi.encode(tbl.ELIGIBILITY_TYPEHASH(), address(tbl), p, uint8(1), eligible, exp)));
        vm.prank(p);
        try tbl.join(keccak256(abi.encode(p, salt)), "", abi.encode(eligible, exp, _sign(ELIG_KEY, h))) {} catch {}
    }

    function lock() external track {
        try tbl.lock() {} catch {}
    }

    function cancel() external track {
        try tbl.cancel() {} catch {}
    }

    /// A result whose tree pays four leaves to seated players (or a stranger), with total <= or > the prize.
    function post(uint256 seed) external track {
        address[] memory s = tbl.seats();
        if (s.length == 0) return;
        uint256 sum;
        for (uint256 i; i < 4; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            leafTo[i] = r % 11 == 0 ? STRANGER : s[r % s.length];
            leafAmt[i] = (r >> 8) % (prize / 2 + 1);
            sum += leafAmt[i];
            leaf[i] = keccak256(bytes.concat(keccak256(abi.encode(tbl.PAYOUT_TAG(), block.chainid, address(tbl), i, leafTo[i], leafAmt[i]))));
        }
        ITableEscrow.Result memory res;
        res.round = tbl.state() == ArenaTypes.State.Disputed ? 1 : 0;
        res.logHead = keccak256(abi.encode(seed));
        res.podium = new address[](0);
        res.payoutRoot = _pair(_pair(leaf[0], leaf[1]), _pair(leaf[2], leaf[3]));
        // usually the exact sum; sometimes more (still capped by the prize) or over the prize (must be refused)
        res.totalPayout = seed % 5 == 0 ? prize + 1 + seed % 7 : seed % 5 == 1 ? sum + seed % 3 : sum;
        res.logURI = "x";
        bytes32 d = registry.resultDigest(address(tbl), res);
        bytes[] memory sigs = new bytes[](2);
        (uint256 a, uint256 b) = vm.addr(signerKeys[0]) < vm.addr(signerKeys[1]) ? (signerKeys[0], signerKeys[1]) : (signerKeys[1], signerKeys[0]);
        sigs[0] = _sign(a, d);
        sigs[1] = _sign(b, d);
        try tbl.postResult(res, sigs) {
            hasTree = true;
            if (res.totalPayout > prize) overPaid = true; // a result over the prize must never be accepted
        } catch {}
    }

    function dispute(uint256 who) external track {
        vm.prank(players[who % 4]);
        try tbl.dispute(bytes32(who)) {} catch {}
    }

    function finalize() external track {
        try tbl.finalize() {} catch {}
    }

    function refundAll() external track {
        ArenaTypes.State st = tbl.state();
        bool due = (st == ArenaTypes.State.Locked || st == ArenaTypes.State.Disputed) && block.timestamp >= tbl.hardDeadline();
        try tbl.refundAll() {} catch {
            if (due) refundFailed = true;
        }
    }

    /// Claims leaf i as `by` (its owner or someone else) with the right or a wrong amount.
    function claimPrize(uint256 i, uint256 by, uint256 skew) external track {
        if (!hasTree) return;
        i %= 4;
        address caller = by % 3 == 0 ? players[by % 4] : leafTo[i];
        uint256 amt = skew % 4 == 0 ? leafAmt[i] + 1 : leafAmt[i];
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = leaf[i ^ 1];
        proof[1] = i < 2 ? _pair(leaf[2], leaf[3]) : _pair(leaf[0], leaf[1]);
        (, bool eligible) = _seatEligible(caller);
        uint256 before = usdg.balanceOf(caller);
        vm.prank(caller);
        try tbl.claimPrize(i, amt, proof, address(0)) {
            uint256 got = usdg.balanceOf(caller) - before;
            paid += got;
            ++claimsOk;
            if (got != leafAmt[i] || caller != leafTo[i] || amt != leafAmt[i]) overPaid = true;
            if (!eligible) notEligiblePaid = true;
        } catch {}
        (, , , , uint256 total) = tbl.currentResult();
        if (paid > total) overPaid = true;
    }

    function sponsorReclaim() external track {
        ArenaTypes.State st = tbl.state();
        uint256 before = usdg.balanceOf(address(vault));
        try tbl.sponsorReclaim() {
            uint256 got = usdg.balanceOf(address(vault)) - before;
            reclaimed += got;
            ++reclaimsOk;
            (, , , , uint256 total) = tbl.currentResult();
            uint256 want = st == ArenaTypes.State.Settled ? prize - total : prize;
            if (got != want) sponsorWrong = true;
        } catch {}
    }

    function warp(uint256 dt) external track {
        vm.warp(block.timestamp + (dt % 40 hours));
    }

    /// Starts a new table once the current one is final.
    function next(uint256 seed) external {
        if (!_final(tbl.state())) return;
        _newTable(seed);
    }

    function _seatEligible(address a) internal view returns (bool seated, bool eligible) {
        (uint16 n, , bool pe) = tbl.seatOf(a);
        return (n != 0, pe);
    }
}

contract FreerollInvariants is Test {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    FreerollHandler internal h;

    function setUp() public {
        h = new FreerollHandler();
    }

    function targetContracts() public view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(h);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory s) {
        bytes4[] memory sel = new bytes4[](13);
        sel[0] = FreerollHandler.join.selector;
        sel[1] = FreerollHandler.join.selector;
        sel[2] = FreerollHandler.lock.selector;
        sel[3] = FreerollHandler.cancel.selector;
        sel[4] = FreerollHandler.post.selector;
        sel[5] = FreerollHandler.dispute.selector;
        sel[6] = FreerollHandler.finalize.selector;
        sel[7] = FreerollHandler.refundAll.selector;
        sel[8] = FreerollHandler.claimPrize.selector;
        sel[9] = FreerollHandler.claimPrize.selector;
        sel[10] = FreerollHandler.sponsorReclaim.selector;
        sel[11] = FreerollHandler.warp.selector;
        sel[12] = FreerollHandler.next.selector;
        s = new FuzzSelector[](1);
        s[0] = FuzzSelector(address(h), sel);
    }

    /// A3 (stateful), A1, A4, A5, A6 for Freerolls, in one campaign of 1,000 runs x 100 calls.
    /// forge-config: default.invariant.runs = 1000
    /// forge-config: default.invariant.depth = 100
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_freerollHolds() public view {
        TableEscrow t = h.tbl();
        (, , , , uint256 total) = t.currentResult();
        // A3: claims <= totalPayout <= prize; the sponsor gets exactly the rest
        assertLe(h.paid(), total, "A3 claims within totalPayout");
        assertLe(total, h.prize(), "A3 totalPayout within prize");
        assertFalse(h.overPaid(), "A3 no claim beyond its leaf");
        assertFalse(h.sponsorWrong(), "A3 sponsor gets exactly the rest");
        assertFalse(h.notEligiblePaid(), "only prize-eligible seats are paid");
        // A1: the escrow holds exactly the prize minus what it paid out
        assertEq(h.usdg().balanceOf(address(t)), h.prize() - h.paid() - h.reclaimed(), "A1 Freeroll balance");
        assertFalse(h.strangerPaid(), "A4 foreign recipient");
        assertFalse(h.refundFailed(), "A5 refund available");
        assertFalse(h.finalLeft(), "A6 final");
    }
}

/// @notice The handler can reach every path: a scripted Freeroll that settles, pays two leaves and reclaims the rest.
contract FreerollHandlerReach is Test {
    function test_handlerReachesClaimsAndReclaim() public {
        FreerollHandler h = new FreerollHandler();
        h.join(0, true);
        h.join(1, true);
        h.join(2, false);
        h.warp(1 hours);
        h.lock();
        h.warp(2 hours);
        uint256 seed = 2; // seed % 5 == 2: totalPayout is the exact sum
        while (true) {
            h.post(seed);
            if (h.hasTree()) break;
            seed += 5;
        }
        h.warp(24 hours);
        h.finalize();
        assertEq(uint8(h.tbl().state()), uint8(ArenaTypes.State.Settled));
        for (uint256 i; i < 4; ++i) h.claimPrize(i, 1, 1); // each leaf by its owner, right amount
        h.sponsorReclaim();
        assertGe(h.claimsOk(), 1, "claims reached");
        assertEq(h.reclaimsOk(), 1, "reclaim reached");
        assertEq(h.usdg().balanceOf(address(h.tbl())), h.prize() - h.paid() - h.reclaimed());
        assertFalse(h.overPaid());
        assertFalse(h.sponsorWrong());
        assertFalse(h.notEligiblePaid());
    }
}
