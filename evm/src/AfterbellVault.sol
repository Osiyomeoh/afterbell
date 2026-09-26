// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20, IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {AfterbellPositions} from "./AfterbellPositions.sol";
import {IERC7540Deposit, IERC7540Operator, IERC7540Redeem, IERC7575} from "./interfaces/IERC7540.sol";

/// @notice Chainlink's price feed interface (the proxy's view functions).
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title Afterbell vault
/// @notice Sells protection on a tokenized stock's next opening print, underwritten by a pool anyone
/// can join.
///
/// Protection is a put spread paying `shares × clamp(upper − open, 0, upper − lower)`, priced and
/// signed off-chain by the quoter (EIP-712). Each one is an NFT (AfterbellPositions); its payout goes
/// to whoever holds it. The vault locks the maximum payout until the series settles on the Chainlink
/// round in force at the open, the last round published at or before it. The feed pushes a round on
/// a 0.5% move, so that round is within the band of the open. Anyone may settle, and anyone may pay
/// the positions out (`process`), earning the keeper's tip on each. A series nobody can settle within
/// the settle window voids, and every premium in it is refunded. A price more than MAX_PRICE_RATIO
/// times from the strikes a series sold is refused as a broken feed: Chainlink's Robinhood Chain
/// feeds spent their first day and a half publishing answers 10^8 too large.
///
/// The pool is an ERC-7540 vault: its shares are this ERC-20, deposits and redemptions are requested
/// and then claimed. Requests are filled at a roll, which comes after each opening once everything
/// the round sold is paid. Nothing is at risk at that moment, so the price of a share is exact: no
/// one can join cheaply before a quiet night or leave ahead of a loss. The first sale after a roll
/// fixes the round's opening. Risk limits cap what a round, and each stock in it, may put at risk as
/// a share of the pool at the roll. Changes to the limits and timings wait for the next roll. The
/// owner can't withdraw the pool; an owner who deposited leaves as any other underwriter does.
contract AfterbellVault is
    ERC20,
    EIP712,
    Ownable2Step,
    ReentrancyGuard,
    IERC165,
    IERC7540Operator,
    IERC7540Deposit,
    IERC7540Redeem,
    IERC7575
{
    using SafeERC20 for IERC20;

    /// @dev Prices carry 8 decimals, like Chainlink's feeds; share amounts carry 6.
    uint256 public constant PRICE_SCALE = 1e8;
    uint256 public constant SHARE_SCALE = 1e6;
    uint8 public constant FEED_DECIMALS = 8;
    /// @notice How far from its strikes a series may settle: above the highest upper strike times
    /// this, or below the lowest lower strike divided by it, the price is refused.
    uint256 public constant MAX_PRICE_RATIO = 10;
    uint256 private constant BPS = 10_000;

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
        /// @dev The keeper's cut of the premium, paid to whoever pays the position out.
        uint128 tip;
        /// @dev What it paid its holder: the payout, or the premium if its series voided.
        uint128 paid;
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
        /// @dev The strikes sold, bounding the price it can settle at. highestUpper is 0 until the first
        /// sale (every upper strike is above its lower, so above 0).
        uint64 lowestLower;
        uint64 highestUpper;
        /// @dev Maximum payouts of its positions not yet paid out.
        uint128 locked;
        /// @dev How many of its positions `process` has passed.
        uint32 processed;
    }

    /// @notice Settlement timings and risk limits. Changes wait for the next roll.
    struct Params {
        uint64 maxRoundAge;
        uint64 settleWindow;
        /// @dev The most a round may lock, as a share of the pool at its roll.
        uint16 maxUtilizationBps;
        /// @dev The most one stock may lock in a round, as a share of the pool at its roll.
        uint16 maxFeedBps;
        /// @dev The keeper's cut of each premium.
        uint16 keeperTipBps;
    }

    struct Request {
        uint64 round;
        uint192 amount;
    }

    struct Claim {
        uint128 assets;
        uint128 shares;
    }

    /// @dev The price of a share at a roll: `assets` per `shares`, each with one virtual unit added,
    /// so an empty pool starts at one share per asset unit and a donation can't skew the first.
    struct Rate {
        uint128 assets;
        uint128 shares;
    }

    IERC20 public immutable collateral;
    AfterbellPositions public immutable positionToken;
    uint256 private immutable collateralUnit;
    uint8 private immutable collateralDecimals;

    address public quoter;
    Params private _params;
    Params private _nextParams;
    bool public paramsQueued;

    /// @notice The round in progress, its opening (0 until its first sale) and the pool's assets at
    /// the roll that began it, which its risk limits are measured against.
    uint64 public round;
    uint64 public roundOpenTs;
    uint256 public roundNav;
    bytes32[] private _roundSeries;

    /// @notice Maximum payouts of positions not yet paid out.
    uint256 public locked;
    /// @notice Keepers' tips on positions not yet paid out.
    uint256 public tipsOwed;
    /// @notice Assets requested for deposit this round, not in the pool until the roll.
    uint256 public pendingDepositAssets;
    /// @notice Shares requested for redemption this round, held by the vault until the roll.
    uint256 public pendingRedeemShares;
    /// @notice Assets owed to redemptions filled at a roll and not yet claimed.
    uint256 public reservedAssets;
    uint256 public nextPositionId;

    mapping(address feed => bool) public feedAllowed;
    mapping(address feed => string) public feedSymbol;
    mapping(uint256 nonce => bool) public nonceUsed;
    mapping(uint256 id => Position) private _positions;
    mapping(bytes32 key => Series) private _series;
    mapping(bytes32 key => uint256[]) private _seriesPositions;

    mapping(address controller => Request) private _depositRequests;
    mapping(address controller => Request) private _redeemRequests;
    mapping(address controller => Claim) private _depositClaims;
    mapping(address controller => Claim) private _redeemClaims;
    mapping(uint64 round => Rate) private _rates;
    mapping(address controller => mapping(address operator => bool)) public override isOperator;

    event QuoterSet(address quoter);
    event FeedAllowed(address indexed feed, string symbol, bool allowed);
    event ParamsSet(Params params);
    event ParamsQueued(Params params);
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
    event Claimed(uint256 indexed id, address indexed holder, uint256 amount, bool refund);
    event Processed(address indexed feed, uint64 indexed openTs, uint256 positions, address keeper, uint256 tips);
    event Rolled(
        uint64 indexed round,
        uint64 openTs,
        uint256 assets,
        uint256 supply,
        uint256 depositAssets,
        uint256 depositShares,
        uint256 redeemShares,
        uint256 redeemAssets
    );
    /// @dev ERC-4626's events, emitted when a request is claimed.
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares
    );

    error NotBuyer();
    error QuoteExpired();
    error AlreadyOpen();
    error FeedNotAllowed();
    error NonceUsed();
    error BadProtection();
    error BadSignature();
    error WrongRound();
    error OverCapacity();
    error OverStockLimit();
    error NotYetOpen();
    error SeriesClosed();
    error SeriesStillOpen();
    error RoundMissing();
    error RoundAfterOpen();
    error RoundTooOld();
    error BadAnswer();
    error ImplausiblePrice();
    error NotRoundInForce();
    error WindowNotOver();
    error NotClaimable();
    error RoundNotOver();
    error BadFeedDecimals();
    error BadParams();
    error Unauthorized();
    error ZeroAmount();
    error OverClaimable();
    error AsyncOnly();

    constructor(IERC20 collateral_, address owner_, address quoter_, uint64 maxRoundAge_, uint64 settleWindow_)
        ERC20("Afterbell Pool", "BELLPOOL")
        EIP712("Afterbell", "1")
        Ownable(owner_)
    {
        collateral = collateral_;
        collateralDecimals = IERC20Metadata(address(collateral_)).decimals();
        collateralUnit = 10 ** collateralDecimals;
        positionToken = new AfterbellPositions();
        round = 1;
        _setQuoter(quoter_);
        // Half the pool at risk on a night at most, a fifth on any one stock; keepers get 2% of premiums.
        Params memory p = Params(maxRoundAge_, settleWindow_, 5_000, 2_000, 200);
        _checkParams(p);
        _params = p;
        emit ParamsSet(p);
    }

    // ---------------------------------------------------------------- buying

    /// @notice Buy protection at a price the quoter signed for this buyer. The position is minted to
    /// the buyer as an NFT.
    function buy(Quote calldata q, bytes calldata signature) external nonReentrant returns (uint256) {
        return _buy(q, signature);
    }

    /// @notice buy, with an EIP-2612 permit for the premium instead of an approval beforehand.
    function buyWithPermit(Quote calldata q, bytes calldata signature, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
        returns (uint256)
    {
        _permit(q.premium, deadline, v, r, s);
        return _buy(q, signature);
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

    /// @notice How much more maximum payout the round can still sell on `feed`, under both risk limits.
    function capacity(address feed) external view returns (uint256) {
        if (roundOpenTs != 0 && block.timestamp >= roundOpenTs) return 0;
        uint256 roundLeft = _left(roundNav * _params.maxUtilizationBps / BPS, locked);
        uint256 feedLocked = roundOpenTs == 0 ? 0 : _series[seriesKey(feed, roundOpenTs)].locked;
        return Math.min(roundLeft, _left(roundNav * _params.maxFeedBps / BPS, feedLocked));
    }

    // ------------------------------------------------------------- settlement

    /// @notice Settle every position on `feed` for the open at `openTs`, using the round in force then.
    /// @param roundId The last round published at or before `openTs`. Anyone can submit it; the contract
    /// checks it really is the last one, so nobody can choose a friendlier round.
    function settle(address feed, uint64 openTs, uint80 roundId) external {
        Series storage s = _series[seriesKey(feed, openTs)];
        if (s.state != SeriesState.Open) revert SeriesClosed();
        // Strictly after: a round published in the same second as the open would also be in force.
        if (block.timestamp <= openTs) revert NotYetOpen();

        AggregatorV3Interface agg = AggregatorV3Interface(feed);
        (bool found, int256 answer, uint256 updatedAt) = _round(agg, roundId);
        if (!found) revert RoundMissing();
        if (updatedAt > openTs) revert RoundAfterOpen();
        if (openTs - updatedAt > _params.maxRoundAge) revert RoundTooOld();
        if (answer <= 0 || uint256(answer) > type(uint64).max) revert BadAnswer();
        // A series with no sales has nothing to pay, and no strikes to check against.
        if (s.highestUpper != 0 && !plausiblePrice(uint256(answer), s.lowestLower, s.highestUpper)) {
            revert ImplausiblePrice();
        }

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
        Series storage s = _series[seriesKey(feed, openTs)];
        if (s.state != SeriesState.Open) revert SeriesClosed();
        if (block.timestamp <= uint256(openTs) + _params.settleWindow) revert WindowNotOver();
        s.state = SeriesState.Voided;
        emit SeriesVoided(feed, openTs);
    }

    /// @notice Pay out up to `max` positions of a settled or voided series, in order, to whoever holds
    /// each one. Anyone can call it and is paid the keepers' tips of the positions it pays.
    function process(address feed, uint64 openTs, uint256 max) external nonReentrant returns (uint256 count) {
        bytes32 key = seriesKey(feed, openTs);
        Series storage s = _series[key];
        if (s.state == SeriesState.Open) revert SeriesStillOpen();
        uint256[] storage ids = _seriesPositions[key];
        uint256 start = s.processed;
        uint256 end = Math.min(ids.length, start + max);
        uint256 tips;
        for (uint256 i = start; i < end; ++i) {
            // Skip any its holder already claimed.
            if (!_positions[ids[i]].closed) tips += _close(ids[i], s);
        }
        s.processed = uint32(end);
        count = end - start;
        if (tips > 0) collateral.safeTransfer(msg.sender, tips);
        emit Processed(feed, openTs, count, msg.sender, tips);
    }

    /// @notice Pay one position out to its holder (or refund it, if its series voided). Anyone can
    /// call it; the money always goes to the holder, and the keeper's tip to the caller.
    function claim(uint256 id) external nonReentrant returns (uint256) {
        Position storage p = _positions[id];
        if (p.feed == address(0) || p.closed) revert NotClaimable();
        Series storage s = _series[seriesKey(p.feed, p.openTs)];
        if (s.state == SeriesState.Open) revert NotClaimable();
        uint256 tip = _close(id, s);
        if (tip > 0) collateral.safeTransfer(msg.sender, tip);
        return p.paid;
    }

    /// @notice What a position pays at an opening price, in collateral units.
    function payoutAt(uint64 shares, uint64 upper, uint64 lower, uint64 price) public view returns (uint256) {
        if (price >= upper) return 0;
        uint256 diff = Math.min(uint256(upper - price), uint256(upper - lower));
        return _payoutUnits(shares, diff);
    }

    /// @notice Whether a series with these strikes may settle at `price`: within MAX_PRICE_RATIO of them.
    function plausiblePrice(uint256 price, uint64 lowestLower, uint64 highestUpper) public pure returns (bool) {
        return price <= uint256(highestUpper) * MAX_PRICE_RATIO && price * MAX_PRICE_RATIO >= lowestLower;
    }

    function seriesKey(address feed, uint64 openTs) public pure returns (bytes32) {
        return keccak256(abi.encode(feed, openTs));
    }

    function position(uint256 id) external view returns (Position memory) {
        return _positions[id];
    }

    function series(bytes32 key) external view returns (Series memory) {
        return _series[key];
    }

    /// @notice A series' positions, in the order they were sold: what a hedger sums for exposure.
    function seriesPositions(address feed, uint64 openTs) external view returns (uint256[] memory) {
        return _seriesPositions[seriesKey(feed, openTs)];
    }

    /// @notice The series the current round has sold, one per stock.
    function roundSeries() external view returns (bytes32[] memory) {
        return _roundSeries;
    }

    // ------------------------------------------------------------------ rolls

    /// @notice End the round and fill the queued deposits and redemptions at the pool's exact value.
    /// Anyone can call it once the round's opening has passed and every position it sold is paid
    /// out, or at any time if it sold nothing. Queued parameter changes take effect here.
    function roll() external nonReentrant {
        if (roundOpenTs != 0) {
            if (block.timestamp <= roundOpenTs) revert RoundNotOver();
            for (uint256 i; i < _roundSeries.length; ++i) {
                bytes32 key = _roundSeries[i];
                Series storage s = _series[key];
                if (s.state == SeriesState.Open || s.processed < _seriesPositions[key].length) revert RoundNotOver();
            }
        }
        // Everything the round sold is paid, so nothing is at risk and the pool's value is exact.
        uint256 assets = totalAssets();
        uint256 supply = totalSupply();
        Rate memory rate = Rate(uint128(assets + 1), uint128(supply + 1));
        _rates[round] = rate;

        uint256 depositAssets = pendingDepositAssets;
        uint256 redeemShares = pendingRedeemShares;
        uint256 depositShares = Math.mulDiv(depositAssets, rate.shares, rate.assets);
        uint256 redeemAssets = Math.mulDiv(redeemShares, rate.assets, rate.shares);
        pendingDepositAssets = 0;
        pendingRedeemShares = 0;
        reservedAssets += redeemAssets;
        _burn(address(this), redeemShares);
        _mint(address(this), depositShares);
        emit Rolled(round, roundOpenTs, assets, supply, depositAssets, depositShares, redeemShares, redeemAssets);

        delete _roundSeries;
        round++;
        roundOpenTs = 0;
        if (paramsQueued) {
            _params = _nextParams;
            paramsQueued = false;
            emit ParamsSet(_nextParams);
        }
        roundNav = totalAssets();
    }

    // ------------------------------------------------- the pool (ERC-7540, ERC-4626)

    function asset() external view returns (address) {
        return address(collateral);
    }

    function share() external view returns (address) {
        return address(this);
    }

    function decimals() public view override returns (uint8) {
        return collateralDecimals;
    }

    /// @notice The pool's assets net of the most its open positions could pay: exact between a roll
    /// and the round's first sale, conservative during a round. Queued deposits, redemptions owed and
    /// keepers' tips aren't the pool's.
    function totalAssets() public view returns (uint256) {
        return collateral.balanceOf(address(this)) - pendingDepositAssets - reservedAssets - tipsOwed - locked;
    }

    function convertToShares(uint256 assets) external view returns (uint256) {
        return Math.mulDiv(assets, totalSupply() + 1, totalAssets() + 1);
    }

    function convertToAssets(uint256 shares) external view returns (uint256) {
        return Math.mulDiv(shares, totalAssets() + 1, totalSupply() + 1);
    }

    /// @notice Queue `assets` of `owner`'s to join the pool at the next roll, for `controller` to claim.
    function requestDeposit(uint256 assets, address controller, address owner) external nonReentrant returns (uint256) {
        if (owner != msg.sender && !isOperator[owner][msg.sender]) revert Unauthorized();
        return _requestDeposit(assets, controller, owner);
    }

    /// @notice requestDeposit from the caller, with an EIP-2612 permit instead of an approval beforehand.
    function requestDepositWithPermit(uint256 assets, address controller, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
        returns (uint256)
    {
        _permit(assets, deadline, v, r, s);
        return _requestDeposit(assets, controller, msg.sender);
    }

    /// @notice Queue `owner`'s `shares` to leave the pool at the next roll, for `controller` to claim.
    function requestRedeem(uint256 shares, address controller, address owner) external nonReentrant returns (uint256) {
        if (shares == 0) revert ZeroAmount();
        if (owner != msg.sender && !isOperator[owner][msg.sender]) _spendAllowance(owner, msg.sender, shares);
        _fill(controller);
        _transfer(owner, address(this), shares);
        Request storage r = _redeemRequests[controller];
        r.round = round;
        r.amount += uint192(shares);
        pendingRedeemShares += shares;
        emit RedeemRequest(controller, owner, 0, msg.sender, shares);
        return 0;
    }

    function pendingDepositRequest(uint256, address controller) external view returns (uint256) {
        Request memory r = _depositRequests[controller];
        return r.round == round ? r.amount : 0;
    }

    function claimableDepositRequest(uint256, address controller) public view returns (uint256) {
        return _claimAfterFill(controller, true).assets;
    }

    function pendingRedeemRequest(uint256, address controller) external view returns (uint256) {
        Request memory r = _redeemRequests[controller];
        return r.round == round ? r.amount : 0;
    }

    function claimableRedeemRequest(uint256, address controller) public view returns (uint256) {
        return _claimAfterFill(controller, false).shares;
    }

    function maxDeposit(address controller) external view returns (uint256) {
        return _claimAfterFill(controller, true).assets;
    }

    function maxMint(address controller) external view returns (uint256) {
        return _claimAfterFill(controller, true).shares;
    }

    function maxWithdraw(address controller) external view returns (uint256) {
        return _claimAfterFill(controller, false).assets;
    }

    function maxRedeem(address controller) external view returns (uint256) {
        return _claimAfterFill(controller, false).shares;
    }

    /// @dev Deposits and redemptions are asynchronous: the price is set at the roll, not now.
    function previewDeposit(uint256) external pure returns (uint256) {
        revert AsyncOnly();
    }

    function previewMint(uint256) external pure returns (uint256) {
        revert AsyncOnly();
    }

    function previewWithdraw(uint256) external pure returns (uint256) {
        revert AsyncOnly();
    }

    function previewRedeem(uint256) external pure returns (uint256) {
        revert AsyncOnly();
    }

    /// @notice Claim the shares a filled deposit of `assets` bought, to `receiver`.
    function deposit(uint256 assets, address receiver, address controller) public nonReentrant returns (uint256 shares) {
        Claim storage c = _claimFor(controller, true);
        if (assets == 0) revert ZeroAmount();
        if (assets > c.assets) revert OverClaimable();
        shares = assets == c.assets ? c.shares : Math.mulDiv(c.shares, assets, c.assets);
        c.assets -= uint128(assets);
        c.shares -= uint128(shares);
        _transfer(address(this), receiver, shares);
        emit Deposit(controller, receiver, assets, shares);
    }

    function deposit(uint256 assets, address receiver) external returns (uint256) {
        return deposit(assets, receiver, msg.sender);
    }

    /// @notice Claim `shares` of a filled deposit, to `receiver`.
    function mint(uint256 shares, address receiver, address controller) public nonReentrant returns (uint256 assets) {
        Claim storage c = _claimFor(controller, true);
        if (shares == 0) revert ZeroAmount();
        if (shares > c.shares) revert OverClaimable();
        assets = shares == c.shares ? c.assets : Math.mulDiv(c.assets, shares, c.shares, Math.Rounding.Ceil);
        c.assets -= uint128(assets);
        c.shares -= uint128(shares);
        _transfer(address(this), receiver, shares);
        emit Deposit(controller, receiver, assets, shares);
    }

    function mint(uint256 shares, address receiver) external returns (uint256) {
        return mint(shares, receiver, msg.sender);
    }

    /// @notice Claim the assets a filled redemption of `shares` is owed, to `receiver`.
    function redeem(uint256 shares, address receiver, address controller) external nonReentrant returns (uint256 assets) {
        Claim storage c = _claimFor(controller, false);
        if (shares == 0) revert ZeroAmount();
        if (shares > c.shares) revert OverClaimable();
        assets = shares == c.shares ? c.assets : Math.mulDiv(c.assets, shares, c.shares);
        _payRedemption(c, assets, shares, receiver, controller);
    }

    /// @notice Claim `assets` of a filled redemption, to `receiver`.
    function withdraw(uint256 assets, address receiver, address controller) external nonReentrant returns (uint256 shares) {
        Claim storage c = _claimFor(controller, false);
        if (assets == 0) revert ZeroAmount();
        if (assets > c.assets) revert OverClaimable();
        shares = assets == c.assets ? c.shares : Math.mulDiv(c.shares, assets, c.assets, Math.Rounding.Ceil);
        _payRedemption(c, assets, shares, receiver, controller);
    }

    function setOperator(address operator, bool approved) external returns (bool) {
        isOperator[msg.sender][operator] = approved;
        emit OperatorSet(msg.sender, operator, approved);
        return true;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IERC165).interfaceId || id == type(IERC7540Operator).interfaceId
            || id == type(IERC7540Deposit).interfaceId || id == type(IERC7540Redeem).interfaceId
            || id == type(IERC7575).interfaceId;
    }

    // ------------------------------------------------------------------ admin

    function setQuoter(address quoter_) external onlyOwner {
        _setQuoter(quoter_);
    }

    /// @notice Allow sales on a Chainlink feed, named by its stock's ticker (the positions' NFTs show
    /// it). Disallowing a feed stops new sales on it; positions already sold still settle and pay.
    function allowFeed(address feed, string calldata symbol) external onlyOwner {
        if (AggregatorV3Interface(feed).decimals() != FEED_DECIMALS) revert BadFeedDecimals();
        if (bytes(symbol).length == 0 || bytes(symbol).length > 12) revert BadParams();
        feedAllowed[feed] = true;
        feedSymbol[feed] = symbol;
        emit FeedAllowed(feed, symbol, true);
    }

    function disallowFeed(address feed) external onlyOwner {
        feedAllowed[feed] = false;
        emit FeedAllowed(feed, feedSymbol[feed], false);
    }

    /// @notice Queue new timings and risk limits, to take effect at the next roll: a round runs to the
    /// end on the rules it started with.
    function setParams(Params calldata p) external onlyOwner {
        _checkParams(p);
        _nextParams = p;
        paramsQueued = true;
        emit ParamsQueued(p);
    }

    function params() external view returns (Params memory) {
        return _params;
    }

    function maxRoundAge() external view returns (uint64) {
        return _params.maxRoundAge;
    }

    function settleWindow() external view returns (uint64) {
        return _params.settleWindow;
    }

    // --------------------------------------------------------------- internal

    function _buy(Quote calldata q, bytes calldata signature) private returns (uint256 id) {
        if (msg.sender != q.buyer) revert NotBuyer();
        if (block.timestamp > q.expiry) revert QuoteExpired();
        if (block.timestamp >= q.openTs) revert AlreadyOpen();
        if (!feedAllowed[q.feed]) revert FeedNotAllowed();
        if (nonceUsed[q.nonce]) revert NonceUsed();
        if (q.shares == 0 || q.upper <= q.lower) revert BadProtection();
        if (ECDSA.recover(hashQuote(q), signature) != quoter) revert BadSignature();
        // One opening per round. The first sale after a roll fixes it; the quoter's signature vouches
        // that it's a real opening, which the contract can't know (holidays).
        if (roundOpenTs == 0) roundOpenTs = q.openTs;
        else if (q.openTs != roundOpenTs) revert WrongRound();

        uint128 maxPayout = uint128(_payoutUnits(q.shares, q.upper - q.lower));
        // A premium above the most it can pay makes no sense, and would let a voided series refund
        // more than the position ever locked.
        if (maxPayout == 0 || q.premium > maxPayout) revert BadProtection();

        bytes32 key = seriesKey(q.feed, q.openTs);
        Series storage s = _series[key];
        if (s.highestUpper == 0) _roundSeries.push(key);
        if (s.highestUpper == 0 || q.lower < s.lowestLower) s.lowestLower = q.lower;
        if (q.upper > s.highestUpper) s.highestUpper = q.upper;
        s.locked += maxPayout;
        locked += maxPayout;
        // Measured against the pool at the roll, so the limits can't move within a round.
        if (locked > roundNav * _params.maxUtilizationBps / BPS) revert OverCapacity();
        if (s.locked > roundNav * _params.maxFeedBps / BPS) revert OverStockLimit();

        uint128 tip = uint128(uint256(q.premium) * _params.keeperTipBps / BPS);
        tipsOwed += tip;
        nonceUsed[q.nonce] = true;
        id = nextPositionId++;
        _positions[id] = Position({
            buyer: q.buyer,
            feed: q.feed,
            openTs: q.openTs,
            shares: q.shares,
            upper: q.upper,
            lower: q.lower,
            premium: q.premium,
            maxPayout: maxPayout,
            tip: tip,
            paid: 0,
            closed: false
        });
        _seriesPositions[key].push(id);

        collateral.safeTransferFrom(msg.sender, address(this), q.premium);
        positionToken.mint(q.buyer, id);
        emit ProtectionBought(id, q.buyer, q.feed, q.openTs, q.shares, q.upper, q.lower, q.premium, maxPayout);
    }

    /// @dev Pay a position out to its holder and release what it locked; returns the keeper's tip.
    function _close(uint256 id, Series storage s) private returns (uint256 tip) {
        Position storage p = _positions[id];
        p.closed = true;
        locked -= p.maxPayout;
        s.locked -= p.maxPayout;
        tipsOwed -= p.tip;
        bool refund = s.state == SeriesState.Voided;
        // A voided position gets its whole premium back, the tip included.
        uint256 amount = refund ? p.premium : payoutAt(p.shares, p.upper, p.lower, s.price);
        tip = refund ? 0 : p.tip;
        p.paid = uint128(amount);
        address holder = positionToken.ownerOf(id);
        if (amount > 0) collateral.safeTransfer(holder, amount);
        emit Claimed(id, holder, amount, refund);
    }

    function _requestDeposit(uint256 assets, address controller, address owner) private returns (uint256) {
        if (assets == 0) revert ZeroAmount();
        _fill(controller);
        collateral.safeTransferFrom(owner, address(this), assets);
        Request storage r = _depositRequests[controller];
        r.round = round;
        r.amount += uint192(assets);
        pendingDepositAssets += assets;
        emit DepositRequest(controller, owner, 0, msg.sender, assets);
        return 0;
    }

    function _payRedemption(Claim storage c, uint256 assets, uint256 shares, address receiver, address controller)
        private
    {
        c.assets -= uint128(assets);
        c.shares -= uint128(shares);
        reservedAssets -= assets;
        collateral.safeTransfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, controller, assets, shares);
    }

    /// @dev The caller must be the controller or its operator; its filled requests become claimable.
    function _claimFor(address controller, bool isDeposit) private returns (Claim storage) {
        if (controller != msg.sender && !isOperator[controller][msg.sender]) revert Unauthorized();
        _fill(controller);
        return isDeposit ? _depositClaims[controller] : _redeemClaims[controller];
    }

    /// @dev Move a controller's requests from rounds already rolled into its claimable balances, at the
    /// rate of the roll that filled them.
    function _fill(address controller) private {
        Request memory d = _depositRequests[controller];
        if (d.amount > 0 && d.round < round) {
            _depositClaims[controller] = _claimAfterFill(controller, true);
            delete _depositRequests[controller];
        }
        Request memory w = _redeemRequests[controller];
        if (w.amount > 0 && w.round < round) {
            _redeemClaims[controller] = _claimAfterFill(controller, false);
            delete _redeemRequests[controller];
        }
    }

    /// @dev A controller's claimable deposit or redemption, counting requests a roll has filled.
    function _claimAfterFill(address controller, bool isDeposit) private view returns (Claim memory c) {
        Request memory r = isDeposit ? _depositRequests[controller] : _redeemRequests[controller];
        c = isDeposit ? _depositClaims[controller] : _redeemClaims[controller];
        if (r.amount == 0 || r.round >= round) return c;
        Rate memory rate = _rates[r.round];
        if (isDeposit) {
            c.assets += uint128(r.amount);
            c.shares += uint128(Math.mulDiv(r.amount, rate.shares, rate.assets));
        } else {
            c.shares += uint128(r.amount);
            c.assets += uint128(Math.mulDiv(r.amount, rate.assets, rate.shares));
        }
    }

    function _permit(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) private {
        // If someone submits the permit first, the allowance is already there: don't fail on it.
        try IERC20Permit(address(collateral)).permit(msg.sender, address(this), value, deadline, v, r, s) {} catch {}
    }

    function _setQuoter(address quoter_) private {
        if (quoter_ == address(0)) revert BadParams();
        quoter = quoter_;
        emit QuoterSet(quoter_);
    }

    function _checkParams(Params memory p) private pure {
        // A window under an hour could void a series before a keeper gets to it; over a week locks
        // the pool for no reason. One stock can't have more room than the whole round, and tips
        // stay below a tenth of the premium.
        if (p.maxRoundAge == 0 || p.settleWindow < 1 hours || p.settleWindow > 7 days) revert BadParams();
        if (p.maxUtilizationBps == 0 || p.maxUtilizationBps > BPS) revert BadParams();
        if (p.maxFeedBps == 0 || p.maxFeedBps > p.maxUtilizationBps || p.keeperTipBps > 1_000) revert BadParams();
    }

    function _left(uint256 cap, uint256 used) private pure returns (uint256) {
        return cap > used ? cap - used : 0;
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
