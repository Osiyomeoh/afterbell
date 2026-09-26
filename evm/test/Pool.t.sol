// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {AfterbellVault} from "../src/AfterbellVault.sol";
import {IERC7540Deposit, IERC7540Operator, IERC7540Redeem, IERC7575} from "../src/interfaces/IERC7540.sol";
import {VaultTest} from "./Base.sol";

/// The underwriters' pool: ERC-7540 requests filled at each roll, at the pool's exact value.
contract PoolTest is VaultTest {
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();
        _fund(alice, 10_000e6);
        vm.prank(alice);
        usd.approve(address(vault), type(uint256).max);
    }

    // -------------------------------------------------------------- standards

    function test_interfaceIds_areTheOnesTheEIPsList() public view {
        assertEq(type(IERC7540Operator).interfaceId, bytes4(0xe3bc4e65));
        assertEq(type(IERC7540Deposit).interfaceId, bytes4(0xce3bbe50));
        assertEq(type(IERC7540Redeem).interfaceId, bytes4(0x620ee8e4));
        assertEq(type(IERC7575).interfaceId, bytes4(0x2f0a18c5));
        assertTrue(vault.supportsInterface(0xe3bc4e65));
        assertTrue(vault.supportsInterface(0xce3bbe50));
        assertTrue(vault.supportsInterface(0x620ee8e4));
        assertTrue(vault.supportsInterface(0x2f0a18c5));
        assertTrue(vault.supportsInterface(0x01ffc9a7));
        assertFalse(vault.supportsInterface(0xffffffff));
        assertEq(vault.share(), address(vault));
        assertEq(vault.asset(), address(usd));
        assertEq(vault.decimals(), 6);
    }

    function test_previews_revertBecauseThePriceIsSetAtTheRoll() public {
        vm.expectRevert(AfterbellVault.AsyncOnly.selector);
        vault.previewDeposit(1);
        vm.expectRevert(AfterbellVault.AsyncOnly.selector);
        vault.previewMint(1);
        vm.expectRevert(AfterbellVault.AsyncOnly.selector);
        vault.previewRedeem(1);
        vm.expectRevert(AfterbellVault.AsyncOnly.selector);
        vault.previewWithdraw(1);
    }

    // --------------------------------------------------------------- deposits

    function test_deposit_waitsForTheRollThenClaimsShares() public {
        vm.prank(alice);
        vault.requestDeposit(1_000e6, alice, alice);
        assertEq(vault.pendingDepositRequest(0, alice), 1_000e6);
        assertEq(vault.claimableDepositRequest(0, alice), 0);
        assertEq(vault.totalAssets(), POOL, "queued money isn't the pool's yet");

        vault.roll();
        assertEq(vault.pendingDepositRequest(0, alice), 0);
        assertEq(vault.claimableDepositRequest(0, alice), 1_000e6);
        assertEq(vault.maxMint(alice), 1_000e6, "one share per unit while nothing has been earned");
        assertEq(vault.roundNav(), POOL + 1_000e6);

        vm.prank(alice);
        assertEq(vault.deposit(1_000e6, alice), 1_000e6);
        assertEq(vault.balanceOf(alice), 1_000e6);
        assertEq(vault.maxDeposit(alice), 0);
    }

    function test_deposit_canBeClaimedInParts() public {
        vm.prank(alice);
        vault.requestDeposit(1_000e6, alice, alice);
        vault.roll();
        vm.startPrank(alice);
        assertEq(vault.mint(400e6, alice), 400e6);
        assertEq(vault.deposit(600e6, alice), 600e6);
        vm.expectRevert(AfterbellVault.OverClaimable.selector);
        vault.deposit(1, alice);
        vm.stopPrank();
    }

    function test_deposit_onlyTheControllerOrItsOperatorClaims() public {
        vm.prank(alice);
        vault.requestDeposit(1_000e6, alice, alice);
        vault.roll();
        vm.prank(bob);
        vm.expectRevert(AfterbellVault.Unauthorized.selector);
        vault.deposit(1_000e6, bob, alice);

        vm.prank(alice);
        vault.setOperator(bob, true);
        assertTrue(vault.isOperator(alice, bob));
        vm.prank(bob);
        vault.deposit(1_000e6, alice, alice);
        assertEq(vault.balanceOf(alice), 1_000e6);
    }

    function test_requestDeposit_spendsOnlyTheOwnersMoneyWithConsent() public {
        vm.prank(bob);
        vm.expectRevert(AfterbellVault.Unauthorized.selector);
        vault.requestDeposit(1_000e6, bob, alice);
        vm.prank(alice);
        vault.setOperator(bob, true);
        vm.prank(bob);
        vault.requestDeposit(1_000e6, alice, alice);
        assertEq(vault.pendingDepositRequest(0, alice), 1_000e6);
    }

    function test_requestDepositWithPermit() public {
        _fund(buyer, 500e6);
        vm.prank(buyer);
        usd.approve(address(vault), 0);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                buyer,
                address(vault),
                500e6,
                usd.nonces(buyer),
                block.timestamp + 60
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(BUYER_KEY, keccak256(abi.encodePacked("\x19\x01", usd.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(buyer);
        vault.requestDepositWithPermit(500e6, buyer, block.timestamp + 60, v, r, s);
        assertEq(vault.pendingDepositRequest(0, buyer), 500e6);
    }

    // ----------------------------------------------------------------- rounds

    function test_roll_waitsUntilEverythingTheRoundSoldIsPaid() public {
        _buy(_quote());
        vm.expectRevert(AfterbellVault.RoundNotOver.selector);
        vault.roll(); // before the bell
        feed.push(355e8, OPEN - 30 minutes);
        vm.warp(OPEN + 1 hours);
        vm.expectRevert(AfterbellVault.RoundNotOver.selector);
        vault.roll(); // not settled
        vault.settle(address(feed), OPEN, feed.latestRound());
        vm.expectRevert(AfterbellVault.RoundNotOver.selector);
        vault.roll(); // not paid out
        _processAll();
        vault.roll();
        assertEq(vault.round(), 3, "the setup's roll, then this one");
        assertEq(vault.roundOpenTs(), 0, "the next sale fixes the next opening");
        assertEq(vault.roundSeries().length, 0);
    }

    function test_roll_anyTimeForARoundThatSoldNothing() public {
        vault.roll();
        vault.roll();
        assertEq(vault.round(), 4);
    }

    /// A quiet night: premiums less tips raise the price of a share, for those in the pool then.
    function test_shares_earnWhatTheRoundKept() public {
        vm.prank(alice);
        vault.requestDeposit(1_000e6, alice, alice); // during the round: not in its risk or its income
        _buy(_quote());
        _settleAt(365e8); // above $360: pays nothing
        _processAll();
        vault.roll();

        uint256 nav = POOL + 19.6e6; // $20 premium less a 2% tip
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(1_000e6, alice);
        assertEq(aliceShares, uint256(1_000e6) * (POOL + 1) / (nav + 1), "alice pays today's price");
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(owner)), nav, 1, "the owner kept the income");
    }

    /// A bad night: the payouts come out of the shares of those in the pool then, and someone who
    /// asked to join before the open doesn't share the loss or dilute it.
    function test_shares_bearWhatTheRoundLost() public {
        vm.prank(alice);
        vault.requestDeposit(1_000e6, alice, alice);
        _buy(_quote());
        _settleAt(340e8); // pays the full $200
        _processAll();
        vault.roll();

        uint256 nav = POOL + 19.6e6 - 200e6;
        vm.prank(alice);
        vault.deposit(1_000e6, alice);
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(alice)), 1_000e6, 1, "alice's money is whole");
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(owner)), nav, 1, "the owner bore the loss");
    }

    // ------------------------------------------------------------ redemptions

    function test_redeem_waitsForTheRollAndCantLeaveAheadOfALoss() public {
        _buy(_quote());
        // The owner asks to leave with everything before the bell, having seen a crash coming.
        vm.prank(owner);
        vault.requestRedeem(POOL, owner, owner);
        assertEq(vault.pendingRedeemRequest(0, owner), POOL);
        assertEq(vault.balanceOf(owner), 0, "the shares wait in the vault");

        _settleAt(340e8);
        _processAll();
        vault.roll();

        uint256 owed = POOL + 19.6e6 - 200e6;
        assertEq(vault.claimableRedeemRequest(0, owner), POOL);
        assertApproxEqAbs(vault.maxWithdraw(owner), owed, 1, "filled after the loss, not before");
        vm.prank(owner);
        uint256 paid = vault.redeem(POOL, owner, owner);
        assertApproxEqAbs(paid, owed, 1);
        assertEq(usd.balanceOf(owner), paid);
        assertEq(vault.totalSupply(), 0);
        assertLe(vault.reservedAssets(), 1, "only rounding dust stays reserved");
    }

    function test_redeem_canBeClaimedInPartsByAnOperator() public {
        vm.prank(owner);
        vault.requestRedeem(10_000e6, owner, owner);
        vault.roll();
        vm.prank(owner);
        vault.setOperator(bob, true);
        vm.startPrank(bob);
        assertEq(vault.withdraw(4_000e6, bob, owner), 4_000e6);
        assertEq(vault.redeem(6_000e6, bob, owner), 6_000e6);
        vm.expectRevert(AfterbellVault.OverClaimable.selector);
        vault.redeem(1, bob, owner);
        vm.stopPrank();
        assertEq(usd.balanceOf(bob), 10_000e6);
    }

    function test_requestRedeem_withAnAllowanceOrAsAnOperator() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, bob, 0, 1e6));
        vault.requestRedeem(1e6, bob, owner);

        vm.prank(owner);
        vault.approve(bob, 1e6);
        vm.prank(bob);
        vault.requestRedeem(1e6, bob, owner);
        assertEq(vault.pendingRedeemRequest(0, bob), 1e6);
    }

    // ------------------------------------------------------------------- risk

    function test_riskLimits_followThePoolFromRollToRoll() public {
        assertEq(vault.capacity(address(feed)), 20_000e6);
        vm.prank(alice);
        vault.requestDeposit(10_000e6, alice, alice);
        assertEq(vault.capacity(address(feed)), 20_000e6, "a queued deposit adds no room this round");
        vault.roll();
        assertEq(vault.capacity(address(feed)), 22_000e6, "a fifth of $110,000");
    }
}
