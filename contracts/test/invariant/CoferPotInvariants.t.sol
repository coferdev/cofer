// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "../utils/Test.sol";
import {CoferBase} from "../utils/CoferBase.sol";
import {CoferPot} from "../../src/CoferPot.sol";
import {CoferFactory} from "../../src/CoferFactory.sol";
import {UniV3SwapAdapter} from "../../src/SwapAdapter.sol";
import {ICoferPot} from "../../src/interfaces/ICoferPot.sol";
import {MockUSDG, MockStockToken, MockAggregator, MockSwapRouter} from "../../src/mocks/Mocks.sol";

/// @notice Drives one 5-member pot through random sequences of real actions. Inputs are kept in valid
///         ranges; actions that may legitimately fail (a vote with stale feeds, a claim while the token
///         is paused) are tried and skipped. Exits and leaves must never fail: if one does, it is recorded.
contract PotHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    CoferPot public immutable pot;
    CoferFactory public immutable factory;
    MockUSDG public immutable usdg;
    MockStockToken public immutable tsla;
    MockAggregator public immutable usdgFeed;
    MockAggregator public immutable tslaFeed;
    MockSwapRouter public immutable router;
    UniV3SwapAdapter public immutable adapter;

    uint256[5] internal keys;
    address[5] public members;
    address public constant OUTSIDER = address(0xD15C0);

    uint256 internal nonce = 1_000_000;
    uint256 public tslaPrice = 250; // whole USD per TSLA, kept equal in the feed and the mock router

    bool public exitReverted;
    bool public leaveReverted;
    uint256 public calls;

    constructor(
        CoferPot pot_,
        CoferFactory factory_,
        MockUSDG usdg_,
        MockStockToken tsla_,
        MockAggregator usdgFeed_,
        MockAggregator tslaFeed_,
        MockSwapRouter router_,
        UniV3SwapAdapter adapter_,
        uint256[5] memory keys_
    ) {
        pot = pot_;
        factory = factory_;
        usdg = usdg_;
        tsla = tsla_;
        usdgFeed = usdgFeed_;
        tslaFeed = tslaFeed_;
        router = router_;
        adapter = adapter_;
        keys = keys_;
        for (uint256 i; i < 5; ++i) members[i] = vm.addr(keys_[i]);
    }

    // ------------------------------------------------------------------ member actions (no vote)

    function deposit(uint256 i, uint256 amt) external {
        ++calls;
        address m = members[i % 5];
        if (!pot.memberInfo(m).active) return;
        amt = _bound(amt, 1e6, 2_000e6);
        usdg.mint(m, amt);
        vm.prank(m);
        usdg.approve(address(pot), amt);
        vm.prank(m);
        try pot.deposit(amt) {} catch {} // closed while a held asset's feed is stale: allowed to fail
    }

    function exit(uint256 i, uint256 pct) external {
        ++calls;
        address m = members[i % 5];
        uint256 shares = pot.memberInfo(m).shares;
        if (shares == 0) return;
        uint256 s = (shares * _bound(pct, 1, 100)) / 100;
        if (s == 0) s = 1;
        vm.prank(m);
        try pot.exit(s, m) {} catch {
            exitReverted = true; // must never happen
        }
    }

    function leave(uint256 i) external {
        ++calls;
        address m = members[i % 5];
        if (!pot.memberInfo(m).active || pot.memberCount() <= 2) return; // keep a group to vote with
        vm.prank(m);
        try pot.leave() {} catch {
            leaveReverted = true; // must never happen
        }
    }

    function spend(uint256 i, uint256 amt) external {
        ++calls;
        address m = members[i % 5];
        amt = _bound(amt, 1, 200e6);
        vm.prank(m);
        try pot.spend(OUTSIDER, amt, bytes32(0)) {} catch {} // no allowance, over the cap or no USDG: allowed to fail
    }

    function claim(uint256 i) external {
        ++calls;
        address m = members[i % 5];
        try pot.claimOwed(address(tsla), m) {} catch {} // nothing owed, or the token is still paused
        try pot.claimOwed(address(usdg), m) {} catch {}
    }

    // ------------------------------------------------------------------ votes (every active member signs)

    function setAllowance(uint256 i, uint256 amt) external {
        ++calls;
        address m = members[i % 5];
        if (!pot.memberInfo(m).active) return;
        _vote(4, abi.encode(m, uint128(_bound(amt, 0, 300e6)), uint32(7 days)));
    }

    function addBack(uint256 i) external {
        ++calls;
        address m = members[i % 5];
        if (pot.memberInfo(m).active) return;
        _vote(2, abi.encode(m));
    }

    function transferOut(uint256 amt) external {
        ++calls;
        uint256 avail = pot.distributable(address(usdg));
        if (avail == 0) return;
        _vote(0, abi.encode(address(usdg), OUTSIDER, _bound(amt, 1, avail)));
    }

    function buy(uint256 amt) external {
        ++calls;
        uint256 avail = pot.distributable(address(usdg));
        if (avail < 1e6) return;
        _swap(address(usdg), address(tsla), _bound(amt, 1e6, avail));
    }

    function sell(uint256 pct) external {
        ++calls;
        uint256 avail = pot.distributable(address(tsla));
        uint256 amountIn = (avail * _bound(pct, 1, 100)) / 100;
        if (amountIn < 1e12) return;
        _swap(address(tsla), address(usdg), amountIn);
    }

    // ------------------------------------------------------------------ the world changes

    function pauseToken(bool paused) external {
        ++calls;
        tsla.setPaused(paused);
    }

    function movePrice(uint256 price) external {
        ++calls;
        tslaPrice = _bound(price, 50, 1_000);
        tslaFeed.set(int256(tslaPrice) * 1e8);
        router.setRate(address(usdg), address(tsla), 1e30 / tslaPrice);
        router.setRate(address(tsla), address(usdg), tslaPrice * 1e6);
    }

    function warp(uint256 secs, bool refreshFeeds) external {
        ++calls;
        vm.warp(block.timestamp + _bound(secs, 1, 2 days));
        if (refreshFeeds) {
            usdgFeed.set(1e8);
            tslaFeed.set(int256(tslaPrice) * 1e8);
        }
    }

    function donate(uint256 amt, bool stock) external {
        ++calls;
        if (stock) tsla.mint(address(pot), _bound(amt, 1, 10e18));
        else usdg.mint(address(pot), _bound(amt, 1, 1_000e6));
    }

    // ------------------------------------------------------------------ helpers

    function _swap(address tokenIn, address tokenOut, uint256 amountIn) internal {
        uint256 swapIn = amountIn - (amountIn * factory.swapFeeBps()) / 10_000;
        uint256 expected;
        try factory.quote(tokenIn, tokenOut, swapIn) returns (uint256 q) {
            expected = q;
        } catch {
            return; // stale feed: the pot refuses too
        }
        uint256 minOut = (expected * 99) / 100;
        if (minOut == 0) return;
        bytes memory route = abi.encodePacked(tokenIn, uint24(3000), tokenOut);
        _vote(1, abi.encode(address(adapter), tokenIn, tokenOut, amountIn, minOut, route));
    }

    /// @dev Every active member signs, so the vote is unanimous and runs at once (no exit window).
    function _vote(uint8 kind, bytes memory data) internal {
        address[] memory list = pot.members();
        uint64 ep = pot.epoch();
        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 n = ++nonce;
        bytes32 digest = pot.hashProposal(kind, data, n, ep, deadline);
        ICoferPot.Vote[] memory v = new ICoferPot.Vote[](list.length);
        for (uint256 k; k < list.length; ++k) {
            (uint8 vv, bytes32 r, bytes32 s) = vm.sign(_keyOf(list[k]), digest);
            v[k] = ICoferPot.Vote(list[k], abi.encodePacked(r, s, vv));
        }
        for (uint256 a = 1; a < v.length; ++a) {
            ICoferPot.Vote memory x = v[a];
            uint256 b = a;
            while (b > 0 && v[b - 1].signer > x.signer) {
                v[b] = v[b - 1];
                --b;
            }
            v[b] = x;
        }
        try pot.execute(kind, data, n, ep, deadline, v) {} catch {} // stale feed, paused token, too many assets...
    }

    function _keyOf(address m) internal view returns (uint256) {
        for (uint256 i; i < 5; ++i) if (members[i] == m) return keys[i];
        revert("not a test member");
    }

    function _bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (hi <= lo) return lo;
        return lo + (x % (hi - lo + 1));
    }
}

