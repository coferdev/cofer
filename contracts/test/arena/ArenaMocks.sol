// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Test-only USDG stand-in: 6 decimals, EIP-2612 permit and EIP-3009 receiveWithAuthorization with the
///         domain ("Global Dollar", "1"), plus a per-address freeze to test claims when the token refuses one
///         account. Not deployed anywhere.
contract MockUSDG3009 {
    string public constant name = "Global Dollar";
    string public constant symbol = "USDG";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    mapping(address => bool) public frozen;

    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

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

    function setFrozen(address a, bool f) external {
        frozen[a] = f;
    }

    function mint(address to, uint256 amt) external {
        totalSupply += amt;
        balanceOf[to] += amt;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
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
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(msg.sender == to, "caller must be the payee");
        require(block.timestamp > validAfter && block.timestamp < validBefore, "time");
        require(!authorizationState[from][nonce], "used");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
            )
        );
        address rec = ecrecover(digest, v, r, s);
        require(rec != address(0) && rec == from, "InvalidSignature");
        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 amt) internal {
        require(!frozen[from] && !frozen[to], "frozen");
        require(balanceOf[from] >= amt, "balance");
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
    }
}
