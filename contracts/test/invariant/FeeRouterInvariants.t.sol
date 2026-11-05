// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "../utils/Test.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {MockUSDG, MockStockToken} from "../../src/mocks/Mocks.sol";

/// @notice Stands in for CoferFactory's pot registry (FeeRouter only calls isPot).
contract PotRegistry {
    mapping(address => bool) public isPot;

    function add(address p) external {
        isPot[p] = true;
    }
}

/// @notice Drives one real FeeRouter through random sequences of what happens to it in production:
///         pots send swap fees (USDG on buys, a stock on sells), pots prepay the group plan, outsiders
///         try to pay a plan, anyone calls distribute, and the owner changes the plan price and split.
///         Each action records what it put in or paid out; anything that breaks a rule sets a flag the
///         invariant reads.
contract FeeRouterHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    FeeRouter public immutable router;
    PotRegistry public immutable registry;
    MockUSDG public immutable usdg;
    MockStockToken public immutable tsla;

    address[3] public pots = [address(0xA001), address(0xA002), address(0xA003)];
    address public constant OUTSIDER = address(0xD15C0);
    address[4] public sinks = [address(0x5101), address(0x5102), address(0x5103), address(0x5104)];

    /// every unit of each token that ever reached the router, and every unit it ever paid to a sink
    mapping(address => uint256) public received;
    mapping(address => uint256) public paidOut;
    /// the latest paid-until date seen for each pot
    mapping(address => uint64) public lastPaidUntil;

    bool public distributeLeftBalance; // distribute left some of the token in the router
    bool public splitWrong; // a sink got other than its exact share
    bool public outsiderPaid; // a non-pot paid for a plan
    bool public planWentBackwards; // a pot's paid-until date moved back
    bool public planCostWrong; // a plan took other than price x months

    uint256 public feesSent;
    uint256 public plansPaid;
    uint256 public distributions; // with a non-zero balance

    constructor() {
        usdg = new MockUSDG();
        tsla = new MockStockToken("Tesla Stock Token", "TSLA");
        registry = new PotRegistry();
        router = new FeeRouter(address(usdg), address(this), 9e6, sinks);
        router.setFactory(address(registry));
        for (uint256 i; i < 3; ++i) registry.add(pots[i]);
    }

    function _token(uint256 seed) internal view returns (address) {
        return seed % 2 == 0 ? address(usdg) : address(tsla);
    }

    /// A pot sends a swap fee (CoferPot._swap: tokenIn.safeTransfer(feeRouter, fee)).
    function sendFee(uint256 potSeed, uint256 tokenSeed, uint256 amount) external {
        address pot = pots[potSeed % 3];
        address token = _token(tokenSeed);
        amount = _bound(amount, 1, 1e30);
        MockUSDG(token).mint(pot, amount);
        vm.prank(pot);
        MockUSDG(token).transfer(address(router), amount);
        received[token] += amount;
        ++feesSent;
    }

    /// A pot prepays the plan after a vote (CoferPot._dispatch PAY_PLAN: approve, payPlan, approve 0).
    function payPlan(uint256 potSeed, uint256 months) external {
        address pot = pots[potSeed % 3];
        months = _bound(months, 1, router.MAX_MONTHS());
        uint256 cost = router.planPricePerMonth() * months;
        usdg.mint(pot, cost);
        uint256 before = usdg.balanceOf(address(router));
        vm.startPrank(pot);
        usdg.approve(address(router), cost);
        uint64 paidUntil = router.payPlan(uint8(months));
        usdg.approve(address(router), 0);
        vm.stopPrank();
        if (usdg.balanceOf(address(router)) - before != cost) planCostWrong = true;
        received[address(usdg)] += cost;
        if (paidUntil < lastPaidUntil[pot] || paidUntil < block.timestamp + months * router.MONTH()) planWentBackwards = true;
        lastPaidUntil[pot] = paidUntil;
        ++plansPaid;
    }

    /// Someone who is not a pot tries to pay for a plan, with the money and the approval in place.
    function outsiderPays(uint256 months) external {
        months = _bound(months, 1, router.MAX_MONTHS());
        uint256 cost = router.planPricePerMonth() * months;
        usdg.mint(OUTSIDER, cost);
        vm.startPrank(OUTSIDER);
        usdg.approve(address(router), cost);
        try router.payPlan(uint8(months)) {
            outsiderPaid = true;
            received[address(usdg)] += cost;
        } catch {}
        usdg.approve(address(router), 0);
        vm.stopPrank();
    }

    /// Anyone splits the router's balance of one token to the sinks.
    function distribute(uint256 tokenSeed, address caller) external {
        address token = _token(tokenSeed);
        uint256 total = MockUSDG(token).balanceOf(address(router));
        uint256[4] memory before;
        for (uint256 i; i < 4; ++i) before[i] = MockUSDG(token).balanceOf(router.sinks(i));
        vm.prank(caller);
        router.distribute(token);
        if (MockUSDG(token).balanceOf(address(router)) != 0) distributeLeftBalance = true;
        uint256 sent;
        for (uint256 i; i < 4; ++i) {
            address s = router.sinks(i);
            uint256 want = i < 3 ? (total * router.bps(i)) / 10_000 : total - sent;
            if (i < 3) sent += want;
            // sinks are distinct here, so each one's balance moves by exactly its share
            if (MockUSDG(token).balanceOf(s) - before[i] != want) splitWrong = true;
        }
        paidOut[token] += total;
        if (total > 0) ++distributions;
    }

    /// The owner changes the plan price, within its cap (immediate, bounded by MAX_PLAN_PRICE).
    function setPlanPrice(uint256 price) external {
        router.setPlanPrice(_bound(price, 0, router.MAX_PLAN_PRICE()));
    }

    /// The owner changes the split between the same four sinks (any split that sums to 100%).
    function setSplit(uint256 a, uint256 b, uint256 c) external {
        uint16 x = uint16(_bound(a, 0, 10_000));
        uint16 y = uint16(_bound(b, 0, 10_000 - x));
        uint16 z = uint16(_bound(c, 0, 10_000 - x - y));
        router.setSinks(sinks, [x, y, z, uint16(10_000 - x - y - z)]);
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + _bound(dt, 1, 90 days));
    }

    function _bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (hi <= lo) return lo;
        return lo + (x % (hi - lo + 1));
    }
}

