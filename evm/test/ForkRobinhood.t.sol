// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {AfterbellVault} from "../src/AfterbellVault.sol";
import {TestUSD} from "../src/TestUSD.sol";

/// Settlement against Chainlink's real TSLA feed on Robinhood Chain mainnet. Needs the network, so it
/// runs only in the fork profile:
///   FOUNDRY_PROFILE=fork forge test
/// Round numbers come from research/data/chainlink-robinhood-TSLA.json.
contract ForkRobinhoodTest is Test {
    address constant TSLA_FEED = 0x4A1166a659A55625345e9515b32adECea5547C38;
    uint80 constant PHASE_1 = uint80(1) << 64;

    // Friday 25 September 2026, 09:30 ET. Round 1341 (published 09:26:48 ET) was in force; round 1342
    // came at 09:32:18 ET. Pyth's first print at or after 09:30 was $384.62.
    uint64 constant OPEN = 1_790_343_000;
    uint80 constant IN_FORCE = PHASE_1 | 1341;

    // Tuesday 23 June 2026, 09:30 ET, the feed's second day. Round 35 (09:28:24 ET) was in force and
    // reads 39,272,465,000: TSLA at about $392.72, published with 16 decimals while the feed reports 8.
    uint64 constant LAUNCH_OPEN = 1_782_221_400;
    uint80 constant LAUNCH_IN_FORCE = PHASE_1 | 35;
    uint256 constant QUOTER_KEY = 0xA11CE;

    AfterbellVault vault;

    function setUp() public {
        vm.createSelectFork("robinhood");
        TestUSD usd = new TestUSD();
        vault = new AfterbellVault(usd, address(this), vm.addr(QUOTER_KEY), 3 days, 1 days);
        vault.allowFeed(TSLA_FEED, "TSLA"); // checks the real feed reports 8 decimals
        // Underwrite the pool with half, and keep the rest for premiums.
        usd.mint(address(this), usd.MINT_LIMIT());
        usd.approve(address(vault), type(uint256).max);
        vault.requestDeposit(usd.MINT_LIMIT() / 2, address(this), address(this));
        vault.roll();
        vault.deposit(usd.MINT_LIMIT() / 2, address(this));
    }

    function test_refusesTheLaunchDayPriceOnTheWrongScale() public {
        // Protection on 1 TSLA from $390 down to $360 for that open, bought the evening before.
        vm.warp(LAUNCH_OPEN - 12 hours);
        AfterbellVault.Quote memory q = AfterbellVault.Quote({
            buyer: address(this),
            feed: TSLA_FEED,
            openTs: LAUNCH_OPEN,
            shares: 1e6,
            upper: 390e8,
            lower: 360e8,
            premium: 1e6,
            expiry: LAUNCH_OPEN - 12 hours + 60,
            nonce: 1
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(QUOTER_KEY, vault.hashQuote(q));
        uint256 id = vault.buy(q, abi.encodePacked(r, s, v));

        vm.warp(LAUNCH_OPEN + 1 hours);
        vm.expectRevert(AfterbellVault.ImplausiblePrice.selector);
        vault.settle(TSLA_FEED, LAUNCH_OPEN, LAUNCH_IN_FORCE);

        // It voids and refunds the premium, where settling would have paid nothing.
        vm.warp(LAUNCH_OPEN + 1 days + 1);
        vault.voidSeries(TSLA_FEED, LAUNCH_OPEN);
        assertEq(vault.claim(id), 1e6);
    }

    function test_settlesFridaysOpenOnTheRoundInForce() public {
        vault.settle(TSLA_FEED, OPEN, IN_FORCE);
        AfterbellVault.Series memory s = vault.series(vault.seriesKey(TSLA_FEED, OPEN));
        assertEq(uint8(s.state), uint8(AfterbellVault.SeriesState.Settled));
        assertEq(s.price, 383_8284_0000, "$383.8284");
        assertEq(s.roundId, IN_FORCE);
    }

    function test_refusesTheRoundAfterTheOpen() public {
        vm.expectRevert(AfterbellVault.RoundAfterOpen.selector);
        vault.settle(TSLA_FEED, OPEN, IN_FORCE + 1);
    }

    function test_refusesTheRoundBeforeTheOneInForce() public {
        vm.expectRevert(AfterbellVault.NotRoundInForce.selector);
        vault.settle(TSLA_FEED, OPEN, IN_FORCE - 1);
    }

    function test_treatsARoundThatDoesNotExistAsMissing() public {
        vm.expectRevert(AfterbellVault.RoundMissing.selector);
        vault.settle(TSLA_FEED, OPEN, PHASE_1 | 1_000_000);
    }
}
