// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CoferBase} from "./utils/CoferBase.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {UniV3SwapAdapter} from "../src/SwapAdapter.sol";

contract FeeRouterAndAdapterTest is CoferBase {
    function test_payPlanOnlyFromPots() public {
        usdg.mint(address(this), 100e6);
        usdg.approve(address(feeRouter), 100e6);
        vm.expectRevert(FeeRouter.NotPot.selector);
        feeRouter.payPlan(1);
    }

    function test_distributeSplits80_10_5_5() public {
        usdg.mint(address(feeRouter), 1_000_003);
        feeRouter.distribute(address(usdg));
        assertEq(usdg.balanceOf(sinks[0]), 800_002);
        assertEq(usdg.balanceOf(sinks[1]), 100_000);
        assertEq(usdg.balanceOf(sinks[2]), 50_000);
        assertEq(usdg.balanceOf(sinks[3]), 50_001, "rounding dust to last sink");
        assertEq(usdg.balanceOf(address(feeRouter)), 0);
    }

    function test_sinksMustSumTo10000() public {
        address[4] memory s = [address(1), address(2), address(3), address(4)];
        uint16[4] memory b = [uint16(8000), uint16(1000), uint16(500), uint16(400)];
        vm.prank(owner);
        vm.expectRevert(FeeRouter.BadParam.selector);
        feeRouter.setSinks(s, b);
    }

    function test_planPriceCap() public {
        vm.prank(owner);
        vm.expectRevert(FeeRouter.BadParam.selector);
        feeRouter.setPlanPrice(101e6);
    }

    function test_factoryWiringOnce() public {
        vm.prank(owner);
        vm.expectRevert(FeeRouter.FactoryAlreadySet.selector);
        feeRouter.setFactory(address(1));
    }

    // ---- adapter

    function test_adapterRejectsMismatchedPath() public {
        usdg.mint(address(this), 10e6);
        usdg.approve(address(adapter), 10e6);
        bytes memory wrong = abi.encodePacked(address(tsla), uint24(3000), address(usdg));
        vm.expectRevert(UniV3SwapAdapter.BadPath.selector);
        adapter.swap(address(usdg), address(tsla), 10e6, 1, wrong);
    }

    function test_adapterRejectsMalformedPath() public {
        vm.expectRevert(UniV3SwapAdapter.BadPath.selector);
        adapter.swap(address(usdg), address(tsla), 10e6, 1, abi.encodePacked(address(usdg), address(tsla)));
    }

    function test_adapterSwapsToCallerAndResetsApproval() public {
        usdg.mint(address(this), 10e6);
        usdg.approve(address(adapter), 10e6);
        uint256 out = adapter.swap(address(usdg), address(tsla), 10e6, 1, _path(address(usdg), address(tsla)));
        assertEq(out, 4e16);
        assertEq(tsla.balanceOf(address(this)), 4e16);
        assertEq(usdg.allowance(address(adapter), address(router)), 0);
        assertEq(usdg.balanceOf(address(adapter)), 0);
    }

    function test_adapterEnforcesMinOut() public {
        usdg.mint(address(this), 10e6);
        usdg.approve(address(adapter), 10e6);
        vm.expectRevert();
        adapter.swap(address(usdg), address(tsla), 10e6, 5e16, _path(address(usdg), address(tsla)));
    }
}
