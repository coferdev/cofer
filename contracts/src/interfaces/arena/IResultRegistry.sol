// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ITableEscrow} from "./ITableEscrow.sol";

interface IResultRegistry {
    event SignerSetQueued(uint256 indexed id, address[] signers, uint8 k, uint64 eta);
    event SignerSetApplied(uint256 indexed id);
    event SignerRevoked(address indexed signer);
    event ResultRecorded(
        address indexed table, uint8 round, bytes32 digest, bytes32 logHead, bytes32 eventsRoot, bytes32 standingsRoot, string logURI
    );
    event TapeAnchored(uint64 indexed hourId, bytes32 tapeHead, string tapeURI);
    event FactorySet(address factory);
    event GuardianSet(address guardian);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    function currentSetId() external view returns (uint256);
    function signerSet(uint256 id) external view returns (address[] memory signers, uint8 k);
    function queueSignerSet(address[] calldata signers, uint8 k) external;
    function applySignerSet() external;
    function revokeSigner(address signer) external;
    function isRevoked(address) external view returns (bool);
    function resultDigest(address table, ITableEscrow.Result calldata r) external view returns (bytes32);
    function verify(uint256 setId, bytes32 digest, bytes[] calldata sigs) external view returns (bool);
    function record(bytes32 digest, ITableEscrow.Result calldata r) external;

    function anchorTape(uint64 hourId, bytes32 tapeHead, string calldata tapeURI, bytes[] calldata sigs) external;
    function tapeHead(uint64 hourId) external view returns (bytes32);
    function tapeDigest(uint64 hourId, bytes32 tapeHead_, string calldata tapeURI) external view returns (bytes32);

    function factory() external view returns (address);
    function setFactory(address f) external;
    function guardian() external view returns (address);
    function setGuardian(address g) external;
}
