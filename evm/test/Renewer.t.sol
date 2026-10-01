// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AfterbellRenewer} from "../src/AfterbellRenewer.sol";
import {AfterbellVault} from "../src/AfterbellVault.sol";
import {VaultTest} from "./Base.sol";

/// The buyer from VaultTest holds a standing order: at most 10 shares, 2% to 7.5% below the price, at most
/// $30 a night, for ten days. The feed's latest price is $367, so the default quote's strikes ($360 and
/// $340) sit at the order's levels.
contract RenewerTest is VaultTest {
    AfterbellRenewer renewer;
    uint64 constant UNTIL = OPEN + 10 days;

    function setUp() public override {
        super.setUp();
        renewer = new AfterbellRenewer(vault);
        feed.push(367e8, T0 - 1 hours);
        vm.startPrank(buyer);
        usd.approve(address(renewer), type(uint256).max);
        renewer.setOrder(address(feed), 10e6, 200, 750, 30e6, UNTIL);
        vm.stopPrank();
    }

    function _renewal() internal returns (AfterbellVault.Quote memory q) {
        q = _quote();
        q.buyer = address(renewer);
    }

    function _renew(AfterbellVault.Quote memory q) internal returns (uint256) {
        bytes memory sig = _sign(q, QUOTER_KEY);
        vm.prank(keeper);
        return renewer.renew(buyer, q, sig);
    }

    function _expectRenewRevert(AfterbellVault.Quote memory q, bytes4 selector) internal {
        bytes memory sig = _sign(q, QUOTER_KEY);
        vm.prank(keeper);
        vm.expectRevert(selector);
        renewer.renew(buyer, q, sig);
    }

    function test_renewsWithinTheOrderAndHandsTheHolderTheNft() public {
        uint256 before = usd.balanceOf(buyer);
        vm.expectEmit(true, true, true, true, address(renewer));
        emit AfterbellRenewer.Renewed(buyer, address(feed), OPEN, 0, 20e6);
        uint256 id = _renew(_renewal());
        assertEq(nft.ownerOf(id), buyer);
        assertEq(before - usd.balanceOf(buyer), 20e6);
        assertEq(usd.balanceOf(address(renewer)), 0);
        assertEq(renewer.order(buyer, address(feed)).lastOpenTs, OPEN);
    }

    function test_paysTheHolderAtTheOpen() public {
        _renew(_renewal());
        uint256 before = usd.balanceOf(buyer);
        _settleAt(350e8);
        _processAll();
        // 10 shares × ($360 − $350)
        assertEq(usd.balanceOf(buyer) - before, 100e6);
    }

    function test_renewsOncePerOpening() public {
        _renew(_renewal());
        _expectRenewRevert(_renewal(), AfterbellRenewer.AlreadyRenewed.selector);
    }

    function test_keepsToTheOrdersLimits() public {
        AfterbellVault.Quote memory q = _renewal();
        q.premium = 31e6;
        _expectRenewRevert(q, AfterbellRenewer.OverPremium.selector);

        q = _renewal();
        q.shares = 11e6;
        _expectRenewRevert(q, AfterbellRenewer.OverShares.selector);

        // Protection far below the order's levels: cheap, and not what the holder asked for.
        q = _renewal();
        (q.upper, q.lower) = (300e8, 280e8);
        _expectRenewRevert(q, AfterbellRenewer.StrikesOffOrder.selector);

        q = _renewal();
        q.buyer = buyer;
        _expectRenewRevert(q, AfterbellRenewer.NotForThisContract.selector);

        q = _renewal();
        q.openTs = UNTIL + 1 days;
        _expectRenewRevert(q, AfterbellRenewer.OrderEnded.selector);
    }

    function test_refusesAStalePrice() public {
        feed.push(367e8, T0 - 5 days);
        _expectRenewRevert(_renewal(), AfterbellRenewer.StalePrice.selector);
    }

    function test_cancellingStopsRenewalsButNotASecondRenewalGuard() public {
        _renew(_renewal());
        vm.prank(buyer);
        renewer.cancel(address(feed));
        _expectRenewRevert(_renewal(), AfterbellRenewer.NoOrder.selector);
        // A new order can't buy the same opening again.
        vm.prank(buyer);
        renewer.setOrder(address(feed), 10e6, 200, 750, 30e6, UNTIL);
        _expectRenewRevert(_renewal(), AfterbellRenewer.AlreadyRenewed.selector);
    }

    function test_refusesABadOrderOrAFeedTheVaultDoesntSell() public {
        vm.startPrank(buyer);
        vm.expectRevert(AfterbellRenewer.FeedNotAllowed.selector);
        renewer.setOrder(address(0xBEEF), 10e6, 200, 750, 30e6, UNTIL);
        vm.expectRevert(AfterbellRenewer.BadOrder.selector);
        renewer.setOrder(address(feed), 10e6, 750, 200, 30e6, UNTIL);
        vm.expectRevert(AfterbellRenewer.BadOrder.selector);
        renewer.setOrder(address(feed), 0, 200, 750, 30e6, UNTIL);
        vm.expectRevert(AfterbellRenewer.BadOrder.selector);
        renewer.setOrder(address(feed), 10e6, 200, 750, 30e6, uint64(block.timestamp));
        vm.stopPrank();
    }

    function test_listsEachHolderAndFeedOnce() public {
        vm.prank(buyer);
        renewer.setOrder(address(feed), 5e6, 100, 500, 10e6, UNTIL);
        assertEq(renewer.orderCount(), 1);
        AfterbellRenewer.OrderKey[] memory keys = renewer.orderKeys(0, 10);
        assertEq(keys.length, 1);
        assertEq(keys[0].holder, buyer);
        assertEq(keys[0].feed, address(feed));
        assertEq(renewer.orderKeys(1, 10).length, 0);
    }

    function testFuzz_buysOnlyWithinThePriceCap(uint128 premium) public {
        premium = uint128(bound(premium, 1, 200e6));
        AfterbellVault.Quote memory q = _renewal();
        q.premium = premium;
        if (premium > 30e6) {
            _expectRenewRevert(q, AfterbellRenewer.OverPremium.selector);
        } else {
            uint256 before = usd.balanceOf(buyer);
            _renew(q);
            assertEq(before - usd.balanceOf(buyer), premium);
        }
    }
}
