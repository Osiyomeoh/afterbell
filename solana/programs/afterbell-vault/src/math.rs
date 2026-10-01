//! Pure settlement, payout and pool math, free of account types so it is unit-tested directly.

use crate::{
    constants::{BPS_DENOMINATOR, MAX_PRICE_RATIO, PRICE_DECIMALS, PRICE_SCALE, SHARE_SCALE},
    error::VaultError,
};

/// `a × b / c`, rounded down.
pub fn mul_div(a: u64, b: u64, c: u64) -> Result<u64, VaultError> {
    if c == 0 {
        return Err(VaultError::MathOverflow);
    }
    u64::try_from((a as u128) * (b as u128) / (c as u128)).map_err(|_| VaultError::MathOverflow)
}

/// `amount × bps / 10_000`, rounded down.
pub fn bps_of(amount: u64, bps: u16) -> u64 {
    // At most `amount`, since bps is checked to be at most 10_000 where it's set.
    ((amount as u128) * (bps as u128) / BPS_DENOMINATOR) as u64
}

/// The pool's assets: the vault's balance less what isn't the pool's (queued
/// deposits, redemptions owed, keepers' tips) and the most its open positions
/// could pay. Exact between a roll and the round's first sale, conservative
/// during a round.
pub fn total_assets(
    balance: u64,
    pending_deposits: u64,
    reserved: u64,
    tips_owed: u64,
    locked: u64,
) -> Result<u64, VaultError> {
    balance
        .checked_sub(pending_deposits)
        .and_then(|x| x.checked_sub(reserved))
        .and_then(|x| x.checked_sub(tips_owed))
        .and_then(|x| x.checked_sub(locked))
        .ok_or(VaultError::MathOverflow)
}

/// Shares for `assets` at a roll's rate, rounded down: each request's share
/// rounds down, so together they never exceed what the roll minted.
pub fn shares_for(assets: u64, pool_assets: u64, supply: u64) -> Result<u64, VaultError> {
    mul_div(assets, supply.checked_add(1).ok_or(VaultError::MathOverflow)?, pool_assets.checked_add(1).ok_or(VaultError::MathOverflow)?)
}

/// Assets for `shares` at a roll's rate, rounded down.
pub fn assets_for(shares: u64, pool_assets: u64, supply: u64) -> Result<u64, VaultError> {
    mul_div(shares, pool_assets.checked_add(1).ok_or(VaultError::MathOverflow)?, supply.checked_add(1).ok_or(VaultError::MathOverflow)?)
}

/// Whether a series with these strikes may settle at `price`: within
/// MAX_PRICE_RATIO of them.
pub fn plausible_price(price: u64, lowest_lower: u64, highest_upper: u64) -> bool {
    (price as u128) <= (highest_upper as u128) * MAX_PRICE_RATIO && (price as u128) * MAX_PRICE_RATIO >= lowest_lower as u128
}

/// Bytes a Token-2022 metadata entry takes: its type-length header, update
/// authority, mint, name, symbol, uri and extra fields, each string prefixed
/// by its length.
pub fn metadata_len(name: &str, symbol: &str, uri: &str, fields: &[(&str, &str)]) -> usize {
    4 + 32 + 32 + (4 + name.len()) + (4 + symbol.len()) + (4 + uri.len())
        + 4
        + fields.iter().map(|(k, v)| 8 + k.len() + v.len()).sum::<usize>()
}

/// A Pyth price (`price × 10^expo`) as an integer with 8 decimals. When the
/// feed carries more than 8 decimals the result rounds up: a higher settlement
/// price never pays a buyer more than the exact one would.
pub fn to_price_8(price: i64, expo: i32) -> Result<u64, VaultError> {
    if price <= 0 {
        return Err(VaultError::NonPositivePrice);
    }
    let shift = PRICE_DECIMALS
        .checked_add(expo)
        .ok_or(VaultError::MathOverflow)?;
    let p = price as u128;
    let scale = 10u128
        .checked_pow(shift.unsigned_abs())
        .ok_or(VaultError::MathOverflow)?;
    let out = if shift >= 0 {
        p.checked_mul(scale).ok_or(VaultError::MathOverflow)?
    } else {
        p.div_ceil(scale)
    };
    u64::try_from(out).map_err(|_| VaultError::MathOverflow)
}

