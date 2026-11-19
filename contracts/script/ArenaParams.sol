// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Every Arena launch value in one place. DeployArena reads these; change them here before the mainnet
///         deploy. After the deploy, caps, the host bond and the weekly vault caps change only through the Safe
///         with the 48 h timelock. The dispute bond (20%) and the weekly reset (Monday 00:00 UTC) are fixed in code:
///         TableFactory.FRIEND_DISPUTE_BOND_BPS and PrizeVault.WEEK_OFFSET.
library ArenaParams {
    // Caps (USDG, 6 decimals)
    uint96 internal constant MAX_BUY_IN = 50e6;
    uint96 internal constant MAX_TABLE_POT = 500e6;
    uint128 internal constant MAX_LIVE_VALUE = 25_000e6;

    // Host bond for public Freerolls not funded by the vault ($COFR, 18 decimals)
    uint256 internal constant MIN_HOST_BOND = 100_000e18;

    // Result signers
    uint8 internal constant RESULT_K = 2;

    // Weekly vault cap per token: Open decision 7, not decided yet (recommendation 2,000 USDG/week).
    uint256 internal constant VAULT_WEEKLY_CAP_USDG = 2_000e6;
}
