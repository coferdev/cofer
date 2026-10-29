// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICoferFactory} from "./interfaces/ICoferFactory.sol";
import {ICoferPot} from "./interfaces/ICoferPot.sol";
import {IAggregatorV3, IERC20} from "./interfaces/IExternal.sol";
import {CoferPot} from "./CoferPot.sol";
import {Clones} from "./lib/Clones.sol";
import {FullMath} from "./lib/FullMath.sol";

/// @title CoferFactory
/// @notice Deploys one CoferPot clone per group and holds the studio-wide registry: listed assets
///         (with their Chainlink feeds), allowlisted swap adapters and the swap fee.
/// @dev Owner = brand multisig. Anything that changes prices or swap routes is timelocked 48h.
///      Owner/guardian powers stop at: pausing NEW deposits and NEW pots, listing/delisting buys.
///      Nothing here can move, freeze or gate a pot's existing funds or exits.
contract CoferFactory is ICoferFactory {
    uint32 public constant TIMELOCK = 48 hours;
    uint16 public constant MAX_SWAP_FEE_BPS = 50; // 0.50% hard cap
    uint32 public constant MAX_STALENESS_CAP = 4 days; // covers a US-market weekend

    address public immutable implementation;
    address public immutable usdg;
    address public immutable feeRouter;

    address public owner;
    address public pendingOwner;
    address public guardian;

    uint16 public swapFeeBps;
    bool public depositsPaused;
    bool public creationPaused;

    mapping(address => Asset) internal _assets;
    address[] public assetList;
    mapping(address => bool) public isAdapter;
    mapping(address => bool) public isPot;

    struct PendingFeed {
        address feed;
        uint32 maxStaleness;
        uint64 eta;
    }

    mapping(address => PendingFeed) public pendingFeed;
    mapping(address => uint64) public pendingAdapterEta;
    uint16 public pendingSwapFeeBps;
    uint64 public pendingSwapFeeEta;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param implementation_ a CoferPot deployed with its constructor (which locks it).
    constructor(
        address implementation_,
        address usdg_,
        address feeRouter_,
        address owner_,
        address guardian_,
        uint16 swapFeeBps_
    ) {
        if (implementation_.code.length == 0) revert BadParam();
        if (usdg_ == address(0) || feeRouter_ == address(0) || owner_ == address(0)) revert BadParam();
        if (swapFeeBps_ > MAX_SWAP_FEE_BPS) revert BadParam();
        usdg = usdg_;
        feeRouter = feeRouter_;
        owner = owner_;
        guardian = guardian_;
        swapFeeBps = swapFeeBps_;
        implementation = implementation_;
        emit OwnershipTransferred(address(0), owner_);
        emit GuardianSet(guardian_);
        emit SwapFeeSet(swapFeeBps_);
    }

    // ------------------------------------------------------------------
    // Pots
    // ------------------------------------------------------------------

    function createPot(
        address[] calldata members,
        uint8 threshold,
        uint16 thresholdBps,
        ICoferPot.Config calldata config,
        bytes32 salt
    ) external returns (address pot) {
        if (creationPaused) revert CreationIsPaused();
        bytes32 s = keccak256(abi.encode(msg.sender, salt)); // creator-bound: no salt squatting
        pot = Clones.cloneDeterministic(implementation, s);
        isPot[pot] = true;
        CoferPot(pot).initialize(usdg, members, threshold, thresholdBps, config);
        emit PotCreated(pot, msg.sender, salt, members, threshold, thresholdBps);
    }

    function predictPot(address creator, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, keccak256(abi.encode(creator, salt)), address(this));
    }

    // ------------------------------------------------------------------
    // Prices (Chainlink). Equity feeds on Robinhood Chain already include the Stock Token
    // multiplier, so value = rawBalance * answer. NEVER multiply by uiMultiplier() here.
    // ------------------------------------------------------------------

    function _price18(address asset) internal view returns (uint256 p18, uint8 dec) {
        Asset storage a = _assets[asset];
        if (!a.listed) revert NotListed();
        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(a.feed).latestRoundData();
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) revert BadPrice(asset);
        if (block.timestamp - updatedAt > a.maxStaleness) revert StalePrice(asset);
        p18 = uint256(answer) * 10 ** (18 - a.feedDecimals);
        dec = a.tokenDecimals;
    }

    /// @notice amountOut = amountIn * priceIn / priceOut, adjusted for token decimals.
    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        if (tokenIn == tokenOut) return amountIn;
        (uint256 pIn, uint8 dIn) = _price18(tokenIn);
        (uint256 pOut, uint8 dOut) = _price18(tokenOut);
        uint256 usd18 = FullMath.mulDiv(amountIn, pIn, 10 ** dIn); // 18-dp USD
        return FullMath.mulDiv(usd18, 10 ** dOut, pOut);
    }

    function valueInUsdg(address asset, uint256 amount) external view returns (uint256) {
        if (asset == usdg) return amount;
        return quote(asset, usdg, amount);
    }

    function isBuyable(address asset) external view returns (bool) {
        return _assets[asset].buyable;
    }

    function assetInfo(address asset) external view returns (Asset memory) {
        return _assets[asset];
    }

    function assetCount() external view returns (uint256) {
        return assetList.length;
    }

    // ------------------------------------------------------------------
    // Registry admin (owner = multisig)
    // ------------------------------------------------------------------

    /// @notice First listing is immediate (no pot can hold an unlisted asset yet). Canonical Stock
    ///         Token addresses must come from the issuer's public asset API (see services/stocks).
    function listAsset(address asset, address feed, uint32 maxStaleness, bool isStock) external onlyOwner {
        if (asset == address(0) || feed == address(0)) revert BadParam();
        if (maxStaleness == 0 || maxStaleness > MAX_STALENESS_CAP) revert BadParam();
        if (_assets[asset].listed) revert AlreadyListed();
        uint8 fd = IAggregatorV3(feed).decimals();
        uint8 td = IERC20(asset).decimals();
        if (fd > 18 || td > 36) revert BadParam();
        _assets[asset] = Asset(true, true, isStock, td, fd, maxStaleness, feed);
        assetList.push(asset);
        emit AssetListed(asset, feed, maxStaleness, isStock);
        emit AssetBuyable(asset, true);
    }

    /// @notice Stop/allow NEW buys of an asset. Immediate. Pots that hold it keep valuing and exiting it.
    function setBuyable(address asset, bool buyable) external onlyOwner {
        if (!_assets[asset].listed) revert NotListed();
        if (asset == usdg && !buyable) revert BadParam(); // selling back to USDG must stay possible
        _assets[asset].buyable = buyable;
        emit AssetBuyable(asset, buyable);
    }

    function queueFeed(address asset, address feed, uint32 maxStaleness) external onlyOwner {
        if (!_assets[asset].listed) revert NotListed();
        if (feed == address(0) || maxStaleness == 0 || maxStaleness > MAX_STALENESS_CAP) revert BadParam();
        uint64 eta = uint64(block.timestamp) + TIMELOCK;
        pendingFeed[asset] = PendingFeed(feed, maxStaleness, eta);
        emit FeedQueued(asset, feed, maxStaleness, eta);
    }

    function applyFeed(address asset) external onlyOwner {
        PendingFeed memory p = pendingFeed[asset];
        if (p.eta == 0) revert NothingQueued();
        if (block.timestamp < p.eta) revert Timelocked();
        uint8 fd = IAggregatorV3(p.feed).decimals();
        if (fd > 18) revert BadParam();
        Asset storage a = _assets[asset];
        a.feed = p.feed;
        a.feedDecimals = fd;
        a.maxStaleness = p.maxStaleness;
        delete pendingFeed[asset];
        emit FeedApplied(asset, p.feed, p.maxStaleness);
    }

    function queueAdapter(address adapter) external onlyOwner {
        if (adapter == address(0) || adapter.code.length == 0) revert BadParam();
        uint64 eta = uint64(block.timestamp) + TIMELOCK;
        pendingAdapterEta[adapter] = eta;
        emit AdapterQueued(adapter, eta);
    }

    function applyAdapter(address adapter) external onlyOwner {
        uint64 eta = pendingAdapterEta[adapter];
        if (eta == 0) revert NothingQueued();
        if (block.timestamp < eta) revert Timelocked();
        delete pendingAdapterEta[adapter];
        isAdapter[adapter] = true;
        emit AdapterSet(adapter, true);
    }

    /// @notice Removing an adapter is immediate (it can only reduce what pots can do).
    function removeAdapter(address adapter) external onlyOwner {
        isAdapter[adapter] = false;
        delete pendingAdapterEta[adapter];
        emit AdapterSet(adapter, false);
    }

    function queueSwapFee(uint16 bps) external onlyOwner {
        if (bps > MAX_SWAP_FEE_BPS) revert BadParam();
        pendingSwapFeeBps = bps;
        pendingSwapFeeEta = uint64(block.timestamp) + TIMELOCK;
        emit SwapFeeQueued(bps, pendingSwapFeeEta);
    }

    function applySwapFee() external onlyOwner {
        if (pendingSwapFeeEta == 0) revert NothingQueued();
        if (block.timestamp < pendingSwapFeeEta) revert Timelocked();
        swapFeeBps = pendingSwapFeeBps;
        pendingSwapFeeEta = 0;
        emit SwapFeeSet(swapFeeBps);
    }

    // ------------------------------------------------------------------
    // Pauses: entries only
    // ------------------------------------------------------------------

    function setDepositsPaused(bool paused) external {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardian();
        depositsPaused = paused;
        emit DepositsPaused(paused);
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
