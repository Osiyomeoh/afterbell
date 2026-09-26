// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {AfterbellVault} from "../src/AfterbellVault.sol";
import {TestUSD} from "../src/TestUSD.sol";

/// Deploys Afterbell on Robinhood Chain with valueless collateral (TestUSD): real Chainlink settlement,
/// no real money. The deployer owns the vault; QUOTER is the address whose signatures price protection.
///
///   QUOTER=0x... forge script script/Deploy.s.sol --rpc-url robinhood \
///     --account afterbell-deployer --sender <deployer address> --broadcast
///
/// Without --broadcast it only simulates against the live chain.
contract Deploy is Script {
    // Chainlink "Robinhood TSLA / USD" on Robinhood Chain mainnet.
    address constant TSLA_FEED = 0x4A1166a659A55625345e9515b32adECea5547C38;
    uint64 constant MAX_ROUND_AGE = 3 days; // covers a weekend with no rounds
    uint64 constant SETTLE_WINDOW = 1 days;
    uint256 constant SEED = 100_000e6; // test collateral the vault starts with

    function run() external returns (TestUSD usd, AfterbellVault vault) {
        address quoter = vm.envAddress("QUOTER");
        vm.startBroadcast();
        address deployer = msg.sender;

        usd = new TestUSD();
        vault = new AfterbellVault(usd, deployer, quoter, MAX_ROUND_AGE, SETTLE_WINDOW);
        vault.allowFeed(TSLA_FEED, true);

        for (uint256 minted; minted < SEED; minted += usd.MINT_LIMIT()) usd.mint(deployer, usd.MINT_LIMIT());
        usd.approve(address(vault), SEED);
        vault.deposit(SEED);
        vm.stopBroadcast();

        console.log("TestUSD", address(usd));
        console.log("AfterbellVault", address(vault));
        console.log("owner", deployer);
        console.log("quoter", quoter);
    }
}
