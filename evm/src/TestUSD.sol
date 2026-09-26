// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title Afterbell Test USD
/// @notice Collateral with no value, for running Afterbell on mainnet without real money. Anyone can
/// mint up to MINT_LIMIT per call. It takes EIP-2612 permits, so buying protection or depositing is
/// one transaction instead of an approve and a call.
contract TestUSD is ERC20Permit {
    uint256 public constant MINT_LIMIT = 10_000e6;

    error OverMintLimit();

    constructor() ERC20("Afterbell Test USD (no value)", "tUSD") ERC20Permit("Afterbell Test USD (no value)") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (amount > MINT_LIMIT) revert OverMintLimit();
        _mint(to, amount);
    }
}
