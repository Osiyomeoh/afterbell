// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {AfterbellVault} from "./AfterbellVault.sol";
import {PositionArt} from "./PositionArt.sol";

/// @title Afterbell positions
/// @notice One NFT per protection the vault sells. Whoever holds it is paid when its series settles,
/// so a position can be sold, lent against, or held by another contract. The vault deploys this
/// contract and is the only one that can mint. The image is drawn on-chain from the vault's record
/// and changes as the position does: open, then where it opened and what it paid.
contract AfterbellPositions is ERC721 {
    AfterbellVault public immutable vault;

    error OnlyVault();

    constructor() ERC721("Afterbell Protection", "BELL") {
        vault = AfterbellVault(msg.sender);
    }

    function mint(address to, uint256 id) external {
        if (msg.sender != address(vault)) revert OnlyVault();
        _mint(to, id);
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return PositionArt.tokenURI(card(id));
    }

    /// @notice What the token shows, read from the vault.
    function card(uint256 id) public view returns (PositionArt.Card memory c) {
        AfterbellVault.Position memory p = vault.position(id);
        AfterbellVault.Series memory s = vault.series(vault.seriesKey(p.feed, p.openTs));
        c = PositionArt.Card({
            id: id,
            symbol: vault.feedSymbol(p.feed),
            openTs: p.openTs,
            shares: p.shares,
            upper: p.upper,
            lower: p.lower,
            premium: p.premium,
            maxPayout: p.maxPayout,
            state: uint8(s.state),
            price: s.price,
            payout: 0,
            closed: p.closed
        });
        if (p.closed) c.payout = p.paid;
        else if (s.state == AfterbellVault.SeriesState.Settled) c.payout = vault.payoutAt(p.shares, p.upper, p.lower, s.price);
    }
}
