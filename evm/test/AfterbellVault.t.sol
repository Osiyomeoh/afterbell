// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {AfterbellVault} from "../src/AfterbellVault.sol";
import {VaultTest} from "./Base.sol";
import {MockFeed} from "./mocks/MockFeed.sol";

/// Selling, settling and paying out protection.
contract AfterbellVaultTest is VaultTest {
    // ----------------------------------------------------------------- buying

    function test_buy_takesThePremiumLocksTheMaxAndMintsTheNFT() public {
        uint256 id = _buy(_quote());
        AfterbellVault.Position memory p = vault.position(id);
        assertEq(p.buyer, buyer);
        assertEq(p.shares, 10e6);
        assertEq(p.premium, 20e6);
        assertEq(p.maxPayout, 200e6, "10 shares x $20 spread");
        assertEq(p.tip, 0.4e6, "2% of the premium");
        assertFalse(p.closed);
        assertEq(nft.ownerOf(id), buyer);
        assertEq(vault.locked(), 200e6);
        assertEq(vault.tipsOwed(), 0.4e6);
        assertEq(usd.balanceOf(buyer), 980e6);
        assertEq(vault.roundOpenTs(), OPEN, "the first sale fixes the round's opening");
        // The pool counts the premium less the tip, net of the most it could pay.
        assertEq(vault.totalAssets(), POOL + 19.6e6 - 200e6);
    }

    function test_buy_rejectsSomeoneElseUsingTheQuote() public {
        AfterbellVault.Quote memory q = _quote();
        bytes memory sig = _sign(q, QUOTER_KEY);
        vm.prank(makeAddr("thief"));
        vm.expectRevert(AfterbellVault.NotBuyer.selector);
        vault.buy(q, sig);
    }

    function test_buy_rejectsExpiredQuote() public {
        AfterbellVault.Quote memory q = _quote();
        bytes memory sig = _sign(q, QUOTER_KEY);
        vm.warp(q.expiry + 1);
        vm.prank(buyer);
        vm.expectRevert(AfterbellVault.QuoteExpired.selector);
        vault.buy(q, sig);
    }

    function test_buy_rejectsProtectionForAnOpenThatHasPassed() public {
        AfterbellVault.Quote memory q = _quote();
        q.openTs = T0;
        _expectBuyRevert(q, AfterbellVault.AlreadyOpen.selector);
    }

    function test_buy_rejectsFeedNotAllowed() public {
        AfterbellVault.Quote memory q = _quote();
        q.feed = address(new MockFeed(8));
        _expectBuyRevert(q, AfterbellVault.FeedNotAllowed.selector);
    }

    function test_buy_rejectsReusedNonce() public {
        AfterbellVault.Quote memory q = _quote();
        _buy(q);
        _expectBuyRevert(q, AfterbellVault.NonceUsed.selector);
    }

    function test_buy_rejectsMalformedProtection() public {
        AfterbellVault.Quote memory q = _quote();
        q.upper = q.lower;
        _expectBuyRevert(q, AfterbellVault.BadProtection.selector);

        q = _quote();
        q.shares = 0;
        _expectBuyRevert(q, AfterbellVault.BadProtection.selector);

        q = _quote();
        q.premium = 200e6 + 1; // above the most it can pay
        _expectBuyRevert(q, AfterbellVault.BadProtection.selector);
    }

    function test_buy_rejectsWrongSigner() public {
        AfterbellVault.Quote memory q = _quote();
        bytes memory sig = _sign(q, 0xB0B);
        vm.prank(buyer);
        vm.expectRevert(AfterbellVault.BadSignature.selector);
        vault.buy(q, sig);
    }

    function test_buy_rejectsATamperedQuote() public {
        AfterbellVault.Quote memory q = _quote();
        bytes memory sig = _sign(q, QUOTER_KEY);
        q.premium = 1e6; // cheaper than what was signed
        vm.prank(buyer);
        vm.expectRevert(AfterbellVault.BadSignature.selector);
        vault.buy(q, sig);
    }

    function test_buy_sellsOneOpeningPerRound() public {
        _buy(_quote());
        AfterbellVault.Quote memory q = _quote();
        q.openTs = OPEN + 1 days;
        _expectBuyRevert(q, AfterbellVault.WrongRound.selector);
    }

    function test_buy_capsAStockAtItsShareOfThePool() public {
        AfterbellVault.Quote memory q = _quote();
        q.shares = 1_000e6; // locks $20,000: a fifth of the pool, the most one stock may
        q.premium = 1_000e6;
        _fund(buyer, 1_000e6);
        _buy(q);
        q = _quote();
        q.shares = 1; // anything more
        q.premium = 0;
        _expectBuyRevert(q, AfterbellVault.OverStockLimit.selector);
    }

    function test_buy_capsTheRoundAtItsShareOfThePool() public {
        // Three stocks at $20,000 each would lock $60,000: more than half the pool.
        MockFeed[3] memory feeds = [feed, new MockFeed(8), new MockFeed(8)];
        vm.startPrank(owner);
        vault.allowFeed(address(feeds[1]), "NVDA");
        vault.allowFeed(address(feeds[2]), "AAPL");
        vm.stopPrank();
        for (uint256 i; i < 2; ++i) {
            AfterbellVault.Quote memory q = _quote();
            q.feed = address(feeds[i]);
            q.shares = 1_000e6;
            q.premium = 0;
            _buy(q);
        }
        AfterbellVault.Quote memory third = _quote();
        third.feed = address(feeds[2]);
        third.shares = 500e6 + 1; // $10,000 is what's left
        third.premium = 0;
        _expectBuyRevert(third, AfterbellVault.OverCapacity.selector);
        assertEq(vault.capacity(address(feeds[2])), 10_000e6);
    }

    function test_capacity_isTheRoomLeftUnderBothLimits() public {
        assertEq(vault.capacity(address(feed)), 20_000e6, "a fifth of the pool for one stock");
        _buy(_quote());
        assertEq(vault.capacity(address(feed)), 20_000e6 - 200e6);
        assertEq(vault.capacity(address(new MockFeed(8))), 20_000e6, "another stock has its own fifth");
        vm.warp(OPEN);
        assertEq(vault.capacity(address(feed)), 0, "nothing sells once the bell has rung");
    }

    function test_buyWithPermit_needsNoApprovalBeforehand() public {
        vm.prank(buyer);
        usd.approve(address(vault), 0);
        AfterbellVault.Quote memory q = _quote();
        bytes memory sig = _sign(q, QUOTER_KEY);
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(q.premium, block.timestamp + 60);
        vm.prank(buyer);
        uint256 id = vault.buyWithPermit(q, sig, block.timestamp + 60, v, r, s);
        assertEq(nft.ownerOf(id), buyer);
        assertEq(usd.balanceOf(buyer), 980e6);
    }

    function test_buyWithPermit_survivesSomeoneSubmittingThePermitFirst() public {
        vm.prank(buyer);
        usd.approve(address(vault), 0);
        AfterbellVault.Quote memory q = _quote();
        bytes memory sig = _sign(q, QUOTER_KEY);
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(q.premium, block.timestamp + 60);
        usd.permit(buyer, address(vault), q.premium, block.timestamp + 60, v, r, s); // front-run
        vm.prank(buyer);
        vault.buyWithPermit(q, sig, block.timestamp + 60, v, r, s);
        assertEq(usd.balanceOf(buyer), 980e6);
    }

    // ------------------------------------------------------------- settlement

    function test_settle_usesTheRoundInForceAtTheOpen() public {
        _buy(_quote());
        uint80 id = _settleAt(355e8);
        AfterbellVault.Series memory s = _series();
        assertEq(uint8(s.state), uint8(AfterbellVault.SeriesState.Settled));
        assertEq(s.price, 355e8);
        assertEq(s.roundId, id);
    }

    function test_buy_recordsTheSeriesStrikeRange() public {
        AfterbellVault.Quote memory q = _quote(); // $360 to $340
        _buy(q);
        q.nonce = ++nonce;
        q.upper = 380e8;
        q.lower = 350e8;
        _buy(q);
        assertEq(_series().lowestLower, 340e8);
        assertEq(_series().highestUpper, 380e8);

        // Protection all the way down to zero leaves no floor on the price.
        q.nonce = ++nonce;
        q.lower = 0;
        q.shares = 1e6;
        _buy(q);
        assertEq(_series().lowestLower, 0);
    }

    /// Chainlink's Robinhood Chain feeds launched publishing answers 10^8 too large (16 decimals, not 8).
    function test_settle_refusesAPriceOnTheWrongScale() public {
        uint256 id = _buy(_quote()); // $360 to $340
        uint80 tooBig = feed.push(355e16, OPEN - 30 minutes);
        feed.push(350e16, OPEN + 10 minutes);
        vm.warp(OPEN + 1 hours);
        vm.expectRevert(AfterbellVault.ImplausiblePrice.selector);
        vault.settle(address(feed), OPEN, tooBig);

        // Nobody can settle it, so it voids and the buyer gets the premium back, not a payout of nothing.
        vm.warp(OPEN + 1 days + 1);
        vault.voidSeries(address(feed), OPEN);
        assertEq(vault.claim(id), 20e6);
    }

    function test_settle_refusesAPriceFarBelowTheStrikes() public {
        _buy(_quote());
        uint80 tooSmall = feed.push(355, OPEN - 30 minutes); // $355 with no decimals
        feed.push(350, OPEN + 10 minutes);
        vm.warp(OPEN + 1 hours);
        vm.expectRevert(AfterbellVault.ImplausiblePrice.selector);
        vault.settle(address(feed), OPEN, tooSmall);
    }

    function test_plausiblePrice_withinTenTimesOfTheStrikes() public view {
        assertTrue(vault.plausiblePrice(3_600e8, 340e8, 360e8));
        assertFalse(vault.plausiblePrice(3_600e8 + 1, 340e8, 360e8));
        assertTrue(vault.plausiblePrice(34e8, 340e8, 360e8));
        assertFalse(vault.plausiblePrice(34e8 - 1, 340e8, 360e8));
        assertTrue(vault.plausiblePrice(1, 0, 360e8));
    }

    function test_settle_acceptsACrashBelowTheLowerStrike() public {
        uint256 id = _buy(_quote()); // $360 to $340: pays $200 at $340 or lower
        _settleAt(40e8); // down 89% overnight, still within ten times of the strikes
        assertEq(vault.claim(id), 200e6);
    }

    function test_settle_acceptsTheLatestRoundWhenNoneCameAfter() public {
        uint80 id = feed.push(355e8, OPEN - 2 hours);
        vm.warp(OPEN + 1);
        vault.settle(address(feed), OPEN, id);
    }

    function test_settle_rejectsARoundPublishedAfterTheOpen() public {
        feed.push(355e8, OPEN - 30 minutes);
        uint80 after_ = feed.push(350e8, OPEN + 10 minutes);
        vm.warp(OPEN + 1 hours);
        vm.expectRevert(AfterbellVault.RoundAfterOpen.selector);
        vault.settle(address(feed), OPEN, after_);
    }

    function test_settle_rejectsAnOlderRoundThanTheOneInForce() public {
        uint80 older = feed.push(370e8, OPEN - 2 hours);
        feed.push(355e8, OPEN - 30 minutes);
        vm.warp(OPEN + 1 hours);
        vm.expectRevert(AfterbellVault.NotRoundInForce.selector);
        vault.settle(address(feed), OPEN, older);
    }

    function test_settle_waitsUntilAfterTheOpen() public {
        uint80 id = feed.push(355e8, OPEN - 30 minutes);
        vm.warp(OPEN);
        vm.expectRevert(AfterbellVault.NotYetOpen.selector);
        vault.settle(address(feed), OPEN, id);
    }

    function test_settle_rejectsAStaleRound() public {
        uint80 id = feed.push(355e8, OPEN - 3 days - 1);
        vm.warp(OPEN + 1);
        vm.expectRevert(AfterbellVault.RoundTooOld.selector);
        vault.settle(address(feed), OPEN, id);
    }

    function test_settle_rejectsAMissingRound() public {
        vm.warp(OPEN + 1);
        vm.expectRevert(AfterbellVault.RoundMissing.selector);
        vault.settle(address(feed), OPEN, (uint80(1) << 64) | 99);
    }

    function test_settle_rejectsANonPositiveAnswer() public {
        uint80 id = feed.push(0, OPEN - 30 minutes);
        vm.warp(OPEN + 1);
        vm.expectRevert(AfterbellVault.BadAnswer.selector);
        vault.settle(address(feed), OPEN, id);
    }

    function test_settle_refusesWhenAPhaseChangeHidesTheNextRound() public {
        uint80 id = feed.push(355e8, OPEN - 30 minutes);
        feed.nextPhase();
        feed.push(350e8, OPEN + 10 minutes);
        vm.warp(OPEN + 1 hours);
        // The round after `id` lives in a new phase, so the contract can't prove `id` was last: it
        // refuses rather than guess, and the series voids after the window if nothing settles it.
        vm.expectRevert(AfterbellVault.NotRoundInForce.selector);
        vault.settle(address(feed), OPEN, id);
    }

    function test_settle_onlyOnce() public {
        uint80 id = _settleAt(355e8);
        vm.expectRevert(AfterbellVault.SeriesClosed.selector);
        vault.settle(address(feed), OPEN, id);
    }

    // ---------------------------------------------------------------- payouts

    function test_process_paysEveryHolderAndTheKeeperTheirTips() public {
        address other = makeAddr("other");
        _fund(other, 100e6);
        vm.prank(other);
        usd.approve(address(vault), type(uint256).max);
        _buy(_quote()); // $360 to $340
        AfterbellVault.Quote memory q = _quote();
        q.buyer = other;
        q.upper = 350e8;
        q.lower = 330e8;
        q.premium = 10e6;
        _buy(q);

        _settleAt(345e8);
        assertEq(_processAll(), 2);
        assertEq(usd.balanceOf(buyer), 980e6 + 150e6, "10 x ($360 - $345)");
        assertEq(usd.balanceOf(other), 90e6 + 50e6, "10 x ($350 - $345)");
        assertEq(usd.balanceOf(keeper), 0.6e6, "2% of $30 of premiums");
        assertEq(vault.locked(), 0);
        assertEq(vault.tipsOwed(), 0);
        assertEq(vault.position(0).paid, 150e6);
        assertTrue(vault.position(1).closed);
    }

    function test_process_paysWhoeverHoldsTheNFTNow() public {
        uint256 id = _buy(_quote());
        address alice = makeAddr("alice");
        vm.prank(buyer);
        nft.transferFrom(buyer, alice, id);
        _settleAt(355e8);
        _processAll();
        assertEq(usd.balanceOf(alice), 50e6);
        assertEq(usd.balanceOf(buyer), 980e6);
    }

    function test_process_worksInBatches() public {
        for (uint256 i; i < 3; ++i) _buy(_quote());
        _settleAt(355e8);
        vm.prank(keeper);
        assertEq(vault.process(address(feed), OPEN, 2), 2);
        assertEq(_series().processed, 2);
        assertEq(_processAll(), 1);
        assertEq(_processAll(), 0, "nothing left");
        assertEq(usd.balanceOf(buyer), 1_000e6 - 60e6 + 150e6);
    }

    function test_process_skipsWhatWasClaimedAndPaysNobodyTwice() public {
        uint256 first = _buy(_quote());
        _buy(_quote());
        _settleAt(355e8);
        vm.prank(buyer);
        vault.claim(first);
        _processAll();
        assertEq(usd.balanceOf(buyer), 1_000e6 - 40e6 + 100e6 + 0.4e6, "two payouts, and the tip for claiming one");
        assertEq(usd.balanceOf(keeper), 0.4e6);
        vm.expectRevert(AfterbellVault.NotClaimable.selector);
        vault.claim(first);
    }

    function test_process_notBeforeTheSeriesSettles() public {
        _buy(_quote());
        vm.expectRevert(AfterbellVault.SeriesStillOpen.selector);
        vault.process(address(feed), OPEN, 10);
    }

    function test_claim_paysTheLossBetweenUpperAndLower() public {
        uint256 id = _buy(_quote());
        _settleAt(355e8);
        vm.prank(keeper);
        assertEq(vault.claim(id), 50e6, "10 shares x ($360 - $355)");
        assertEq(usd.balanceOf(buyer), 980e6 + 50e6);
        assertEq(vault.locked(), 0);
    }

    function test_claim_capsAtTheMaxPayout() public {
        uint256 id = _buy(_quote());
        _settleAt(300e8);
        assertEq(vault.claim(id), 200e6);
    }

    function test_claim_paysNothingAboveUpper() public {
        uint256 id = _buy(_quote());
        _settleAt(365e8);
        assertEq(vault.claim(id), 0);
        assertEq(vault.locked(), 0);
    }

    function test_claim_byAnyonePaysTheHolderAndTipsTheCaller() public {
        uint256 id = _buy(_quote());
        _settleAt(355e8);
        vm.prank(keeper);
        vault.claim(id);
        assertEq(usd.balanceOf(buyer), 1_030e6);
        assertEq(usd.balanceOf(keeper), 0.4e6);
    }

    function test_claim_onlyOnceAndOnlyAfterSettlement() public {
        uint256 id = _buy(_quote());
        vm.expectRevert(AfterbellVault.NotClaimable.selector);
        vault.claim(id);
        _settleAt(355e8);
        vault.claim(id);
        vm.expectRevert(AfterbellVault.NotClaimable.selector);
        vault.claim(id);
        vm.expectRevert(AfterbellVault.NotClaimable.selector);
        vault.claim(999);
    }

    // -------------------------------------------------------------------- void

    function test_void_refundsTheWholePremiumAfterTheWindow() public {
        uint256 id = _buy(_quote());
        vm.warp(OPEN + 1 days);
        vm.expectRevert(AfterbellVault.WindowNotOver.selector);
        vault.voidSeries(address(feed), OPEN);

        vm.warp(OPEN + 1 days + 1);
        vault.voidSeries(address(feed), OPEN);
        _processAll();
        assertEq(vault.position(id).paid, 20e6, "the tip included");
        assertEq(usd.balanceOf(buyer), 1_000e6);
        assertEq(usd.balanceOf(keeper), 0, "no tip on a refund");
        assertEq(vault.locked(), 0);
        assertEq(vault.tipsOwed(), 0);

        uint80 late = feed.push(355e8, OPEN - 30 minutes);
        vm.expectRevert(AfterbellVault.SeriesClosed.selector);
        vault.settle(address(feed), OPEN, late);
    }

    function test_void_notAfterSettlement() public {
        _settleAt(355e8);
        vm.warp(OPEN + 2 days);
        vm.expectRevert(AfterbellVault.SeriesClosed.selector);
        vault.voidSeries(address(feed), OPEN);
    }

    // ------------------------------------------------------------------- admin

    function test_adminFunctionsAreOwnerOnly() public {
        AfterbellVault.Params memory p = vault.params();
        vm.startPrank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        vault.setQuoter(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        vault.allowFeed(address(feed), "TSLA");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        vault.disallowFeed(address(feed));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        vault.setParams(p);
        vm.stopPrank();
    }

    function test_allowFeed_requiresEightDecimalsAndATicker() public {
        MockFeed wrong = new MockFeed(18);
        vm.startPrank(owner);
        vm.expectRevert(AfterbellVault.BadFeedDecimals.selector);
        vault.allowFeed(address(wrong), "X");
        vm.expectRevert(AfterbellVault.BadParams.selector);
        vault.allowFeed(address(feed), "");
        vm.stopPrank();
        assertEq(vault.feedSymbol(address(feed)), "TSLA");
    }

    function test_setParams_isBoundedAndWaitsForTheRoll() public {
        AfterbellVault.Params memory p = vault.params();
        vm.startPrank(owner);
        p.settleWindow = 59 minutes;
        vm.expectRevert(AfterbellVault.BadParams.selector);
        vault.setParams(p);
        p = vault.params();
        p.maxFeedBps = p.maxUtilizationBps + 1; // one stock can't have more room than the round
        vm.expectRevert(AfterbellVault.BadParams.selector);
        vault.setParams(p);
        p = vault.params();
        p.keeperTipBps = 1_001;
        vm.expectRevert(AfterbellVault.BadParams.selector);
        vault.setParams(p);

        p = vault.params();
        p.maxUtilizationBps = 10_000;
        p.maxFeedBps = 10_000;
        vault.setParams(p);
        vm.stopPrank();

        // The round in progress keeps its limits.
        assertEq(vault.params().maxUtilizationBps, 5_000);
        assertTrue(vault.paramsQueued());
        vault.roll();
        assertEq(vault.params().maxUtilizationBps, 10_000);
        assertFalse(vault.paramsQueued());
    }

    function test_disallowedFeed_stillSettlesAndPays() public {
        uint256 id = _buy(_quote());
        vm.prank(owner);
        vault.disallowFeed(address(feed));
        _settleAt(355e8);
        assertEq(vault.claim(id), 50e6);
    }

    // ------------------------------------------------------------------- fuzz

    function testFuzz_payoutNeverExceedsTheMaxAndFallsAsThePriceRises(
        uint64 shares,
        uint64 upper,
        uint64 spread,
        uint64 price
    ) public view {
        shares = uint64(bound(shares, 1, 1_000_000e6));
        upper = uint64(bound(upper, 2, 1_000_000e8));
        spread = uint64(bound(spread, 1, upper));
        uint64 lower = upper - spread;
        price = uint64(bound(price, 0, 2_000_000e8));

        uint256 max = vault.payoutAt(shares, upper, lower, 0);
        uint256 at = vault.payoutAt(shares, upper, lower, price);
        assertLe(at, max);
        if (price < type(uint64).max) assertLe(vault.payoutAt(shares, upper, lower, price + 1), at);
    }

    /// Whatever opens, the vault pays every position and ends the round with exactly what it should.
    function testFuzz_staysSolventThroughSettlement(uint8 count, int64 openPrice) public {
        count = uint8(bound(count, 1, 20));
        // Anywhere the vault accepts for any count: from a tenth of $330 to ten times $360.
        openPrice = int64(bound(openPrice, 33e8, 3_600e8));
        uint256 premiums;
        uint256 tips;
        for (uint256 i; i < count; i++) {
            AfterbellVault.Quote memory q = _quote();
            q.shares = uint64(1e6 + i * 1e6);
            q.upper = uint64(360e8 - i * 1e8);
            q.lower = uint64(330e8 - i * 1e8);
            q.premium = uint128(5e6 + i);
            _fund(buyer, q.premium);
            _buy(q);
            premiums += q.premium;
            tips += q.premium * 200 / 10_000;
        }
        assertLe(vault.locked(), vault.roundNav() / 2);

        uint256 before = usd.balanceOf(buyer);
        _settleAt(openPrice);
        _processAll();
        uint256 paid = usd.balanceOf(buyer) - before;

        assertEq(vault.locked(), 0);
        assertEq(vault.tipsOwed(), 0);
        assertEq(usd.balanceOf(keeper), tips);
        assertEq(vault.totalAssets(), POOL + premiums - tips - paid);
        vault.roll();
        assertEq(vault.roundNav(), POOL + premiums - tips - paid);
    }

    /// Outside ten times the strikes, no price settles the series; it voids and refunds every premium.
    function testFuzz_refusesPricesFarFromTheStrikes(int64 openPrice, bool above) public {
        openPrice = above
            ? int64(bound(openPrice, 3_600e8 + 1, type(int64).max - 1e8))
            : int64(bound(openPrice, 1e8 + 1, 34e8 - 1));
        uint256 id = _buy(_quote());
        uint80 round = feed.push(openPrice, OPEN - 30 minutes);
        feed.push(openPrice - 1e8, OPEN + 10 minutes);
        vm.warp(OPEN + 1 hours);
        vm.expectRevert(AfterbellVault.ImplausiblePrice.selector);
        vault.settle(address(feed), OPEN, round);
        vm.warp(OPEN + 1 days + 1);
        vault.voidSeries(address(feed), OPEN);
        assertEq(vault.claim(id), 20e6);
    }

    // ---------------------------------------------------------------- helpers

    function _permitSig(uint256 value, uint256 deadline) internal view returns (uint8, bytes32, bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                buyer,
                address(vault),
                value,
                usd.nonces(buyer),
                deadline
            )
        );
        return vm.sign(BUYER_KEY, keccak256(abi.encodePacked("\x19\x01", usd.DOMAIN_SEPARATOR(), structHash)));
    }
}
