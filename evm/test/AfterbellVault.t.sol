// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

import {AfterbellVault} from "../src/AfterbellVault.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {MockFeed} from "./mocks/MockFeed.sol";

contract AfterbellVaultTest is Test {
    uint256 constant QUOTER_KEY = 0xA11CE;
    uint64 constant T0 = 1_790_000_000;
    uint64 constant OPEN = T0 + 1 days;

    TestUSD usd;
    MockFeed feed;
    AfterbellVault vault;
    address owner = makeAddr("owner");
    address buyer = makeAddr("buyer");
    address quoter;
    uint256 nonce;

    function setUp() public {
        vm.warp(T0);
        quoter = vm.addr(QUOTER_KEY);
        usd = new TestUSD();
        feed = new MockFeed(8);
        vault = new AfterbellVault(usd, owner, quoter, 3 days, 1 days);
        vm.prank(owner);
        vault.allowFeed(address(feed), true);

        _fund(owner, 100_000e6);
        vm.startPrank(owner);
        usd.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6);
        vm.stopPrank();

        _fund(buyer, 1_000e6);
        vm.prank(buyer);
        usd.approve(address(vault), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers

    function _fund(address to, uint256 amount) internal {
        for (; amount > 0;) {
            uint256 part = amount > usd.MINT_LIMIT() ? usd.MINT_LIMIT() : amount;
            usd.mint(to, part);
            amount -= part;
        }
    }

    /// 10 shares, protection from $360 down to $340 (max $200), $20 premium.
    function _quote() internal returns (AfterbellVault.Quote memory q) {
        q = AfterbellVault.Quote({
            buyer: buyer,
            feed: address(feed),
            openTs: OPEN,
            shares: 10e6,
            upper: 360e8,
            lower: 340e8,
            premium: 20e6,
            expiry: T0 + 120,
            nonce: ++nonce
        });
    }

    function _sign(AfterbellVault.Quote memory q, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, vault.hashQuote(q));
        return abi.encodePacked(r, s, v);
    }

    function _buy(AfterbellVault.Quote memory q) internal returns (uint256) {
        bytes memory sig = _sign(q, QUOTER_KEY);
        vm.prank(q.buyer);
        return vault.buy(q, sig);
    }

    /// Sign first: vm.expectRevert applies to the next external call, and signing calls hashQuote.
    function _expectBuyRevert(AfterbellVault.Quote memory q, bytes4 selector) internal {
        bytes memory sig = _sign(q, QUOTER_KEY);
        vm.prank(q.buyer);
        vm.expectRevert(selector);
        vault.buy(q, sig);
    }

    /// Publish a round at `openTs - secsBefore` and one after the open, then settle on the first.
    function _settleAt(int256 price) internal returns (uint80 id) {
        id = feed.push(price, OPEN - 30 minutes);
        feed.push(price - 1e8, OPEN + 10 minutes);
        vm.warp(OPEN + 1 hours);
        vault.settle(address(feed), OPEN, id);
    }

    // ----------------------------------------------------------------- buying

    function test_buy_takesPremiumAndLocksMaxPayout() public {
        uint256 id = _buy(_quote());
        (address b,,, uint64 shares,,, uint128 premium, uint128 maxPayout, bool closed) = vault.positions(id);
        assertEq(b, buyer);
        assertEq(shares, 10e6);
        assertEq(premium, 20e6);
        assertEq(maxPayout, 200e6, "10 shares x $20 spread");
        assertFalse(closed);
        assertEq(vault.locked(), 200e6);
        assertEq(usd.balanceOf(buyer), 980e6);
        assertEq(vault.freeCollateral(), 100_000e6 + 20e6 - 200e6);
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

    function test_buy_rejectsWhenCollateralCantCoverTheMaxPayout() public {
        AfterbellVault.Quote memory q = _quote();
        q.shares = 6_000e6; // max payout $120,000 > $100,000 deposited + premium
        _expectBuyRevert(q, AfterbellVault.InsufficientCollateral.selector);
    }

    // ------------------------------------------------------------- settlement

    function test_settle_usesTheRoundInForceAtTheOpen() public {
        _buy(_quote());
        uint80 id = _settleAt(355e8);
        (AfterbellVault.SeriesState state, uint64 price, uint80 roundId) = vault.series(vault.seriesKey(address(feed), OPEN));
        assertEq(uint8(state), uint8(AfterbellVault.SeriesState.Settled));
        assertEq(price, 355e8);
        assertEq(roundId, id);
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

    // ------------------------------------------------------------------ claims

    function test_claim_paysTheLossBetweenUpperAndLower() public {
        uint256 id = _buy(_quote());
        _settleAt(355e8);
        uint256 paid = vault.claim(id);
        assertEq(paid, 50e6, "10 shares x ($360 - $355)");
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

    function test_claim_byAnyonePaysTheBuyer() public {
        uint256 id = _buy(_quote());
        _settleAt(355e8);
        vm.prank(makeAddr("keeper"));
        vault.claim(id);
        assertEq(usd.balanceOf(buyer), 1_030e6);
        assertEq(usd.balanceOf(makeAddr("keeper")), 0);
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

    function test_void_refundsThePremiumAfterTheWindow() public {
        uint256 id = _buy(_quote());
        vm.warp(OPEN + 1 days);
        vm.expectRevert(AfterbellVault.WindowNotOver.selector);
        vault.voidSeries(address(feed), OPEN);

        vm.warp(OPEN + 1 days + 1);
        vault.voidSeries(address(feed), OPEN);
        assertEq(vault.claim(id), 20e6);
        assertEq(usd.balanceOf(buyer), 1_000e6);
        assertEq(vault.locked(), 0);

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

    function test_withdraw_onlyFreeCollateral() public {
        _buy(_quote());
        uint256 free = vault.freeCollateral();
        vm.startPrank(owner);
        vm.expectRevert(AfterbellVault.InsufficientCollateral.selector);
        vault.withdraw(free + 1, owner);
        vault.withdraw(free, owner);
        vm.stopPrank();
        assertEq(vault.freeCollateral(), 0);
        assertEq(usd.balanceOf(address(vault)), vault.locked());
    }

    function test_adminFunctionsAreOwnerOnly() public {
        vm.startPrank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        vault.withdraw(1, buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        vault.setQuoter(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        vault.allowFeed(address(feed), false);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        vault.setParams(1 days, 1 days);
        vm.stopPrank();
    }

    function test_allowFeed_requiresEightDecimals() public {
        MockFeed wrong = new MockFeed(18);
        vm.prank(owner);
        vm.expectRevert(AfterbellVault.BadFeedDecimals.selector);
        vault.allowFeed(address(wrong), true);
    }

    function test_setParams_bounds() public {
        vm.startPrank(owner);
        vm.expectRevert(AfterbellVault.BadParams.selector);
        vault.setParams(0, 1 days);
        vm.expectRevert(AfterbellVault.BadParams.selector);
        vault.setParams(1 days, 59 minutes);
        vm.expectRevert(AfterbellVault.BadParams.selector);
        vault.setParams(1 days, 7 days + 1);
        vm.stopPrank();
    }

    function test_disallowedFeed_stillSettlesAndClaims() public {
        uint256 id = _buy(_quote());
        vm.prank(owner);
        vault.allowFeed(address(feed), false);
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

    /// Whatever opens, the vault can pay every position and ends with exactly what it should.
    function testFuzz_staysSolventThroughSettlement(uint8 count, int64 openPrice) public {
        count = uint8(bound(count, 1, 20));
        openPrice = int64(bound(openPrice, 1, 1_000e8));
        uint256 premiums;
        uint256[] memory ids = new uint256[](count);
        for (uint256 i; i < count; i++) {
            AfterbellVault.Quote memory q = _quote();
            q.shares = uint64(1e6 + i * 1e6);
            q.upper = uint64(360e8 - i * 1e8);
            q.lower = uint64(330e8 - i * 1e8);
            q.premium = uint128(5e6 + i);
            _fund(buyer, q.premium);
            ids[i] = _buy(q);
            premiums += q.premium;
        }
        assertLe(vault.locked(), usd.balanceOf(address(vault)));

        _settleAt(openPrice);
        uint256 paid;
        for (uint256 i; i < count; i++) paid += vault.claim(ids[i]);

        assertEq(vault.locked(), 0);
        assertEq(usd.balanceOf(address(vault)), 100_000e6 + premiums - paid);
    }
}
