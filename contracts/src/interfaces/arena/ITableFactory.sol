// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArenaTypes} from "../../arena/ArenaTypes.sol";

interface ITableFactory {
    event TableCreated(address indexed table, address indexed host, ArenaTypes.Mode mode, uint256 signerSetId, bytes32 rulesHash);
    event CapsQueued(uint96 maxBuyIn, uint96 maxTablePot, uint128 maxLiveValue, uint64 eta);
    event CapsApplied(uint96 maxBuyIn, uint96 maxTablePot, uint128 maxLiveValue);
    event CreationPaused(bool paused);
    event EligibilitySignerQueued(address signer, uint64 eta);
    event EligibilitySignerApplied(address signer);
    event GuardianSet(address guardian);
    event MinHostBondQueued(uint256 bond, uint64 eta);
    event MinHostBondApplied(uint256 bond);
    event StakePoolSet(address pool);
    event PrizeVaultSet(address vault);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    function createTable(ArenaTypes.TableParams calldata p, bytes32 salt) external returns (address table);
    function predictTable(address host, bytes32 salt) external view returns (address);
    function isTable(address) external view returns (bool);

    function maxBuyIn() external view returns (uint96);
    function maxTablePot() external view returns (uint96);
    function maxLiveValue() external view returns (uint128);
    function liveValue() external view returns (uint128);
    function minHostBond() external view returns (uint256);
    function queueMinHostBond(uint256 bond) external;
    function applyMinHostBond() external;
    function queueCaps(uint96 maxBuyIn_, uint96 maxTablePot_, uint128 maxLiveValue_) external;
    function applyCaps() external;

    function reserve(uint256 amount) external;
    function release(uint256 amount) external;

    function setCreationPaused(bool paused) external;
    function creationPaused() external view returns (bool);
    function setGuardian(address g) external;
    function guardian() external view returns (address);
    function queueEligibilitySigner(address s) external;
    function applyEligibilitySigner() external;
    function eligibilitySigner() external view returns (address);
    function registry() external view returns (address);
    function stakePool() external view returns (address);
    function prizeVault() external view returns (address);
    function setStakePool(address pool) external;
    function setPrizeVault(address vault) external;
    function usdg() external view returns (address);
    function cofr() external view returns (address);
    function implementation() external view returns (address);
    function owner() external view returns (address);
}
