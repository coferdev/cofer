// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CoferBase} from "./utils/CoferBase.sol";
import {ICoferFactory} from "../src/interfaces/ICoferFactory.sol";
import {ICoferPot} from "../src/interfaces/ICoferPot.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {MockStockToken, MockAggregator} from "../src/mocks/Mocks.sol";

/// @notice Every owner/guardian function refuses an unauthorized caller, and the bounded ones refuse bad
///         input. Every CoferPot entry point refuses an unauthorized caller or invalid input.
contract NegativeTest is CoferBase {
    address internal constant ATTACKER = address(0xBAD);
    uint8 constant TRANSFER = 0;
    uint8 constant PAY_PLAN = 7;

    // ================================================================ CoferFactory: who may call

    function test_factory_everyOwnerFunctionRefusesOthers() public {
        address[2] memory notOwner = [ATTACKER, guardian]; // the guardian is not the owner either
        for (uint256 k; k < 2; ++k) {
            vm.startPrank(notOwner[k]);
            vm.expectRevert(ICoferFactory.NotOwner.selector);
            factory.listAsset(address(0x1234), address(usdgFeed), 1 days, false);
            vm.expectRevert(ICoferFactory.NotOwner.selector);
            factory.setBuyable(address(tsla), false);
            vm.expectRevert(ICoferFactory.NotOwner.selector);
            factory.queueFeed(address(tsla), address(tslaFeed), 1 days);
            vm.expectRevert(ICoferFactory.NotOwner.selector);
            factory.applyFeed(address(tsla));
            vm.expectRevert(ICoferFactory.NotOwner.selector);
            factory.queueAdapter(address(adapter));
            vm.expectRevert(ICoferFactory.NotOwner.selector);
            factory.applyAdapter(address(adapter));
            vm.expectRevert(ICoferFactory.NotOwner.selector);
            factory.removeAdapter(address(adapter));
            vm.expectRevert(ICoferFactory.NotOwner.selector);
            factory.queueSwapFee(10);
            vm.expectRevert(ICoferFactory.NotOwner.selector);
            factory.applySwapFee();
            vm.expectRevert(ICoferFactory.NotOwner.selector);
            factory.setGuardian(ATTACKER);
            vm.expectRevert(ICoferFactory.NotOwner.selector);
            factory.transferOwnership(ATTACKER);
            vm.stopPrank();
        }
    }

    function test_factory_pausesRefuseAnyoneButOwnerOrGuardian() public {
        vm.startPrank(ATTACKER);
        vm.expectRevert(ICoferFactory.NotGuardian.selector);
        factory.setDepositsPaused(true);
        vm.expectRevert(ICoferFactory.NotGuardian.selector);
        factory.setCreationPaused(true);
        vm.stopPrank();
        // control: the guardian may pause and unpause both
        vm.startPrank(guardian);
        factory.setDepositsPaused(true);
        factory.setCreationPaused(true);
        factory.setDepositsPaused(false);
        factory.setCreationPaused(false);
        vm.stopPrank();
    }

    function test_factory_acceptOwnershipOnlyByPendingOwner() public {
        vm.prank(ATTACKER);
        vm.expectRevert(ICoferFactory.NotOwner.selector);
        factory.acceptOwnership(); // nothing pending
        vm.prank(owner);
        factory.transferOwnership(address(0xB0B));
        vm.prank(ATTACKER);
        vm.expectRevert(ICoferFactory.NotOwner.selector);
        factory.acceptOwnership();
    }

    // ================================================================ CoferFactory: bad input from the owner

    function test_factory_listAssetRefusesBadInput() public {
        MockStockToken t = new MockStockToken("New", "NEW");
        MockAggregator f = new MockAggregator(8, 1e8);
        vm.startPrank(owner);
        vm.expectRevert(ICoferFactory.BadParam.selector);
        factory.listAsset(address(0), address(f), 1 days, true);
        vm.expectRevert(ICoferFactory.BadParam.selector);
        factory.listAsset(address(t), address(0), 1 days, true);
        vm.expectRevert(ICoferFactory.BadParam.selector);
        factory.listAsset(address(t), address(f), 0, true);
        vm.expectRevert(ICoferFactory.BadParam.selector);
        factory.listAsset(address(t), address(f), 4 days + 1, true);
        vm.expectRevert(ICoferFactory.AlreadyListed.selector);
        factory.listAsset(address(tsla), address(f), 1 days, true);
        vm.stopPrank();
    }

    function test_factory_feedChangesRefuseBadInputAndEarlyApply() public {
        vm.startPrank(owner);
        vm.expectRevert(ICoferFactory.NotListed.selector);
        factory.setBuyable(address(0x1234), true);
        vm.expectRevert(ICoferFactory.NotListed.selector);
        factory.queueFeed(address(0x1234), address(tslaFeed), 1 days);
        vm.expectRevert(ICoferFactory.BadParam.selector);
        factory.queueFeed(address(tsla), address(0), 1 days);
        vm.expectRevert(ICoferFactory.BadParam.selector);
        factory.queueFeed(address(tsla), address(tslaFeed), 0);
        vm.expectRevert(ICoferFactory.BadParam.selector);
        factory.queueFeed(address(tsla), address(tslaFeed), 4 days + 1);
        vm.expectRevert(ICoferFactory.NothingQueued.selector);
        factory.applyFeed(address(tsla));
        factory.queueFeed(address(tsla), address(tslaFeed), 2 days);
        vm.expectRevert(ICoferFactory.Timelocked.selector);
        factory.applyFeed(address(tsla));
        vm.stopPrank();
    }

    function test_factory_adapterAndFeeChangesRefuseBadInputAndEarlyApply() public {
        vm.startPrank(owner);
        vm.expectRevert(ICoferFactory.BadParam.selector);
        factory.queueAdapter(address(0));
        vm.expectRevert(ICoferFactory.BadParam.selector);
        factory.queueAdapter(address(0x1234)); // no code
        vm.expectRevert(ICoferFactory.NothingQueued.selector);
        factory.applyAdapter(address(0x1234));
        factory.queueAdapter(address(router));
        vm.expectRevert(ICoferFactory.Timelocked.selector);
        factory.applyAdapter(address(router));

        vm.expectRevert(ICoferFactory.BadParam.selector);
        factory.queueSwapFee(51); // cap is 0.50%
        vm.expectRevert(ICoferFactory.NothingQueued.selector);
        factory.applySwapFee();
        factory.queueSwapFee(40);
        vm.expectRevert(ICoferFactory.Timelocked.selector);
        factory.applySwapFee();
        vm.stopPrank();
    }

    // ================================================================ FeeRouter

    function test_feeRouter_everyOwnerFunctionRefusesOthers() public {
        address[4] memory s = [address(1), address(2), address(3), address(4)];
        uint16[4] memory b = [uint16(2500), 2500, 2500, 2500];
        vm.startPrank(ATTACKER);
        vm.expectRevert(FeeRouter.NotOwner.selector);
        feeRouter.setFactory(address(factory));
        vm.expectRevert(FeeRouter.NotOwner.selector);
        feeRouter.setSinks(s, b);
        vm.expectRevert(FeeRouter.NotOwner.selector);
        feeRouter.setPlanPrice(1e6);
        vm.expectRevert(FeeRouter.NotOwner.selector);
        feeRouter.transferOwnership(ATTACKER);
        vm.expectRevert(FeeRouter.NotOwner.selector);
        feeRouter.acceptOwnership(); // nothing pending
        vm.stopPrank();
    }

    function test_feeRouter_refusesBadInputFromOwnerAndPots() public {
        address[4] memory s = [address(1), address(2), address(3), address(4)];
        vm.startPrank(owner);
        vm.expectRevert(FeeRouter.BadParam.selector);
        feeRouter.setSinks([address(0), address(2), address(3), address(4)], [uint16(2500), 2500, 2500, 2500]);
        vm.expectRevert(FeeRouter.BadParam.selector);
        feeRouter.setSinks(s, [uint16(2500), 2500, 2500, 2499]);
        vm.expectRevert(FeeRouter.BadParam.selector);
        feeRouter.setPlanPrice(100e6 + 1);
        vm.expectRevert(FeeRouter.FactoryAlreadySet.selector);
        feeRouter.setFactory(address(factory));
        vm.stopPrank();

        vm.startPrank(address(pot)); // a real pot, but months out of range
        vm.expectRevert(FeeRouter.BadParam.selector);
        feeRouter.payPlan(0);
        vm.expectRevert(FeeRouter.BadParam.selector);
        feeRouter.payPlan(13);
        vm.stopPrank();
    }

    // ================================================================ CoferPot: who may call

    function test_pot_memberOnlyFunctionsRefuseOthers() public {
        vm.startPrank(ATTACKER);
        vm.expectRevert(ICoferPot.NotMember.selector);
        pot.deposit(1e6);
        vm.expectRevert(ICoferPot.NotMember.selector);
        pot.depositWithPermit(1e6, block.timestamp, 0, bytes32(0), bytes32(0));
        vm.expectRevert(ICoferPot.NotMember.selector);
        pot.spend(ATTACKER, 1e6, bytes32(0));
        vm.expectRevert(ICoferPot.NotMember.selector);
        pot.revokeVote(bytes32(uint256(1)));
        vm.expectRevert(ICoferPot.NotMember.selector);
        pot.leave();
        vm.stopPrank();
    }

    function test_pot_outsiderWithNoSharesCannotExit() public {
        _deposit(0, 100e6);
        vm.prank(ATTACKER);
        vm.expectRevert(ICoferPot.InsufficientShares.selector);
        pot.exit(1, ATTACKER);
    }

    // ================================================================ CoferPot: bad input

    function test_pot_memberActionsRefuseBadInput() public {
        _deposit(0, 100e6);
        vm.startPrank(m[0]);
        vm.expectRevert(ICoferPot.ZeroAmount.selector);
        pot.deposit(0);
        vm.expectRevert(ICoferPot.ZeroAmount.selector);
        pot.exit(0, m[0]);
        vm.expectRevert(ICoferPot.BadParam.selector);
        pot.exit(1, address(0));
        vm.expectRevert(ICoferPot.ZeroAmount.selector);
        pot.spend(m[1], 0, bytes32(0));
        vm.expectRevert(ICoferPot.BadParam.selector);
        pot.spend(address(0), 1e6, bytes32(0));
        vm.expectRevert(ICoferPot.NoAllowance.selector);
        pot.spend(m[1], 1e6, bytes32(0));
        vm.stopPrank();
        vm.expectRevert(ICoferPot.NothingOwed.selector);
        pot.claimOwed(address(usdg), m[0]);
    }

    function test_pot_executeRefusesBadProposals() public {
        _deposit(0, 100e6);
        bytes memory data = abi.encode(address(usdg), m[1], uint256(1e6));
        uint64 ep = pot.epoch();

        vm.expectRevert(ICoferPot.UnknownKind.selector);
        pot.execute(8, data, 1, ep, FAR_DEADLINE, new ICoferPot.Vote[](0));

        vm.expectRevert(ICoferPot.StaleEpoch.selector);
        pot.execute(TRANSFER, data, 1, ep + 1, FAR_DEADLINE, new ICoferPot.Vote[](0));

        uint64 past = uint64(block.timestamp - 1);
        vm.expectRevert(ICoferPot.Expired.selector);
        pot.execute(TRANSFER, data, 1, ep, past, new ICoferPot.Vote[](0));

        // too few votes: 2 of the 3 needed
        bytes32 d = pot.hashProposal(TRANSFER, data, 1, ep, FAR_DEADLINE);
        vm.expectRevert(abi.encodeWithSelector(ICoferPot.NotEnoughVotes.selector, 2, 3));
        pot.execute(TRANSFER, data, 1, ep, FAR_DEADLINE, _votes(d, _idx2(0, 1)));

        // a nonce cannot be used twice (unanimous, so it runs at once)
        assertTrue(_exec(TRANSFER, data, 5, _all()));
        vm.expectRevert(ICoferPot.NonceUsed.selector);
        pot.execute(TRANSFER, data, 5, ep, FAR_DEADLINE, new ICoferPot.Vote[](0));
    }

    function test_pot_votesRefuseOutOfRangeSettings() public {
        // each vote is unanimous; the bounded settings still refuse out-of-range values
        _expectExecRevert(6, abi.encode(uint32(3 days + 1), uint16(300), uint16(50), true), 11, ICoferPot.BadParam.selector); // guardDelay cap
        _expectExecRevert(6, abi.encode(uint32(6 hours), uint16(1001), uint16(50), true), 12, ICoferPot.BadParam.selector); // slippage cap
        _expectExecRevert(6, abi.encode(uint32(6 hours), uint16(300), uint16(201), true), 13, ICoferPot.BadParam.selector); // entry spread cap
        _expectExecRevert(5, abi.encode(uint8(6), uint16(0)), 14, ICoferPot.BadParam.selector); // fixed threshold above member count
        _expectExecRevert(5, abi.encode(uint8(0), uint16(10_001)), 15, ICoferPot.BadParam.selector); // share over 100%
        _expectExecRevert(4, abi.encode(m[1], uint128(1e6), uint32(59 minutes)), 16, ICoferPot.BadParam.selector); // period too short
        _expectExecRevert(2, abi.encode(m[1]), 17, ICoferPot.AlreadyMember.selector);
        _expectExecRevert(3, abi.encode(ATTACKER), 18, ICoferPot.NotMember.selector);
    }

    function test_pot_payPlanRefusesWhenItCannotPay() public {
        // empty pot: the plan cost is more than it holds
        _expectExecRevert(PAY_PLAN, abi.encode(uint8(1)), 21, ICoferPot.InsufficientBalance.selector);
    }

    /// @dev Signs first (view calls), so the expected revert applies to execute itself.
    function _expectExecRevert(uint8 kind, bytes memory data, uint256 nonce, bytes4 err) internal {
        uint64 ep = pot.epoch();
        ICoferPot.Vote[] memory v = _votes(pot.hashProposal(kind, data, nonce, ep, FAR_DEADLINE), _all());
        vm.expectRevert(err);
        pot.execute(kind, data, nonce, ep, FAR_DEADLINE, v);
    }
}
