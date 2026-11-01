// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICoferPot} from "./interfaces/ICoferPot.sol";
import {ICoferFactory} from "./interfaces/ICoferFactory.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {IERC20Permit} from "./interfaces/IExternal.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";
import {SignatureChecker} from "./lib/SignatureChecker.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";

/// @title CoferPot
/// @notice One shared group account (EIP-1167 clone per group). Holds USDG plus allowlisted tokens
///         (Robinhood Stock Tokens, other listed ERC-20s) and tracks each member's contribution as
///         non-transferable shares.
///
/// Invariants (tested):
///  - Exit is never gated: `exit`/`leave` have no pause check, no vote, no oracle. A member always
///    receives `distributable(asset) * shares / totalShares` of EVERY held asset (rounded down,
///    i.e. in favour of the pot). If one token transfer fails (paused Stock Token), that amount is
///    reserved and claimable later via `claimOwed`; the other assets still go out.
///  - Allowance spends need no vote and are capped per member per period, in USDG.
///  - Everything else needs EIP-712 signatures from `requiredVotes()` distinct current members.
///    Execution is permissionless. Non-unanimous votes (except swaps) wait `guardDelay` so members
///    who disagree can exit first.
///  - Non-upgradeable. The studio cannot move, freeze or pause funds; the factory can only pause
///    NEW deposits and pot creation.
contract CoferPot is ICoferPot, ReentrancyGuard {
    using SafeTransferLib for address;

    uint256 public constant MAX_MEMBERS = 50;
    uint256 public constant MAX_ASSETS = 12;
    uint256 public constant VIRTUAL_SHARES = 1e12; // first 1 USDG (1e6) mints 1e18 shares
    uint256 public constant VIRTUAL_ASSETS = 1;
    uint32 public constant MAX_GUARD_DELAY = 3 days;
    uint16 public constant MAX_SLIP_BPS = 1000;
    uint16 public constant MAX_ENTRY_SPREAD_BPS = 200;
    uint32 public constant MIN_ALLOWANCE_PERIOD = 1 hours;
    uint32 public constant MAX_ALLOWANCE_PERIOD = 90 days;
    uint256 private constant BPS = 10_000;

    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant PROPOSAL_TYPEHASH =
        keccak256("Proposal(uint8 kind,bytes data,uint256 nonce,uint64 epoch,uint64 deadline)");
    bytes32 private constant NAME_HASH = keccak256("Cofer");
    bytes32 private constant VERSION_HASH = keccak256("1");

    struct Member {
        bool active;
        uint32 period;
        uint64 periodStart;
        uint128 allowance;
        uint128 spent;
        uint256 shares;
    }

    ICoferFactory public factory;
    address public usdg;
    bool private _initialized;

    uint8 public threshold; // fixed count (used when thresholdBps == 0)
    uint16 public thresholdBps; // share of members required, rounded up (e.g. 6000 = 3 of 5)
    uint64 public epoch;
    uint256 public totalShares;
    Config public config;

    mapping(address => Member) internal _members;
    address[] internal _memberList;
    mapping(address => uint256) internal _memberIndex; // index + 1

    address[] internal _held; // _held[0] == usdg forever
    mapping(address => bool) public isHeld;

    mapping(address => uint256) public reserved; // per asset, owed to exiters whose transfer failed
    mapping(address => mapping(address => uint256)) public owed; // asset => account => amount

    mapping(uint256 => bool) public usedNonce;
    mapping(bytes32 => uint64) public queuedAt;
    mapping(bytes32 => mapping(address => bool)) public revoked;

    modifier onlyMember() {
        if (!_members[msg.sender].active) revert NotMember();
        _;
    }

    constructor() {
        _initialized = true; // lock the implementation; clones have fresh storage
    }

    function initialize(
        address usdg_,
        address[] calldata members_,
        uint8 threshold_,
        uint16 thresholdBps_,
        Config calldata config_
    ) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        if (usdg_ == address(0) || members_.length == 0) revert BadParam();
        factory = ICoferFactory(msg.sender);
        usdg = usdg_;
        _held.push(usdg_);
        isHeld[usdg_] = true;
        for (uint256 i; i < members_.length; ++i) {
            _addMember(members_[i]);
        }
        _setThreshold(threshold_, thresholdBps_);
        _setConfig(config_);
        emit Initialized(msg.sender, usdg_, members_, threshold_, thresholdBps_);
    }

    // ------------------------------------------------------------------
    // Member actions (no vote)
    // ------------------------------------------------------------------

    /// @notice Contribute USDG; mints shares at current NAV. Only gate in the whole contract that a
    ///         pause can close (entries only).
    function deposit(uint256 amount) external nonReentrant onlyMember returns (uint256 shares) {
        shares = _deposit(amount);
    }

    /// @notice Same as deposit, using USDG's EIP-2612 permit. Permit failures are ignored (front-run
    ///         griefing safe); the transferFrom then succeeds only if allowance exists.
    function depositWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
        onlyMember
        returns (uint256 shares)
    {
        try IERC20Permit(usdg).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        shares = _deposit(amount);
    }

    /// @notice Take your exact share of every held asset. Never paused, never voted, no oracle.
    function exit(uint256 shares, address to) external nonReentrant {
        if (shares == 0) revert ZeroAmount();
        if (to == address(0)) revert BadParam();
        _exit(msg.sender, shares, to);
    }

    /// @notice Exit everything and stop being a member.
    function leave() external nonReentrant onlyMember {
        uint256 s = _members[msg.sender].shares;
        if (s > 0) _exit(msg.sender, s, msg.sender);
        _removeMember(msg.sender);
    }

    /// @notice Spend from your own allowance (USDG), no vote. Comes out of the shared pot.
    function spend(address to, uint256 amount, bytes32 memo) external nonReentrant onlyMember {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert BadParam();
        Member storage m = _members[msg.sender];
        if (m.period == 0 || m.allowance == 0) revert NoAllowance();
        _rollWindow(m);
        uint256 newSpent = uint256(m.spent) + amount;
        if (newSpent > m.allowance) revert AllowanceExceeded();
        if (amount > distributable(usdg)) revert InsufficientBalance();
        m.spent = uint128(newSpent);
        usdg.safeTransfer(to, amount);
        emit AllowanceSpent(msg.sender, to, amount, memo, uint256(m.allowance) - newSpent);
    }

    /// @notice Withdraw a vote you signed off-chain, before it executes.
    function revokeVote(bytes32 digest) external onlyMember {
        revoked[digest][msg.sender] = true;
        emit VoteRevoked(digest, msg.sender);
    }

    /// @notice Retry an exit transfer that failed earlier (e.g. token was paused). Anyone may call;
    ///         funds always go to `account`.
    function claimOwed(address asset, address account) external nonReentrant {
        uint256 amt = owed[asset][account];
        if (amt == 0) revert NothingOwed();
        owed[asset][account] = 0;
        reserved[asset] -= amt;
        asset.safeTransfer(account, amt);
        emit OwedClaimed(asset, account, amt);
        _prune();
    }

    // ------------------------------------------------------------------
    // Votes
    // ------------------------------------------------------------------

    /// @notice Execute (or queue) a proposal once enough members have signed it. Permissionless.
    /// @param votes sorted by strictly ascending signer address.
    /// @return executed false if this call only queued the proposal behind `guardDelay`.
    function execute(
        uint8 kind,
        bytes calldata data,
        uint256 nonce,
        uint64 epoch_,
        uint64 deadline,
        Vote[] calldata votes
    ) external nonReentrant returns (bool executed) {
        if (kind > uint8(Kind.PAY_PLAN)) revert UnknownKind();
        if (usedNonce[nonce]) revert NonceUsed();
        if (epoch_ != epoch) revert StaleEpoch();
        if (block.timestamp > deadline) revert Expired();

        bytes32 digest = hashProposal(kind, data, nonce, epoch_, deadline);
        uint256 approvals = _countVotes(digest, votes);
        uint256 required = requiredVotes();
        if (approvals < required) revert NotEnoughVotes(approvals, required);

        uint32 delay = (kind == uint8(Kind.SWAP) || approvals >= _memberList.length) ? 0 : config.guardDelay;
        if (delay > 0) {
            uint64 q = queuedAt[digest];
            if (q == 0) {
                queuedAt[digest] = uint64(block.timestamp);
                emit ProposalQueued(digest, kind, nonce, uint64(block.timestamp) + delay);
                return false;
            }
            if (block.timestamp < uint256(q) + delay) revert TooEarly(q + delay);
        }

        usedNonce[nonce] = true;
        _dispatch(Kind(kind), data);
        emit ProposalExecuted(digest, kind, nonce, approvals);
        return true;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function hashProposal(uint8 kind, bytes calldata data, uint256 nonce, uint64 epoch_, uint64 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(PROPOSAL_TYPEHASH, kind, keccak256(data), nonce, epoch_, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function requiredVotes() public view returns (uint256) {
        uint256 n = _memberList.length;
        if (n == 0) return type(uint256).max;
        if (thresholdBps > 0) {
            uint256 r = (n * thresholdBps + BPS - 1) / BPS;
            return r == 0 ? 1 : r;
        }
        return threshold > n ? n : threshold;
    }

    function memberCount() external view returns (uint256) {
        return _memberList.length;
    }

    function members() external view returns (address[] memory) {
        return _memberList;
    }

    function memberInfo(address account) external view returns (MemberView memory v) {
        Member storage m = _members[account];
        v = MemberView(m.active, m.shares, m.allowance, m.period, m.periodStart, m.spent);
    }

    function heldAssets() external view returns (address[] memory) {
        return _held;
    }

    function distributable(address asset) public view returns (uint256) {
        uint256 bal = asset.balanceOf(address(this));
        uint256 res = reserved[asset];
        return bal > res ? bal - res : 0;
    }

    function allowanceLeft(address member) external view returns (uint256) {
        Member storage m = _members[member];
        if (!m.active || m.period == 0) return 0;
        if (block.timestamp >= uint256(m.periodStart) + m.period) return m.allowance;
        return m.spent >= m.allowance ? 0 : m.allowance - m.spent;
    }

    function previewExit(uint256 shares) external view returns (address[] memory assets, uint256[] memory amounts) {
        uint256 n = _held.length;
        assets = new address[](n);
        amounts = new uint256[](n);
        uint256 supply = totalShares;
        for (uint256 i; i < n; ++i) {
            assets[i] = _held[i];
            if (supply > 0 && shares <= supply) amounts[i] = (distributable(_held[i]) * shares) / supply;
        }
    }

    /// @notice NAV in USDG units. Reverts (StalePrice) if a held non-USDG asset's feed is stale.
    ///         Only deposits and the swap floor use it; exits never do.
    function navUsdg() public view returns (uint256 nav, uint256 nonUsdgValue) {
        nav = distributable(usdg);
        uint256 n = _held.length;
        for (uint256 i = 1; i < n; ++i) {
            uint256 bal = distributable(_held[i]);
            if (bal == 0) continue;
            nonUsdgValue += factory.valueInUsdg(_held[i], bal);
        }
        nav += nonUsdgValue;
    }

    // ------------------------------------------------------------------
    // Internal: money
    // ------------------------------------------------------------------

    function _deposit(uint256 amount) internal returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();
        if (!config.depositsOpen || factory.depositsPaused()) revert DepositsClosed();
        (uint256 nav, uint256 nonUsdgValue) = navUsdg();
        uint256 effective = amount;
        if (nonUsdgValue > 0 && config.entrySpreadBps > 0) {
            effective = (amount * (BPS - config.entrySpreadBps)) / BPS;
        }
        // rounds down: in favour of existing members; virtual offset blocks donation inflation
        shares = (effective * (totalShares + VIRTUAL_SHARES)) / (nav + VIRTUAL_ASSETS);
        if (shares == 0) revert ZeroAmount();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        _members[msg.sender].shares += shares;
        totalShares += shares;
        emit Deposited(msg.sender, amount, shares, nav);
    }

    function _exit(address account, uint256 shares, address to) internal {
        Member storage m = _members[account];
        if (m.shares < shares) revert InsufficientShares();
        uint256 supply = totalShares;
        m.shares -= shares;
        totalShares = supply - shares;

        uint256 n = _held.length;
        address[] memory assets = new address[](n);
        uint256[] memory amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            address asset = _held[i];
            assets[i] = asset;
            uint256 amt = (distributable(asset) * shares) / supply; // rounds down
            if (amt == 0) continue;
            amounts[i] = amt;
            if (!asset.tryTransfer(to, amt)) {
                owed[asset][to] += amt;
                reserved[asset] += amt;
                emit ExitOwed(asset, to, amt);
            }
        }
        emit Exited(account, to, shares, assets, amounts);
        _prune();
    }

    function _rollWindow(Member storage m) internal {
        uint256 start = m.periodStart;
        if (block.timestamp >= start + m.period) {
            uint256 periods = (block.timestamp - start) / m.period;
            m.periodStart = uint64(start + periods * m.period);
            m.spent = 0;
        }
    }

    // ------------------------------------------------------------------
    // Internal: votes
    // ------------------------------------------------------------------

    function _countVotes(bytes32 digest, Vote[] calldata votes) internal view returns (uint256 approvals) {
        address last;
        for (uint256 i; i < votes.length; ++i) {
            address signer = votes[i].signer;
            if (signer <= last) revert UnsortedOrDuplicateSigner();
            last = signer;
            if (!_members[signer].active) revert SignerNotMember(signer);
            if (revoked[digest][signer]) continue; // revoked votes simply do not count
            if (!SignatureChecker.isValidSignatureNow(signer, digest, votes[i].signature)) {
                revert InvalidSignature(signer);
            }
            ++approvals;
        }
    }

    function _dispatch(Kind kind, bytes calldata data) internal {
        if (kind == Kind.TRANSFER) {
            (address asset, address to, uint256 amount) = abi.decode(data, (address, address, uint256));
            if (!isHeld[asset]) revert AssetNotHeld(asset);
            if (to == address(0) || amount == 0) revert BadParam();
            if (amount > distributable(asset)) revert InsufficientBalance();
            asset.safeTransfer(to, amount);
            emit Transferred(asset, to, amount);
            _prune();
        } else if (kind == Kind.SWAP) {
            _swap(data);
        } else if (kind == Kind.ADD_MEMBER) {
            _addMember(abi.decode(data, (address)));
            _bumpEpoch();
        } else if (kind == Kind.REMOVE_MEMBER) {
            address who = abi.decode(data, (address));
            if (!_members[who].active) revert NotMember();
            uint256 s = _members[who].shares;
            if (s > 0) _exit(who, s, who); // removed members always get their exact share
            _removeMember(who);
            _bumpEpoch();
        } else if (kind == Kind.SET_ALLOWANCE) {
            (address who, uint128 amount, uint32 period) = abi.decode(data, (address, uint128, uint32));
            Member storage m = _members[who];
            if (!m.active) revert NotMember();
            if (amount > 0 && (period < MIN_ALLOWANCE_PERIOD || period > MAX_ALLOWANCE_PERIOD)) revert BadParam();
            m.allowance = amount;
            m.period = amount == 0 ? 0 : period;
            m.periodStart = uint64(block.timestamp);
            m.spent = 0;
            emit AllowanceSet(who, amount, m.period);
        } else if (kind == Kind.SET_THRESHOLD) {
            (uint8 t, uint16 bps) = abi.decode(data, (uint8, uint16));
            _setThreshold(t, bps);
            _bumpEpoch();
        } else if (kind == Kind.SET_CONFIG) {
            (uint32 d, uint16 slip, uint16 spread, bool open) = abi.decode(data, (uint32, uint16, uint16, bool));
            _setConfig(Config(d, slip, spread, open));
            _bumpEpoch();
        } else if (kind == Kind.PAY_PLAN) {
            (uint8 months, uint256 maxCost) = abi.decode(data, (uint8, uint256));
            IFeeRouter router = IFeeRouter(factory.feeRouter());
            uint256 cost = router.planPricePerMonth() * months;
            if (cost > maxCost) revert PlanCostAboveMax(cost, maxCost);
            if (cost > distributable(usdg)) revert InsufficientBalance();
            usdg.safeApprove(address(router), cost);
            router.payPlan(months);
            usdg.safeApprove(address(router), 0);
            emit PlanPaid(months, cost);
        } else {
            revert UnknownKind();
        }
    }

    function _swap(bytes calldata data) internal {
        (address adapter, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes memory route) =
            abi.decode(data, (address, address, address, uint256, uint256, bytes));
        if (!factory.isAdapter(adapter)) revert AdapterNotAllowed(adapter);
        if (!isHeld[tokenIn]) revert AssetNotHeld(tokenIn);
        if (tokenOut == tokenIn || !factory.isBuyable(tokenOut)) revert AssetNotBuyable(tokenOut);
        if (amountIn == 0 || amountIn > distributable(tokenIn)) revert InsufficientBalance();

        uint256 fee = (amountIn * factory.swapFeeBps()) / BPS;
        uint256 swapIn = amountIn - fee;
        {
            // Oracle floor: the signed minOut may not be looser than maxSlipBps under the feed quote.
            // Reverts on stale feeds, so no buys/sells against a stale price.
            uint256 expected = factory.quote(tokenIn, tokenOut, swapIn);
            uint256 floor = (expected * (BPS - config.maxSlipBps)) / BPS;
            if (minOut < floor || minOut == 0) revert SlippageTooLoose(minOut, floor);
        }
        if (!isHeld[tokenOut]) {
            if (_held.length >= MAX_ASSETS) revert TooManyAssets();
            _held.push(tokenOut);
            isHeld[tokenOut] = true;
            emit AssetAdded(tokenOut);
        }
        if (fee > 0) tokenIn.safeTransfer(factory.feeRouter(), fee);

        uint256 before = tokenOut.balanceOf(address(this));
        tokenIn.safeApprove(adapter, swapIn);
        ISwapAdapter(adapter).swap(tokenIn, tokenOut, swapIn, minOut, route);
        tokenIn.safeApprove(adapter, 0);
        uint256 got = tokenOut.balanceOf(address(this)) - before;
        if (got < minOut) revert OutputTooLow(got, minOut);
        emit Swapped(adapter, tokenIn, tokenOut, amountIn, fee, got);
        _prune();
    }

    // ------------------------------------------------------------------
    // Internal: membership & config
    // ------------------------------------------------------------------

    function _addMember(address who) internal {
        if (who == address(0)) revert BadParam();
        if (_members[who].active) revert AlreadyMember();
        if (_memberList.length >= MAX_MEMBERS) revert TooManyMembers();
        _members[who].active = true;
        _memberList.push(who);
        _memberIndex[who] = _memberList.length;
        emit MemberAdded(who);
    }

    function _removeMember(address who) internal {
        uint256 idx = _memberIndex[who];
        uint256 lastIdx = _memberList.length;
        if (idx != lastIdx) {
            address moved = _memberList[lastIdx - 1];
            _memberList[idx - 1] = moved;
            _memberIndex[moved] = idx;
        }
        _memberList.pop();
        delete _memberIndex[who];
        Member storage m = _members[who];
        m.active = false;
        m.allowance = 0;
        m.period = 0;
        m.spent = 0;
        // shares are zero here (exited before removal)
        emit MemberRemoved(who);
    }

    function _setThreshold(uint8 t, uint16 bps) internal {
        if (bps > BPS) revert BadParam();
        if (bps == 0 && (t == 0 || t > _memberList.length)) revert BadParam();
        threshold = t;
        thresholdBps = bps;
        emit ThresholdSet(t, bps);
    }

    function _setConfig(Config memory c) internal {
        if (c.guardDelay > MAX_GUARD_DELAY || c.maxSlipBps > MAX_SLIP_BPS || c.entrySpreadBps > MAX_ENTRY_SPREAD_BPS) {
            revert BadParam();
        }
        config = c;
        emit ConfigSet(c.guardDelay, c.maxSlipBps, c.entrySpreadBps, c.depositsOpen);
    }

    function _bumpEpoch() internal {
        unchecked {
            ++epoch;
        }
        emit EpochBumped(epoch);
    }

    /// @dev Drops non-USDG assets whose balance and reservations are both zero (keeps loops short).
    function _prune() internal {
        uint256 i = _held.length;
        while (i > 1) {
            --i;
            address a = _held[i];
            if (reserved[a] == 0 && a.balanceOf(address(this)) == 0) {
                _held[i] = _held[_held.length - 1];
                _held.pop();
                isHeld[a] = false;
                emit AssetRemoved(a);
            }
        }
    }
}
