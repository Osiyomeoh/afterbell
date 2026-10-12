// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {AfterbellVault} from "../src/AfterbellVault.sol";
import {TestUSD} from "../src/TestUSD.sol";

/// Pins the EIP-712 digest of one quote, so the TypeScript signer (pricing/quote.test.ts) and the
/// contract are checked against the same vector.
contract QuoteVectorTest is Test {
    function test_quoteDigestVector() public {
        // The same vector is asserted in pricing/quote.test.ts.
        vm.chainId(46630);
        // Deployed at a fixed address, so the vector pins the typed-data encoding, not the bytecode
        // (a CREATE2 address would move with every change to the contract).
        address at = 0xFb94De7E63834a1271b9b7E316d7c13B66F38995;
        deployCodeTo(
            "AfterbellVault.sol:AfterbellVault", abi.encode(new TestUSD(), address(1), address(2), 3 days, 1 days), at
        );
        AfterbellVault vault = AfterbellVault(at);
        AfterbellVault.Quote memory q = AfterbellVault.Quote({
            buyer: 0x1111111111111111111111111111111111111111,
            feed: 0x4A1166a659A55625345e9515b32adECea5547C38,
            openTs: 1_790_343_000,
            shares: 10e6,
            upper: 360e8,
            lower: 340e8,
            premium: 20e6,
            expiry: 1_790_300_000,
            nonce: 42
        });
        assertEq(address(vault), 0xFb94De7E63834a1271b9b7E316d7c13B66F38995);
        assertEq(vault.hashQuote(q), 0x7ea4a414cced87b14b75cfcdd74ae1cf2739d435c02be15497d5a2decb6d3d9a);
    }
}
