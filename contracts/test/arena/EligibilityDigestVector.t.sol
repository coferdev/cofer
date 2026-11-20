// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "../utils/Test.sol";
import {TableEscrow} from "../../src/arena/TableEscrow.sol";

/// @notice A fixed vector for the Eligibility digest as TableEscrow._seat checks it; services/test/arenaEligibility.test.ts
///         computes the same value in TS, so the eligibility signer and the escrow can never drift apart.
contract EligibilityDigestVectorTest is Test {
    function test_eligibilityDigestVector() public {
        vm.chainId(4663);
        TableEscrow t = new TableEscrow();
        address player = address(0xA11CE);
        bytes32 h = t.hashTyped(keccak256(abi.encode(t.ELIGIBILITY_TYPEHASH(), address(t), player, uint8(1), true, uint64(1_800_000_540))));
        emit log_vector(address(t), h);
        assertEq(h, VECTOR);
    }

    event log_vector(address table, bytes32 digest);

    bytes32 internal constant VECTOR = 0x2581b43e37af149227f1385854a9c288d5bf16ccfc07e6288b8a8a672aeeb05b;
}
