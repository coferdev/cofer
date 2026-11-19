// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "../utils/Test.sol";
import {MockERC20} from "../../src/mocks/Mocks.sol";
import {MockUSDG3009} from "./ArenaMocks.sol";
import {ArenaTypes} from "../../src/arena/ArenaTypes.sol";
import {ResultRegistry} from "../../src/arena/ResultRegistry.sol";
import {TableFactory} from "../../src/arena/TableFactory.sol";
import {TableEscrow} from "../../src/arena/TableEscrow.sol";
import {PrizeVault} from "../../src/arena/PrizeVault.sol";
import {StakePool} from "../../src/arena/StakePool.sol";
import {ArenaParams} from "../../script/ArenaParams.sol";
import {ITableEscrow} from "../../src/interfaces/arena/ITableEscrow.sol";

/// @notice Shared setup for the Arena tests: the launch caps (50 / 500 / 25,000 USDG), a 2-of-3 signer set,
///         an eligibility key, a vault with the launch weekly caps, and helpers that sign as each role.
abstract contract ArenaBase is Test {
    MockUSDG3009 internal usdg;
    MockERC20 internal cofr;
    ResultRegistry internal registry;
    TableEscrow internal impl;
    TableFactory internal factory;
    StakePool internal pool;
    PrizeVault internal vault;

    address internal guardian = address(0x6A);
    address internal scheduler = address(0x5C);
    uint256 internal constant ELIG_KEY = 0xE11;
    uint256 internal constant INVITE_KEY = 0x1A7;
    uint256[3] internal signerKeys = [uint256(0x5161), 0x5162, 0x5163];
    uint256[6] internal playerKeys = [uint256(0xB1), 0xB2, 0xB3, 0xB4, 0xB5, 0xB6];
    address[6] internal players;
    address internal host;
    uint256 internal constant HOST_KEY = 0xA0;

    uint96 internal constant BUY_IN = 50e6;
    bytes32 internal constant RULES = keccak256("rules-json-v1");
    uint256 internal nextSalt;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG3009();
        cofr = new MockERC20("Cofer", "COFR", 18);
        address[] memory s = new address[](3);
        for (uint256 i; i < 3; ++i) s[i] = vm.addr(signerKeys[i]);
        registry = new ResultRegistry(address(this), guardian, s, 2);
        impl = new TableEscrow();
        factory = new TableFactory(
            address(usdg), address(cofr), address(registry), address(impl), address(this), guardian, vm.addr(ELIG_KEY),
            ArenaParams.MAX_BUY_IN, ArenaParams.MAX_TABLE_POT, ArenaParams.MAX_LIVE_VALUE, ArenaParams.MIN_HOST_BOND
        );
        registry.setFactory(address(factory));
        pool = new StakePool(address(cofr), address(factory));
        factory.setStakePool(address(pool));
        address[] memory toks = new address[](2);
        toks[0] = address(usdg);
        toks[1] = address(cofr);
        uint256[] memory caps = new uint256[](2);
        caps[0] = ArenaParams.VAULT_WEEKLY_CAP_USDG;
        caps[1] = 1_000_000e18;
        vault = new PrizeVault(address(factory), address(this), scheduler, toks, caps);
        factory.setPrizeVault(address(vault));

        host = vm.addr(HOST_KEY);
        for (uint256 i; i < 6; ++i) {
            players[i] = vm.addr(playerKeys[i]);
            usdg.mint(players[i], 1_000e6);
        }
        usdg.mint(host, 1_000e6);
    }

    // ------------------------------------------------------------------ params

    function _friend(uint16 minSeats, uint16 maxSeats, uint64 lockAt) internal view returns (ArenaTypes.TableParams memory p) {
        p.mode = ArenaTypes.Mode.FRIEND;
        p.token = address(usdg);
        p.buyIn = BUY_IN;
        p.minSeats = minSeats;
        p.maxSeats = maxSeats;
        p.lockAt = lockAt;
        p.openUntil = lockAt == 0 ? uint64(block.timestamp + 1 days) : 0;
        p.duration = 24 hours;
        p.disputeWindow = 2 hours;
        p.settleGrace = 24 hours;
        p.disputeBondBps = 2_000;
        p.payoutBps = new uint16[](2);
        p.payoutBps[0] = 7_000;
        p.payoutBps[1] = 3_000;
        p.rulesHash = RULES;
        p.cryptoOnly = true;
    }

    function _freeroll(uint96 prize, uint16 maxSeats) internal view returns (ArenaTypes.TableParams memory p) {
        p.mode = ArenaTypes.Mode.FREEROLL;
        p.token = address(usdg);
        p.prize = prize;
        p.minSeats = 2;
        p.maxSeats = maxSeats;
        p.lockAt = uint64(block.timestamp + 1 days);
        p.duration = 2 hours;
        p.disputeWindow = 24 hours;
        p.settleGrace = 72 hours;
        p.rulesHash = RULES;
    }

    function _create(ArenaTypes.TableParams memory p) internal returns (TableEscrow t) {
        vm.prank(host);
        t = TableEscrow(factory.createTable(p, bytes32(++nextSalt)));
    }

    // ------------------------------------------------------------------ signatures

    function _sign(uint256 key, bytes32 h) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, h);
        return abi.encodePacked(r, s, v);
    }

    function _elig(TableEscrow t, address player, bool prizeEligible) internal view returns (bytes memory) {
        uint64 exp = uint64(block.timestamp + 5 minutes);
        ArenaTypes.Mode mode = t.params().mode;
        bytes32 h = t.hashTyped(keccak256(abi.encode(t.ELIGIBILITY_TYPEHASH(), address(t), player, uint8(mode), prizeEligible, exp)));
        return abi.encode(prizeEligible, exp, _sign(ELIG_KEY, h));
    }

    function _invite(TableEscrow t, address player) internal view returns (bytes memory) {
        uint64 exp = uint64(block.timestamp + 1 days);
        bytes32 h = t.hashTyped(keccak256(abi.encode(t.INVITE_TYPEHASH(), address(t), player, exp)));
        return abi.encode(exp, _sign(INVITE_KEY, h));
    }

    function _skh(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("session-key", i));
    }

    function _join(TableEscrow t, uint256 i) internal {
        vm.prank(players[i]);
        usdg.approve(address(t), type(uint256).max);
        bytes memory e = _elig(t, players[i], true);
        vm.prank(players[i]);
        t.join(_skh(i), "", e);
    }

    /// @dev k-of-n signatures sorted by signer address (strictly ascending).
    function _sigs(bytes32 digest, uint256[] memory which) internal view returns (bytes[] memory out) {
        uint256 n = which.length;
        uint256[] memory keys = new uint256[](n);
        for (uint256 i; i < n; ++i) keys[i] = signerKeys[which[i]];
        for (uint256 i; i < n; ++i) {
            for (uint256 j = i + 1; j < n; ++j) {
                if (vm.addr(keys[j]) < vm.addr(keys[i])) (keys[i], keys[j]) = (keys[j], keys[i]);
            }
        }
        out = new bytes[](n);
        for (uint256 i; i < n; ++i) out[i] = _sign(keys[i], digest);
    }

    function _two() internal pure returns (uint256[] memory w) {
        w = new uint256[](2);
        w[0] = 0;
        w[1] = 1;
    }

    function _result(uint8 round, address first, address second) internal pure returns (ITableEscrow.Result memory r) {
        r.round = round;
        r.logHead = keccak256(abi.encode("log", round));
        r.eventsRoot = keccak256("events");
        r.standingsRoot = keccak256("standings");
        r.podium = new address[](2);
        r.podium[0] = first;
        r.podium[1] = second;
        r.engineBuild = keccak256("engine");
        r.logURI = "ipfs://log";
    }

    function _post(TableEscrow t, ITableEscrow.Result memory r) internal {
        bytes32 d = registry.resultDigest(address(t), r);
        t.postResult(r, _sigs(d, _two()));
    }

    /// @dev A 3-seat scheduled Friend Table, locked.
    function _lockedFriend() internal returns (TableEscrow t) {
        t = _create(_friend(2, 5, uint64(block.timestamp + 1 hours)));
        _join(t, 0);
        _join(t, 1);
        _join(t, 2);
        vm.warp(t.params().lockAt);
        t.lock();
    }
}
