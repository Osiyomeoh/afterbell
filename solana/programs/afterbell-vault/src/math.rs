//! Pure settlement and payout math, free of account types so it is unit-tested directly.

use crate::{
    constants::{BPS_DENOMINATOR, PRICE_DECIMALS, PRICE_SCALE, SHARE_SCALE},
    error::VaultError,
};

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
    fn settlement_timing() {
        let t = 1_000;
        assert!(check_settlement_timing(1_000, 990, t, 60).is_ok());
        assert!(check_settlement_timing(1_060, 999, t, 60).is_ok());
        assert_eq!(check_settlement_timing(999, 990, t, 60), Err(VaultError::PriceBeforeOpen));
        assert_eq!(check_settlement_timing(1_061, 999, t, 60), Err(VaultError::PriceAfterWindow));
        assert_eq!(check_settlement_timing(1_005, 1_000, t, 60), Err(VaultError::NotFirstPriceAfterOpen));
    }
}
