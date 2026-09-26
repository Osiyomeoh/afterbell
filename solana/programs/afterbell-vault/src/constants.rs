pub const VAULT_SEED: &[u8] = b"vault";
pub const VAULT_TOKEN_SEED: &[u8] = b"vault_token";
pub const FEED_SEED: &[u8] = b"feed";
pub const SERIES_SEED: &[u8] = b"series";
pub const POSITION_SEED: &[u8] = b"position";

/// Prices carry 8 decimals (as on the EVM vault); share amounts carry 6.
pub const PRICE_DECIMALS: i32 = 8;
pub const PRICE_SCALE: u128 = 100_000_000;
pub const SHARE_SCALE: u128 = 1_000_000;

/// How long after the open a settlement print may be published. Pyth equity
/// feeds print many times a second in session, so a minute is generous; an hour
/// is the most a vault may allow.
pub const MIN_SETTLE_WINDOW_SECS: u32 = 1;
pub const MAX_SETTLE_WINDOW_SECS: u32 = 3_600;

/// How long after the open anyone may void a series nobody settled. The floor
/// gives keepers time; the ceiling stops collateral being locked for no reason.
pub const MIN_VOID_DELAY_SECS: u32 = 3_600;
pub const MAX_VOID_DELAY_SECS: u32 = 7 * 24 * 3_600;

/// Widest Pyth confidence interval a vault may accept, as a share of price.
pub const MAX_CONF_BPS_LIMIT: u16 = 1_000;
pub const BPS_DENOMINATOR: u128 = 10_000;
