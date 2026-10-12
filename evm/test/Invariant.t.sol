// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";

import {AfterbellPositions} from "../src/AfterbellPositions.sol";
import {AfterbellVault} from "../src/AfterbellVault.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {MockFeed} from "./mocks/MockFeed.sol";

/// Drives the vault through random rounds: buys on two stocks within the risk limits, settlements at
/// any price the vault accepts, voids, claims, batched payouts, rolls, deposits, redemptions, partial
/// claims and NFT transfers. Every call is one the vault should accept, so a revert is a failure.
contract Handler is Test {
    uint256 constant QUOTER_KEY = 0xA11CE;

    AfterbellVault public vault;
    TestUSD public usd;
    AfterbellPositions public nft;
    MockFeed[2] public feeds;
    address[4] public actors;
    uint64 public openTs;
    uint256 nonce;

    /// What positions have been paid, in total, and what every position could have paid at most.
    uint256 public ghostPaid;
    uint256 public ghostRolls;
    /// How often each path ran, to check the runs reach the interesting states.
    uint256 public buys;
    uint256 public settled;
    uint256 public voided;
    uint256 public rolledAfterSales;

    constructor(
        AfterbellVault vault_,
        TestUSD usd_,
        MockFeed[2] memory feeds_,
        address[4] memory actors_,
        uint64 open
    ) {
        vault = vault_;
        usd = usd_;
        nft = vault_.positionToken();
        feeds = feeds_;
        actors = actors_;
        openTs = open;
    }

    // ----------------------------------------------------------------- buying

    function buy(uint256 who, uint256 which, uint64 shares, uint64 upper, uint64 spread, uint16 premiumBps) external {
        if (block.timestamp >= openTs || (vault.roundOpenTs() != 0 && vault.roundOpenTs() != openTs)) return;
        MockFeed feed = feeds[which % 2];
        upper = uint64(bound(upper, 50e8, 500e8));
        spread = uint64(bound(spread, 1e8, upper / 2));
        shares = uint64(bound(shares, 0.1e6, 100e6));
        uint256 maxPayout = vault.payoutAt(shares, upper, upper - spread, 0);
        // Sized down to the room left, so the pool runs up against its limits.
        uint256 room = vault.capacity(address(feed));
        if (maxPayout > room) {
            shares = uint64(uint256(shares) * room / maxPayout);
            maxPayout = vault.payoutAt(shares, upper, upper - spread, 0);
        }
        if (shares == 0 || maxPayout == 0) return;

        address buyer = actors[who % 4];
        AfterbellVault.Quote memory q = AfterbellVault.Quote({
            buyer: buyer,
            feed: address(feed),
            openTs: openTs,
            shares: shares,
            upper: upper,
            lower: upper - spread,
            premium: uint128(maxPayout * bound(premiumBps, 0, 10_000) / 10_000),
            expiry: uint64(block.timestamp + 60),
            nonce: ++nonce
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(QUOTER_KEY, vault.hashQuote(q));
        _mint(buyer, q.premium);
        vm.startPrank(buyer);
        usd.approve(address(vault), q.premium);
        vault.buy(q, abi.encodePacked(r, s, v));
        vm.stopPrank();
        buys++;
    }

    // --------------------------------------------------------- the round's end

    /// After the bell, settle each stock sold at a random price the vault accepts, or void it.
    function settleOrVoid(uint256 priceSeed, bool voidIt) external {
        if (vault.roundOpenTs() != openTs) return;
        if (block.timestamp <= openTs) vm.warp(openTs + 1 hours);
        for (uint256 i; i < 2; ++i) {
            AfterbellVault.Series memory s = vault.series(vault.seriesKey(address(feeds[i]), openTs));
            if (s.highestUpper == 0 || s.state != AfterbellVault.SeriesState.Open) continue;
            if (voidIt) {
                if (block.timestamp <= openTs + vault.settleWindow()) vm.warp(openTs + vault.settleWindow() + 1);
                vault.voidSeries(address(feeds[i]), openTs);
                voided++;
            } else {
                uint256 lo = uint256(s.lowestLower) / 10 + 1;
                uint256 price = bound(uint256(keccak256(abi.encode(priceSeed, i))), lo, uint256(s.highestUpper) * 10);
                feeds[i].push(int256(price), openTs - 10 minutes);
                vault.settle(address(feeds[i]), openTs, feeds[i].latestRound());
                settled++;
            }
        }
    }

    function claim(uint256 idSeed, uint256 who) external {
        uint256 n = vault.nextPositionId();
        if (n == 0) return;
        uint256 id = idSeed % n;
        AfterbellVault.Position memory p = vault.position(id);
        AfterbellVault.Series memory s = vault.series(vault.seriesKey(p.feed, p.openTs));
        if (p.closed || s.state == AfterbellVault.SeriesState.Open) return;
        vm.prank(actors[who % 4]);
        ghostPaid += vault.claim(id);
    }

    /// Pay out everything the round sold, in batches, then roll into the next round.
    function processAndRoll(uint256 batch) external {
        if (vault.roundOpenTs() == openTs) {
            bytes32[] memory keys = vault.roundSeries();
            for (uint256 i; i < 2; ++i) {
                AfterbellVault.Series memory s = vault.series(vault.seriesKey(address(feeds[i]), openTs));
                if (s.highestUpper != 0 && s.state == AfterbellVault.SeriesState.Open) return;
            }
            uint256 before = _held();
            for (uint256 i; i < keys.length; ++i) {
                address feed = address(feeds[0]);
                if (keys[i] != vault.seriesKey(feed, openTs)) feed = address(feeds[1]);
                while (vault.series(keys[i]).processed < vault.seriesPositions(feed, openTs).length) {
                    vault.process(feed, openTs, bound(batch, 1, 5));
                }
            }
            ghostPaid += _held() - before;
            rolledAfterSales++;
        }
        vault.roll();
        ghostRolls++;
        // Once the bell has rung, the next round sells the next opening.
        if (block.timestamp >= openTs) {
            openTs = uint64(block.timestamp > openTs ? block.timestamp : openTs) + 1 days;
            vm.warp(openTs - 12 hours);
        }
    }

    // ----------------------------------------------------------------- the pool

    function requestDeposit(uint256 who, uint256 amount) external {
        address lp = actors[who % 4];
        amount = bound(amount, 1e6, 50_000e6);
        _mint(lp, amount);
        vm.startPrank(lp);
        usd.approve(address(vault), amount);
        vault.requestDeposit(amount, lp, lp);
        vm.stopPrank();
    }

    function requestRedeem(uint256 who, uint256 shares) external {
        address lp = actors[who % 4];
        uint256 balance = vault.balanceOf(lp);
        if (balance == 0) return;
        vm.prank(lp);
        vault.requestRedeem(bound(shares, 1, balance), lp, lp);
    }

    function claimDeposit(uint256 who, bool part) external {
        address lp = actors[who % 4];
        uint256 max = vault.maxDeposit(lp);
        if (max == 0) return;
        vm.prank(lp);
        vault.deposit(part && max > 1 ? max / 2 : max, lp, lp);
    }

    function claimRedeem(uint256 who, bool part) external {
        address lp = actors[who % 4];
        uint256 max = vault.maxRedeem(lp);
        if (max == 0) return;
        vm.prank(lp);
        vault.redeem(part && max > 1 ? max / 2 : max, lp, lp);
    }

    function transferPosition(uint256 idSeed, uint256 to) external {
        uint256 n = vault.nextPositionId();
        if (n == 0) return;
        uint256 id = idSeed % n;
        address holder = nft.ownerOf(id);
        vm.prank(holder);
        nft.transferFrom(holder, actors[to % 4], id);
    }

    /// TestUSD mints at most MINT_LIMIT a call.
    function _mint(address to, uint256 amount) private {
        for (uint256 left = amount; left > 0;) {
            uint256 part = left > usd.MINT_LIMIT() ? usd.MINT_LIMIT() : left;
            usd.mint(to, part);
            left -= part;
        }
    }

    function _held() private view returns (uint256 total) {
        for (uint256 i; i < 4; ++i) {
            total += usd.balanceOf(actors[i]);
        }
    }
}

contract InvariantTest is Test {
    AfterbellVault vault;
    TestUSD usd;
    Handler handler;
    address[4] actors = [makeAddr("a"), makeAddr("b"), makeAddr("c"), makeAddr("d")];

    function setUp() public {
        vm.warp(1_790_000_000);
        usd = new TestUSD();
        MockFeed[2] memory feeds = [new MockFeed(8), new MockFeed(8)];
        vault = new AfterbellVault(usd, address(this), vm.addr(0xA11CE), 3 days, 1 days);
        vault.allowFeed(address(feeds[0]), "TSLA");
        vault.allowFeed(address(feeds[1]), "NVDA");
        handler = new Handler(vault, usd, feeds, actors, uint64(block.timestamp + 1 days));
        // Underwrite the pool to begin with.
        handler.requestDeposit(0, 50_000e6);
        handler.processAndRoll(1);
        handler.claimDeposit(0, false);
        targetContract(address(handler));
        bytes4[] memory actions = new bytes4[](9);
        actions[0] = Handler.buy.selector;
        actions[1] = Handler.settleOrVoid.selector;
        actions[2] = Handler.claim.selector;
        actions[3] = Handler.processAndRoll.selector;
        actions[4] = Handler.requestDeposit.selector;
        actions[5] = Handler.requestRedeem.selector;
        actions[6] = Handler.claimDeposit.selector;
        actions[7] = Handler.claimRedeem.selector;
        actions[8] = Handler.transferPosition.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: actions}));
    }

    /// The vault always holds what it owes: queued deposits, redemptions filled, tips, and the most
    /// every open position could pay.
    function invariant_holdsEverythingItOwes() public view {
        uint256 owed = vault.pendingDepositAssets() + vault.reservedAssets() + vault.tipsOwed() + vault.locked();
        assertGe(usd.balanceOf(address(vault)), owed);
        vault.totalAssets(); // doesn't underflow
    }

    /// `locked` and `tipsOwed` are exactly the maxima and tips of the positions not yet paid out, and
    /// no position was ever paid more than it could pay, or other than its premium when voided.
    function invariant_everyPositionAccountedFor() public view {
        uint256 lockedSum;
        uint256 tipSum;
        for (uint256 id; id < vault.nextPositionId(); ++id) {
            AfterbellVault.Position memory p = vault.position(id);
            if (!p.closed) {
                lockedSum += p.maxPayout;
                tipSum += p.tip;
                continue;
            }
            AfterbellVault.Series memory s = vault.series(vault.seriesKey(p.feed, p.openTs));
            if (s.state == AfterbellVault.SeriesState.Voided) assertEq(p.paid, p.premium);
            else assertEq(p.paid, vault.payoutAt(p.shares, p.upper, p.lower, s.price));
            assertLe(p.paid, p.maxPayout);
        }
        assertEq(vault.locked(), lockedSum);
        assertEq(vault.tipsOwed(), tipSum);
    }

    /// The shares and money set aside for underwriters' claims are there to claim.
    function invariant_claimsAreBacked() public view {
        uint256 shares = vault.pendingRedeemShares();
        uint256 assets;
        for (uint256 i; i < 4; ++i) {
            shares += vault.maxMint(actors[i]);
            assets += vault.maxWithdraw(actors[i]);
        }
        assertGe(vault.balanceOf(address(vault)), shares);
        assertGe(vault.reservedAssets(), assets);
    }

    function afterInvariant() public view {
        console.log("buys %d, settled %d, voided %d", handler.buys(), handler.settled(), handler.voided());
        console.log(
            "rolls %d, after sales %d, paid out %d",
            handler.ghostRolls(),
            handler.rolledAfterSales(),
            handler.ghostPaid()
        );
    }

    /// A round never locks more than its limit of the pool it started with.
    function invariant_withinTheRisklimit() public view {
        assertLe(vault.locked(), vault.roundNav() * vault.params().maxUtilizationBps / 10_000);
    }
}
