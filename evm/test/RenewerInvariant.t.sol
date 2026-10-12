// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";

import {AfterbellPositions} from "../src/AfterbellPositions.sol";
import {AfterbellRenewer} from "../src/AfterbellRenewer.sol";
import {AfterbellVault} from "../src/AfterbellVault.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {MockFeed} from "./mocks/MockFeed.sol";

/// Drives standing orders through random nights: holders set, replace and cancel orders; anyone
/// renews with quotes that are sometimes within the order and sometimes not (too dear, too big, strikes
/// off the order's levels, a second time for the same opening); nights settle and the pool rolls. A
/// renewal the order doesn't allow must revert; one it allows is checked against the order as it
/// stood, and the ghosts record anything the renewer let through that it shouldn't have.
contract RenewerHandler is Test {
    uint256 constant QUOTER_KEY = 0xA11CE;

    AfterbellVault public vault;
    AfterbellRenewer public renewer;
    TestUSD public usd;
    AfterbellPositions public nft;
    MockFeed public feed;
    address[3] public holders;
    uint64 public openTs;
    uint256 nonce;

    /// Renewals that broke the order they ran under. Every invariant below wants these at zero.
    uint256 public overPremium;
    uint256 public overShares;
    uint256 public twiceForOneOpening;
    uint256 public afterItEnded;
    uint256 public wrongCharge;
    /// Every position a renewal bought, and whom for.
    uint256[] public ids;
    mapping(uint256 id => address holder) public boughtFor;
    mapping(address holder => mapping(uint64 openTs => bool)) public renewedFor;
    /// How often each path ran, to check the runs reach the interesting states.
    uint256 public renewals;
    uint256 public refused;
    uint256 public nights;

    constructor(
        AfterbellVault vault_,
        AfterbellRenewer renewer_,
        TestUSD usd_,
        MockFeed feed_,
        address[3] memory holders_,
        uint64 open
    ) {
        vault = vault_;
        renewer = renewer_;
        usd = usd_;
        nft = vault_.positionToken();
        feed = feed_;
        holders = holders_;
        openTs = open;
    }

    function setOrder(uint256 who, uint64 maxShares, uint16 startBps, uint16 depthBps, uint128 maxPremium, uint8 days_)
        external
    {
        startBps = uint16(bound(startBps, 50, 1_000));
        depthBps = uint16(bound(depthBps, startBps + 50, 3_000));
        vm.prank(holders[who % 3]);
        renewer.setOrder(
            address(feed),
            uint64(bound(maxShares, 0.1e6, 20e6)),
            startBps,
            depthBps,
            uint128(bound(maxPremium, 1e6, 60e6)),
            uint64(block.timestamp + bound(days_, 1, 30) * 1 days)
        );
    }

    function cancel(uint256 who) external {
        address holder = holders[who % 3];
        if (renewer.order(holder, address(feed)).maxShares == 0) return;
        vm.prank(holder);
        renewer.cancel(address(feed));
    }

    /// A renewal for `who`, near their order's levels or off them, at any size and price, from anyone.
    function renew(uint256 who, uint64 shares, uint128 premium, int16 offBps, uint256 caller, bool withinOrder)
        external
    {
        if (block.timestamp >= openTs || (vault.roundOpenTs() != 0 && vault.roundOpenTs() != openTs)) return;
        address holder = holders[who % 3];
        AfterbellRenewer.Order memory o = renewer.order(holder, address(feed));
        (, int256 answer,,,) = feed.latestRoundData();
        uint256 price = uint256(answer);
        // Half the time a quote the order allows, as the keeper sends; otherwise anything, up to 8% of
        // the price off the order's levels, so both paths run.
        int256 off = int256(price) * (withinOrder ? bound(offBps, -300, 300) : bound(offBps, -800, 800)) / 10_000;
        if (withinOrder && o.maxShares != 0) {
            shares = uint64(bound(shares, 0.1e6, o.maxShares));
            premium = uint128(bound(premium, 0.1e6, o.maxPremium));
        }
        uint16 start = o.maxShares == 0 ? 200 : o.startBps;
        uint16 depth = o.maxShares == 0 ? 1_000 : o.depthBps;
        uint256 upper = uint256(int256(price * (10_000 - start) / 10_000) + off);
        uint256 lower = uint256(int256(price * (10_000 - depth) / 10_000) + off);

        AfterbellVault.Quote memory q = AfterbellVault.Quote({
            buyer: address(renewer),
            feed: address(feed),
            openTs: openTs,
            shares: withinOrder ? shares : uint64(bound(shares, 0.1e6, 25e6)),
            upper: uint64(upper),
            lower: uint64(lower),
            premium: withinOrder ? premium : uint128(bound(premium, 0.1e6, 80e6)),
            expiry: uint64(block.timestamp + 60),
            nonce: ++nonce
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(QUOTER_KEY, vault.hashQuote(q));
        uint256 before = usd.balanceOf(holder);

        vm.prank(address(uint160(bound(caller, 1, type(uint160).max))));
        try renewer.renew(holder, q, abi.encodePacked(r, s, v)) returns (uint256 id) {
            renewals++;
            if (q.premium > o.maxPremium) overPremium++;
            if (q.shares > o.maxShares) overShares++;
            if (q.openTs <= o.lastOpenTs || renewedFor[holder][q.openTs]) twiceForOneOpening++;
            if (q.openTs > o.until) afterItEnded++;
            if (before - usd.balanceOf(holder) != q.premium) wrongCharge++;
            renewedFor[holder][q.openTs] = true;
            ids.push(id);
            boughtFor[id] = holder;
        } catch {
            refused++;
        }
    }

    /// The bell: settle at a price the vault accepts, pay everything out, roll, and sell the next night.
    function nextNight(uint256 priceSeed) external {
        if (vault.roundOpenTs() == openTs) {
            if (block.timestamp <= openTs) vm.warp(openTs + 1 hours);
            AfterbellVault.Series memory s = vault.series(vault.seriesKey(address(feed), openTs));
            if (s.highestUpper != 0 && s.state == AfterbellVault.SeriesState.Open) {
                uint256 price = bound(priceSeed, uint256(s.lowestLower) / 10 + 1, uint256(s.highestUpper) * 10);
                feed.push(int256(price), openTs - 10 minutes);
                vault.settle(address(feed), openTs, feed.latestRound());
                vault.process(address(feed), openTs, 1_000);
            }
        }
        vault.roll();
        if (block.timestamp >= openTs) {
            openTs = uint64(block.timestamp) + 1 days;
            vm.warp(openTs - 12 hours);
            // A fresh price for the next night's orders, within a few percent of the last.
            (, int256 last,,,) = feed.latestRoundData();
            feed.push(last * int256(bound(priceSeed, 9_500, 10_500)) / 10_000, block.timestamp);
            nights++;
        }
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }
}

contract RenewerInvariantTest is Test {
    RenewerHandler handler;
    AfterbellVault vault;
    AfterbellRenewer renewer;
    TestUSD usd;
    address[3] holders = [makeAddr("ada"), makeAddr("ben"), makeAddr("cy")];

    function setUp() public {
        vm.warp(1_790_000_000);
        usd = new TestUSD();
        MockFeed feed = new MockFeed(8);
        feed.push(360e8, block.timestamp - 1 hours);
        vault = new AfterbellVault(usd, address(this), vm.addr(0xA11CE), 3 days, 1 days);
        vault.allowFeed(address(feed), "TSLA");
        renewer = new AfterbellRenewer(vault);

        // Underwrite the pool, and give each holder money and an open allowance, as the app's checkout does.
        _mint(address(this), 100_000e6);
        usd.approve(address(vault), type(uint256).max);
        vault.requestDeposit(100_000e6, address(this), address(this));
        vault.roll();
        vault.deposit(100_000e6, address(this));
        for (uint256 i; i < 3; ++i) {
            _mint(holders[i], 5_000e6);
            vm.prank(holders[i]);
            usd.approve(address(renewer), type(uint256).max);
        }

        handler = new RenewerHandler(vault, renewer, usd, feed, holders, uint64(block.timestamp + 1 days));
        targetContract(address(handler));
        bytes4[] memory actions = new bytes4[](4);
        actions[0] = RenewerHandler.setOrder.selector;
        actions[1] = RenewerHandler.cancel.selector;
        actions[2] = RenewerHandler.renew.selector;
        actions[3] = RenewerHandler.nextNight.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: actions}));
    }

    function _mint(address to, uint256 amount) private {
        for (; amount > 0;) {
            uint256 part = amount > usd.MINT_LIMIT() ? usd.MINT_LIMIT() : amount;
            usd.mint(to, part);
            amount -= part;
        }
    }

    /// A renewal never costs the holder more than the order's cap, or buys more shares than it allows.
    function invariant_withinTheOrdersLimits() public view {
        assertEq(handler.overPremium(), 0, "paid more than the order's cap");
        assertEq(handler.overShares(), 0, "bought more shares than the order allows");
        assertEq(handler.wrongCharge(), 0, "charged the holder something other than the premium");
    }

    /// Never twice for one opening, even across a cancel and a new order; never past the order's end.
    function invariant_oncePerOpeningWhileTheOrderStands() public view {
        assertEq(handler.twiceForOneOpening(), 0, "renewed twice for one opening");
        assertEq(handler.afterItEnded(), 0, "renewed after the order ended");
    }

    /// Every position bought lands with its holder, and the renewer keeps neither NFTs nor money.
    function invariant_everyPositionWithItsHolder() public view {
        AfterbellPositions nft = vault.positionToken();
        for (uint256 i; i < handler.idCount(); ++i) {
            uint256 id = handler.ids(i);
            // A position paid out is burned; one still held belongs to the holder it was bought for.
            if (vault.position(id).closed) continue;
            assertEq(nft.ownerOf(id), handler.boughtFor(id), "a position isn't with its holder");
        }
        assertEq(nft.balanceOf(address(renewer)), 0, "the renewer holds a position");
        assertEq(usd.balanceOf(address(renewer)), 0, "the renewer holds money");
    }

    function afterInvariant() public view {
        console.log("renewals %d, refused %d, nights %d", handler.renewals(), handler.refused(), handler.nights());
    }
}
