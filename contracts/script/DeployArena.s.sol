// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "../test/utils/Test.sol";
import {ResultRegistry} from "../src/arena/ResultRegistry.sol";
import {TableFactory} from "../src/arena/TableFactory.sol";
import {TableEscrow} from "../src/arena/TableEscrow.sol";
import {PrizeVault} from "../src/arena/PrizeVault.sol";
import {StakePool} from "../src/arena/StakePool.sol";
import {ArenaParams} from "./ArenaParams.sol";

/// @notice The Arena deployment (registry, escrow implementation, factory, stake pool, prize vault), with every
///         launch value from ArenaParams. The deployer wires the contracts, then starts the two-step hand-over of
///         the registry, the factory and the vault to the Safe; the Safe finishes it with acceptOwnership() on each
///         (three Safe transactions). Until then the deployer can change nothing that matters: no table can be
///         created before the factory's wiring is done, and wiring happens in this same script.
///
///   DEPLOYER_KEY=0x... SAFE=0x... GUARDIAN=0x... SIGNER_1=0x... SIGNER_2=0x... SIGNER_3=0x... ELIG_SIGNER=0x... \
///   SCHEDULER=0x... [USDG=0x... COFR=0x... on testnet] \
///   forge script script/DeployArena.s.sol --rpc-url robinhood_testnet --broadcast
contract DeployArena {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant MAINNET = 4663;
    uint256 internal constant TESTNET = 46630;
    address internal constant MAINNET_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant MAINNET_COFR = 0x2Edd2762eC5A928F749380309ecA0E33941B3e3e;

    struct Config {
        address owner; // the deployer while wiring
        address safe;
        address guardian;
        address[] signers;
        address eligSigner;
        address scheduler;
        address usdg;
        address cofr;
    }

    struct Deployed {
        ResultRegistry registry;
        TableEscrow impl;
        TableFactory factory;
        StakePool pool;
        PrizeVault vault;
    }

    function run() external returns (Deployed memory d) {
        require(block.chainid == MAINNET || block.chainid == TESTNET, "DeployArena: 4663 or 46630 only");
        uint256 key = vm.envUint("DEPLOYER_KEY");
        Config memory c;
        c.owner = vm.addr(key);
        c.safe = vm.envAddress("SAFE");
        c.guardian = vm.envAddress("GUARDIAN");
        c.signers = new address[](3);
        c.signers[0] = vm.envAddress("SIGNER_1");
        c.signers[1] = vm.envAddress("SIGNER_2");
        c.signers[2] = vm.envAddress("SIGNER_3");
        c.eligSigner = vm.envAddress("ELIG_SIGNER");
        c.scheduler = vm.envAddress("SCHEDULER");
        if (block.chainid == MAINNET) {
            c.usdg = MAINNET_USDG;
            c.cofr = MAINNET_COFR;
        } else {
            c.usdg = vm.envAddress("USDG");
            c.cofr = vm.envAddress("COFR");
        }
        vm.startBroadcast(key);
        d = deploy(c);
        vm.stopBroadcast();
    }

    /// @dev Called by run() and by the deploy test (which checks every value below against ArenaParams).
    function deploy(Config memory c) public returns (Deployed memory d) {
        require(c.safe != address(0) && c.safe != c.owner, "DeployArena: the Safe must be set and not the deployer");
        require(c.guardian != address(0) && c.eligSigner != address(0) && c.scheduler != address(0), "DeployArena: a role is unset");
        require(c.signers.length == 3, "DeployArena: three result signers");
        for (uint256 i; i < 3; ++i) {
            require(c.signers[i] != address(0) && c.signers[i] != c.owner, "DeployArena: a signer is unset or the deployer");
            for (uint256 j = i + 1; j < 3; ++j) require(c.signers[i] != c.signers[j], "DeployArena: signers must differ");
        }

        d.registry = new ResultRegistry(c.owner, c.guardian, c.signers, ArenaParams.RESULT_K);
        d.impl = new TableEscrow();
        d.factory = new TableFactory(
            c.usdg, c.cofr, address(d.registry), address(d.impl), c.owner, c.guardian, c.eligSigner,
            ArenaParams.MAX_BUY_IN, ArenaParams.MAX_TABLE_POT, ArenaParams.MAX_LIVE_VALUE, ArenaParams.MIN_HOST_BOND
        );
        d.registry.setFactory(address(d.factory));
        d.pool = new StakePool(c.cofr, address(d.factory));
        d.factory.setStakePool(address(d.pool));
        address[] memory toks = new address[](1);
        toks[0] = c.usdg;
        uint256[] memory caps = new uint256[](1);
        caps[0] = ArenaParams.VAULT_WEEKLY_CAP_USDG;
        d.vault = new PrizeVault(address(d.factory), c.owner, c.scheduler, toks, caps);
        d.factory.setPrizeVault(address(d.vault));

        d.registry.transferOwnership(c.safe);
        d.factory.transferOwnership(c.safe);
        d.vault.transferOwnership(c.safe);
    }
}
