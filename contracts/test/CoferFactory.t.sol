// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CoferBase} from "./utils/CoferBase.sol";
import {ICoferPot} from "../src/interfaces/ICoferPot.sol";
import {ICoferFactory} from "../src/interfaces/ICoferFactory.sol";
import {UniV3SwapAdapter} from "../src/SwapAdapter.sol";
import {MockAggregator, MockStockToken} from "../src/mocks/Mocks.sol";
import {FullMath} from "../src/lib/FullMath.sol";

contract CoferFactoryTest is CoferBase {
    function _cfg() internal pure returns (ICoferPot.Config memory) {
        return ICoferPot.Config({guardDelay: 1 hours, maxSlipBps: 200, entrySpreadBps: 0, depositsOpen: true});
    }

    function test_predictMatchesCreate() public {
        address[] memory list = new address[](1);
        list[0] = address(this);
        address predicted = factory.predictPot(address(this), bytes32("x"));
        address pot2 = factory.createPot(list, 1, 0, _cfg(), bytes32("x"));
        assertEq(predicted, pot2);
        assertTrue(factory.isPot(pot2));
    }

    function test_saltBoundToCreator() public {
        address[] memory list = new address[](1);
        list[0] = address(this);
        address a = factory.createPot(list, 1, 0, _cfg(), bytes32("same"));
        vm.prank(address(0xCAFE));
        address b = factory.createPot(list, 1, 0, _cfg(), bytes32("same"));
        assertTrue(a != b, "different creators get different pots");
    }

    function test_createRejectsBadThreshold() public {
        address[] memory list = new address[](2);
        list[0] = address(1);
        list[1] = address(2);
        vm.expectRevert(ICoferPot.BadParam.selector);
        factory.createPot(list, 3, 0, _cfg(), bytes32("bad"));
    }

    function test_createRejectsDuplicateMembers() public {
        address[] memory list = new address[](2);
        list[0] = address(1);
        list[1] = address(1);
        vm.expectRevert(ICoferPot.AlreadyMember.selector);
        factory.createPot(list, 1, 0, _cfg(), bytes32("dup"));
    }

    function test_creationPause() public {
        vm.prank(guardian);
        factory.setCreationPaused(true);
        address[] memory list = new address[](1);
        list[0] = address(this);
        vm.expectRevert(ICoferFactory.CreationIsPaused.selector);
        factory.createPot(list, 1, 0, _cfg(), bytes32("p"));
    }

    function test_onlyOwnerAdmin() public {
        vm.expectRevert(ICoferFactory.NotOwner.selector);
        factory.listAsset(address(1), address(2), 1 days, false);
        vm.expectRevert(ICoferFactory.NotOwner.selector);
        factory.queueAdapter(address(adapter));
        vm.expectRevert(ICoferFactory.NotGuardian.selector);
        factory.setDepositsPaused(true);
    }

    function test_adapterTimelock() public {
        UniV3SwapAdapter a2 = new UniV3SwapAdapter(address(router));
        vm.startPrank(owner);
        factory.queueAdapter(address(a2));
        vm.expectRevert(ICoferFactory.Timelocked.selector);
        factory.applyAdapter(address(a2));
        vm.warp(block.timestamp + 48 hours);
        factory.applyAdapter(address(a2));
        assertTrue(factory.isAdapter(address(a2)));
        factory.removeAdapter(address(a2));
        assertFalse(factory.isAdapter(address(a2)));
        vm.stopPrank();
    }

    function test_feedTimelock() public {
        MockAggregator f2 = new MockAggregator(8, 300e8);
        vm.startPrank(owner);
        factory.queueFeed(address(tsla), address(f2), 1 days);
        vm.expectRevert(ICoferFactory.Timelocked.selector);
        factory.applyFeed(address(tsla));
        vm.warp(block.timestamp + 48 hours);
        factory.applyFeed(address(tsla));
        vm.stopPrank();
        usdgFeed.set(1e8);
        f2.set(300e8);
        assertEq(factory.valueInUsdg(address(tsla), 1e18), 300e6);
    }

    function test_swapFeeCapAndTimelock() public {
        vm.startPrank(owner);
        vm.expectRevert(ICoferFactory.BadParam.selector);
        factory.queueSwapFee(51);
        factory.queueSwapFee(20);
        vm.expectRevert(ICoferFactory.Timelocked.selector);
        factory.applySwapFee();
        vm.warp(block.timestamp + 48 hours);
        factory.applySwapFee();
        vm.stopPrank();
        assertEq(factory.swapFeeBps(), 20);
    }

    function test_relistRejected() public {
        vm.prank(owner);
        vm.expectRevert(ICoferFactory.AlreadyListed.selector);
        factory.listAsset(address(tsla), address(tslaFeed), 1 days, true);
    }

    function test_usdgCannotBeMadeUnbuyable() public {
        vm.prank(owner);
        vm.expectRevert(ICoferFactory.BadParam.selector);
        factory.setBuyable(address(usdg), false);
    }

    function test_quoteUsesFeedAnswerOnlyEvenWithMultiplier() public {
        // A 2-for-1 split: issuer sets uiMultiplier 2e18; the RHC feed already reports underlying x 2.
        // Valuation must be raw x feed, never raw x feed x multiplier.
        tsla.setMultiplier(2e18);
        tslaFeed.set(500e8); // feed embeds the multiplier (docs: latestRoundData already includes it)
        assertEq(factory.valueInUsdg(address(tsla), 1e18), 500e6, "no double apply");
    }

    function test_staleAndBadPricesRevert() public {
        tslaFeed.set(0);
        vm.expectRevert(abi.encodeWithSelector(ICoferFactory.BadPrice.selector, address(tsla)));
        factory.valueInUsdg(address(tsla), 1e18);
        tslaFeed.set(250e8);
        vm.warp(block.timestamp + 4 days + 1);
        vm.expectRevert(abi.encodeWithSelector(ICoferFactory.StalePrice.selector, address(tsla)));
        factory.valueInUsdg(address(tsla), 1e18);
    }

    function test_ownershipTwoStep() public {
        vm.prank(owner);
        factory.transferOwnership(address(0x1234));
        assertEq(factory.owner(), owner);
        vm.prank(address(0x1234));
        factory.acceptOwnership();
        assertEq(factory.owner(), address(0x1234));
    }

    function testFuzz_mulDivMatchesPlainMath(uint128 a, uint128 b, uint128 d) public pure {
        vm.assume(d > 0);
        assertEq(FullMath.mulDiv(a, b, d), (uint256(a) * uint256(b)) / d);
    }

    function test_mulDivFullPrecision() public pure {
        uint256 x = type(uint256).max;
        assertEq(FullMath.mulDiv(x, x, x), x);
        assertEq(FullMath.mulDiv(x, 3, 6), x / 2);
    }
}
