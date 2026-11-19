// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "../utils/Test.sol";
import {MockERC20} from "../../src/mocks/Mocks.sol";
import {MockUSDG3009} from "../arena/ArenaMocks.sol";
import {ArenaTypes} from "../../src/arena/ArenaTypes.sol";
import {ResultRegistry} from "../../src/arena/ResultRegistry.sol";
import {TableFactory} from "../../src/arena/TableFactory.sol";
import {TableEscrow} from "../../src/arena/TableEscrow.sol";
import {PrizeVault} from "../../src/arena/PrizeVault.sol";
import {StakePool} from "../../src/arena/StakePool.sol";
import {IStakePool} from "../../src/interfaces/arena/IStakePool.sol";

/// @notice Random sequences against the PrizeVault and the StakePool: stakers stake, unstake, pledge and mark bonds;
///         the scheduler funds Freerolls; strangers try to take money out; time moves (across Monday resets).
contract VaultStakeHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockUSDG3009 public usdg;
    MockERC20 public cofr;
    TableFactory public factory;
    PrizeVault public vault;
    StakePool public pool;
    address public constant SCHEDULER = address(0x5C4E);
    address public constant STRANGER = address(0x5757);
    uint256 public constant CAP = 2_000e6;
    address[3] public stakers = [address(0xA1), address(0xA2), address(0xA3)];
    uint256 public constant START = 1_000_000e18;

    uint256[] public ids;
    mapping(address => uint256) public pledged; // ghost: COFR each staker gave to the vault
    uint256 public vaultStart;
    uint256 public outToTables; // ghost: USDG that left the vault into factory tables
    mapping(uint256 => uint256) public spentInWeek; // ghost per vault week
    bool public unstakeFailed; // A16: an unlocked, non-bond position could not be unstaked
    bool public strangerTook; // A15: money left the vault other than through fundFreeroll
    bool public overCap; // A15
    bool public fundedNonTable; // A15
    uint256 internal salt;

    constructor() {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG3009();
        cofr = new MockERC20("Cofer", "COFR", 18);
        address[] memory s = new address[](3);
        s[0] = address(0x5161);
        s[1] = address(0x5162);
        s[2] = address(0x5163);
        ResultRegistry registry = new ResultRegistry(address(this), address(0x6A), s, 2);
        TableEscrow impl = new TableEscrow();
        factory = new TableFactory(
            address(usdg), address(cofr), address(registry), address(impl), address(this), address(0x6A), address(0xE11),
            50e6, 500e6, 25_000e6, 100_000e18
        );
        registry.setFactory(address(factory));
        pool = new StakePool(address(cofr), address(factory));
        factory.setStakePool(address(pool));
        address[] memory toks = new address[](1);
        toks[0] = address(usdg);
        uint256[] memory caps = new uint256[](1);
        caps[0] = CAP;
        vault = new PrizeVault(address(factory), address(this), SCHEDULER, toks, caps);
        factory.setPrizeVault(address(vault));
        usdg.mint(address(vault), 50_000e6);
        vaultStart = 50_000e6;
        for (uint256 i; i < 3; ++i) {
            cofr.mint(stakers[i], START);
            vm.prank(stakers[i]);
            cofr.approve(address(pool), type(uint256).max);
        }
    }

    /// At most MAX_POSITIONS positions, so the invariant's full walk over them stays cheap (128,000 calls per run).
    uint256 public constant MAX_POSITIONS = 40;

    function stake(uint256 who, uint256 amount, uint8 term) external {
        if (ids.length >= MAX_POSITIONS) return;
        address a = stakers[who % 3];
        amount = 1 + (amount % (cofr.balanceOf(a) / 4 + 1));
        if (cofr.balanceOf(a) < amount) return;
        vm.prank(a);
        ids.push(pool.stake(amount, IStakePool.Term(term % 3)));
    }

    function unstake(uint256 pick) external {
        if (ids.length == 0) return;
        uint256 id = ids[pick % ids.length];
        (address owner, uint96 unlockAt, uint256 amount,, bool isBond) = pool.positions(id);
        if (owner == address(0)) return;
        bool free = block.timestamp >= unlockAt && (!isBond || block.timestamp >= pool.bondUntil(owner));
        uint256 before = cofr.balanceOf(owner);
        vm.prank(owner);
        try pool.unstake(id) {
            if (cofr.balanceOf(owner) != before + amount) unstakeFailed = true; // returned exactly what is left
        } catch {
            if (free) unstakeFailed = true;
        }
    }

    function pledge(uint256 pick, uint256 amount) external {
        if (ids.length == 0) return;
        uint256 id = ids[pick % ids.length];
        (address owner,, uint256 left,,) = pool.positions(id);
        if (owner == address(0) || left == 0) return;
        amount = 1 + (amount % left);
        vm.prank(owner);
        pool.pledge(id, amount);
        pledged[owner] += amount;
    }

    function markBond(uint256 pick) external {
        if (ids.length == 0) return;
        uint256 id = ids[pick % ids.length];
        (address owner,,,, bool isBond) = pool.positions(id);
        if (owner == address(0) || isBond) return;
        vm.prank(owner);
        pool.markBond(id);
    }

    function fund(uint96 prize) external {
        prize = uint96(1e6 + (prize % 600e6));
        uint256 week = vault.currentWeek();
        ArenaTypes.TableParams memory p;
        p.mode = ArenaTypes.Mode.FREEROLL;
        p.token = address(usdg);
        p.prize = prize;
        p.minSeats = 2;
        p.maxSeats = 100;
        p.lockAt = uint64(block.timestamp + 1 days);
        p.duration = 2 hours;
        p.disputeWindow = 24 hours;
        p.settleGrace = 72 hours;
        p.rulesHash = keccak256("rules");
        uint256 before = usdg.balanceOf(address(vault));
        vm.prank(SCHEDULER);
        try vault.fundFreeroll(p, bytes32(++salt)) returns (address t) {
            if (!factory.isTable(t) || usdg.balanceOf(t) != prize) fundedNonTable = true;
            if (before - usdg.balanceOf(address(vault)) != prize) fundedNonTable = true;
            outToTables += prize;
            spentInWeek[week] += prize;
            if (spentInWeek[week] > CAP) overCap = true;
        } catch {}
    }

    function strangerAttempts(uint96 prize) external {
        uint256 before = usdg.balanceOf(address(vault));
        ArenaTypes.TableParams memory p;
        p.mode = ArenaTypes.Mode.FREEROLL;
        p.token = address(usdg);
        p.prize = uint96(1e6 + (prize % 100e6));
        vm.startPrank(STRANGER);
        try vault.fundFreeroll(p, bytes32(++salt)) {} catch {}
        try vault.queueWeeklyCap(address(usdg), type(uint256).max) {} catch {}
        try vault.setScheduler(STRANGER) {} catch {}
        vm.stopPrank();
        if (usdg.balanceOf(address(vault)) != before) strangerTook = true;
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + 1 + (secs % 10 days));
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }
}

