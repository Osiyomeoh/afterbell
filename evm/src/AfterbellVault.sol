// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20, IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Chainlink's price feed interface (the proxy's view functions).
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title Afterbell vault
/// @notice Sells protection on a tokenized stock's next opening print: a put spread that pays
/// `shares × clamp(upper − open, 0, upper − lower)`. The buyer pays a premium quoted and signed
/// off-chain (EIP-712); the vault locks the maximum payout until the series settles.
///
/// Settlement is permissionless: anyone submits the Chainlink round that was in force at the open
/// (the last round published at or before `openTs`). The feed pushes a round on a 0.5% move, so the
/// round in force is within that band of the price at the open; the first round after the open is
/// not, which is why it isn't used. A series that can't be settled within `settleWindow` voids and
/// every premium in it is refunded.
contract AfterbellVault is EIP712, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Prices carry 8 decimals, like Chainlink's feeds; share amounts carry 6.
    uint256 public constant PRICE_SCALE = 1e8;
    uint256 public constant SHARE_SCALE = 1e6;
    uint8 public constant FEED_DECIMALS = 8;

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(address buyer,address feed,uint64 openTs,uint64 shares,uint64 upper,uint64 lower,uint128 premium,uint64 expiry,uint256 nonce)"
    );

    struct Quote {
        address buyer;
        address feed;
        uint64 openTs;
        uint64 shares;
        uint64 upper;
        uint64 lower;
        uint128 premium;
        uint64 expiry;
        uint256 nonce;
    }

    struct Position {
        address buyer;
        address feed;
        uint64 openTs;
        uint64 shares;
        uint64 upper;
        uint64 lower;
        uint128 premium;
        uint128 maxPayout;
        bool closed;
    }

    enum SeriesState {
        Open,
        Settled,
        Voided
    }

    struct Series {
        SeriesState state;
        uint64 price;
        uint80 roundId;
    }

    IERC20 public immutable collateral;
    uint256 private immutable collateralUnit;

    address public quoter;
    uint64 public maxRoundAge;
    uint64 public settleWindow;
    /// @notice Collateral reserved for the maximum payouts of open positions.
    uint256 public locked;
    uint256 public nextPositionId;

    mapping(address feed => bool) public feedAllowed;
    mapping(uint256 nonce => bool) public nonceUsed;
    mapping(uint256 id => Position) public positions;
    mapping(bytes32 key => Series) public series;

    event QuoterSet(address quoter);
    event FeedAllowed(address indexed feed, bool allowed);
    event ParamsSet(uint64 maxRoundAge, uint64 settleWindow);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event ProtectionBought(
        uint256 indexed id,
        address indexed buyer,
        address indexed feed,
        uint64 openTs,
        uint64 shares,
        uint64 upper,
        uint64 lower,
        uint128 premium,
        uint128 maxPayout
    );
    event SeriesSettled(address indexed feed, uint64 indexed openTs, uint64 price, uint80 roundId);
    event SeriesVoided(address indexed feed, uint64 indexed openTs);
    event Claimed(uint256 indexed id, address indexed buyer, uint256 amount, bool refund);

    error NotBuyer();
    error QuoteExpired();
    error AlreadyOpen();
    error FeedNotAllowed();
    error NonceUsed();
    error BadProtection();
    error BadSignature();
    error InsufficientCollateral();
    error NotYetOpen();
    error SeriesClosed();
    error RoundMissing();
    error RoundAfterOpen();
    error RoundTooOld();
    error BadAnswer();
    error NotRoundInForce();
    error WindowNotOver();
    error NotClaimable();
    error BadFeedDecimals();
    error BadParams();

    constructor(IERC20 collateral_, address owner_, address quoter_, uint64 maxRoundAge_, uint64 settleWindow_)
        EIP712("Afterbell", "1")
        Ownable(owner_)
    {
        collateral = collateral_;
        collateralUnit = 10 ** IERC20Metadata(address(collateral_)).decimals();
        _setQuoter(quoter_);
        _setParams(maxRoundAge_, settleWindow_);
    }

    // ---------------------------------------------------------------- buying

    /// @notice Buy protection at a price the quoter signed for this buyer.
    function buy(Quote calldata q, bytes calldata signature) external nonReentrant returns (uint256 id) {
        if (msg.sender != q.buyer) revert NotBuyer();
        if (block.timestamp > q.expiry) revert QuoteExpired();
        if (block.timestamp >= q.openTs) revert AlreadyOpen();
        if (!feedAllowed[q.feed]) revert FeedNotAllowed();
        if (nonceUsed[q.nonce]) revert NonceUsed();
        if (q.shares == 0 || q.upper <= q.lower) revert BadProtection();
        if (ECDSA.recover(hashQuote(q), signature) != quoter) revert BadSignature();

        uint128 maxPayout = uint128(_payoutUnits(q.shares, q.upper - q.lower));
        // A premium above the most it can pay makes no sense, and would let a voided series refund
        // more than the position ever locked.
        if (maxPayout == 0 || q.premium > maxPayout) revert BadProtection();

        nonceUsed[q.nonce] = true;
        locked += maxPayout;
        id = nextPositionId++;
        positions[id] = Position({
            buyer: q.buyer,
            feed: q.feed,
            openTs: q.openTs,
            shares: q.shares,
            upper: q.upper,
            lower: q.lower,
            premium: q.premium,
            maxPayout: maxPayout,
            closed: false
        });

        collateral.safeTransferFrom(msg.sender, address(this), q.premium);
        // The premium counts toward the collateral that backs the payout.
        if (locked > collateral.balanceOf(address(this))) revert InsufficientCollateral();

        emit ProtectionBought(id, q.buyer, q.feed, q.openTs, q.shares, q.upper, q.lower, q.premium, maxPayout);
    }

    /// @notice The EIP-712 digest the quoter signs.
    function hashQuote(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH, q.buyer, q.feed, q.openTs, q.shares, q.upper, q.lower, q.premium, q.expiry, q.nonce
                )
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ------------------------------------------------------------- settlement

    /// @notice Settle every position on `feed` for the open at `openTs`, using the round in force then.
    /// @param roundId The last round published at or before `openTs`. Anyone can submit it; the contract
    /// checks it really is the last one, so nobody can choose a friendlier round.
    function settle(address feed, uint64 openTs, uint80 roundId) external {
        Series storage s = series[seriesKey(feed, openTs)];
        if (s.state != SeriesState.Open) revert SeriesClosed();
        // Strictly after: a round published in the same second as the open would also be in force.
        if (block.timestamp <= openTs) revert NotYetOpen();

        AggregatorV3Interface agg = AggregatorV3Interface(feed);
        (bool found, int256 answer, uint256 updatedAt) = _round(agg, roundId);
        if (!found) revert RoundMissing();
        if (updatedAt > openTs) revert RoundAfterOpen();
        if (openTs - updatedAt > maxRoundAge) revert RoundTooOld();
        if (answer <= 0 || uint256(answer) > type(uint64).max) revert BadAnswer();

        // In force at the open: the next round in the same phase came after it, or there is none yet.
        (bool nextFound,, uint256 nextUpdatedAt) = _round(agg, roundId + 1);
        if (nextFound) {
            if (nextUpdatedAt <= openTs) revert NotRoundInForce();
        } else {
            (uint80 latest,,,,) = agg.latestRoundData();
            if (latest != roundId) revert NotRoundInForce();
        }

        s.state = SeriesState.Settled;
        s.price = uint64(uint256(answer));
        s.roundId = roundId;
        emit SeriesSettled(feed, openTs, uint64(uint256(answer)), roundId);
    }

    /// @notice Void a series nobody could settle in time; its positions get their premiums back.
    function voidSeries(address feed, uint64 openTs) external {
        Series storage s = series[seriesKey(feed, openTs)];
        if (s.state != SeriesState.Open) revert SeriesClosed();
        if (block.timestamp <= uint256(openTs) + settleWindow) revert WindowNotOver();
        s.state = SeriesState.Voided;
        emit SeriesVoided(feed, openTs);
    }

    /// @notice Pay a position out (or refund it, if its series voided). Anyone can call it; the money
    /// always goes to the buyer, so a keeper can claim for everyone.
    function claim(uint256 id) external nonReentrant returns (uint256 amount) {
        Position storage p = positions[id];
        if (p.buyer == address(0) || p.closed) revert NotClaimable();
        Series storage s = series[seriesKey(p.feed, p.openTs)];
        if (s.state == SeriesState.Open) revert NotClaimable();

        p.closed = true;
        locked -= p.maxPayout;
        bool refund = s.state == SeriesState.Voided;
        amount = refund ? p.premium : payoutAt(p.shares, p.upper, p.lower, s.price);

        if (amount > 0) collateral.safeTransfer(p.buyer, amount);
        emit Claimed(id, p.buyer, amount, refund);
    }

    /// @notice What a position pays at an opening price, in collateral units.
    function payoutAt(uint64 shares, uint64 upper, uint64 lower, uint64 price) public view returns (uint256) {
        if (price >= upper) return 0;
        uint256 diff = Math.min(uint256(upper - price), uint256(upper - lower));
        return _payoutUnits(shares, diff);
    }

    function seriesKey(address feed, uint64 openTs) public pure returns (bytes32) {
        return keccak256(abi.encode(feed, openTs));
    }

    /// @notice Collateral not reserved for open positions: what the owner may withdraw.
    function freeCollateral() public view returns (uint256) {
        return collateral.balanceOf(address(this)) - locked;
    }

    // ------------------------------------------------------------------ admin

    function deposit(uint256 amount) external {
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount, address to) external onlyOwner {
        if (amount > freeCollateral()) revert InsufficientCollateral();
        collateral.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    function setQuoter(address quoter_) external onlyOwner {
        _setQuoter(quoter_);
    }

    function allowFeed(address feed, bool allowed) external onlyOwner {
        if (allowed && AggregatorV3Interface(feed).decimals() != FEED_DECIMALS) revert BadFeedDecimals();
        feedAllowed[feed] = allowed;
        emit FeedAllowed(feed, allowed);
    }

    /// @notice Disallowing a feed stops new sales on it; positions already sold still settle and claim.
    function setParams(uint64 maxRoundAge_, uint64 settleWindow_) external onlyOwner {
        _setParams(maxRoundAge_, settleWindow_);
    }

    // --------------------------------------------------------------- internal

    function _setQuoter(address quoter_) private {
        if (quoter_ == address(0)) revert BadParams();
        quoter = quoter_;
        emit QuoterSet(quoter_);
    }

    function _setParams(uint64 maxRoundAge_, uint64 settleWindow_) private {
        // A window under an hour could void a series before a keeper gets to it; over a week locks
        // collateral for no reason.
        if (maxRoundAge_ == 0 || settleWindow_ < 1 hours || settleWindow_ > 7 days) revert BadParams();
        maxRoundAge = maxRoundAge_;
        settleWindow = settleWindow_;
        emit ParamsSet(maxRoundAge_, settleWindow_);
    }

    /// @dev shares (6 decimals) × a price difference (8 decimals), in collateral units, rounded down.
    function _payoutUnits(uint256 shares, uint256 priceDiff) private view returns (uint256) {
        return Math.mulDiv(shares * priceDiff, collateralUnit, SHARE_SCALE * PRICE_SCALE);
    }

    /// @dev A round's answer and time. Chainlink proxies revert for rounds that don't exist yet, and
    /// some return zeros; both count as missing.
    function _round(AggregatorV3Interface agg, uint80 roundId)
        private
        view
        returns (bool found, int256 answer, uint256 updatedAt)
    {
        try agg.getRoundData(roundId) returns (uint80, int256 a, uint256, uint256 u, uint80) {
            return (u != 0, a, u);
        } catch {
            return (false, 0, 0);
        }
    }
}
