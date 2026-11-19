// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArenaTypes} from "./ArenaTypes.sol";
import {ITableFactory} from "../interfaces/arena/ITableFactory.sol";
import {ITableEscrow} from "../interfaces/arena/ITableEscrow.sol";
import {IResultRegistry} from "../interfaces/arena/IResultRegistry.sol";
import {IStakePool} from "../interfaces/arena/IStakePool.sol";
import {Clones} from "../lib/Clones.sol";
import {SafeTransferLib} from "../lib/SafeTransferLib.sol";
import {ReentrancyGuard} from "../lib/ReentrancyGuard.sol";

/// @title TableFactory
/// @notice Clones one TableEscrow per game, checks every table's parameters against on-chain caps, and keeps the
///         live value of all unsettled Friend Tables under `maxLiveValue` (spec §3.1, §3.10, §3.11).
/// @dev No admin power here reaches any table's funds: caps, the eligibility signer and the signer set are copied
///      into a table at creation, and pausing stops NEW tables only.
contract TableFactory is ITableFactory, ReentrancyGuard {
    using SafeTransferLib for address;

    error NotOwner();
    error NotGuardian();
    error NotTableErr();
    error BadParam();
    error Paused();
    error TooEarly();
    error NothingQueued();
    error AlreadySet();
    error OverLiveCap();
    error NeedHostBond();
    error PrizeNotFunded();

    uint32 public constant TIMELOCK = 48 hours;
    uint32 public constant FRIEND_MIN_DURATION = 24 hours;
    uint32 public constant FRIEND_DISPUTE_WINDOW = 2 hours;
    uint32 public constant FRIEND_SETTLE_GRACE = 24 hours;
    uint32 public constant FREEROLL_DISPUTE_WINDOW = 24 hours;
    uint32 public constant FREEROLL_SETTLE_GRACE = 72 hours;
    uint16 public constant FRIEND_DISPUTE_BOND_BPS = 2_000; // 20% of the buy-in, fixed, not host-chosen (Open decision 8)
    uint16 public constant FRIEND_MAX_SEATS = 10;
    uint16 public constant FREEROLL_MAX_SEATS = 4096;
    uint96 public constant MIN_BUY_IN = 1e6; // 1 USDG
    uint64 public constant MAX_OPEN = 7 days; // sit-and-go registration window
    uint8 public constant MAX_PODIUM = 3;

    address public owner;
    address public pendingOwner;
    address public guardian;

    address public immutable usdg;
    address public immutable cofr;
    address public immutable registry;
    address public immutable implementation;

    address public stakePool;
    address public prizeVault;
    address public eligibilitySigner;
    uint256 public minHostBond;
    bool public creationPaused;

    uint96 public maxBuyIn;
    uint96 public maxTablePot;
    uint128 public maxLiveValue;
    uint128 public liveValue;

    struct QueuedCaps {
        uint96 maxBuyIn;
        uint96 maxTablePot;
        uint128 maxLiveValue;
        uint64 eta;
    }

    QueuedCaps public queuedCaps;
    uint256 public queuedMinHostBond;
    uint64 public queuedMinHostBondEta;
    address public queuedEligibilitySigner;
    uint64 public queuedEligibilityEta;

    mapping(address => bool) public isTable;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address usdg_,
        address cofr_,
        address registry_,
        address implementation_,
        address owner_,
        address guardian_,
        address eligibilitySigner_,
        uint96 maxBuyIn_,
        uint96 maxTablePot_,
        uint128 maxLiveValue_,
        uint256 minHostBond_
    ) {
        if (
            usdg_ == address(0) || cofr_ == address(0) || registry_ == address(0) || implementation_ == address(0)
                || owner_ == address(0) || eligibilitySigner_ == address(0)
        ) revert BadParam();
        _checkCaps(maxBuyIn_, maxTablePot_);
        usdg = usdg_;
        cofr = cofr_;
        registry = registry_;
        implementation = implementation_;
        owner = owner_;
        guardian = guardian_;
        eligibilitySigner = eligibilitySigner_;
        maxBuyIn = maxBuyIn_;
        maxTablePot = maxTablePot_;
        maxLiveValue = maxLiveValue_;
        minHostBond = minHostBond_;
        emit OwnershipTransferred(address(0), owner_);
        emit GuardianSet(guardian_);
        emit CapsApplied(maxBuyIn_, maxTablePot_, maxLiveValue_);
        emit EligibilitySignerApplied(eligibilitySigner_);
        emit MinHostBondApplied(minHostBond_);
    }

    // ------------------------------------------------------------------ tables

    function createTable(ArenaTypes.TableParams calldata p, bytes32 salt) external nonReentrant returns (address table) {
        if (creationPaused) revert Paused();
        _checkParams(p);

        table = Clones.cloneDeterministic(implementation, _salt(msg.sender, salt));
        isTable[table] = true;
        uint256 setId = IResultRegistry(registry).currentSetId();
        ITableEscrow(table).initialize(p, msg.sender, msg.sender, setId, eligibilitySigner);

        if (p.mode == ArenaTypes.Mode.FREEROLL) {
            if (msg.sender != prizeVault) {
                address pool = stakePool;
                if (pool == address(0) || IStakePool(pool).bondOf(msg.sender) < minHostBond) revert NeedHostBond();
                uint64 start = p.lockAt != 0 ? p.lockAt : p.openUntil;
                IStakePool(pool).noteHosted(msg.sender, start + 1 hours + p.duration + p.settleGrace);
            }
            // the prize is in escrow before anyone can join
            uint256 before = p.token.balanceOf(table);
            p.token.safeTransferFrom(msg.sender, table, p.prize);
            if (p.token.balanceOf(table) - before != p.prize) revert PrizeNotFunded();
        }
        emit TableCreated(table, msg.sender, p.mode, setId, p.rulesHash);
    }

    function predictTable(address host, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(host, salt), address(this));
    }

    function _salt(address host, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(host, salt));
    }

    function _checkParams(ArenaTypes.TableParams calldata p) internal view {
        if (p.rulesHash == bytes32(0) || p.minSeats < 2 || p.minSeats > p.maxSeats || p.duration == 0) revert BadParam();
        if (p.lockAt == 0) {
            if (p.openUntil <= block.timestamp || p.openUntil > block.timestamp + MAX_OPEN) revert BadParam();
        } else {
            if (p.lockAt <= block.timestamp || p.openUntil != 0) revert BadParam();
        }
        if (p.settleGrace < 2 * uint256(p.disputeWindow) + 12 hours) revert BadParam();

        if (p.mode == ArenaTypes.Mode.FRIEND) {
            if (p.token != usdg || p.prize != 0 || !p.cryptoOnly) revert BadParam();
            if (p.buyIn < MIN_BUY_IN || p.buyIn > maxBuyIn) revert BadParam();
            if (p.maxSeats > FRIEND_MAX_SEATS || uint256(p.buyIn) * p.maxSeats > maxTablePot) revert BadParam();
            if (p.duration < FRIEND_MIN_DURATION) revert BadParam();
            if (p.disputeWindow != FRIEND_DISPUTE_WINDOW || p.settleGrace != FRIEND_SETTLE_GRACE) revert BadParam();
            if (p.disputeBondBps != FRIEND_DISPUTE_BOND_BPS) revert BadParam();
            uint256 n = p.payoutBps.length;
            if (n == 0 || n > MAX_PODIUM || n > p.minSeats) revert BadParam();
            uint256 sum;
            for (uint256 i; i < n; ++i) {
                if (p.payoutBps[i] == 0) revert BadParam();
                sum += p.payoutBps[i];
            }
            if (sum != 10_000) revert BadParam();
        } else {
            if (p.token != usdg && p.token != cofr) revert BadParam();
            if (p.buyIn != 0 || p.prize == 0 || p.maxSeats > FREEROLL_MAX_SEATS) revert BadParam();
            if (p.disputeWindow != FREEROLL_DISPUTE_WINDOW || p.settleGrace != FREEROLL_SETTLE_GRACE) revert BadParam();
            if (p.disputeBondBps != 0 || p.payoutBps.length != 0) revert BadParam();
        }
    }

    // ------------------------------------------------------------------ live value (tables only)

    function reserve(uint256 amount) external {
        if (!isTable[msg.sender]) revert NotTableErr();
        uint256 v = uint256(liveValue) + amount;
        if (v > maxLiveValue) revert OverLiveCap();
        liveValue = uint128(v);
    }

    /// @notice Never reverts for a table (saturating), so no refund or claim can be blocked by the accounting.
    function release(uint256 amount) external {
        if (!isTable[msg.sender]) revert NotTableErr();
        uint128 v = liveValue;
        liveValue = amount >= v ? 0 : v - uint128(amount);
    }

    // ------------------------------------------------------------------ admin (none of it reaches a table's funds)

    function queueCaps(uint96 maxBuyIn_, uint96 maxTablePot_, uint128 maxLiveValue_) external onlyOwner {
        _checkCaps(maxBuyIn_, maxTablePot_);
        uint64 eta = uint64(block.timestamp) + TIMELOCK;
        queuedCaps = QueuedCaps(maxBuyIn_, maxTablePot_, maxLiveValue_, eta);
        emit CapsQueued(maxBuyIn_, maxTablePot_, maxLiveValue_, eta);
    }

    function applyCaps() external onlyOwner {
        QueuedCaps memory q = queuedCaps;
        if (q.eta == 0) revert NothingQueued();
        if (block.timestamp < q.eta) revert TooEarly();
        delete queuedCaps;
        maxBuyIn = q.maxBuyIn;
        maxTablePot = q.maxTablePot;
        maxLiveValue = q.maxLiveValue;
        emit CapsApplied(q.maxBuyIn, q.maxTablePot, q.maxLiveValue);
    }

    function _checkCaps(uint96 maxBuyIn_, uint96 maxTablePot_) internal pure {
        if (maxBuyIn_ < MIN_BUY_IN || maxTablePot_ < maxBuyIn_) revert BadParam();
    }

    /// @notice Host bond for public Freerolls not funded by the vault. Same 48 h timelock as the caps; it is checked
    ///         only in createTable, so a change applies to new tables only.
    function queueMinHostBond(uint256 bond) external onlyOwner {
        queuedMinHostBond = bond;
        queuedMinHostBondEta = uint64(block.timestamp) + TIMELOCK;
        emit MinHostBondQueued(bond, queuedMinHostBondEta);
    }

    function applyMinHostBond() external onlyOwner {
        uint64 eta = queuedMinHostBondEta;
        if (eta == 0) revert NothingQueued();
        if (block.timestamp < eta) revert TooEarly();
        minHostBond = queuedMinHostBond;
        queuedMinHostBond = 0;
        queuedMinHostBondEta = 0;
        emit MinHostBondApplied(minHostBond);
    }

    function setCreationPaused(bool paused) external {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardian();
        creationPaused = paused;
        emit CreationPaused(paused);
    }

    function setGuardian(address g) external onlyOwner {
        guardian = g;
        emit GuardianSet(g);
    }

    function queueEligibilitySigner(address s) external onlyOwner {
        if (s == address(0)) revert BadParam();
        queuedEligibilitySigner = s;
        queuedEligibilityEta = uint64(block.timestamp) + TIMELOCK;
        emit EligibilitySignerQueued(s, queuedEligibilityEta);
    }

    function applyEligibilitySigner() external onlyOwner {
        if (queuedEligibilityEta == 0) revert NothingQueued();
        if (block.timestamp < queuedEligibilityEta) revert TooEarly();
        eligibilitySigner = queuedEligibilitySigner;
        queuedEligibilitySigner = address(0);
        queuedEligibilityEta = 0;
        emit EligibilitySignerApplied(eligibilitySigner);
    }

    function setStakePool(address pool) external onlyOwner {
        if (stakePool != address(0)) revert AlreadySet();
        if (pool == address(0)) revert BadParam();
        stakePool = pool;
        emit StakePoolSet(pool);
    }

    function setPrizeVault(address vault) external onlyOwner {
        if (prizeVault != address(0)) revert AlreadySet();
        if (vault == address(0)) revert BadParam();
        prizeVault = vault;
        emit PrizeVaultSet(vault);
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