/// @notice Stateful invariants for CoferPot (docs/invariants.md C1, C5, C6, solvency).
///         Foundry calls targetContracts()/targetSelectors() directly; they are declared here because the
///         repo's vendored test helpers have no invariant support.
contract CoferPotInvariants is CoferBase {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    PotHandler internal handler;

    function setUp() public override {
        super.setUp();
        for (uint256 i; i < 5; ++i) _deposit(i, 500e6);
        handler = new PotHandler(pot, factory, usdg, tsla, usdgFeed, tslaFeed, router, adapter, keys);
    }

    function targetContracts() public view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory s) {
        bytes4[] memory sel = new bytes4[](14);
        sel[0] = PotHandler.deposit.selector;
        sel[1] = PotHandler.exit.selector;
        sel[2] = PotHandler.leave.selector;
        sel[3] = PotHandler.spend.selector;
        sel[4] = PotHandler.claim.selector;
        sel[5] = PotHandler.setAllowance.selector;
        sel[6] = PotHandler.addBack.selector;
        sel[7] = PotHandler.transferOut.selector;
        sel[8] = PotHandler.buy.selector;
        sel[9] = PotHandler.sell.selector;
        sel[10] = PotHandler.pauseToken.selector;
        sel[11] = PotHandler.movePrice.selector;
        sel[12] = PotHandler.warp.selector;
        sel[13] = PotHandler.donate.selector;
        s = new FuzzSelector[](1);
        s[0] = FuzzSelector(address(handler), sel);
    }

    /// forge-config: default.invariant.runs = 1000
    /// forge-config: default.invariant.depth = 100
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_potAccountsAndExitsHold() public view {
        // C5: total shares == sum of every member's shares (members who left hold none)
        uint256 sum;
        for (uint256 i; i < 5; ++i) sum += pot.memberInfo(m[i]).shares;
        assertEq(pot.totalShares(), sum, "C5: totalShares != sum of member shares");

        // C6: for each asset, reserved <= balance and reserved == sum owed (exits only ever pay members)
        address[2] memory assets = [address(usdg), address(tsla)];
        for (uint256 a; a < 2; ++a) {
            uint256 owedSum;
            for (uint256 i; i < 5; ++i) owedSum += pot.owed(assets[a], m[i]);
            assertEq(pot.reserved(assets[a]), owedSum, "C6: reserved != sum owed");
            assertLe(pot.reserved(assets[a]), _bal(assets[a]), "C6: reserved > balance");
        }

        // C1 under random sequences: no exit or leave ever reverted
        assertFalse(handler.exitReverted(), "C1: an exit reverted");
        assertFalse(handler.leaveReverted(), "C1: a leave reverted");

        // Solvency: what every member would receive on exit, summed, fits in what the pot can pay
        address[] memory held = pot.heldAssets();
        for (uint256 a; a < held.length; ++a) {
            uint256 total;
            for (uint256 i; i < 5; ++i) {
                uint256 sh = pot.memberInfo(m[i]).shares;
                if (sh == 0) continue;
                (address[] memory as_, uint256[] memory amts) = pot.previewExit(sh);
                for (uint256 k; k < as_.length; ++k) if (as_[k] == held[a]) total += amts[k];
            }
            assertLe(total, pot.distributable(held[a]), "solvency: exits would pay more than the pot holds");
        }
    }

    /// @dev The handler's actions really take effect (they are not all skipped): a vote-driven buy, an exit
    ///      while the stock is paused (set aside), a claim after unpausing, a leave and a re-add.
    function test_handlerActionsTakeEffect() public {
        handler.buy(1_000e6);
        assertTrue(tsla.balanceOf(address(pot)) > 0, "buy ran");
        handler.pauseToken(true);
        handler.exit(0, 99); // _bound(99, 1, 100) = 100%
        assertTrue(pot.owed(address(tsla), m[0]) > 0, "exit set the paused stock aside");
        assertEq(pot.memberInfo(m[0]).shares, 0, "exit took every share");
        handler.pauseToken(false);
        handler.claim(0);
        assertEq(pot.owed(address(tsla), m[0]), 0, "claim paid it out");
        handler.leave(1);
        assertFalse(pot.memberInfo(m[1]).active, "leave ran");
        handler.addBack(1);
        assertTrue(pot.memberInfo(m[1]).active, "re-add vote ran");
        handler.setAllowance(2, 100e6);
        handler.spend(2, 50e6 - 1); // _bound(50e6 - 1, 1, 200e6) = 50e6
        assertEq(usdg.balanceOf(handler.OUTSIDER()), 50e6, "allowance spend ran");
        invariant_potAccountsAndExitsHold();
    }

    function _bal(address token) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(pot)));
        require(ok && ret.length >= 32, "balanceOf");
        return abi.decode(ret, (uint256));
    }
}
