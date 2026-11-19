// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IResultRegistry} from "../interfaces/arena/IResultRegistry.sol";
import {ITableEscrow} from "../interfaces/arena/ITableEscrow.sol";
import {ITableFactory} from "../interfaces/arena/ITableFactory.sol";
import {SignatureChecker} from "../lib/SignatureChecker.sol";

/// @title ResultRegistry
/// @notice Result signer sets (timelocked, snapshotted per table), EIP-712 result digests, result records and the
///         hourly price-tape anchors (spec §3.6, §4.2). It never holds or moves funds.
/// @dev A new signer set gets a new id; old ids are never edited, so a rotation cannot reach a live table.
///      Revocation is immediate and permanent and only removes signing power, in every set.
contract ResultRegistry is IResultRegistry {
    error NotOwner();
    error NotGuardian();
    error BadParam();
    error TooEarly();
    error NothingQueued();
    error NotTable();
    error AlreadySet();
    error AlreadyAnchored();
    error BadSignatures();

    uint32 public constant TIMELOCK = 48 hours;
    uint8 public constant MIN_SIGNERS = 3;
    uint8 public constant MAX_SIGNERS = 7;

    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant RESULT_TYPEHASH = keccak256(
        "Result(address table,uint8 round,bytes32 rulesHash,bytes32 logHead,bytes32 eventsRoot,bytes32 standingsRoot,"
        "bytes32 podiumHash,bytes32 payoutRoot,uint256 totalPayout,bytes32 engineBuild,bytes32 logURIHash)"
    );
    bytes32 public constant TAPE_TYPEHASH = keccak256("Tape(uint64 hourId,bytes32 tapeHead,bytes32 tapeURIHash)");

    address public owner;
    address public pendingOwner;
    address public guardian;
    address public factory;

    struct SignerSet {
        address[] signers;
        uint8 k;
    }

    uint256 public currentSetId;
    mapping(uint256 => SignerSet) internal _sets;
    mapping(uint256 => mapping(address => bool)) internal _inSet;
    mapping(address => bool) public isRevoked;

    SignerSet internal _queued;
    uint64 public queuedEta;

    mapping(address => mapping(uint8 => bytes32)) public recordedDigest; // table => round => digest
    mapping(uint64 => bytes32) public tapeHead;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, address guardian_, address[] memory initialSigners, uint8 k) {
        if (owner_ == address(0)) revert BadParam();
        owner = owner_;
        guardian = guardian_;
        emit OwnershipTransferred(address(0), owner_);
        emit GuardianSet(guardian_);
        _checkSet(initialSigners, k);
        _apply(initialSigners, k);
    }

    // ------------------------------------------------------------------ signer sets

    function signerSet(uint256 id) external view returns (address[] memory signers, uint8 k) {
        SignerSet storage s = _sets[id];
        return (s.signers, s.k);
    }

    function queueSignerSet(address[] calldata signers, uint8 k) external onlyOwner {
        _checkSet(signers, k);
        _queued.signers = signers;
        _queued.k = k;
        queuedEta = uint64(block.timestamp) + TIMELOCK;
        emit SignerSetQueued(currentSetId + 1, signers, k, queuedEta);
    }

    function applySignerSet() external onlyOwner {
        if (queuedEta == 0) revert NothingQueued();
        if (block.timestamp < queuedEta) revert TooEarly();
        address[] memory s = _queued.signers;
        uint8 k = _queued.k;
        delete _queued;
        queuedEta = 0;
        _apply(s, k);
    }

    function revokeSigner(address signer) external {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardian();
        isRevoked[signer] = true;
        emit SignerRevoked(signer);
    }

    function _checkSet(address[] memory signers, uint8 k) internal pure {
        uint256 n = signers.length;
        if (n < MIN_SIGNERS || n > MAX_SIGNERS || k < 2 || k > n) revert BadParam();
        for (uint256 i; i < n; ++i) {
            if (signers[i] == address(0)) revert BadParam();
            for (uint256 j; j < i; ++j) {
                if (signers[i] == signers[j]) revert BadParam();
            }
        }
    }

    function _apply(address[] memory signers, uint8 k) internal {
        uint256 id = ++currentSetId;
        SignerSet storage s = _sets[id];
        s.signers = signers;
        s.k = k;
        for (uint256 i; i < signers.length; ++i) {
            _inSet[id][signers[i]] = true;
        }
        emit SignerSetApplied(id);
    }

    // ------------------------------------------------------------------ digests and verification

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Cofer Arena"), keccak256("1"), block.chainid, address(this)));
    }

    function resultDigest(address table, ITableEscrow.Result calldata r) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                RESULT_TYPEHASH,
                table,
                r.round,
                ITableEscrow(table).rulesHash(),
                r.logHead,
                r.eventsRoot,
                r.standingsRoot,
                keccak256(abi.encodePacked(r.podium)),
                r.payoutRoot,
                r.totalPayout,
                r.engineBuild,
                keccak256(bytes(r.logURI))
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function tapeDigest(uint64 hourId, bytes32 tapeHead_, string calldata tapeURI) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(TAPE_TYPEHASH, hourId, tapeHead_, keccak256(bytes(tapeURI))));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice True when at least k distinct, non-revoked signers of set `setId` signed `digest`.
    /// @dev Signatures must be sorted by recovered address, strictly ascending (so duplicates fail). Signatures
    ///      from addresses outside the set, or revoked, do not count.
    function verify(uint256 setId, bytes32 digest, bytes[] calldata sigs) public view returns (bool) {
        SignerSet storage s = _sets[setId];
        if (s.k == 0) return false;
        uint256 good;
        address last;
        for (uint256 i; i < sigs.length; ++i) {
            address a = SignatureChecker.tryRecover(digest, sigs[i]);
            if (a == address(0) || a <= last) return false;
            last = a;
            if (_inSet[setId][a] && !isRevoked[a]) ++good;
        }
        return good >= s.k;
    }

    // ------------------------------------------------------------------ records

    /// @notice Called by a factory table when it accepts a result.
    function record(bytes32 digest, ITableEscrow.Result calldata r) external {
        address f = factory;
        if (f == address(0) || !ITableFactory(f).isTable(msg.sender)) revert NotTable();
        recordedDigest[msg.sender][r.round] = digest;
        emit ResultRecorded(msg.sender, r.round, digest, r.logHead, r.eventsRoot, r.standingsRoot, r.logURI);
    }

    /// @notice Anchors one UTC hour of the shared price tape with k-of-n signatures of the current set. Anyone submits.
    function anchorTape(uint64 hourId, bytes32 tapeHead_, string calldata tapeURI, bytes[] calldata sigs) external {
        if (tapeHead_ == bytes32(0)) revert BadParam();
        if (tapeHead[hourId] != bytes32(0)) revert AlreadyAnchored();
        if (!verify(currentSetId, tapeDigest(hourId, tapeHead_, tapeURI), sigs)) revert BadSignatures();
        tapeHead[hourId] = tapeHead_;
        emit TapeAnchored(hourId, tapeHead_, tapeURI);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Set once by the owner after the factory is deployed (the registry is deployed first).
    function setFactory(address f) external onlyOwner {
        if (factory != address(0)) revert AlreadySet();
        if (f == address(0)) revert BadParam();
        factory = f;
        emit FactorySet(f);
    }

    function setGuardian(address g) external onlyOwner {
        guardian = g;
        emit GuardianSet(g);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
