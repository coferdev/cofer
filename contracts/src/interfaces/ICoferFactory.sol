// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICoferPot} from "./ICoferPot.sol";

interface ICoferFactory {
    struct Asset {
        bool listed; // has ever been listed (feed kept for valuation forever)
        bool buyable; // pots may swap INTO it
        bool isStock; // Robinhood Stock Token (ERC-8056); frontend geo-gates buys
        uint8 tokenDecimals;
        uint8 feedDecimals;
        uint32 maxStaleness; // seconds
        address feed; // Chainlink AggregatorV3 (equity feeds already include the multiplier)
    }

    event PotCreated(address indexed pot, address indexed creator, bytes32 salt, address[] members, uint8 threshold, uint16 thresholdBps);
    event AssetListed(address indexed asset, address feed, uint32 maxStaleness, bool isStock);
    event AssetBuyable(address indexed asset, bool buyable);
    event FeedQueued(address indexed asset, address feed, uint32 maxStaleness, uint64 eta);
    event FeedApplied(address indexed asset, address feed, uint32 maxStaleness);
    event AdapterQueued(address indexed adapter, uint64 eta);
    event AdapterSet(address indexed adapter, bool allowed);
    event SwapFeeQueued(uint16 bps, uint64 eta);
    event SwapFeeSet(uint16 bps);
    event DepositsPaused(bool paused);
    event CreationPaused(bool paused);
    event GuardianSet(address guardian);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotGuardian();
    error BadParam();
    error AlreadyListed();
    error NotListed();
    error Timelocked();
    error NothingQueued();
    error StalePrice(address asset);
    error BadPrice(address asset);
    error CreationIsPaused();

    function usdg() external view returns (address);
    function feeRouter() external view returns (address);
    function implementation() external view returns (address);
    function swapFeeBps() external view returns (uint16);
    function depositsPaused() external view returns (bool);
    function isPot(address) external view returns (bool);
    function isAdapter(address) external view returns (bool);
    function isBuyable(address asset) external view returns (bool);
    function assetInfo(address asset) external view returns (Asset memory);
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256);
    function valueInUsdg(address asset, uint256 amount) external view returns (uint256);

    function createPot(
        address[] calldata members,
        uint8 threshold,
        uint16 thresholdBps,
        ICoferPot.Config calldata config,
        bytes32 salt
    ) external returns (address pot);

    function predictPot(address creator, bytes32 salt) external view returns (address);
}
