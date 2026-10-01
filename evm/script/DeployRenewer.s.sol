// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {AfterbellRenewer} from "../src/AfterbellRenewer.sol";
import {AfterbellVault} from "../src/AfterbellVault.sol";

/// Deploys the renewer ("protect every night") beside an existing vault. It has no owner and holds no
/// money between renewals; the vault doesn't change.
///
///   VAULT=0x... forge script script/DeployRenewer.s.sol --rpc-url robinhood \
///     --account afterbell-deployer --sender <deployer address> --broadcast
///
/// Without --broadcast it only simulates against the live chain.
contract DeployRenewer is Script {
    function run() external returns (AfterbellRenewer renewer) {
        AfterbellVault vault = AfterbellVault(vm.envAddress("VAULT"));
        require(address(vault.collateral()) != address(0), "VAULT isn't an Afterbell vault");
        vm.startBroadcast();
        renewer = new AfterbellRenewer(vault);
        vm.stopBroadcast();
        console.log("renewer", address(renewer));
    }
}
