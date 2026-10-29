// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "./Test.sol";
import {CoferPot} from "../../src/CoferPot.sol";
import {CoferFactory} from "../../src/CoferFactory.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {UniV3SwapAdapter} from "../../src/SwapAdapter.sol";
import {ICoferPot} from "../../src/interfaces/ICoferPot.sol";
import {MockUSDG, MockStockToken, MockAggregator, MockSwapRouter} from "../../src/mocks/Mocks.sol";

abstract contract CoferBase is Test {
    MockUSDG internal usdg;
    MockStockToken internal tsla;
    MockAggregator internal usdgFeed;
    MockAggregator internal tslaFeed;
    MockSwapRouter internal router;
    UniV3SwapAdapter internal adapter;
    FeeRouter internal feeRouter;
    CoferPot internal impl;
    CoferFactory internal factory;
    CoferPot internal pot;

    address internal owner = address(0xA0);
    address internal guardian = address(0xA1);
    address[4] internal sinks = [address(0xB1), address(0xB2), address(0xB3), address(0xB4)];

    uint256[5] internal keys = [uint256(0xA11CE), 0xB0B, 0xCA401, 0xD0D0, 0xE11E];
    address[5] internal m; // members, same order as keys

    uint24 internal constant FEE_TIER = 3000;
    uint64 internal constant FAR_DEADLINE = 4_000_000_000; // fixed so a digest is stable across warps

    function setUp() public virtual {
        vm.warp(1_760_000_000);
        usdg = new MockUSDG();
        tsla = new MockStockToken("Tesla", "TSLA");
        usdgFeed = new MockAggregator(8, 1e8);
        tslaFeed = new MockAggregator(8, 250e8);
        router = new MockSwapRouter();
        adapter = new UniV3SwapAdapter(address(router));
        feeRouter = new FeeRouter(address(usdg), owner, 10e6, sinks);
        impl = new CoferPot();
        factory = new CoferFactory(address(impl), address(usdg), address(feeRouter), owner, guardian, 30);

        vm.startPrank(owner);
        feeRouter.setFactory(address(factory));
        factory.listAsset(address(usdg), address(usdgFeed), 1 days, false);
        factory.listAsset(address(tsla), address(tslaFeed), 4 days, true);
        factory.queueAdapter(address(adapter));
        vm.warp(block.timestamp + 48 hours);
        factory.applyAdapter(address(adapter));
        vm.stopPrank();
        usdgFeed.set(1e8);
        tslaFeed.set(250e8);

        // 1 USDG (1e6) -> 1/250 TSLA (4e15); 1 TSLA (1e18) -> 250 USDG (250e6)
        router.setRate(address(usdg), address(tsla), 4e27);
        router.setRate(address(tsla), address(usdg), 250e6);
        tsla.mint(address(router), 1_000_000e18);
        usdg.mint(address(router), 1_000_000_000e6);

        address[] memory list = new address[](5);
        for (uint256 i; i < 5; ++i) {
            m[i] = vm.addr(keys[i]);
            list[i] = m[i];
        }
        pot = CoferPot(
            factory.createPot(
                list,
                0,
                6000, // 60% of members, rounded up -> 3 of 5
                ICoferPot.Config({guardDelay: 6 hours, maxSlipBps: 300, entrySpreadBps: 50, depositsOpen: true}),
                bytes32("group-1")
            )
        );
        for (uint256 i; i < 5; ++i) {
            usdg.mint(m[i], 1_000e6);
            vm.prank(m[i]);
            usdg.approve(address(pot), type(uint256).max);
        }
    }

    // ---------------------------------------------------------------- helpers

    function _deposit(uint256 i, uint256 amt) internal returns (uint256) {
        vm.prank(m[i]);
        return pot.deposit(amt);
    }

    function _sig(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Signs `digest` with members at `idx` and returns votes sorted by signer address.
    function _votes(bytes32 digest, uint256[] memory idx) internal view returns (ICoferPot.Vote[] memory v) {
        v = new ICoferPot.Vote[](idx.length);
        for (uint256 i; i < idx.length; ++i) {
            v[i] = ICoferPot.Vote(m[idx[i]], _sig(keys[idx[i]], digest));
        }
        // insertion sort by signer
        for (uint256 i = 1; i < v.length; ++i) {
            ICoferPot.Vote memory x = v[i];
            uint256 j = i;
            while (j > 0 && v[j - 1].signer > x.signer) {
                v[j] = v[j - 1];
                --j;
            }
            v[j] = x;
        }
    }

    function _idx(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function _idx2(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        (r[0], r[1]) = (a, b);
    }

    function _all() internal pure returns (uint256[] memory r) {
        r = new uint256[](5);
        for (uint256 i; i < 5; ++i) r[i] = i;
    }

    /// @dev Execute with given signers; returns the `executed` flag.
    function _exec(uint8 kind, bytes memory data, uint256 nonce, uint256[] memory idx) internal returns (bool) {
        uint64 deadline = FAR_DEADLINE;
        uint64 ep = pot.epoch();
        bytes32 d = pot.hashProposal(kind, data, nonce, ep, deadline);
        return pot.execute(kind, data, nonce, ep, deadline, _votes(d, idx));
    }

    function _path(address a, address b) internal pure returns (bytes memory) {
        return abi.encodePacked(a, FEE_TIER, b);
    }

    function _swapData(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(address(adapter), tokenIn, tokenOut, amountIn, minOut, _path(tokenIn, tokenOut));
    }
}
