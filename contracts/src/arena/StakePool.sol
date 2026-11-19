// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IStakePool} from "../interfaces/arena/IStakePool.sol";
import {ITableFactory} from "../interfaces/arena/ITableFactory.sol";
import {SafeTransferLib} from "../lib/SafeTransferLib.sol";
import {ReentrancyGuard} from "../lib/ReentrancyGuard.sol";

/// @title StakePool
/// @notice $COFR locks (spec §3.10). A position is (owner, amount, term, unlockAt, isBond). Weight drives off-chain
///         perks only. `pledge` sends COFR to the PrizeVault for good. There is no reward accounting at all, no
///         owner and no pause: `unstake` is blocked only by the position's own unlock time and, for a host bond,
///         by `bondUntil`.
contract StakePool is IStakePool, ReentrancyGuard {
    using SafeTransferLib for address;

    error BadParam();
    error NotPositionOwner();
    error StillLocked();
    error NotFactory();
    error NoVault();
    error AlreadyBond();

    struct Position {
        address owner;
        uint96 unlockAt;
        uint256 amount;
        Term term;
        bool isBond;
    }

    address public immutable cofr;
    address public immutable factory;

    uint256 public nextId = 1;
    mapping(uint256 => Position) public positions;
    mapping(address => uint256) public weightOf;
    mapping(address => uint256) public bondOf;
    mapping(address => uint64) public bondUntil;

    constructor(address cofr_, address factory_) {
        if (cofr_ == address(0) || factory_ == address(0)) revert BadParam();
        cofr = cofr_;
        factory = factory_;
    }

    function termLength(Term t) public pure returns (uint64) {
        return t == Term.D7 ? 7 days : t == Term.D30 ? 30 days : 90 days;
    }

    function termWeight(Term t) public pure returns (uint256) {
        return t == Term.D7 ? 1 : t == Term.D30 ? 2 : 4;
    }

    function stake(uint256 amount, Term term) external nonReentrant returns (uint256 id) {
        if (amount == 0) revert BadParam();
        uint256 before = cofr.balanceOf(address(this));
        cofr.safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = cofr.balanceOf(address(this)) - before; // credit what actually arrived
        if (got == 0) revert BadParam();
        id = nextId++;
        uint64 unlockAt = uint64(block.timestamp) + termLength(term);
        positions[id] = Position(msg.sender, unlockAt, got, term, false);
        weightOf[msg.sender] += got * termWeight(term);
        emit Staked(msg.sender, id, got, term, unlockAt);
    }

    function unstake(uint256 id) external nonReentrant {
        Position memory p = positions[id];
        if (p.owner != msg.sender) revert NotPositionOwner();
        if (block.timestamp < p.unlockAt) revert StillLocked();
        if (p.isBond && block.timestamp < bondUntil[msg.sender]) revert StillLocked();
        delete positions[id];
        weightOf[msg.sender] -= p.amount * termWeight(p.term);
        if (p.isBond) bondOf[msg.sender] -= p.amount;
        emit Unstaked(msg.sender, id, p.amount);
        if (p.amount != 0) cofr.safeTransfer(msg.sender, p.amount);
    }

    function pledge(uint256 id, uint256 amount) external nonReentrant {
        Position storage p = positions[id];
        if (p.owner != msg.sender) revert NotPositionOwner();
        if (amount == 0 || amount > p.amount) revert BadParam();
        address vault = ITableFactory(factory).prizeVault();
        if (vault == address(0)) revert NoVault();
        p.amount -= amount;
        weightOf[msg.sender] -= amount * termWeight(p.term);
        if (p.isBond) bondOf[msg.sender] -= amount;
        emit Pledged(msg.sender, id, amount);
        cofr.safeTransfer(vault, amount);
    }

    function markBond(uint256 id) external {
        Position storage p = positions[id];
        if (p.owner != msg.sender) revert NotPositionOwner();
        if (p.isBond) revert AlreadyBond();
        p.isBond = true;
        bondOf[msg.sender] += p.amount;
        emit BondMarked(msg.sender, id);
    }

    /// @notice Factory only: a host's bond stays locked until 30 days after their last event.
    function noteHosted(address host, uint64 eventEnd) external {
        if (msg.sender != factory) revert NotFactory();
        uint64 until = eventEnd + 30 days;
        if (until > bondUntil[host]) {
            bondUntil[host] = until;
            emit BondExtended(host, until);
        }
    }
}