contract VaultStakeInvariants is Test {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    VaultStakeHandler internal h;

    function setUp() public {
        h = new VaultStakeHandler();
    }

    function targetContracts() public view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(h);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory s) {
        bytes4[] memory sel = new bytes4[](9);
        sel[0] = VaultStakeHandler.stake.selector;
        sel[1] = VaultStakeHandler.stake.selector;
        sel[2] = VaultStakeHandler.unstake.selector;
        sel[3] = VaultStakeHandler.pledge.selector;
        sel[4] = VaultStakeHandler.markBond.selector;
        sel[5] = VaultStakeHandler.fund.selector;
        sel[6] = VaultStakeHandler.fund.selector;
        sel[7] = VaultStakeHandler.strangerAttempts.selector;
        sel[8] = VaultStakeHandler.warp.selector;
        s = new FuzzSelector[](1);
        s[0] = FuzzSelector(address(h), sel);
    }

    /// A15: the vault pays out only through fundFreeroll, only into factory tables, within the weekly cap.
    function invariant_vaultOnlyFundsEscrows() public view {
        assertFalse(h.strangerTook(), "A15 stranger");
        assertFalse(h.fundedNonTable(), "A15 non-table");
        assertFalse(h.overCap(), "A15 weekly cap");
        assertEq(h.usdg().balanceOf(address(h.vault())), h.vaultStart() - h.outToTables(), "A15 vault balance");
    }

    /// A16: the pool holds exactly the open positions; each staker has exactly what they started with minus what
    ///      they pledged (nothing more: no reward path); unstake after unlock never fails.
    function invariant_stakeConserved() public view {
        StakePool pool = h.pool();
        uint256 open;
        for (uint256 i; i < h.idCount(); ++i) {
            (,, uint256 amount,,) = pool.positions(h.ids(i));
            open += amount;
        }
        assertEq(h.cofr().balanceOf(address(pool)), open, "A16 pool holds the open positions");
        uint256 pledgedAll;
        for (uint256 i; i < 3; ++i) {
            address a = h.stakers(i);
            uint256 mine;
            for (uint256 j; j < h.idCount(); ++j) {
                (address owner,, uint256 amount,,) = pool.positions(h.ids(j));
                if (owner == a) mine += amount;
            }
            assertEq(h.cofr().balanceOf(a) + mine, h.START() - h.pledged(a), "A16 staker exact");
            pledgedAll += h.pledged(a);
        }
        assertEq(h.cofr().balanceOf(address(h.vault())), pledgedAll, "A16 pledges went to the vault");
        assertFalse(h.unstakeFailed(), "A16 unstake after unlock");
    }
}
