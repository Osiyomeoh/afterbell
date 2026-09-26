// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AfterbellPositions} from "../src/AfterbellPositions.sol";
import {AfterbellVault} from "../src/AfterbellVault.sol";
import {PositionArt} from "../src/PositionArt.sol";
import {VaultTest} from "./Base.sol";

/// Positions as NFTs: minted by the vault only, and drawn on-chain from its record.
contract PositionsTest is VaultTest {
    function test_onlyTheVaultMints() public {
        vm.expectRevert(AfterbellPositions.OnlyVault.selector);
        nft.mint(buyer, 7);
        assertEq(address(nft.vault()), address(vault));
        assertEq(nft.name(), "Afterbell Protection");
        assertEq(nft.symbol(), "BELL");
    }

    function test_card_followsThePositionFromOpenToPaid() public {
        uint256 id = _buy(_quote());
        string memory art = PositionArt.svg(nft.card(id));
        assertTrue(vm.contains(art, ">TSLA<"));
        assertTrue(vm.contains(art, "PROTECTION #0"));
        assertTrue(vm.contains(art, "until the 09:30 ET open, 22 Sep 2026"));
        assertTrue(vm.contains(art, "pays up to $200.00"));
        assertTrue(vm.contains(art, "$360.00"));
        assertTrue(vm.contains(art, "$340.00"));
        assertTrue(vm.contains(art, "10 shares  |  cost $20.00"));
        assertTrue(vm.contains(art, "Open until the bell"));

        _settleAt(355.5e8);
        art = PositionArt.svg(nft.card(id));
        assertTrue(vm.contains(art, "Opened at $355.50  |  pays $45.00"));
        assertTrue(vm.contains(art, "stroke-dasharray"), "the opening is marked on the chart");

        _processAll();
        assertTrue(vm.contains(PositionArt.svg(nft.card(id)), "Opened at $355.50  |  paid $45.00"));
    }

    function test_card_showsARefundWhenTheSeriesVoids() public {
        uint256 id = _buy(_quote());
        vm.warp(OPEN + 1 days + 1);
        vault.voidSeries(address(feed), OPEN);
        assertTrue(vm.contains(PositionArt.svg(nft.card(id)), "Voided: premium to refund"));
        _processAll();
        assertTrue(vm.contains(PositionArt.svg(nft.card(id)), "Voided: premium refunded"));
    }

    function test_card_writesFractionalShares() public {
        uint256 id = _buyShares(2.5e6);
        assertTrue(vm.contains(PositionArt.svg(nft.card(id)), "2.5 shares"));
    }

    function test_tokenURI_isOnChainJson() public {
        uint256 id = _buy(_quote());
        string memory uri = nft.tokenURI(id);
        assertTrue(vm.contains(uri, "data:application/json;base64,"));
        vm.expectRevert();
        nft.tokenURI(99);
    }

    function _buyShares(uint64 shares) internal returns (uint256) {
        AfterbellVault.Quote memory q = _quote();
        q.shares = shares;
        q.premium = 1e6;
        return _buy(q);
    }
}
