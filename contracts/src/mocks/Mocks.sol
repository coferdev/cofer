// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IV3SwapRouter} from "../interfaces/IExternal.sol";
import {IERC1271} from "../interfaces/IERC1271.sol";
import {SignatureChecker} from "../lib/SignatureChecker.sol";

/// @notice Test-only ERC-20. Not deployed to mainnet.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public paused;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function mint(address to, uint256 amt) public {
        totalSupply += amt;
        balanceOf[to] += amt;
        emit Transfer(address(0), to, amt);
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        emit Approval(msg.sender, spender, amt);
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        _transfer(msg.sender, to, amt);
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amt, "allowance");
            allowance[from][msg.sender] = a - amt;
        }
        _transfer(from, to, amt);
        return true;
    }

    function _transfer(address from, address to, uint256 amt) internal {
        require(!paused, "paused");
        require(balanceOf[from] >= amt, "balance");
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        emit Transfer(from, to, amt);
    }
}

/// @notice USDG stand-in: 6 decimals + EIP-2612 permit with domain ("Global Dollar", "1").
contract MockUSDG is MockERC20 {
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    mapping(address => uint256) public nonces;

    constructor() MockERC20("Global Dollar", "USDG", 6) {}

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Global Dollar"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        require(block.timestamp <= deadline, "expired");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))
            )
        );
        address rec = ecrecover(digest, v, r, s);
        require(rec != address(0) && rec == owner, "InvalidSignature");
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }
}

/// @notice ERC-8056-shaped Stock Token stand-in: 18 decimals, raw (non-rebasing) balances,
///         uiMultiplier for display only, pausable transfers (to test exit griefing).
contract MockStockToken is MockERC20 {
    uint256 public uiMultiplier = 1e18;

    constructor(string memory n, string memory s) MockERC20(n, s, 18) {}

    function setMultiplier(uint256 m) external {
        uiMultiplier = m;
    }

    function balanceOfUI(address a) external view returns (uint256) {
        return (balanceOf[a] * uiMultiplier) / 1e18;
    }
}

contract MockAggregator {
    uint8 public immutable decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;

    constructor(uint8 d, int256 a) {
        decimals = d;
        set(a);
    }

    function set(int256 a) public {
        answer = a;
        updatedAt = block.timestamp;
        roundId++;
    }

    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}

/// @notice SwapRouter02 stand-in. Pays out amountIn * rate / 1e18 of the last path token,
///         from its own (pre-minted) balance. `skim` lets tests simulate a bad pool.
contract MockSwapRouter is IV3SwapRouter {
    mapping(address => mapping(address => uint256)) public rate; // tokenIn => tokenOut => 1e18-scaled
    uint256 public skimBps;

    function setRate(address tokenIn, address tokenOut, uint256 r) external {
        rate[tokenIn][tokenOut] = r;
    }

    function setSkimBps(uint256 b) external {
        skimBps = b;
    }

    function exactInput(ExactInputParams calldata p) external payable returns (uint256 out) {
        address tokenIn = address(bytes20(p.path[0:20]));
        address tokenOut = address(bytes20(p.path[p.path.length - 20:p.path.length]));
        MockERC20(tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        out = (p.amountIn * rate[tokenIn][tokenOut]) / 1e18;
        out -= (out * skimBps) / 10_000;
        require(out >= p.amountOutMinimum, "Too little received");
        MockERC20(tokenOut).transfer(p.recipient, out);
    }
}

/// @notice Smart-account stand-in (Kernel/Safe-like): ERC-1271 by an owner key; can make calls.
contract MockSmartAccount is IERC1271 {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes memory sig) external view returns (bytes4) {
        // Real Kernel wraps `hash` in its own replay-safe domain; the mock checks the owner directly.
        return SignatureChecker.tryRecover(hash, sig) == owner ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    function call(address target, bytes calldata data) external returns (bytes memory ret) {
        require(msg.sender == owner, "owner");
        bool ok;
        (ok, ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
