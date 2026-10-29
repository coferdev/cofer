// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "./utils/Test.sol";
import {CoferPot} from "../src/CoferPot.sol";

/// @notice Cross-language parity: the digest below was produced by services/src/core/proposal.ts
///         (viem hashTypedData). services/test/proposal.test.ts asserts the same constant, and also
///         runs this contract's compiled bytecode in an EVM. If either side changes encoding, both fail.
contract ParityTest is Test {
    address constant POT = address(0xc0FE);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    bytes32 constant VIEM_DIGEST = 0xa3e41da42fd01dedbc3e4b7600ae28231e31f47e4360226fb7aebbff916cde7a;

    function test_hashProposalMatchesViem() public {
        CoferPot impl = new CoferPot();
        vm.etch(POT, address(impl).code); // hashProposal reads only constants, chainid and address(this)
        vm.chainId(4663);
        bytes memory data = abi.encode(USDG, address(0xF00D), uint256(100_000_000));
        bytes32 d = CoferPot(POT).hashProposal(0, data, 42, 0, 4_000_000_000);
        assertEq(d, VIEM_DIGEST);
    }

    function test_typehashStrings() public {
        CoferPot impl = new CoferPot();
        assertEq(impl.PROPOSAL_TYPEHASH(), keccak256("Proposal(uint8 kind,bytes data,uint256 nonce,uint64 epoch,uint64 deadline)"));
        assertEq(
            impl.DOMAIN_TYPEHASH(),
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
        );
    }
}
