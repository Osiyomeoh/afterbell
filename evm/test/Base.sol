// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {AfterbellPositions} from "../src/AfterbellPositions.sol";
import {AfterbellVault} from "../src/AfterbellVault.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {MockFeed} from "./mocks/MockFeed.sol";

/// A vault with a $100,000 pool underwritten by its owner, a TSLA feed, and a buyer with $1,000.
/// Its round sells protection for OPEN; the default quote is 10 shares from $360 down to $340 (the
/// most it pays is $200) for a $20 premium.
abstract contract VaultTest is Test {
    uint256 constant QUOTER_KEY = 0xA11CE;
    uint256 constant BUYER_KEY = 0xB0B0;
    uint64 constant T0 = 1_790_000_000;
    uint64 constant OPEN = T0 + 1 days; // Tue 22 Sep 2026, 14:13:20 UTC
    uint256 constant POOL = 100_000e6;

    TestUSD usd;
    MockFeed feed;
    AfterbellVault vault;
    AfterbellPositions nft;
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address buyer;
    address quoter;
    uint256 nonce;

    function setUp() public virtual {
        vm.warp(T0);
        quoter = vm.addr(QUOTER_KEY);
        buyer = vm.addr(BUYER_KEY);
        usd = new TestUSD();
        feed = new MockFeed(8);
        vault = new AfterbellVault(usd, owner, quoter, 3 days, 1 days);
        nft = vault.positionToken();
        vm.prank(owner);
        vault.allowFeed(address(feed), "TSLA");
        _underwrite(owner, POOL);

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

    /// Request a deposit, roll the (empty) round and claim the shares.
    function _underwrite(address lp, uint256 amount) internal returns (uint256 shares) {
        _fund(lp, amount);
        vm.startPrank(lp);
        usd.approve(address(vault), type(uint256).max);
        vault.requestDeposit(amount, lp, lp);
        vm.stopPrank();
        vault.roll();
        vm.prank(lp);
        shares = vault.deposit(amount, lp);
    }

    function _quote() internal returns (AfterbellVault.Quote memory q) {
        q = AfterbellVault.Quote({
            buyer: buyer,
            feed: address(feed),
            openTs: OPEN,
            shares: 10e6,
            upper: 360e8,
            lower: 340e8,
            premium: 20e6,
            expiry: uint64(block.timestamp + 120),
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

    /// Publish a round before the open and one after it, then settle on the first.
    function _settleAt(int256 price) internal returns (uint80 id) {
        id = feed.push(price, OPEN - 30 minutes);
        feed.push(price - 1e8, OPEN + 10 minutes);
        vm.warp(OPEN + 1 hours);
        vault.settle(address(feed), OPEN, id);
    }

    function _processAll() internal returns (uint256) {
        vm.prank(keeper);
        return vault.process(address(feed), OPEN, 1_000);
    }

    function _series() internal view returns (AfterbellVault.Series memory) {
        return vault.series(vault.seriesKey(address(feed), OPEN));
    }
}
