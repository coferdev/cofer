// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The parts of USDG the Arena calls (EIP-2612 + EIP-3009; re-checked in ArenaFork).
interface IUSDG {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}
