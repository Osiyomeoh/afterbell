use anchor_lang::prelude::*;

/// Sells protection in one collateral mint. Its token account holds deposits
/// and premiums; `locked` is what open positions could still pay out.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub authority: Pubkey,
    /// The ed25519 key whose signature prices every sale.
    pub quoter: Pubkey,
    pub collateral_mint: Pubkey,
    pub vault_token: Pubkey,
    /// 10^decimals of the collateral mint.
    pub collateral_unit: u64,
    pub locked: u64,
    pub settle_window_secs: u32,
    pub void_delay_secs: u32,
    pub max_conf_bps: u16,
    pub bump: u8,
    pub token_bump: u8,
}

/// Whether the vault sells protection on a Pyth feed. Disallowing a feed stops
/// new sales; positions already sold still settle and claim.
#[account]
#[derive(InitSpace)]
pub struct FeedConfig {
    pub vault: Pubkey,
    pub feed_id: [u8; 32],
    pub allowed: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum SeriesState {
    Open,
    Settled,
    Voided,
}

/// Every position on one feed for one open settles together, on one price.
#[account]
#[derive(InitSpace)]
pub struct Series {
    pub vault: Pubkey,
    pub feed_id: [u8; 32],
    pub open_ts: i64,
    pub state: SeriesState,
    /// Settlement price with 8 decimals.
    pub price: u64,
    pub publish_time: i64,
    pub bump: u8,
}

/// One sale. Its address comes from the quote's nonce, so a quote buys once.
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub vault: Pubkey,
    pub series: Pubkey,
    pub buyer: Pubkey,
    pub nonce: [u8; 32],
    pub shares: u64,
    pub upper: u64,
    pub lower: u64,
    pub premium: u64,
    pub max_payout: u64,
    pub bump: u8,
}
