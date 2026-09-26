// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title What a position's NFT shows
/// @notice The token's metadata and image, drawn on-chain from the vault's own record: the stock, the
/// opening, the payoff (flat at the maximum below the lower strike, falling to nothing at the upper),
/// and, once the bell has rung, where it opened and what the position paid.
library PositionArt {
    using Strings for uint256;

    /// @dev Everything the card shows. Prices carry 8 decimals, money 6, shares 6.
    struct Card {
        uint256 id;
        string symbol;
        uint64 openTs;
        uint64 shares;
        uint64 upper;
        uint64 lower;
        uint128 premium;
        uint128 maxPayout;
        /// 0 open, 1 settled, 2 voided (the vault's SeriesState).
        uint8 state;
        uint64 price;
        /// What it pays at `price` (settled) or paid, and whether it has been paid out.
        uint256 payout;
        bool closed;
    }

    string private constant GOLD = "#c9a45c";
    string private constant INK = "#101214";
    string private constant TEXT = "#ecebe7";
    string private constant MUTED = "#8b9098";
    string private constant GAIN = "#6fcf97";

    function tokenURI(Card memory c) internal pure returns (string memory) {
        string memory head = string.concat(
            '{"name":"Afterbell protection #',
            c.id.toString(),
            " (",
            c.symbol,
            ')","description":"A put spread on ',
            c.symbol,
            "'s next opening print, settled on-chain on Chainlink's price in force at 09:30 ET. Its payout goes to whoever holds this token. Collateral is TestUSD, which has no value.\""
        );
        string memory json = string.concat(
            head,
            ',"image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg(c))),
            '","attributes":',
            _attributes(c),
            "}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function svg(Card memory c) internal pure returns (string memory) {
        string memory head = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" font-family="ui-monospace,Menlo,monospace"><rect width="400" height="400" rx="22" fill="',
            INK,
            '"/>',
            _text(28, 46, 12, GOLD, string.concat("AFTERBELL  PROTECTION #", c.id.toString())),
            '<text x="28" y="98" font-size="44" font-family="Georgia,serif" fill="',
            TEXT,
            '">',
            c.symbol,
            "</text>"
        );
        string memory foot = string.concat(
            _text(28, 338, 14, TEXT, string.concat(_shares(c.shares), " shares  |  paid $", _money(c.premium))),
            _text(28, 364, 14, _statusColor(c), _status(c)),
            "</svg>"
        );
        return string.concat(
            head, _text(28, 126, 13, MUTED, string.concat("until the 09:30 ET open, ", _date(c.openTs))), _chart(c), foot
        );
    }

    // ------------------------------------------------------------- the chart

    function _chart(Card memory c) private pure returns (string memory out) {
        // Price axis from 0.75 spreads below the lower strike to 0.75 above the upper one.
        uint256 pad = (uint256(c.upper) - c.lower) * 3 / 4 + 1;
        uint256 lo = c.lower > pad ? c.lower - pad : 0;
        uint256 hi = uint256(c.upper) + pad;
        out = string.concat(_payoff(c, _x(c.lower, lo, hi), _x(c.upper, lo, hi)), _labels(c, lo, hi));
        if (c.state == 1) {
            string memory xp = _x(c.price, lo, hi).toString();
            out = string.concat(
                out, '<line x1="', xp, '" y1="150" x2="', xp, '" y2="292" stroke="', TEXT, '" stroke-dasharray="4 4"/>'
            );
        }
    }

    function _payoff(Card memory c, uint256 xl, uint256 xu) private pure returns (string memory) {
        return string.concat(
            '<line x1="28" y1="292" x2="372" y2="292" stroke="#2a2e33"/><polyline fill="none" stroke="',
            GOLD,
            '" stroke-width="3" stroke-linejoin="round" points="28,176 ',
            xl.toString(),
            ",176 ",
            xu.toString(),
            ',292 372,292"/>',
            _text(28, 166, 12, MUTED, string.concat("pays up to $", _money(c.maxPayout)))
        );
    }

    function _labels(Card memory c, uint256 lo, uint256 hi) private pure returns (string memory) {
        return string.concat(
            _text(_x(c.lower, lo, hi), 312, 11, MUTED, string.concat("$", _price(c.lower))),
            _text(_x(c.upper, lo, hi), 312, 11, MUTED, string.concat("$", _price(c.upper)))
        );
    }

    /// @dev A price's x position on the chart, clamped to its edges.
    function _x(uint256 p, uint256 lo, uint256 hi) private pure returns (uint256) {
        if (p <= lo) return 28;
        if (p >= hi) return 372;
        return 28 + (p - lo) * 344 / (hi - lo);
    }

    // ------------------------------------------------------------- the words

    function _status(Card memory c) private pure returns (string memory) {
        if (c.state == 0) return "Open until the bell";
        if (c.state == 2) return c.closed ? "Voided: premium refunded" : "Voided: premium to refund";
        return string.concat(
            "Opened at $", _price(c.price), c.closed ? "  |  paid $" : "  |  pays $", _money(c.payout)
        );
    }

    function _statusColor(Card memory c) private pure returns (string memory) {
        return c.state == 1 && c.payout > 0 ? GAIN : c.state == 0 ? TEXT : MUTED;
    }

    function _attributes(Card memory c) private pure returns (string memory) {
        string memory status = c.state == 0 ? "Open" : c.state == 2 ? "Voided" : c.closed ? "Paid" : "Settled";
        return string.concat(
            "[",
            _trait("Stock", c.symbol),
            ",",
            _trait("Opening", _date(c.openTs)),
            ",",
            _trait("Shares", _shares(c.shares)),
            ",",
            _trait("Protected from", string.concat("$", _price(c.upper))),
            ",",
            string.concat(
                _trait("Down to", string.concat("$", _price(c.lower))),
                ",",
                _trait("Premium", string.concat("$", _money(c.premium))),
                ",",
                _trait("Pays up to", string.concat("$", _money(c.maxPayout))),
                ",",
                _trait("Status", status),
                "]"
            )
        );
    }

    function _trait(string memory name, string memory value) private pure returns (string memory) {
        return string.concat('{"trait_type":"', name, '","value":"', value, '"}');
    }

    function _text(uint256 x, uint256 y, uint256 size, string memory fill, string memory body)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            '<text x="',
            x.toString(),
            '" y="',
            y.toString(),
            '" font-size="',
            size.toString(),
            '" fill="',
            fill,
            '">',
            body,
            "</text>"
        );
    }

    // --------------------------------------------------------- number formats

    /// @dev A price with 8 decimals as dollars and cents, rounded down: 38382840000 is "383.82".
    function _price(uint256 p) private pure returns (string memory) {
        return _fixed(p / 1e6, 2);
    }

    /// @dev Money with 6 decimals as dollars and cents, rounded down.
    function _money(uint256 m) private pure returns (string memory) {
        return _fixed(m / 1e4, 2);
    }

    /// @dev Shares with 6 decimals, without trailing zeros: 10000000 is "10", 2500000 is "2.5".
    function _shares(uint256 s) private pure returns (string memory) {
        uint256 whole = s / 1e6;
        uint256 frac = s % 1e6;
        if (frac == 0) return whole.toString();
        uint256 digits = 6;
        while (frac % 10 == 0) {
            frac /= 10;
            digits--;
        }
        return string.concat(whole.toString(), ".", _pad(frac, digits));
    }

    function _fixed(uint256 v, uint256 places) private pure returns (string memory) {
        uint256 unit = 10 ** places;
        return string.concat((v / unit).toString(), ".", _pad(v % unit, places));
    }

    function _pad(uint256 v, uint256 digits) private pure returns (string memory s) {
        s = v.toString();
        while (bytes(s).length < digits) s = string.concat("0", s);
    }

    /// @dev The UTC date of a timestamp, as "28 Sep 2026". Every US opening falls on the same date in
    /// UTC as in New York. Civil-from-days, after Howard Hinnant.
    function _date(uint256 ts) private pure returns (string memory) {
        uint256 z = ts / 86_400 + 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 day = doy - (153 * mp + 2) / 5 + 1;
        uint256 month = mp < 10 ? mp + 3 : mp - 9;
        uint256 year = yoe + era * 400 + (month <= 2 ? 1 : 0);
        string memory names = "JanFebMarAprMayJunJulAugSepOctNovDec";
        bytes memory m = new bytes(3);
        for (uint256 i; i < 3; ++i) m[i] = bytes(names)[(month - 1) * 3 + i];
        return string.concat(day.toString(), " ", string(m), " ", year.toString());
    }
}