/// `shares` (6 decimals) × a price difference (8 decimals), in collateral
/// units, rounded down.
pub fn payout_units(shares: u64, price_diff: u64, collateral_unit: u64) -> Result<u64, VaultError> {
    let v = (shares as u128)
        .checked_mul(price_diff as u128)
        .and_then(|x| x.checked_mul(collateral_unit as u128))
        .ok_or(VaultError::MathOverflow)?
        / (SHARE_SCALE * PRICE_SCALE);
    u64::try_from(v).map_err(|_| VaultError::MathOverflow)
}

/// What protection pays at an opening price: nothing at or above `upper`, the
/// loss below it, capped at `upper − lower`.
pub fn payout_at(
    shares: u64,
    upper: u64,
    lower: u64,
    price: u64,
    collateral_unit: u64,
) -> Result<u64, VaultError> {
    if price >= upper {
        return Ok(0);
    }
    let diff = (upper - price).min(upper.saturating_sub(lower));
    payout_units(shares, diff, collateral_unit)
}

/// True when `conf / price <= max_conf_bps / 10_000`. Requires `price > 0`.
pub fn confidence_ok(price: i64, conf: u64, max_conf_bps: u16) -> bool {
    if price <= 0 {
        return false;
    }
    (conf as u128) * BPS_DENOMINATOR <= (price as u128) * (max_conf_bps as u128)
}

