// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice EIP-1167 minimal proxy deployment, vendored from OpenZeppelin Contracts (MIT),
///         contracts/proxy/Clones.sol:
///         - cloneDeterministic: v5.0.2 (tag commit dbb6104ce834628e473d2173bbc9d47f81a9eec3), same
///           assembly; the block is marked "memory-safe" and the error is FailedDeployment() (the
///           name OpenZeppelin uses from v5.1) instead of ERC1167FailedCreateClone().
///         - predictDeterministicAddress: v5.1.0 (tag commit 69c8def5f222ff96f2b5beff05dfba996368aa79),
///           unchanged (identical through v5.5.0).
library Clones {
    error FailedDeployment();

    function cloneDeterministic(address implementation, bytes32 salt) internal returns (address instance) {
        assembly ("memory-safe") {
            mstore(0x00, or(shr(0xe8, shl(0x60, implementation)), 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000))
            mstore(0x20, or(shl(0x78, implementation), 0x5af43d82803e903d91602b57fd5bf3))
            instance := create2(0, 0x09, 0x37, salt)
        }
        if (instance == address(0)) revert FailedDeployment();
    }

    function predictDeterministicAddress(address implementation, bytes32 salt, address deployer)
        internal
        pure
        returns (address predicted)
    {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(add(ptr, 0x38), deployer)
            mstore(add(ptr, 0x24), 0x5af43d82803e903d91602b57fd5bf3ff)
            mstore(add(ptr, 0x14), implementation)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73)
            mstore(add(ptr, 0x58), salt)
            mstore(add(ptr, 0x78), keccak256(add(ptr, 0x0c), 0x37))
            predicted := and(keccak256(add(ptr, 0x43), 0x55), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }
}
