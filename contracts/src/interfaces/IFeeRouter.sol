// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IFeeRouter {
    event PlanPaid(address indexed pot, uint8 months, uint256 cost, uint64 paidUntil);
    event Distributed(address indexed token, uint256 total);
    event SinksSet(address[4] sinks, uint16[4] bps);
    event PlanPriceSet(uint256 pricePerMonth);
    event FactorySet(address factory);

    function payPlan(uint8 months) external returns (uint64 paidUntil);
    function planPricePerMonth() external view returns (uint256);
    function planPaidUntil(address pot) external view returns (uint64);
    function distribute(address token) external;
}
