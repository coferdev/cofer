// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface ICoferPot {
    /// @dev Values are part of the signed EIP-712 payload (`uint8 kind`). Never reorder.
    enum Kind {
        TRANSFER, // 0: (address asset, address to, uint256 amount)
        SWAP, // 1: (address adapter, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes route)
        ADD_MEMBER, // 2: (address member)
        REMOVE_MEMBER, // 3: (address member)  -> member is force-exited in kind first, never confiscated
        SET_ALLOWANCE, // 4: (address member, uint128 amount, uint32 period)
        SET_THRESHOLD, // 5: (uint8 threshold, uint16 thresholdBps)
        SET_CONFIG, // 6: (uint32 guardDelay, uint16 maxSlipBps, uint16 entrySpreadBps, bool depositsOpen)
        PAY_PLAN // 7: (uint8 months)
    }

    struct Config {
        uint32 guardDelay; // seconds a passed non-unanimous vote waits before execution (exit window)
        uint16 maxSlipBps; // max distance of a swap's signed minOut below the oracle quote
        uint16 entrySpreadBps; // kept in the pot on deposits while non-USDG assets are held
        bool depositsOpen; // group-level pause of NEW deposits (exits are never pausable)
    }

    struct Vote {
        address signer;
        bytes signature;
    }

    struct MemberView {
        bool active;
        uint256 shares;
        uint128 allowance;
        uint32 period;
        uint64 periodStart;
        uint128 spent;
    }

    event Initialized(address indexed factory, address usdg, address[] members, uint8 threshold, uint16 thresholdBps);
    event Deposited(address indexed member, uint256 amount, uint256 shares, uint256 navBefore);
    event Exited(address indexed member, address indexed to, uint256 shares, address[] assets, uint256[] amounts);
    event ExitOwed(address indexed asset, address indexed account, uint256 amount);
    event OwedClaimed(address indexed asset, address indexed account, uint256 amount);
    event AllowanceSpent(address indexed member, address indexed to, uint256 amount, bytes32 memo, uint256 remaining);
    event VoteRevoked(bytes32 indexed digest, address indexed member);
    event ProposalQueued(bytes32 indexed digest, uint8 kind, uint256 nonce, uint64 eta);
    event ProposalExecuted(bytes32 indexed digest, uint8 kind, uint256 nonce, uint256 approvals);
    event Transferred(address indexed asset, address indexed to, uint256 amount);
    event Swapped(
        address indexed adapter,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 fee,
        uint256 amountOut
    );
    event MemberAdded(address indexed member);
    event MemberRemoved(address indexed member);
    event AllowanceSet(address indexed member, uint128 amount, uint32 period);
    event ThresholdSet(uint8 threshold, uint16 thresholdBps);
    event ConfigSet(uint32 guardDelay, uint16 maxSlipBps, uint16 entrySpreadBps, bool depositsOpen);
    event PlanPaid(uint8 months, uint256 cost);
    event EpochBumped(uint64 epoch);
    event AssetAdded(address indexed asset);
    event AssetRemoved(address indexed asset);

    error AlreadyInitialized();
    error NotMember();
    error NotFactory();
    error ZeroAmount();
    error DepositsClosed();
    error InsufficientShares();
    error InsufficientBalance();
    error NoAllowance();
    error AllowanceExceeded();
    error NonceUsed();
    error StaleEpoch();
    error Expired();
    error NotEnoughVotes(uint256 approvals, uint256 required);
    error UnsortedOrDuplicateSigner();
    error SignerNotMember(address signer);
    error InvalidSignature(address signer);
    error TooEarly(uint64 eta);
    error UnknownKind();
    error BadParam();
    error AssetNotHeld(address asset);
    error AssetNotBuyable(address asset);
    error AdapterNotAllowed(address adapter);
    error TooManyAssets();
    error TooManyMembers();
    error AlreadyMember();
    error SlippageTooLoose(uint256 minOut, uint256 floor);
    error OutputTooLow(uint256 got, uint256 minOut);
    error NothingOwed();

    // ---- member actions (no vote) ----
    function deposit(uint256 amount) external returns (uint256 shares);
    function depositWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        returns (uint256 shares);
    function exit(uint256 shares, address to) external;
    function leave() external;
    function spend(address to, uint256 amount, bytes32 memo) external;
    function revokeVote(bytes32 digest) external;
    function claimOwed(address asset, address account) external;

    // ---- votes ----
    function execute(uint8 kind, bytes calldata data, uint256 nonce, uint64 epoch, uint64 deadline, Vote[] calldata votes)
        external
        returns (bool executed);
    function hashProposal(uint8 kind, bytes calldata data, uint256 nonce, uint64 epoch, uint64 deadline)
        external
        view
        returns (bytes32);
    function domainSeparator() external view returns (bytes32);

    // ---- views ----
    function epoch() external view returns (uint64);
    function totalShares() external view returns (uint256);
    function requiredVotes() external view returns (uint256);
    function memberCount() external view returns (uint256);
    function members() external view returns (address[] memory);
    function memberInfo(address account) external view returns (MemberView memory);
    function heldAssets() external view returns (address[] memory);
    function distributable(address asset) external view returns (uint256);
    function allowanceLeft(address member) external view returns (uint256);
    function previewExit(uint256 shares) external view returns (address[] memory assets, uint256[] memory amounts);
    function navUsdg() external view returns (uint256 nav, uint256 nonUsdgValue);
}
