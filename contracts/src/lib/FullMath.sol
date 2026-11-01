// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice 512-bit mulDiv (rounds down), adapted from OpenZeppelin Contracts v4.9.6 (tag commit
///         dc44c9f1a4c3b10af99492eed84f83ed244203f6), contracts/utils/math/Math.sol,
///         mulDiv(uint256,uint256,uint256), the same in every v4.9.x release (MIT; original credit
///         to Remco Bloemen). Changes that do not alter any result: prod0 is x * y in the unchecked
///         block instead of mul(x, y) in assembly; twos uses 0 - denominator instead of
///         ~denominator + 1; a MulDivOverflow() error replaces the require string; the result is
///         returned implicitly. Checked against plain maths by testFuzz_mulDivMatchesPlainMath.
library FullMath {
    error MulDivOverflow();

    function mulDiv(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0 = x * y;
            uint256 prod1;
            assembly {
                let mm := mulmod(x, y, not(0))
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) {
                return prod0 / denominator; // reverts on denominator == 0
            }
            if (denominator <= prod1) revert MulDivOverflow();
            uint256 remainder;
            assembly {
                remainder := mulmod(x, y, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = denominator & (0 - denominator);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inverse = (3 * denominator) ^ 2;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            result = prod0 * inverse;
        }
    }
}