/// Checks a Pyth update is *the* settlement price: published inside
/// `[open_ts, open_ts + window]`, and the first at or after `open_ts` (its
/// predecessor was published strictly before). The second condition stops a
/// settler from picking whichever price in the window suits them.
pub fn check_settlement_timing(
    publish_time: i64,
    prev_publish_time: i64,
    open_ts: i64,
    window_secs: u32,
) -> Result<(), VaultError> {
    if publish_time < open_ts {
        return Err(VaultError::PriceBeforeOpen);
    }
    let window_end = open_ts
        .checked_add(window_secs as i64)
        .ok_or(VaultError::MathOverflow)?;
    if publish_time > window_end {
        return Err(VaultError::PriceAfterWindow);
    }
    if prev_publish_time >= open_ts {
        return Err(VaultError::NotFirstPriceAfterOpen);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const USD: u64 = 1_000_000; // 6-decimal collateral

    #[test]
    fn converts_pyth_prices_to_8_decimals() {
        // Pyth equities use expo -5: $383.82840 -> 383.82840000
        assert_eq!(to_price_8(38_382_840, -5).unwrap(), 38_382_840_000);
        assert_eq!(to_price_8(12_345, -8).unwrap(), 12_345);
        assert_eq!(to_price_8(5, 0).unwrap(), 500_000_000);
    }

    #[test]
    fn rounds_finer_prices_up() {
        // 1.000000001 at expo -9 -> 1.00000001 (up), never down
        assert_eq!(to_price_8(1_000_000_001, -9).unwrap(), 100_000_001);
        assert_eq!(to_price_8(1_000_000_000, -9).unwrap(), 100_000_000);
    }

    #[test]
    fn rejects_non_positive_and_overflowing_prices() {
        assert_eq!(to_price_8(0, -5), Err(VaultError::NonPositivePrice));
        assert_eq!(to_price_8(-1, -5), Err(VaultError::NonPositivePrice));
        assert_eq!(to_price_8(i64::MAX, 0), Err(VaultError::MathOverflow));
    }

    #[test]
    fn pays_the_loss_between_upper_and_lower() {
        // 10 shares, $360 -> $340
        let (s, up, lo) = (10_000_000, 36_000_000_000, 34_000_000_000);
        assert_eq!(payout_at(s, up, lo, 36_500_000_000, USD).unwrap(), 0);
        assert_eq!(payout_at(s, up, lo, 36_000_000_000, USD).unwrap(), 0);
        assert_eq!(payout_at(s, up, lo, 35_500_000_000, USD).unwrap(), 50 * USD);
        assert_eq!(payout_at(s, up, lo, 34_000_000_000, USD).unwrap(), 200 * USD);
        assert_eq!(payout_at(s, up, lo, 1, USD).unwrap(), 200 * USD);
    }

    #[test]
    fn payout_rounds_down() {
        // 1 micro-share x $0.00000001 is far below a micro-dollar
        assert_eq!(payout_units(1, 1, USD).unwrap(), 0);
        // 0.333333 shares x $3 = $0.999999
        assert_eq!(payout_units(333_333, 300_000_000, USD).unwrap(), 999_999);
    }

    #[test]
    fn payout_at_extremes_does_not_overflow_silently() {
        assert!(payout_units(u64::MAX, u64::MAX, USD).is_err());
        assert!(payout_units(u64::MAX, 1, USD).is_ok());
    }

    #[test]
    fn confidence_bounds() {
        assert!(confidence_ok(10_000, 50, 100));
        assert!(confidence_ok(10_000, 100, 100));
        assert!(!confidence_ok(10_000, 101, 100));
        assert!(!confidence_ok(0, 0, 100));
        assert!(!confidence_ok(-5, 0, 100));
    }

    #[test]
    fn mul_div_rounds_down_and_refuses_zero_or_overflow() {
        assert_eq!(mul_div(10, 3, 4).unwrap(), 7);
        assert_eq!(mul_div(u64::MAX, u64::MAX, u64::MAX).unwrap(), u64::MAX);
        assert_eq!(mul_div(1, 1, 0), Err(VaultError::MathOverflow));
        assert_eq!(mul_div(u64::MAX, 2, 1), Err(VaultError::MathOverflow));
    }

    #[test]
    fn tips_are_a_share_of_the_premium() {
        assert_eq!(bps_of(4 * USD, 200), 80_000); // 2% of $4
        assert_eq!(bps_of(49, 200), 0);
        assert_eq!(bps_of(u64::MAX, 10_000), u64::MAX);
    }

    #[test]
    fn total_assets_excludes_what_is_not_the_pools() {
        assert_eq!(total_assets(1_000, 100, 200, 10, 300).unwrap(), 390);
        assert_eq!(total_assets(1_000, 1_000, 0, 0, 0).unwrap(), 0);
        assert_eq!(total_assets(1_000, 900, 0, 0, 101), Err(VaultError::MathOverflow));
    }

    #[test]
    fn an_empty_pool_starts_at_one_share_per_unit() {
        assert_eq!(shares_for(1_000 * USD, 0, 0).unwrap(), 1_000 * USD);
        assert_eq!(assets_for(1_000 * USD, 0, 0).unwrap(), 1_000 * USD);
    }

    #[test]
    fn shares_follow_the_pools_value() {
        // A pool of 101 assets and 100 shares: a share is worth (101+1)/(100+1).
        assert_eq!(shares_for(102, 101, 100).unwrap(), 101);
        assert_eq!(assets_for(101, 101, 100).unwrap(), 102);
        // Round trips never create value.
        for (a, s) in [(99_991_576_800u64, 100_000_000_000u64), (7, 3), (1, 1_000_000)] {
            for x in [1u64, 13, 999_999, 1_000_000_000] {
                assert!(assets_for(shares_for(x, a, s).unwrap(), a, s).unwrap() <= x);
            }
        }
    }

    #[test]
    fn plausible_prices_are_within_ten_times_the_strikes() {
        let (lo, hi) = (34_000_000_000, 36_000_000_000);
        assert!(plausible_price(35_500_000_000, lo, hi));
        assert!(plausible_price(360_000_000_000, lo, hi));
        assert!(!plausible_price(360_000_000_001, lo, hi));
        assert!(plausible_price(3_400_000_000, lo, hi));
        assert!(!plausible_price(3_399_999_999, lo, hi));
    }

    #[test]
    fn metadata_length_counts_every_string() {
        assert_eq!(metadata_len("", "", "", &[]), 84);
        assert_eq!(metadata_len("Afterbell #1 TSLA", "BELL", "https://x/", &[("position", "abc")]), 84 + 17 + 4 + 10 + 8 + 8 + 3);
    }

    #[test]
    fn settlement_timing() {
        let t = 1_000;
        assert!(check_settlement_timing(1_000, 990, t, 60).is_ok());
        assert!(check_settlement_timing(1_060, 999, t, 60).is_ok());
        assert_eq!(check_settlement_timing(999, 990, t, 60), Err(VaultError::PriceBeforeOpen));
        assert_eq!(check_settlement_timing(1_061, 999, t, 60), Err(VaultError::PriceAfterWindow));
        assert_eq!(check_settlement_timing(1_005, 1_000, t, 60), Err(VaultError::NotFirstPriceAfterOpen));
    }
}