/// @notice Stateful invariants for FeeRouter (docs/invariants.md C19a-C19c).
///         Foundry calls targetContracts()/targetSelectors() directly; they are declared here because the
///         repo's vendored test helpers have no invariant support.
contract FeeRouterInvariants is Test {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    FeeRouterHandler internal handler;

    function setUp() public {
        handler = new FeeRouterHandler();
    }

    function targetContracts() public view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory s) {
        bytes4[] memory sel = new bytes4[](7);
        sel[0] = FeeRouterHandler.sendFee.selector;
        sel[1] = FeeRouterHandler.payPlan.selector;
        sel[2] = FeeRouterHandler.outsiderPays.selector;
        sel[3] = FeeRouterHandler.distribute.selector;
        sel[4] = FeeRouterHandler.setPlanPrice.selector;
        sel[5] = FeeRouterHandler.setSplit.selector;
        sel[6] = FeeRouterHandler.warp.selector;
        s = new FuzzSelector[](1);
        s[0] = FuzzSelector(address(handler), sel);
    }

    /// forge-config: default.invariant.runs = 1000
    /// forge-config: default.invariant.depth = 100
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_feeRouterConservesAndSplitsExactly() public view {
        FeeRouter router = handler.router();
        address[2] memory tokens = [address(handler.usdg()), address(handler.tsla())];

        for (uint256 t; t < 2; ++t) {
            MockUSDG token = MockUSDG(tokens[t]);
            uint256 atSinks;
            for (uint256 i; i < 4; ++i) atSinks += token.balanceOf(handler.sinks(i));
            // C19a: every unit that came in is either still in the router or at a sink; nothing is lost or made up
            assertEq(handler.received(tokens[t]), token.balanceOf(address(router)) + atSinks, "C19a: fees not conserved");
            assertEq(handler.paidOut(tokens[t]), atSinks, "C19a: sinks hold other than what distribute paid");
        }

        // C19b: distribute always empties the router and pays each sink exactly its share (dust to the last)
        assertFalse(handler.distributeLeftBalance(), "C19b: distribute left a balance");
        assertFalse(handler.splitWrong(), "C19b: a sink got other than its share");
        uint256 sum;
        for (uint256 i; i < 4; ++i) sum += router.bps(i);
        assertEq(sum, 10_000, "C19b: split does not sum to 100%");

        // C19c: only pots ever hold a plan; a plan costs exactly price x months; paid-until never moves back
        assertFalse(handler.outsiderPaid(), "C19c: a non-pot paid for a plan");
        assertEq(router.planPaidUntil(handler.OUTSIDER()), 0, "C19c: a non-pot has a plan");
        assertFalse(handler.planCostWrong(), "C19c: a plan cost other than price x months");
        assertFalse(handler.planWentBackwards(), "C19c: a paid-until date moved back");
    }

    /// The handler's actions really take effect (none of them silently reverts every time).
    function test_feeRouterHandlerActionsTakeEffect() public {
        handler.sendFee(0, 0, 1_000e6); // USDG fee
        handler.sendFee(1, 1, 3e18); // stock fee
        handler.payPlan(2, 3);
        handler.outsiderPays(1);
        handler.setSplit(7000, 2000, 500);
        handler.distribute(0, address(0xBEEF));
        handler.distribute(1, address(0xBEEF));
        handler.warp(40 days);
        handler.payPlan(2, 1);
        assertEq(handler.feesSent(), 2, "fees");
        assertEq(handler.plansPaid(), 2, "plans");
        assertEq(handler.distributions(), 2, "distributions");
        assertFalse(handler.outsiderPaid(), "outsider");
        assertGe(handler.paidOut(address(handler.usdg())), 1_000e6 + 27e6, "USDG paid out");
        invariant_feeRouterConservesAndSplitsExactly();
    }
}
