// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArenaTypes} from "../../arena/ArenaTypes.sol";

interface ITableEscrow {
    struct Result {
        uint8 round; // 0 = first post, 1 = revision after a dispute
        bytes32 logHead; // last link of the hash-chained event log
        bytes32 eventsRoot; // Merkle root over (seq, eventHash, chainHash)
        bytes32 standingsRoot; // Merkle root over final standings rows
        address[] podium; // FRIEND: ranked winners, length == payoutBps.length
        bytes32 payoutRoot; // FREEROLL: Merkle root over (index, account, amount)
        uint256 totalPayout; // FREEROLL: sum of payout leaves, <= prize
        bytes32 engineBuild; // OCI digest of the engine/replay build
        string logURI; // published log location
    }

    event Joined(address indexed player, uint16 seat, bytes32 sessionKeyHash, bool prizeEligible);
    event Left(address indexed player);
    event Kicked(address indexed player);
    event Locked(uint64 lockedAt, uint64 endAt, uint64 hardDeadline, uint256 pot);
    event Cancelled();
    event ResultPosted(uint8 round, bytes32 digest, uint64 disputeEnd);
    event Disputed(address indexed by, uint8 round, bytes32 reasonHash, uint256 bond);
    event Objection(address indexed by, bytes32 reasonHash);
    event Settled(bytes32 digest, bool unanimous);
    event Refunded(uint8 reason); // 0 not started, 1 deadline, 2 unanimous void
    event Claimed(address indexed account, address indexed to, uint256 amount);

    function initialize(
        ArenaTypes.TableParams calldata p,
        address host,
        address sponsor,
        uint256 signerSetId,
        address eligibilitySigner
    ) external;

    function state() external view returns (ArenaTypes.State);
    function params() external view returns (ArenaTypes.TableParams memory);
    function rulesHash() external view returns (bytes32);
    function host() external view returns (address);
    function sponsor() external view returns (address);
    function signerSetId() external view returns (uint256);
    function lockedAt() external view returns (uint64);
    function endAt() external view returns (uint64);
    function hardDeadline() external view returns (uint64);
    function disputeEnd() external view returns (uint64);
    function seats() external view returns (address[] memory);
    function seatOf(address) external view returns (uint16 seatPlusOne, bytes32 sessionKeyHash, bool prizeEligible);
    function owed(address) external view returns (uint256);

    // Open
    function join(bytes32 sessionKeyHash, bytes calldata invite, bytes calldata eligibility) external;
    function joinWithAuthorization(
        address player,
        bytes32 sessionKeyHash,
        bytes calldata invite,
        bytes calldata eligibility,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
    function joinWithPermit(
        bytes32 sessionKeyHash,
        bytes calldata invite,
        bytes calldata eligibility,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
    function leave() external;
    function kick(address player) external;
    function lock() external;
    function cancel() external;

    // Settling
    function postResult(Result calldata r, bytes[] calldata signerSigs) external;
    function dispute(bytes32 reasonHash) external;
    function finalize() external;
    function acceptAll(bytes[] calldata playerSigs) external;
    function voidAll(bytes[] calldata playerSigs) external;
    function refundAll() external;

    // Pull payments
    function claim(address to) external;
    function claimPrize(uint256 index, uint256 amount, bytes32[] calldata proof, address to) external;
    function sponsorReclaim() external;
}
