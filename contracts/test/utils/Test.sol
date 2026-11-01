// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Written for this repo; no code copied. The Vm interface declares 19 cheatcodes, each with
///         the same signature as in forge-std v1.17.0 src/Vm.sol (tag commit
///         f3dae6e6ee381f25eb6a246f7da9b85c91a68219). The assert helpers are this repo's own and
///         revert with a message, so the suite compiles with plain solc and runs under `forge test`
///         or Hardhat 3 Solidity tests without installs.
interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function chainId(uint256) external;
    function etch(address, bytes calldata) external;
    function addr(uint256) external pure returns (address);
    function sign(uint256, bytes32) external pure returns (uint8, bytes32, bytes32);
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function label(address, string calldata) external;
    function assume(bool) external pure;
    function envUint(string calldata) external view returns (uint256);
    function envAddress(string calldata) external view returns (address);
    function envOr(string calldata, address) external view returns (address);
    function envOr(string calldata, uint256) external view returns (uint256);
    function startBroadcast(uint256) external;
    function stopBroadcast() external;
}

abstract contract Test {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bool public IS_TEST = true;

    function fail(string memory m) internal pure {
        revert(m);
    }

    function assertTrue(bool c, string memory m) internal pure {
        if (!c) revert(m);
    }

    function assertTrue(bool c) internal pure {
        assertTrue(c, "assertTrue");
    }

    function assertFalse(bool c) internal pure {
        assertTrue(!c, "assertFalse");
    }

    function assertFalse(bool c, string memory msg_) internal pure {
        assertTrue(!c, msg_);
    }

    function assertEq(uint256 a, uint256 b, string memory m) internal pure {
        if (a != b) revert(string.concat(m, ": ", _u(a), " != ", _u(b)));
    }

    function assertEq(uint256 a, uint256 b) internal pure {
        assertEq(a, b, "assertEq(uint)");
    }

    function assertEq(address a, address b) internal pure {
        if (a != b) revert("assertEq(address)");
    }

    function assertEq(bytes32 a, bytes32 b) internal pure {
        if (a != b) revert("assertEq(bytes32)");
    }

    function assertEq(bool a, bool b) internal pure {
        if (a != b) revert("assertEq(bool)");
    }

    function assertGe(uint256 a, uint256 b, string memory m) internal pure {
        if (a < b) revert(string.concat(m, ": ", _u(a), " < ", _u(b)));
    }

    function assertLe(uint256 a, uint256 b, string memory m) internal pure {
        if (a > b) revert(string.concat(m, ": ", _u(a), " > ", _u(b)));
    }

    function bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (hi <= lo) return lo;
        return lo + (x % (hi - lo + 1));
    }

    function _u(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory b;
        while (v > 0) {
            b = abi.encodePacked(bytes1(uint8(48 + (v % 10))), b);
            v /= 10;
        }
        return string(b);
    }
}
