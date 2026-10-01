// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {AfterbellPositions} from "./AfterbellPositions.sol";
import {AfterbellVault, AggregatorV3Interface} from "./AfterbellVault.sol";

/// @title Afterbell renewer
/// @notice "Protect every night": a holder's standing order, renewed for each opening by anyone (in
/// practice a keeper) with a quote the quoter signed for this contract. The holder sets the limits once:
/// how many shares at most, where protection starts and stops below the price, the most they'll pay a
/// night, and until when. Each renewal takes the premium from the holder, buys through the vault, and
/// hands the position's NFT straight to the holder, so the payout reaches them as for any purchase.
///
/// It sits beside the vault and changes nothing in it: the vault sells to `msg.sender == q.buyer`, so
/// quotes for renewals name this contract as the buyer. The holder's limits, not the caller, protect the
/// holder: whoever renews can only buy what the order allows, once per opening, at a price the quoter
/// signed. The strikes must sit near the order's levels below the feed's latest price, so a renewal
/// can't swap in protection the holder didn't ask for.
contract AfterbellRenewer is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice A standing order. Shares carry 6 decimals, the premium the collateral's.
    struct Order {
        uint64 maxShares;
        /// Where protection starts and stops, below the price, in basis points (200 and 1,000 for 2% to 10%).
        uint16 startBps;
        uint16 depthBps;
        uint128 maxPremium;
        /// Renews for openings up to and including this time.
        uint64 until;
        /// The last opening it bought for: one renewal per opening.
        uint64 lastOpenTs;
    }

    uint256 private constant BPS = 10_000;
    /// @notice How far a renewal's strikes may sit from the order's levels at the feed's latest price, as a
    /// share of that price. The quoter prices from the lower of the close and the live price, which can sit
    /// a few percent below the feed overnight, so this is loose enough for that and tight enough to keep
    /// the protection the one the holder asked for.
    uint256 public constant STRIKE_TOLERANCE_BPS = 500;
    /// @notice How old the feed's latest price may be: Chainlink's equity feeds pause for weekends and holidays.
    uint256 public constant MAX_PRICE_AGE = 4 days;

    AfterbellVault public immutable vault;
    IERC20 public immutable collateral;
    AfterbellPositions public immutable positions;

    mapping(address holder => mapping(address feed => Order)) private _orders;
    /// @dev Every (holder, feed) that has ever had an order, for keepers to walk.
    OrderKey[] private _keys;
    mapping(address holder => mapping(address feed => bool)) private _listed;

    struct OrderKey {
        address holder;
        address feed;
    }

    event OrderSet(address indexed holder, address indexed feed, Order order);
    event OrderCancelled(address indexed holder, address indexed feed);
    event Renewed(address indexed holder, address indexed feed, uint64 indexed openTs, uint256 positionId, uint128 premium);

    error FeedNotAllowed();
    error BadOrder();
    error NoOrder();
    error OrderEnded();
    error AlreadyRenewed();
    error NotForThisContract();
    error OverShares();
    error OverPremium();
    error StrikesOffOrder();
    error StalePrice();

    constructor(AfterbellVault vault_) {
        vault = vault_;
        collateral = vault_.collateral();
        positions = vault_.positionToken();
    }

    // ------------------------------------------------------------------ holders

    /// @notice Sets (or replaces) the caller's standing order on `feed`. The caller also approves this
    /// contract for the premiums (or uses setOrderWithPermit). Replacing an order keeps its last renewal,
    /// so it can't renew twice for one opening.
    function setOrder(address feed, uint64 maxShares, uint16 startBps, uint16 depthBps, uint128 maxPremium, uint64 until) public {
        if (!vault.feedAllowed(feed)) revert FeedNotAllowed();
        if (maxShares == 0 || maxPremium == 0 || startBps == 0 || depthBps <= startBps || depthBps >= BPS || until <= block.timestamp) {
            revert BadOrder();
        }
        Order storage o = _orders[msg.sender][feed];
        (o.maxShares, o.startBps, o.depthBps, o.maxPremium, o.until) = (maxShares, startBps, depthBps, maxPremium, until);
        if (!_listed[msg.sender][feed]) {
            _listed[msg.sender][feed] = true;
            _keys.push(OrderKey(msg.sender, feed));
        }
        emit OrderSet(msg.sender, feed, o);
    }

    /// @notice setOrder, with an EIP-2612 permit for the premiums in the same transaction.
    function setOrderWithPermit(
        address feed,
        uint64 maxShares,
        uint16 startBps,
        uint16 depthBps,
        uint128 maxPremium,
        uint64 until,
        uint256 allowance,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // A permit already used (someone submitted it first) leaves the allowance in place; the order still stands.
        try IERC20Permit(address(collateral)).permit(msg.sender, address(this), allowance, deadline, v, r, s) {} catch {}
        setOrder(feed, maxShares, startBps, depthBps, maxPremium, until);
    }

    /// @notice Ends the caller's order on `feed`. Protection already bought stays the holder's.
    function cancel(address feed) external {
        if (_orders[msg.sender][feed].maxShares == 0) revert NoOrder();
        // Keep the last renewal, so a new order can't renew twice for one opening.
        uint64 lastOpenTs = _orders[msg.sender][feed].lastOpenTs;
        delete _orders[msg.sender][feed];
        _orders[msg.sender][feed].lastOpenTs = lastOpenTs;
        emit OrderCancelled(msg.sender, feed);
    }

    // ------------------------------------------------------------------ keepers

    /// @notice Buys tonight's protection for `holder`'s order, with a quote the quoter signed for this
    /// contract. Anyone may call it; the order's limits decide what can be bought.
    function renew(address holder, AfterbellVault.Quote calldata q, bytes calldata signature) external nonReentrant returns (uint256 id) {
        Order storage o = _orders[holder][q.feed];
        if (o.maxShares == 0) revert NoOrder();
        if (q.openTs > o.until) revert OrderEnded();
        if (q.openTs <= o.lastOpenTs) revert AlreadyRenewed();
        if (q.buyer != address(this)) revert NotForThisContract();
        if (q.shares > o.maxShares) revert OverShares();
        if (q.premium > o.maxPremium) revert OverPremium();
        _checkStrikes(q, o);

        o.lastOpenTs = q.openTs;
        collateral.safeTransferFrom(holder, address(this), q.premium);
        collateral.forceApprove(address(vault), q.premium);
        id = vault.buy(q, signature);
        positions.transferFrom(address(this), holder, id);
        emit Renewed(holder, q.feed, q.openTs, id, q.premium);
    }

    /// @dev The strikes sit within STRIKE_TOLERANCE_BPS of the order's levels at the feed's latest price.
    function _checkStrikes(AfterbellVault.Quote calldata q, Order storage o) private view {
        (, int256 answer,, uint256 updatedAt,) = AggregatorV3Interface(q.feed).latestRoundData();
        if (answer <= 0 || block.timestamp > updatedAt + MAX_PRICE_AGE) revert StalePrice();
        uint256 price = uint256(answer);
        uint256 tolerance = price * STRIKE_TOLERANCE_BPS / BPS;
        if (_gap(q.upper, price * (BPS - o.startBps) / BPS) > tolerance || _gap(q.lower, price * (BPS - o.depthBps) / BPS) > tolerance) {
            revert StrikesOffOrder();
        }
    }

    function _gap(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    // ------------------------------------------------------------------ views

    function order(address holder, address feed) external view returns (Order memory) {
        return _orders[holder][feed];
    }

    function orderCount() external view returns (uint256) {
        return _keys.length;
    }

    /// @notice The (holder, feed) of every order ever set, from `start`, at most `count` of them: some may
    /// since have been cancelled or ended.
    function orderKeys(uint256 start, uint256 count) external view returns (OrderKey[] memory page) {
        uint256 end = start + count > _keys.length ? _keys.length : start + count;
        page = new OrderKey[](end > start ? end - start : 0);
        for (uint256 i = start; i < end; i++) {
            page[i - start] = _keys[i];
        }
    }
}
