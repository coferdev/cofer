// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "../utils/Test.sol";
import {MockERC20} from "../../src/mocks/Mocks.sol";
import {MockUSDG3009} from "./ArenaMocks.sol";
import {DeployArena} from "../../script/DeployArena.s.sol";
import {ArenaParams} from "../../script/ArenaParams.sol";
import {ArenaTypes} from "../../src/arena/ArenaTypes.sol";

/// @notice The deploy script wires everything with the ArenaParams values and leaves the Safe one accept away from
///         owning the registry, the factory and the vault.
contract DeployArenaTest is Test {
    DeployArena internal dep;
    DeployArena.Config internal c;
    address internal constant SAFE = address(0x5AFE);

    function setUp() public {
        vm.warp(1_800_000_000);
        dep = new DeployArena();
        c.owner = address(dep); // in a test the script contract itself is the deployer
        c.safe = SAFE;
        c.guardian = address(0x6A);
        c.signers = new address[](3);
        c.signers[0] = address(0x5161);
        c.signers[1] = address(0x5162);
        c.signers[2] = address(0x5163);
        c.eligSigner = address(0xE11);
        c.scheduler = address(0x5C);
        c.usdg = address(new MockUSDG3009());
        c.cofr = address(new MockERC20("Cofer", "COFR", 18));
    }

    function test_deployUsesTheLaunchValuesAndWiresEverything() public {
        DeployArena.Deployed memory d = dep.deploy(c);
        assertEq(d.factory.maxBuyIn(), ArenaParams.MAX_BUY_IN);
        assertEq(d.factory.maxTablePot(), ArenaParams.MAX_TABLE_POT);
        assertEq(d.factory.maxLiveValue(), ArenaParams.MAX_LIVE_VALUE);
        assertEq(d.factory.minHostBond(), ArenaParams.MIN_HOST_BOND);
        assertEq(d.factory.usdg(), c.usdg);
        assertEq(d.factory.cofr(), c.cofr);
        assertEq(d.factory.registry(), address(d.registry));
        assertEq(d.factory.implementation(), address(d.impl));
        assertEq(d.factory.stakePool(), address(d.pool));
        assertEq(d.factory.prizeVault(), address(d.vault));
        assertEq(d.factory.eligibilitySigner(), c.eligSigner);
        assertEq(d.factory.guardian(), c.guardian);
        assertEq(d.registry.factory(), address(d.factory));
        assertEq(d.registry.guardian(), c.guardian);
        assertEq(d.vault.factory(), address(d.factory));
        assertEq(d.vault.scheduler(), c.scheduler);
        assertEq(d.vault.weeklyCap(c.usdg), ArenaParams.VAULT_WEEKLY_CAP_USDG);
        assertEq(d.factory.FRIEND_DISPUTE_BOND_BPS(), 2_000);
    }

    function test_theSafeAcceptsOwnershipOfAllThree() public {
        DeployArena.Deployed memory d = dep.deploy(c);
        assertEq(d.registry.pendingOwner(), SAFE);
        assertEq(d.factory.pendingOwner(), SAFE);
        assertEq(d.vault.pendingOwner(), SAFE);
        vm.startPrank(SAFE);
        d.registry.acceptOwnership();
        d.factory.acceptOwnership();
        d.vault.acceptOwnership();
        vm.stopPrank();
        assertEq(d.registry.owner(), SAFE);
        assertEq(d.factory.owner(), SAFE);
        assertEq(d.vault.owner(), SAFE);
    }

    function test_refusesMissingOrRepeatedRoles() public {
        c.safe = address(dep);
        vm.expectRevert(bytes("DeployArena: the Safe must be set and not the deployer"));
        dep.deploy(c);
        c.safe = SAFE;
        c.signers[2] = c.signers[0];
        vm.expectRevert(bytes("DeployArena: signers must differ"));
        dep.deploy(c);
    }

    function test_runRefusesOtherChains() public {
        vm.chainId(1);
        vm.expectRevert(bytes("DeployArena: 4663 or 46630 only"));
        dep.run();
    }

    function test_aTableCanBeCreatedRightAfterDeploy() public {
        DeployArena.Deployed memory d = dep.deploy(c);
        ArenaTypes.TableParams memory p;
        p.mode = ArenaTypes.Mode.FRIEND;
        p.token = c.usdg;
        p.buyIn = 10e6;
        p.minSeats = 3;
        p.maxSeats = 5;
        p.lockAt = uint64(block.timestamp + 1 hours);
        p.duration = 24 hours;
        p.disputeWindow = 2 hours;
        p.settleGrace = 24 hours;
        p.disputeBondBps = 2_000;
        p.payoutBps = new uint16[](1);
        p.payoutBps[0] = 10_000;
        p.rulesHash = keccak256("rules");
        p.cryptoOnly = true;
        vm.prank(address(0xB0B));
        assertTrue(d.factory.createTable(p, bytes32(uint256(1))) != address(0));
    }
}
