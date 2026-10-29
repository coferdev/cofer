// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice An allowlisted swap adapter. Pulls exactly `amountIn` of `tokenIn` from msg.sender and
///         sends at least `minOut` of `tokenOut` back to msg.sender, or reverts.
interface ISwapAdapter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes calldata route)
        external
        returns (uint256 amountOut);
}
