// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArenaTypes} from "./ArenaTypes.sol";
import {IPrizeVault} from "../interfaces/arena/IPrizeVault.sol";
import {ITableFactory} from "../interfaces/arena/ITableFactory.sol";
import {SafeTransferLib} from "../lib/SafeTransferLib.sol";
import {ReentrancyGuard} from "../lib/ReentrancyGuard.sol";

/// @title PrizeVault
/// @notice Freeroll prize budget (spec §3.10). Its only outflow is `fundFreeroll`, which creates a new Freeroll
///         table through the factory with the vault as sponsor, so the prize lands in that table's escrow. A weekly
///         cap per token (48 h timelock to change) bounds what the scheduler key can spend.
/// @dev No transfer(to), no sweep, no owner withdrawal. Inflows are plain transfers. No shares, no prices.
contract PrizeVault is IPrizeVault, ReentrancyGuard {
    using SafeTransferLib for address;

    error NotOwner();
    error NotScheduler();
    error BadParam();
    error OverWeeklyCap();
    error TooEarly();
    error NothingQueued();
    error FundingMismatch();

    uint32 public constant TIMELOCK = 48 hours;

    address public immutable factory;
    address public owner;
    address public pendingOwner;
    address public scheduler;

    mapping(address => uint256) public weeklyCap;
    mapping(address => uint256) internal _spent;
    mapping(address => uint256) internal _spentWeek;
    mapping(address => uint256) public queuedCap;
    mapping(address => uint64) public queuedCapEta;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address factory_, address owner_, address scheduler_, address[] memory tokens, uint256[] memory caps) {
        if (factory_ == address(0) || owner_ == address(0) || tokens.length != caps.length) revert BadParam();
        factory = factory_;
        owner = owner_;
        scheduler = scheduler_;
        emit OwnershipTransferred(address(0), owner_);
        emit SchedulerSet(scheduler_);
        for (uint256 i; i < tokens.length; ++i) {
            weeklyCap[tokens[i]] = caps[i];
            emit WeeklyCapApplied(tokens[i], caps[i]);
        }
    }

    /// @notice Unix time 0 is a Thursday; shifting by 3 days makes each week start Monday 00:00 UTC.
    uint256 public constant WEEK_OFFSET = 3 days;

    /// @notice Week number; the weekly cap resets every Monday at 00:00 UTC.
    function currentWeek() public view returns (uint256) {
        return (block.timestamp + WEEK_OFFSET) / 1 weeks;
    }

    function spentThisWeek(address token) public view returns (uint256) {
        return _spentWeek[token] == currentWeek() ? _spent[token] : 0;
    }

    function fundFreeroll(ArenaTypes.TableParams calldata p, bytes32 salt) external nonReentrant returns (address table) {
        if (msg.sender != scheduler) revert NotScheduler();
        if (p.mode != ArenaTypes.Mode.FREEROLL) revert BadParam();
        uint256 spent = spentThisWeek(p.token) + p.prize;
        if (spent > weeklyCap[p.token]) revert OverWeeklyCap();
        _spent[p.token] = spent;
        _spentWeek[p.token] = currentWeek();

        uint256 before = p.token.balanceOf(address(this));
        p.token.safeApprove(factory, p.prize);
        table = ITableFactory(factory).createTable(p, salt);
        p.token.safeApprove(factory, 0);
        if (before - p.token.balanceOf(address(this)) != p.prize || !ITableFactory(factory).isTable(table)) {
            revert FundingMismatch();
        }
        emit Funded(table, p.token, p.prize);
    }

    function queueWeeklyCap(address token, uint256 cap) external onlyOwner {
        queuedCap[token] = cap;
        queuedCapEta[token] = uint64(block.timestamp) + TIMELOCK;
        emit WeeklyCapQueued(token, cap, queuedCapEta[token]);
    }

    function applyWeeklyCap(address token) external onlyOwner {
        uint64 eta = queuedCapEta[token];
        if (eta == 0) revert NothingQueued();
        if (block.timestamp < eta) revert TooEarly();
        weeklyCap[token] = queuedCap[token];
        delete queuedCap[token];
        delete queuedCapEta[token];
        emit WeeklyCapApplied(token, weeklyCap[token]);
    }

    function setScheduler(address s) external onlyOwner {
        scheduler = s;
        emit SchedulerSet(s);
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
