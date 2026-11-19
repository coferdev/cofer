// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "../utils/Test.sol";
import {ResultRegistry} from "../../src/arena/ResultRegistry.sol";
import {ITableEscrow} from "../../src/interfaces/arena/ITableEscrow.sol";

contract RulesHashStub {
    function rulesHash() external pure returns (bytes32) {
        return keccak256("rules-json-v1");
    }
}

/// @notice A fixed vector for the Result digest; services/test/arenaSigner.test.ts computes the same value in TS,
///         so the signers' digest and the registry's digest can never drift apart.
contract ResultDigestVectorTest is Test {
    function test_resultDigestVector() public {
        vm.chainId(4663);
        address[] memory s = new address[](3);
        s[0] = address(0x5161);
        s[1] = address(0x5162);
        s[2] = address(0x5163);
        ResultRegistry reg = new ResultRegistry(address(this), address(0x6A), s, 2);
        RulesHashStub table = new RulesHashStub();
        ITableEscrow.Result memory r;
        r.round = 1;
        r.logHead = keccak256("log");
        r.eventsRoot = keccak256("events");
        r.standingsRoot = keccak256("standings");
        r.podium = new address[](2);
        r.podium[0] = address(0xB1);
        r.podium[1] = address(0xB2);
        r.payoutRoot = keccak256("payout");
        r.totalPayout = 123e6;
        r.engineBuild = keccak256("engine");
        r.logURI = "ipfs://bafy-log";
        bytes32 d = reg.resultDigest(address(table), r);
        emit log_vector(address(reg), address(table), d);
        assertEq(d, VECTOR);
    }

    event log_vector(address registry, address table, bytes32 digest);

    bytes32 internal constant VECTOR = 0x0c7e305cc718e437969c8b17b7c5fcd4d38331286f8a80c7f2dcfa9b9de90775;
}
