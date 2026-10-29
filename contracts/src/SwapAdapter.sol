// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";
import {IV3SwapRouter} from "./interfaces/IExternal.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";

/// @title UniV3SwapAdapter
/// @notice Stateless adapter over Uniswap SwapRouter02 `exactInput` on Robinhood Chain
///         (0xcaf681a66d020601342297493863e78c959e5cb2). The only contract a pot approves for swaps.
///         - path must start at tokenIn and end at tokenOut (packed v3 path: token|fee|token...)
///         - output always goes to msg.sender (the pot); minOut is enforced twice (router + here)
///         - approvals are exact and reset to zero; the adapter never keeps a balance
contract UniV3SwapAdapter is ISwapAdapter, ReentrancyGuard {
    using SafeTransferLib for address;

    address public immutable router;
    uint256 public constant MAX_HOPS = 3;

    error BadPath();
    error OutputTooLow(uint256 got, uint256 minOut);

    constructor(address router_) {
        if (router_ == address(0)) revert BadPath();
        router = router_;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes calldata route)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        _checkPath(route, tokenIn, tokenOut);
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        tokenIn.safeApprove(router, amountIn);
        uint256 before = tokenOut.balanceOf(msg.sender);
        IV3SwapRouter(router).exactInput(
            IV3SwapRouter.ExactInputParams({path: route, recipient: msg.sender, amountIn: amountIn, amountOutMinimum: minOut})
        );
        tokenIn.safeApprove(router, 0);
        amountOut = tokenOut.balanceOf(msg.sender) - before;
        if (amountOut < minOut) revert OutputTooLow(amountOut, minOut);
    }

    function _checkPath(bytes calldata path, address tokenIn, address tokenOut) internal pure {
        uint256 len = path.length;
        if (len < 43 || (len - 20) % 23 != 0) revert BadPath();
        if ((len - 20) / 23 > MAX_HOPS) revert BadPath();
        address first = address(bytes20(path[0:20]));
        address last = address(bytes20(path[len - 20:len]));
        if (first != tokenIn || last != tokenOut) revert BadPath();
    }
}
