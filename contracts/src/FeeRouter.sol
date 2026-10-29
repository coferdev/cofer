// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";

interface IPotRegistry {
    function isPot(address) external view returns (bool);
}

/// @title FeeRouter
/// @notice Receives the group swap fee (sent by pots in the input token) and optional monthly group
///         plan payments (USDG, prepaid). `distribute` splits any token balance to four sinks:
///         work 80% / treasury 10% / holder-perks budget 5% / buy-and-burn 5%.
///         Nothing here is ever paid to token holders.
contract FeeRouter is IFeeRouter, ReentrancyGuard {
    using SafeTransferLib for address;

    uint256 public constant MAX_PLAN_PRICE = 100e6; // 100 USDG per month hard cap
    uint8 public constant MAX_MONTHS = 12;
    uint64 public constant MONTH = 30 days;

    address public immutable usdg;
    address public owner;
    address public pendingOwner;
    address public factory;

    uint256 public planPricePerMonth;
    mapping(address => uint64) public planPaidUntil;

    address[4] public sinks;
    uint16[4] public bps;

    error NotOwner();
    error NotPot();
    error BadParam();
    error FactoryAlreadySet();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address usdg_, address owner_, uint256 planPrice_, address[4] memory sinks_) {
        if (usdg_ == address(0) || owner_ == address(0) || planPrice_ > MAX_PLAN_PRICE) revert BadParam();
        usdg = usdg_;
        owner = owner_;
        planPricePerMonth = planPrice_;
        _setSinks(sinks_, [uint16(8000), uint16(1000), uint16(500), uint16(500)]);
        emit PlanPriceSet(planPrice_);
    }

    /// @notice One-time wiring (router is deployed before the factory).
    function setFactory(address factory_) external onlyOwner {
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert BadParam();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @notice Called by a pot after a PAY_PLAN vote. Pulls price x months USDG from the pot.
    function payPlan(uint8 months) external nonReentrant returns (uint64 paidUntil) {
        if (factory == address(0) || !IPotRegistry(factory).isPot(msg.sender)) revert NotPot();
        if (months == 0 || months > MAX_MONTHS) revert BadParam();
        uint256 cost = planPricePerMonth * months;
        if (cost > 0) usdg.safeTransferFrom(msg.sender, address(this), cost);
        uint64 start = planPaidUntil[msg.sender];
        if (start < block.timestamp) start = uint64(block.timestamp);
        paidUntil = start + uint64(months) * MONTH;
        planPaidUntil[msg.sender] = paidUntil;
        emit PlanPaid(msg.sender, months, cost, paidUntil);
    }

    /// @notice Permissionless. Splits the router's whole balance of `token` to the four sinks.
    function distribute(address token) external nonReentrant {
        uint256 total = token.balanceOf(address(this));
        if (total == 0) return;
        uint256 sent;
        for (uint256 i; i < 3; ++i) {
            uint256 amt = (total * bps[i]) / 10_000;
            sent += amt;
            if (amt > 0) token.safeTransfer(sinks[i], amt);
        }
        token.safeTransfer(sinks[3], total - sent); // remainder (rounding dust) to the last sink
        emit Distributed(token, total);
    }

    function setSinks(address[4] calldata sinks_, uint16[4] calldata bps_) external onlyOwner {
        _setSinks(sinks_, bps_);
    }

    function setPlanPrice(uint256 price) external onlyOwner {
        if (price > MAX_PLAN_PRICE) revert BadParam();
        planPricePerMonth = price;
        emit PlanPriceSet(price);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function _setSinks(address[4] memory sinks_, uint16[4] memory bps_) internal {
        uint256 sum;
        for (uint256 i; i < 4; ++i) {
            if (sinks_[i] == address(0)) revert BadParam();
            sum += bps_[i];
        }
        if (sum != 10_000) revert BadParam();
        sinks = sinks_;
        bps = bps_;
        emit SinksSet(sinks_, bps_);
    }
}
