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

    AfterbellVault vault;

    function setUp() public {
        vm.createSelectFork("robinhood");
        TestUSD usd = new TestUSD();
        vault = new AfterbellVault(usd, address(this), address(this), 3 days, 1 days);
        vault.allowFeed(TSLA_FEED, true); // checks the real feed reports 8 decimals
    }

    function test_settlesFridaysOpenOnTheRoundInForce() public {
        vault.settle(TSLA_FEED, OPEN, IN_FORCE);
        (AfterbellVault.SeriesState state, uint64 price, uint80 roundId) = vault.series(vault.seriesKey(TSLA_FEED, OPEN));
        assertEq(uint8(state), uint8(AfterbellVault.SeriesState.Settled));
        assertEq(price, 383_8284_0000, "$383.8284");
        assertEq(roundId, IN_FORCE);
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
