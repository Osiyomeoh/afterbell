// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev ERC-7540 (asynchronous ERC-4626 vaults) and ERC-7575, as the EIPs define them. Each interface's
/// ERC-165 id is the one the EIP lists; test/Pool.t.sol checks that.

/// ERC-165 id 0xe3bc4e65.
interface IERC7540Operator {
    event OperatorSet(address indexed controller, address indexed operator, bool approved);

    function setOperator(address operator, bool approved) external returns (bool);
    function isOperator(address controller, address operator) external view returns (bool status);
}

/// ERC-165 id 0xce3bbe50.
interface IERC7540Deposit {
    event DepositRequest(
        address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 assets
    );

    function requestDeposit(uint256 assets, address controller, address owner) external returns (uint256 requestId);
    function pendingDepositRequest(uint256 requestId, address controller) external view returns (uint256 pendingAssets);
    function claimableDepositRequest(uint256 requestId, address controller)
        external
        view
        returns (uint256 claimableAssets);
    function deposit(uint256 assets, address receiver, address controller) external returns (uint256 shares);
    function mint(uint256 shares, address receiver, address controller) external returns (uint256 assets);
}

/// ERC-165 id 0x620ee8e4.
interface IERC7540Redeem {
    event RedeemRequest(
        address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares
    );

    function requestRedeem(uint256 shares, address controller, address owner) external returns (uint256 requestId);
    function pendingRedeemRequest(uint256 requestId, address controller) external view returns (uint256 pendingShares);
    function claimableRedeemRequest(uint256 requestId, address controller)
        external
        view
        returns (uint256 claimableShares);
}

/// ERC-165 id 0x2f0a18c5: ERC-4626's functions (without ERC-20's) and `share`.
interface IERC7575 {
    function asset() external view returns (address);
    function share() external view returns (address);
    function totalAssets() external view returns (uint256);
    function convertToShares(uint256 assets) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function maxDeposit(address receiver) external view returns (uint256);
    function previewDeposit(uint256 assets) external view returns (uint256);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function maxMint(address receiver) external view returns (uint256);
    function previewMint(uint256 shares) external view returns (uint256);
    function mint(uint256 shares, address receiver) external returns (uint256 assets);
    function maxWithdraw(address owner) external view returns (uint256);
    function previewWithdraw(uint256 assets) external view returns (uint256);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function maxRedeem(address owner) external view returns (uint256);
    function previewRedeem(uint256 shares) external view returns (uint256);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}
