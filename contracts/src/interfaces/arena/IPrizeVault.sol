// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArenaTypes} from "../../arena/ArenaTypes.sol";

interface IPrizeVault {
    event Funded(address indexed table, address indexed token, uint256 amount);
    event WeeklyCapQueued(address indexed token, uint256 cap, uint64 eta);
    event WeeklyCapApplied(address indexed token, uint256 cap);
    event SchedulerSet(address scheduler);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    function fundFreeroll(ArenaTypes.TableParams calldata p, bytes32 salt) external returns (address table);
    function weeklyCap(address token) external view returns (uint256);
    function spentThisWeek(address token) external view returns (uint256);
    function queueWeeklyCap(address token, uint256 cap) external;
    function applyWeeklyCap(address token) external;
    function setScheduler(address s) external;
    // Inflows are plain transfers. There is no other outflow: no transfer(to), no sweep, no owner withdrawal.
}
