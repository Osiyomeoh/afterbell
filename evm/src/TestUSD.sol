// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Afterbell Test USD
/// @notice Collateral with no value, for running Afterbell on mainnet without real money. Anyone can
/// mint up to MINT_LIMIT per call.
contract TestUSD is ERC20 {
    uint256 public constant MINT_LIMIT = 10_000e6;

    error OverMintLimit();

    constructor() ERC20("Afterbell Test USD (no value)", "tUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (amount > MINT_LIMIT) revert OverMintLimit();
        _mint(to, amount);
    }
}
