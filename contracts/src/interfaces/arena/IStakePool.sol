// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IStakePool {
    enum Term {
        D7,
        D30,
        D90
    } // weight multipliers 1, 2, 4

    event Staked(address indexed owner, uint256 indexed id, uint256 amount, Term term, uint64 unlockAt);
    event Unstaked(address indexed owner, uint256 indexed id, uint256 amount);
    event Pledged(address indexed owner, uint256 indexed id, uint256 amount);
    event BondMarked(address indexed owner, uint256 indexed id);
    event BondExtended(address indexed owner, uint64 bondUntil);

    function stake(uint256 amount, Term term) external returns (uint256 id);
    function unstake(uint256 id) external;
    function pledge(uint256 id, uint256 amount) external;
    function markBond(uint256 id) external;
    function noteHosted(address host, uint64 eventEnd) external;
    function weightOf(address owner) external view returns (uint256);
    function bondOf(address owner) external view returns (uint256);
    function bondUntil(address owner) external view returns (uint64);
    // There is no reward, distribute or claimRewards function.
}
