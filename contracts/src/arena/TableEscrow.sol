// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArenaTypes} from "./ArenaTypes.sol";
import {ITableEscrow} from "../interfaces/arena/ITableEscrow.sol";
import {ITableFactory} from "../interfaces/arena/ITableFactory.sol";
import {IResultRegistry} from "../interfaces/arena/IResultRegistry.sol";
import {IUSDG} from "../interfaces/arena/IUSDG.sol";
import {SafeTransferLib} from "../lib/SafeTransferLib.sol";
import {SignatureChecker} from "../lib/SignatureChecker.sol";
import {ReentrancyGuard} from "../lib/ReentrancyGuard.sol";

/// @title TableEscrow
/// @notice One per game (EIP-1167 clone). Holds that game's buy-ins (Friend Table) or prize (Freeroll), runs the
///         state machine of spec §3.4 and pays out by pull only. No owner, no guardian, no pause: the only
///         privileged actor is the host, who can kick before lock (the kicked player is paid back) and cancel a
///         table where the host is alone. Every path ends: Open tables can always cancel, and after
///         `hardDeadline` a Locked or Disputed table can always be refunded by anyone.
contract TableEscrow is ITableEscrow, ReentrancyGuard {
    using SafeTransferLib for address;

    error AlreadyInitialized();
    error BadState();
    error NotJoinable();
    error Full();
    error AlreadySeated();
    error NotSeated();
    error BadSessionKey();
    error BadInvite();
    error BadEligibility();
    error NotPrizeEligible();
    error LeaveClosed();
    error NotHost();
    error CannotLock();
    error CannotCancel();
    error TooEarly();
    error TooLate();
    error WrongRound();
    error BadSignatures();
    error BadPodium();
    error OverPrize();
    error UseFinalize();
    error NothingOwed();
    error FriendOnly();
    error FreerollOnly();
    error AlreadyClaimed();
    error BadProof();
    error OverPayout();

    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant INVITE_TYPEHASH = keccak256("Invite(address table,address player,uint64 expiry)");
    bytes32 public constant ELIGIBILITY_TYPEHASH =
        keccak256("Eligibility(address table,address player,uint8 mode,bool prizeEligible,uint64 expiry)");
    bytes32 public constant ACCEPT_TYPEHASH = keccak256("Accept(address table,bytes32 digest)");
    bytes32 public constant VOID_TYPEHASH = keccak256("Void(address table)");
    bytes32 public constant PAYOUT_TAG = keccak256("COFER_ARENA_PAYOUT_V1");
    uint64 public constant MAX_ELIGIBILITY_AGE = 10 minutes;
    uint64 public constant LEAVE_CUTOFF = 10 minutes;
    uint64 public constant LOCK_WINDOW = 1 hours;

    struct Seat {
        uint16 seatPlusOne;
        bytes32 sessionKeyHash;
        bool prizeEligible;
    }

    bool private _initialized;
    address private _factory;
    address private _registry;
    address private _token;

    address public host;
    address public sponsor;
    uint256 public signerSetId;
    address public eligibilitySigner;

    ArenaTypes.Mode private _mode;
    uint96 private _buyIn;
    uint96 private _prize;
    uint16 private _minSeats;
    uint16 private _maxSeats;
    uint64 private _lockAt;
    uint64 private _openUntil;
    uint32 private _duration;
    uint32 private _disputeWindow;
    uint32 private _settleGrace;
    uint16 private _disputeBondBps;
    uint16[] private _payoutBps;
    address private _inviteSigner;
    bytes32 public rulesHash;
    bool private _cryptoOnly;

    ArenaTypes.State private _state;
    uint64 public lockedAt;
    uint64 public endAt;
    uint64 public hardDeadline;
    uint64 public disputeEnd;

    uint8 private _round; // round of the result currently posted
    bytes32 private _digest; // digest of the result currently posted
    bytes32 private _round0PodiumHash;
    address[] private _podium;
    bytes32 private _payoutRoot;
    uint256 private _totalPayout;
    address private _disputer;
    uint256 private _bond;

    address[] private _seats;
    mapping(address => Seat) private _seatOf;
    mapping(address => uint256) public owed;

    uint256 private _reservedLeft; // buy-ins still counted in the factory's liveValue
    uint256 private _prizePaid;
    mapping(uint256 => uint256) private _claimedBitmap;
    bool private _sponsorReclaimed;

    /// @dev The implementation itself can never be initialised or used.
    constructor() {
        _initialized = true;
    }

    /// @notice Called once by the factory in the same transaction that creates the clone.
    function initialize(
        ArenaTypes.TableParams calldata p,
        address host_,
        address sponsor_,
        uint256 signerSetId_,
        address eligibilitySigner_
    ) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        _factory = msg.sender;
        _registry = ITableFactory(msg.sender).registry();
        _token = p.token;
        host = host_;
        sponsor = sponsor_;
        signerSetId = signerSetId_;
        eligibilitySigner = eligibilitySigner_;
        _mode = p.mode;
        _buyIn = p.buyIn;
        _prize = p.prize;
        _minSeats = p.minSeats;
        _maxSeats = p.maxSeats;
        _lockAt = p.lockAt;
        _openUntil = p.openUntil;
        _duration = p.duration;
        _disputeWindow = p.disputeWindow;
        _settleGrace = p.settleGrace;
        _disputeBondBps = p.disputeBondBps;
        _payoutBps = p.payoutBps;
        _inviteSigner = p.inviteSigner;
        rulesHash = p.rulesHash;
        _cryptoOnly = p.cryptoOnly;
    }

    // ------------------------------------------------------------------ views

    function state() external view returns (ArenaTypes.State) {
        return _state;
    }

    function params() external view returns (ArenaTypes.TableParams memory p) {
        p.mode = _mode;
        p.token = _token;
        p.buyIn = _buyIn;
        p.prize = _prize;
        p.minSeats = _minSeats;
        p.maxSeats = _maxSeats;
        p.lockAt = _lockAt;
        p.openUntil = _openUntil;
        p.duration = _duration;
        p.disputeWindow = _disputeWindow;
        p.settleGrace = _settleGrace;
        p.disputeBondBps = _disputeBondBps;
        p.payoutBps = _payoutBps;
        p.inviteSigner = _inviteSigner;
        p.rulesHash = rulesHash;
        p.cryptoOnly = _cryptoOnly;
    }

    function seats() external view returns (address[] memory) {
        return _seats;
    }

    function seatOf(address a) external view returns (uint16 seatPlusOne, bytes32 sessionKeyHash, bool prizeEligible) {
        Seat storage s = _seatOf[a];
        return (s.seatPlusOne, s.sessionKeyHash, s.prizeEligible);
    }

    function factory() external view returns (address) {
        return _factory;
    }

    function currentResult() external view returns (uint8 round, bytes32 digest, address[] memory podium, bytes32 payoutRoot, uint256 totalPayout) {
        return (_round, _digest, _podium, _payoutRoot, _totalPayout);
    }

    function dispute_() external view returns (address disputer, uint256 bond) {
        return (_disputer, _bond);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Cofer Arena"), keccak256("1"), block.chainid, address(this)));
    }

    function hashTyped(bytes32 structHash) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice The EIP-3009 nonce a joiner signs: it binds the USDG signature to the joiner's session key.
    function joinNonce(address player, bytes32 sessionKeyHash, bytes calldata invite) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), player, sessionKeyHash, keccak256(invite)));
    }

    // ------------------------------------------------------------------ Open

    function join(bytes32 sessionKeyHash, bytes calldata invite, bytes calldata eligibility) external nonReentrant {
        bool full = _seat(msg.sender, sessionKeyHash, invite, eligibility);
        if (full) _lock();
        if (_mode == ArenaTypes.Mode.FRIEND) _token.safeTransferFrom(msg.sender, address(this), _buyIn);
    }

    function joinWithAuthorization(
        address player,
        bytes32 sessionKeyHash,
        bytes calldata invite,
        bytes calldata eligibility,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (_mode != ArenaTypes.Mode.FRIEND) revert FriendOnly();
        bytes32 nonce = joinNonce(player, sessionKeyHash, invite);
        bool full = _seat(player, sessionKeyHash, invite, eligibility);
        if (full) _lock();
        uint256 before = _token.balanceOf(address(this));
        IUSDG(_token).receiveWithAuthorization(player, address(this), _buyIn, validAfter, validBefore, nonce, v, r, s);
        if (_token.balanceOf(address(this)) - before != _buyIn) revert BadState();
    }

    function joinWithPermit(
        bytes32 sessionKeyHash,
        bytes calldata invite,
        bytes calldata eligibility,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (_mode != ArenaTypes.Mode.FRIEND) revert FriendOnly();
        bool full = _seat(msg.sender, sessionKeyHash, invite, eligibility);
        if (full) _lock();
        // a front-run permit only spends the signature; the allowance it set is still there
        try IUSDG(_token).permit(msg.sender, address(this), _buyIn, deadline, v, r, s) {} catch {}
        _token.safeTransferFrom(msg.sender, address(this), _buyIn);
    }

    /// @dev Seats `player`; returns true when a sit-and-go table just became full (it then locks).
    function _seat(address player, bytes32 sessionKeyHash, bytes calldata invite, bytes calldata eligibility)
        internal
        returns (bool full)
    {
        if (_state != ArenaTypes.State.Open) revert BadState();
        if (_lockAt != 0 ? block.timestamp >= _lockAt : block.timestamp >= _openUntil) revert NotJoinable();
        if (sessionKeyHash == bytes32(0)) revert BadSessionKey();
        if (_seatOf[player].seatPlusOne != 0) revert AlreadySeated();
        if (_seats.length >= _maxSeats) revert Full();

        if (_inviteSigner != address(0)) {
            (uint64 exp, bytes memory sig) = abi.decode(invite, (uint64, bytes));
            if (exp < block.timestamp) revert BadInvite();
            bytes32 h = hashTyped(keccak256(abi.encode(INVITE_TYPEHASH, address(this), player, exp)));
            if (SignatureChecker.tryRecover(h, sig) != _inviteSigner) revert BadInvite();
        }

        bool prizeEligible;
        {
            (bool pe, uint64 exp, bytes memory sig) = abi.decode(eligibility, (bool, uint64, bytes));
            if (exp < block.timestamp || exp > block.timestamp + MAX_ELIGIBILITY_AGE) revert BadEligibility();
            bytes32 h =
                hashTyped(keccak256(abi.encode(ELIGIBILITY_TYPEHASH, address(this), player, uint8(_mode), pe, exp)));
            if (SignatureChecker.tryRecover(h, sig) != eligibilitySigner) revert BadEligibility();
            if (_mode == ArenaTypes.Mode.FRIEND && !pe) revert NotPrizeEligible();
            prizeEligible = pe;
        }

        _seats.push(player);
        uint16 seatNo = uint16(_seats.length);
        _seatOf[player] = Seat(seatNo, sessionKeyHash, prizeEligible);
        emit Joined(player, seatNo, sessionKeyHash, prizeEligible);

        if (_mode == ArenaTypes.Mode.FRIEND) {
            _reservedLeft += _buyIn;
            ITableFactory(_factory).reserve(_buyIn);
        }
        return _lockAt == 0 && _seats.length == _maxSeats;
    }

    function leave() external nonReentrant {
        if (_state != ArenaTypes.State.Open) revert BadState();
        if (_seatOf[msg.sender].seatPlusOne == 0) revert NotSeated();
        if (_lockAt != 0 && block.timestamp + LEAVE_CUTOFF > _lockAt) revert LeaveClosed();
        _removeSeat(msg.sender);
        emit Left(msg.sender);
        if (_mode == ArenaTypes.Mode.FRIEND) {
            _releaseReserved(_buyIn);
            _token.safeTransfer(msg.sender, _buyIn);
        }
    }

    function kick(address player) external nonReentrant {
        if (msg.sender != host) revert NotHost();
        if (_state != ArenaTypes.State.Open) revert BadState();
        if (_seatOf[player].seatPlusOne == 0) revert NotSeated();
        _removeSeat(player);
        if (_mode == ArenaTypes.Mode.FRIEND) owed[player] += _buyIn;
        emit Kicked(player);
    }

    function _removeSeat(address player) internal {
        uint256 i = _seatOf[player].seatPlusOne - 1;
        uint256 last = _seats.length - 1;
        if (i != last) {
            address moved = _seats[last];
            _seats[i] = moved;
            _seatOf[moved].seatPlusOne = uint16(i + 1);
        }
        _seats.pop();
        delete _seatOf[player];
    }

    function lock() external nonReentrant {
        if (_state != ArenaTypes.State.Open) revert BadState();
        if (_lockAt == 0 || block.timestamp < _lockAt || block.timestamp >= _lockAt + LOCK_WINDOW) revert CannotLock();
        if (_seats.length < _minSeats) revert CannotLock();
        _lock();
    }

    function _lock() internal {
        _state = ArenaTypes.State.Locked;
        lockedAt = uint64(block.timestamp);
        endAt = lockedAt + _duration;
        hardDeadline = endAt + _settleGrace;
        uint256 pot = _mode == ArenaTypes.Mode.FRIEND ? uint256(_buyIn) * _seats.length : _prize;
        emit Locked(lockedAt, endAt, hardDeadline, pot);
    }

    function cancel() external nonReentrant {
        if (_state != ArenaTypes.State.Open) revert BadState();
        uint256 n = _seats.length;
        bool ok;
        if (_lockAt != 0) {
            ok = (block.timestamp >= _lockAt && n < _minSeats) || block.timestamp >= _lockAt + LOCK_WINDOW;
        } else {
            ok = block.timestamp >= _openUntil;
        }
        if (!ok && msg.sender == host) ok = n == 0 || (n == 1 && _seatOf[host].seatPlusOne != 0);
        if (!ok) revert CannotCancel();
        _refund(0);
        emit Cancelled();
    }

    // ------------------------------------------------------------------ Settling

    function postResult(Result calldata r, bytes[] calldata signerSigs) external nonReentrant {
        if (_state == ArenaTypes.State.Locked) {
            if (r.round != 0) revert WrongRound();
            if (block.timestamp < endAt) revert TooEarly();
            if (block.timestamp + 2 * uint256(_disputeWindow) > hardDeadline) revert TooLate();
        } else if (_state == ArenaTypes.State.Disputed) {
            if (r.round != 1) revert WrongRound();
            if (block.timestamp + _disputeWindow > hardDeadline) revert TooLate();
        } else {
            revert BadState();
        }

        bytes32 digest = IResultRegistry(_registry).resultDigest(address(this), r);
        if (!IResultRegistry(_registry).verify(signerSetId, digest, signerSigs)) revert BadSignatures();

        if (_mode == ArenaTypes.Mode.FRIEND) {
            uint256 n = r.podium.length;
            if (n != _payoutBps.length || r.payoutRoot != bytes32(0) || r.totalPayout != 0) revert BadPodium();
            for (uint256 i; i < n; ++i) {
                if (_seatOf[r.podium[i]].seatPlusOne == 0) revert BadPodium();
                for (uint256 j; j < i; ++j) {
                    if (r.podium[i] == r.podium[j]) revert BadPodium();
                }
            }
            _podium = r.podium;
            if (r.round == 0) _round0PodiumHash = keccak256(abi.encodePacked(r.podium));
        } else {
            if (r.podium.length != 0) revert BadPodium();
            if (r.totalPayout > _prize) revert OverPrize();
            _payoutRoot = r.payoutRoot;
            _totalPayout = r.totalPayout;
        }

        _round = r.round;
        _digest = digest;
        disputeEnd = uint64(block.timestamp) + _disputeWindow;
        _state = ArenaTypes.State.Settling;
        IResultRegistry(_registry).record(digest, r);
        emit ResultPosted(r.round, digest, disputeEnd);
    }

    function dispute(bytes32 reasonHash) external nonReentrant {
        if (_state != ArenaTypes.State.Settling) revert BadState();
        if (block.timestamp >= disputeEnd) revert TooLate();
        if (_seatOf[msg.sender].seatPlusOne == 0) revert NotSeated();
        if (_round != 0) {
            emit Objection(msg.sender, reasonHash); // round 1 is final: recorded, does not pause
            return;
        }
        _state = ArenaTypes.State.Disputed;
        uint256 bond;
        if (_mode == ArenaTypes.Mode.FRIEND) {
            bond = uint256(_buyIn) * _disputeBondBps / 10_000;
            _disputer = msg.sender;
            _bond = bond;
        }
        emit Disputed(msg.sender, 0, reasonHash, bond);
        if (bond != 0) _token.safeTransferFrom(msg.sender, address(this), bond);
    }

    function finalize() external nonReentrant {
        if (_state != ArenaTypes.State.Settling) revert BadState();
        if (block.timestamp < disputeEnd) revert TooEarly();
        _settle(false);
    }

    function acceptAll(bytes[] calldata playerSigs) external nonReentrant {
        if (_state != ArenaTypes.State.Settling) revert BadState();
        _checkAll(hashTyped(keccak256(abi.encode(ACCEPT_TYPEHASH, address(this), _digest))), playerSigs);
        _settle(true);
    }

    function voidAll(bytes[] calldata playerSigs) external nonReentrant {
        if (_mode != ArenaTypes.Mode.FRIEND) revert FriendOnly();
        ArenaTypes.State s = _state;
        if (s == ArenaTypes.State.Settled || s == ArenaTypes.State.Refunded) revert BadState();
        if (_seats.length == 0) revert NotSeated();
        _checkAll(hashTyped(keccak256(abi.encode(VOID_TYPEHASH, address(this)))), playerSigs);
        _refund(2);
    }

    function refundAll() external nonReentrant {
        ArenaTypes.State s = _state;
        if (s == ArenaTypes.State.Settling) revert UseFinalize();
        if (s != ArenaTypes.State.Locked && s != ArenaTypes.State.Disputed) revert BadState();
        if (block.timestamp < hardDeadline) revert TooEarly();
        _refund(1);
    }

    /// @dev One signature per seat, in seat order (passkey accounts via ERC-1271, wallets via ECDSA).
    function _checkAll(bytes32 h, bytes[] calldata sigs) internal view {
        uint256 n = _seats.length;
        if (sigs.length != n) revert BadSignatures();
        for (uint256 i; i < n; ++i) {
            if (!SignatureChecker.isValidSignatureNow(_seats[i], h, sigs[i])) revert BadSignatures();
        }
    }

    function _settle(bool unanimous) internal {
        _state = ArenaTypes.State.Settled;
        if (_mode == ArenaTypes.Mode.FRIEND) {
            uint256 pot = uint256(_buyIn) * _seats.length;
            if (_bond != 0) {
                // podium changed in round 1: the bond goes back; unchanged: it joins the podium payouts
                if (keccak256(abi.encodePacked(_podium)) != _round0PodiumHash) owed[_disputer] += _bond;
                else pot += _bond;
            }
            uint256 paid;
            for (uint256 i; i < _podium.length; ++i) {
                uint256 a = pot * _payoutBps[i] / 10_000;
                owed[_podium[i]] += a;
                paid += a;
            }
            owed[_podium[0]] += pot - paid; // rounding dust to first place
        }
        emit Settled(_digest, unanimous);
    }

    function _refund(uint8 reason) internal {
        _state = ArenaTypes.State.Refunded;
        if (_mode == ArenaTypes.Mode.FRIEND) {
            uint256 n = _seats.length;
            for (uint256 i; i < n; ++i) {
                owed[_seats[i]] += _buyIn;
            }
            if (_bond != 0) owed[_disputer] += _bond;
        }
        emit Refunded(reason);
    }

    // ------------------------------------------------------------------ pull payments

    /// @notice Pays the caller's credit (payout, refund, a kicked seat's buy-in, or a returned bond).
    /// @dev Credits are only ever written when they are final, so a claim is open whenever one exists. If the
    ///      token refuses this transfer, only this call reverts and the amount stays owed.
    function claim(address to) external nonReentrant {
        uint256 amt = owed[msg.sender];
        if (amt == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        address dest = to == address(0) ? msg.sender : to;
        _releaseReserved(amt);
        _token.safeTransfer(dest, amt);
        emit Claimed(msg.sender, dest, amt);
    }

    function claimPrize(uint256 index, uint256 amount, bytes32[] calldata proof, address to) external nonReentrant {
        if (_mode != ArenaTypes.Mode.FREEROLL) revert FreerollOnly();
        if (_state != ArenaTypes.State.Settled) revert BadState();
        Seat storage s = _seatOf[msg.sender];
        if (s.seatPlusOne == 0) revert NotSeated();
        if (!s.prizeEligible) revert NotPrizeEligible();
        uint256 word = index >> 8;
        uint256 bit = 1 << (index & 255);
        if (_claimedBitmap[word] & bit != 0) revert AlreadyClaimed();
        if (_prizePaid + amount > _totalPayout) revert OverPayout();
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(PAYOUT_TAG, block.chainid, address(this), index, msg.sender, amount)))
        );
        if (!_verifyProof(proof, _payoutRoot, leaf)) revert BadProof();
        _claimedBitmap[word] |= bit;
        _prizePaid += amount;
        address dest = to == address(0) ? msg.sender : to;
        _token.safeTransfer(dest, amount);
        emit Claimed(msg.sender, dest, amount);
    }

    function isPrizeClaimed(uint256 index) external view returns (bool) {
        return _claimedBitmap[index >> 8] & (1 << (index & 255)) != 0;
    }

    /// @notice Freeroll: after Settled the sponsor gets `prize - totalPayout`; after Refunded the whole prize. Once.
    function sponsorReclaim() external nonReentrant {
        if (_mode != ArenaTypes.Mode.FREEROLL) revert FreerollOnly();
        if (_sponsorReclaimed) revert AlreadyClaimed();
        uint256 amt;
        if (_state == ArenaTypes.State.Settled) amt = _prize - _totalPayout;
        else if (_state == ArenaTypes.State.Refunded) amt = _prize;
        else revert BadState();
        _sponsorReclaimed = true;
        if (amt != 0) _token.safeTransfer(sponsor, amt);
        emit Claimed(sponsor, sponsor, amt);
    }

    function _releaseReserved(uint256 amt) internal {
        uint256 rel = amt < _reservedLeft ? amt : _reservedLeft;
        if (rel == 0) return;
        _reservedLeft -= rel;
        ITableFactory(_factory).release(rel);
    }

    /// @dev OpenZeppelin MerkleProof.processProof (sorted-pair keccak256).
    function _verifyProof(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == root;
    }
}
