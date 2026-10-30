// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "../utils/Test.sol";
import {CoferPot} from "../../src/CoferPot.sol";
import {CoferFactory} from "../../src/CoferFactory.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {UniV3SwapAdapter} from "../../src/SwapAdapter.sol";
import {ICoferPot} from "../../src/interfaces/ICoferPot.sol";
import {IERC20, IV3SwapRouter} from "../../src/interfaces/IExternal.sol";

/// @notice Fork-only cheatcodes (kept out of the shared Vm subset so offline runners are unaffected).
interface VmFork {
    function record() external;
    function accesses(address) external returns (bytes32[] memory reads, bytes32[] memory writes);
    function load(address, bytes32) external view returns (bytes32);
    function store(address, bytes32, bytes32) external;
}

interface IUniV3Factory {
    function getPool(address, address, uint24) external view returns (address);
}

interface IUniV3Pool {
    function liquidity() external view returns (uint128);
}

interface IQuoterV2 {
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (uint256 amountOut, uint160[] memory, uint32[] memory, uint256 gasEstimate);
}

/// @title Swap path on a local fork of Robinhood Chain mainnet
/// @notice Fresh Cofer contracts on the fork, real USDG + one real Stock Token + real Chainlink feeds,
///         real SwapRouter02 and QuoterV2. Run through `bun scripts/fork-swap-test.ts` (services/),
///         which passes canonical addresses in FORK_* variables. Without a 4663 fork every test
///         returns at once, so plain `forge test` and Hardhat stay offline.
///         The vote is built the way the bot builds it: best QuoterV2 tier, then
///         minOut = max(pool x (1 - 1%), oracle x (1 - maxSlipBps)).
contract SwapForkTest is Test {
    VmFork internal constant fvm = VmFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;

    uint8 internal constant SWAP = 1;
    uint16 internal constant SLIP_BPS = 100; // bot default for /buy and /sell
    uint256 internal constant DEPOSIT = 1_000e6;
    uint256 internal constant BUY = 100e6;
    uint256 internal constant QUOTE_GAS = 500_000;
    uint24[4] internal FEES = [uint24(100), 500, 3000, 10000];

    bool internal forked;
    address internal usdg;
    address internal stock;
    address internal swapRouter;
    address internal quoter;
    address internal v3Factory;

    CoferFactory internal factory;
    FeeRouter internal feeRouter;
    UniV3SwapAdapter internal adapter;
    CoferPot internal pot;

    address internal owner = address(0xA0);
    address internal whale = address(0xBADA55);
    uint256[3] internal keys = [uint256(0xA11CE), 0xB0B, 0xCA401];
    address[3] internal m;

    function setUp() public {
        if (block.chainid != 4663) return;
        forked = true;
        usdg = vm.envAddress("FORK_USDG");
        stock = vm.envAddress("FORK_STOCK");
        swapRouter = vm.envAddress("FORK_ROUTER");
        quoter = vm.envAddress("FORK_QUOTER");
        v3Factory = vm.envAddress("FORK_V3_FACTORY");

        // Same wiring as script/Deploy.s.sol, plus the stock listing from build-asset-list.ts.
        address[4] memory sinks = [address(0xB1), address(0xB2), address(0xB3), address(0xB4)];
        CoferPot impl = new CoferPot();
        feeRouter = new FeeRouter(usdg, owner, 9e6, sinks);
        factory = new CoferFactory(address(impl), usdg, address(feeRouter), owner, owner, 30);
        adapter = new UniV3SwapAdapter(swapRouter);
        vm.startPrank(owner);
        feeRouter.setFactory(address(factory));
        factory.listAsset(usdg, vm.envAddress("FORK_USDG_FEED"), 1 days, false);
        factory.listAsset(stock, vm.envAddress("FORK_STOCK_FEED"), 4 days, true);
        factory.queueAdapter(address(adapter));
        uint256 t0 = block.timestamp;
        vm.warp(t0 + factory.TIMELOCK());
        factory.applyAdapter(address(adapter));
        vm.warp(t0); // back to the fork's own time, so the real feeds are exactly as fresh as on-chain
        vm.stopPrank();

        address[] memory list = new address[](3);
        for (uint256 i; i < 3; ++i) {
            m[i] = vm.addr(keys[i]);
            list[i] = m[i];
        }
        pot = CoferPot(
            factory.createPot(
                list,
                0,
                6000, // 2 of 3
                ICoferPot.Config({guardDelay: 6 hours, maxSlipBps: 300, entrySpreadBps: 50, depositsOpen: true}),
                bytes32("fork-group")
            )
        );
        for (uint256 i; i < 3; ++i) {
            _deal(usdg, m[i], DEPOSIT);
            vm.startPrank(m[i]);
            IERC20(usdg).approve(address(pot), DEPOSIT);
            pot.deposit(DEPOSIT);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------ buys

    function test_fork_buyThroughRealRouter() public {
        if (!forked) return;
        uint256 feeBefore = IERC20(usdg).balanceOf(address(feeRouter));
        (uint256 got, uint256 minOut) = _buy();
        assertGe(got, minOut, "pot received at least minOut");
        assertEq(IERC20(usdg).balanceOf(address(feeRouter)) - feeBefore, (BUY * 30) / 10_000, "0.30% fee to FeeRouter");
        assertEq(IERC20(usdg).balanceOf(address(pot)), 3 * DEPOSIT - BUY, "pot paid exactly amountIn");
        assertEq(pot.heldAssets().length, 2, "stock added to held assets");
        _assertAdapterClean();
    }

    /// @dev The gate: a vote signed at a fair price is refused once the pool is pushed off-price.
    function test_fork_skewedPoolRefusesBuy() public {
        if (!forked) return;
        (bytes memory data, uint256 minOut, uint256 floor, bytes memory path) = _plan(usdg, stock, BUY);
        (uint64 ep, uint64 dl, ICoferPot.Vote[] memory v) = _sign(data, 1);

        uint256 swapIn = BUY - (BUY * 30) / 10_000;
        uint256 skewed = _skew(path, usdg, 10_000e6, swapIn, floor);
        _log("pool quote after skew", skewed);
        _log("signed minOut", minOut);
        _log("oracle floor", floor);

        // 1. the vote signed before the skew no longer executes: the pool cannot pay its minOut
        uint256 usdgBefore = IERC20(usdg).balanceOf(address(pot));
        uint256 feeBefore = IERC20(usdg).balanceOf(address(feeRouter));
        _assertPoolRefuses(data, 1, ep, dl, v);
        assertEq(IERC20(usdg).balanceOf(address(pot)), usdgBefore, "pot USDG untouched");
        assertEq(IERC20(stock).balanceOf(address(pot)), 0, "no stock bought");
        assertEq(IERC20(usdg).balanceOf(address(feeRouter)), feeBefore, "no fee taken");
        assertFalse(pot.usedNonce(1), "nonce still unused");

        // 2. the bot would refuse to build a new vote: pool quote is below the oracle floor
        assertTrue(skewed < floor, "computeMinOut refuses: pool below oracle floor");

        // 3. a vote built from the skewed quote anyway is refused by the on-chain oracle floor
        uint256 looseMin = (skewed * (10_000 - SLIP_BPS)) / 10_000;
        bytes memory loose = abi.encode(address(adapter), usdg, stock, BUY, looseMin, path);
        (ep, dl, v) = _sign(loose, 2);
        vm.expectRevert(abi.encodeWithSelector(ICoferPot.SlippageTooLoose.selector, looseMin, floor));
        pot.execute(SWAP, loose, 2, ep, dl, v);
    }

    // ------------------------------------------------------------------ sells

    function test_fork_sellThroughRealRouter() public {
        if (!forked) return;
        (uint256 bal,) = _buy();
        (bytes memory data, uint256 minOut,,) = _plan(stock, usdg, bal);
        uint256 usdgBefore = IERC20(usdg).balanceOf(address(pot));
        assertTrue(_execute(data, 2), "sell executes at once");
        assertGe(IERC20(usdg).balanceOf(address(pot)) - usdgBefore, minOut, "pot received at least minOut");
        assertEq(IERC20(stock).balanceOf(address(pot)), 0, "all stock sold");
        assertEq(pot.heldAssets().length, 1, "stock pruned from held assets");
        _assertAdapterClean();
    }

    function test_fork_skewedPoolRefusesSell() public {
        if (!forked) return;
        (uint256 bal,) = _buy();
        (bytes memory data,, uint256 floor, bytes memory path) = _plan(stock, usdg, bal);
        (uint64 ep, uint64 dl, ICoferPot.Vote[] memory v) = _sign(data, 2);

        uint256 swapIn = bal - (bal * 30) / 10_000;
        uint256 skewed = _skew(path, stock, factory.quote(usdg, stock, 10_000e6), swapIn, floor);
        _log("pool quote after skew", skewed);
        _log("oracle floor", floor);

        uint256 usdgBefore = IERC20(usdg).balanceOf(address(pot));
        _assertPoolRefuses(data, 2, ep, dl, v);
        assertEq(IERC20(stock).balanceOf(address(pot)), bal, "pot stock untouched");
        assertEq(IERC20(usdg).balanceOf(address(pot)), usdgBefore, "pot USDG untouched");
        assertTrue(skewed < floor, "computeMinOut refuses: pool below oracle floor");
    }

    // ------------------------------------------------------------------ exit

    /// @dev Exit is never gated: after a refused buy against a skewed pool, a member still leaves
    ///      with their exact share of real USDG and the real Stock Token.
    function test_fork_exitAfterRefusedBuy() public {
        if (!forked) return;
        _buy();
        (bytes memory data,, uint256 floor, bytes memory path) = _plan(usdg, stock, BUY);
        (uint64 ep, uint64 dl, ICoferPot.Vote[] memory v) = _sign(data, 2);
        _skew(path, usdg, 10_000e6, BUY - (BUY * 30) / 10_000, floor);
        _assertPoolRefuses(data, 2, ep, dl, v);

        address who = m[0];
        uint256 shares = pot.memberInfo(who).shares;
        uint256 supply = pot.totalShares();
        uint256 wantUsdg = (pot.distributable(usdg) * shares) / supply;
        uint256 wantStock = (pot.distributable(stock) * shares) / supply;
        vm.prank(who);
        pot.exit(shares, who);
        assertEq(IERC20(usdg).balanceOf(who), wantUsdg, "exact USDG share");
        assertEq(IERC20(stock).balanceOf(who), wantStock, "exact stock share, delivered (not set aside)");
        assertEq(pot.owed(stock, who), 0, "nothing owed");
    }

    // ------------------------------------------------------------------ helpers

    /// @dev Builds a swap vote like the bot: best QuoterV2 tier, the factory's oracle quote, and
    ///      minOut = max(pool x (1 - SLIP_BPS), floor). Refuses (like computeMinOut) if pool < floor.
    function _plan(address tokenIn, address tokenOut, uint256 amountIn)
        internal
        returns (bytes memory data, uint256 minOut, uint256 floor, bytes memory path)
    {
        uint256 swapIn = amountIn - (amountIn * factory.swapFeeBps()) / 10_000;
        uint256 poolOut;
        (path, poolOut) = _bestRoute(tokenIn, tokenOut, swapIn);
        (, uint16 maxSlip,,) = pot.config();
        floor = (factory.quote(tokenIn, tokenOut, swapIn) * (10_000 - maxSlip)) / 10_000;
        assertGe(poolOut, floor, "pool already below the oracle floor before any skew");
        uint256 fromPool = (poolOut * (10_000 - SLIP_BPS)) / 10_000;
        minOut = fromPool > floor ? fromPool : floor;
        data = abi.encode(address(adapter), tokenIn, tokenOut, amountIn, minOut, path);
    }

    /// @dev Highest QuoterV2 output across the v3 fee tiers. Tiers with no pool, or no liquidity in
    ///      range, are skipped. Each quote gets a gas cap like a real eth_call: a badly priced pool
    ///      can otherwise walk empty ticks for a very long time. A failed quote is logged, never silent.
    function _bestRoute(address tokenIn, address tokenOut, uint256 amountIn)
        internal
        returns (bytes memory path, uint256 out)
    {
        for (uint256 i; i < FEES.length; ++i) {
            address pool = IUniV3Factory(v3Factory).getPool(tokenIn, tokenOut, FEES[i]);
            if (pool == address(0) || IUniV3Pool(pool).liquidity() == 0) continue;
            bytes memory p = abi.encodePacked(tokenIn, FEES[i], tokenOut);
            try IQuoterV2(quoter).quoteExactInput{gas: QUOTE_GAS}(p, amountIn) returns (uint256 o, uint160[] memory, uint32[] memory, uint256) {
                if (o > out) (path, out) = (p, o);
            } catch {
                _log("quote failed (gas cap or RPC) at fee tier", FEES[i]);
            }
        }
        assertTrue(out > 0, "no v3 pool quoted for this pair");
        _log("chosen fee tier", uint24(bytes3(_slice3(path, 20))));
        _log("pool quote", out);
    }

    function _buy() internal returns (uint256 got, uint256 minOut) {
        bytes memory data;
        (data, minOut,,) = _plan(usdg, stock, BUY);
        assertTrue(_execute(data, 1), "buy executes at once (swaps skip the exit window)");
        got = IERC20(stock).balanceOf(address(pot));
    }

    /// @dev A whale trades `tokenIn` through the same pool in growing chunks until QuoterV2 says
    ///      the pot's own swap of `probeIn` would pay less than `target`.
    function _skew(bytes memory path, address tokenIn, uint256 chunk, uint256 probeIn, uint256 target)
        internal
        returns (uint256 quoted)
    {
        for (uint256 i; i < 12; ++i) {
            _deal(tokenIn, whale, chunk);
            vm.startPrank(whale);
            IERC20(tokenIn).approve(swapRouter, chunk);
            IV3SwapRouter(swapRouter).exactInput(IV3SwapRouter.ExactInputParams(path, whale, chunk, 0));
            vm.stopPrank();
            (quoted,,,) = IQuoterV2(quoter).quoteExactInput(path, probeIn);
            if (quoted < target) {
                _log("whale trades", i + 1);
                return quoted;
            }
            chunk *= 2;
        }
        revert("could not skew the pool");
    }

    /// @dev execute() must revert inside the pool swap (SwapRouter02 "Too little received"),
    ///      not at the oracle floor: this vote passed the floor when it was signed.
    function _assertPoolRefuses(bytes memory data, uint256 nonce, uint64 ep, uint64 dl, ICoferPot.Vote[] memory v)
        internal
    {
        (bool ok, bytes memory ret) = address(pot).call(abi.encodeCall(CoferPot.execute, (SWAP, data, nonce, ep, dl, v)));
        assertFalse(ok, "execute must revert");
        assertTrue(keccak256(ret) == keccak256(abi.encodeWithSignature("Error(string)", "Too little received")), "pool refused");
    }

    function _assertAdapterClean() internal view {
        assertEq(IERC20(usdg).balanceOf(address(adapter)), 0, "adapter keeps no USDG");
        assertEq(IERC20(stock).balanceOf(address(adapter)), 0, "adapter keeps no stock");
        assertEq(IERC20(usdg).allowance(address(adapter), swapRouter), 0, "adapter USDG approval reset");
        assertEq(IERC20(stock).allowance(address(adapter), swapRouter), 0, "adapter stock approval reset");
        assertEq(IERC20(usdg).allowance(address(pot), address(adapter)), 0, "pot USDG approval reset");
        assertEq(IERC20(stock).allowance(address(pot), address(adapter)), 0, "pot stock approval reset");
    }

    function _execute(bytes memory data, uint256 nonce) internal returns (bool) {
        (uint64 ep, uint64 dl, ICoferPot.Vote[] memory v) = _sign(data, nonce);
        return pot.execute(SWAP, data, nonce, ep, dl, v);
    }

    /// @dev All three members sign; votes sorted by signer address.
    function _sign(bytes memory data, uint256 nonce) internal view returns (uint64 ep, uint64 dl, ICoferPot.Vote[] memory v) {
        ep = pot.epoch();
        dl = uint64(block.timestamp + 1 days);
        bytes32 digest = pot.hashProposal(SWAP, data, nonce, ep, dl);
        v = new ICoferPot.Vote[](3);
        for (uint256 i; i < 3; ++i) {
            (uint8 sv, bytes32 r, bytes32 s) = vm.sign(keys[i], digest);
            v[i] = ICoferPot.Vote(m[i], abi.encodePacked(r, s, sv));
        }
        for (uint256 i = 1; i < 3; ++i) {
            ICoferPot.Vote memory x = v[i];
            uint256 j = i;
            while (j > 0 && v[j - 1].signer > x.signer) {
                v[j] = v[j - 1];
                --j;
            }
            v[j] = x;
        }
    }

    /// @dev Sets `to`'s balance on the local fork only: finds the storage slot balanceOf reads,
    ///      writes it, and keeps it only if balanceOf then returns exactly `amount`.
    function _deal(address token, address to, uint256 amount) internal {
        fvm.record();
        IERC20(token).balanceOf(to);
        (bytes32[] memory reads,) = fvm.accesses(token);
        for (uint256 i = reads.length; i > 0; --i) {
            bytes32 slot = reads[i - 1];
            bytes32 prev = fvm.load(token, slot);
            fvm.store(token, slot, bytes32(amount));
            // gas cap: a wrong slot (e.g. a loop bound) must fail fast, not spin on the test's huge gas limit
            try IERC20(token).balanceOf{gas: 200_000}(to) returns (uint256 b) {
                if (b == amount) return;
            } catch {}
            fvm.store(token, slot, prev);
        }
        revert("balance slot not found");
    }

    function _slice3(bytes memory b, uint256 at) internal pure returns (bytes3 r) {
        assembly {
            r := mload(add(add(b, 32), at))
        }
    }

    function _log(string memory label, uint256 value) internal view {
        (bool ok,) = CONSOLE.staticcall(abi.encodeWithSignature("log(string,uint256)", label, value));
        ok;
    }
}
