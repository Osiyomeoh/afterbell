use anchor_lang::prelude::*;

use crate::constants::VAULT_SEED;

/// Settlement timings and risk limits. Changes wait for the next roll, so a
/// round runs to the end on the rules it started with.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct Params {
    pub settle_window_secs: u32,
    pub void_delay_secs: u32,
    pub max_conf_bps: u16,
    /// The most a round may lock, as a share of the pool at its roll.
    pub max_utilization_bps: u16,
    /// The most one stock may lock in a round, as a share of the pool at its roll.
    pub max_feed_bps: u16,
    /// The keeper's cut of each premium, paid to whoever pays the position out.
    pub keeper_tip_bps: u16,
}

/// An underwriters' pool selling protection in one collateral mint. Its token
/// account holds the pool, premiums, queued deposits and redemptions owed.
///
/// Deposits and redemptions are requests filled at `roll`, which ends a round
/// once everything it sold is paid out: nothing is at risk then, so the pool's
/// value is exact and nobody joins or leaves at a stale price.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub authority: Pubkey,
    /// The ed25519 key whose signature prices every sale.
    pub quoter: Pubkey,
    pub collateral_mint: Pubkey,
    pub vault_token: Pubkey,
    /// The pool's shares (Token-2022, minted by the vault) and the vault's own
    /// account of them: queued redemptions wait there, filled deposits too.
    pub share_mint: Pubkey,
    pub share_escrow: Pubkey,
    /// 10^decimals of the collateral mint.
    pub collateral_unit: u64,
    pub params: Params,
    pub next_params: Params,
    pub params_queued: bool,
    /// The round in progress, its opening (0 until its first sale) and the
    /// pool's assets at the roll that began it, which its risk limits use.
    pub round: u64,
    pub round_open_ts: i64,
    pub round_nav: u64,
    /// Positions the round sold that aren't paid out yet. A position is paid
    /// only once its series settles or voids, so zero means the round is over.
    pub round_unpaid: u32,
    pub positions_sold: u64,
    /// The most the open positions could still pay.
    pub locked: u64,
    /// Keepers' tips on positions not yet paid out.
    pub tips_owed: u64,
    pub pending_deposit_assets: u64,
    pub pending_redeem_shares: u64,
    /// Filled redemptions not yet claimed.
    pub reserved_assets: u64,
    /// Where a position NFT's image is served: this plus the position's address.
    #[max_len(128)]
    pub art_uri: String,
    pub bump: u8,
    pub token_bump: u8,
    pub share_mint_bump: u8,
    pub share_escrow_bump: u8,
}

impl Vault {
    /// The vault PDA's signer seeds: it signs for its token accounts and mints.
    pub fn seeds(&self) -> [&[u8]; 4] {
        [VAULT_SEED, self.authority.as_ref(), self.collateral_mint.as_ref(), std::slice::from_ref(&self.bump)]
    }
}

/// Whether the vault sells protection on a Pyth feed, and the stock's ticker
/// (the positions' NFTs show it). Disallowing a feed stops new sales; positions
/// already sold still settle and pay.
#[account]
#[derive(InitSpace)]
pub struct FeedConfig {
    pub vault: Pubkey,
    pub feed_id: [u8; 32],
    pub allowed: bool,
    #[max_len(12)]
    pub symbol: String,
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
    /// The strikes sold, bounding the price it can settle at.
    pub lowest_lower: u64,
    pub highest_upper: u64,
    /// Maximum payouts of its positions not yet paid out.
    pub locked: u64,
    pub sold: u32,
    pub paid: u32,
    pub bump: u8,
}

/// One sale. Its address comes from the quote's nonce, so a quote buys once.
/// It's paid to whoever holds its NFT, and stays on-chain afterwards with what
/// it paid.
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub vault: Pubkey,
    pub series: Pubkey,
    pub buyer: Pubkey,
    /// Its NFT: a Token-2022 mint with a supply of one.
    pub mint: Pubkey,
    pub nonce: [u8; 32],
    /// Numbered in order of sale, from 1.
    pub number: u64,
    pub shares: u64,
    pub upper: u64,
    pub lower: u64,
    pub premium: u64,
    pub max_payout: u64,
    pub tip: u64,
    pub closed: bool,
    /// What it paid, and to whom: the payout, or the premium if its series voided.
    pub paid: u64,
    pub paid_to: Pubkey,
    pub bump: u8,
    pub mint_bump: u8,
}

/// An underwriter's queued deposit and redemption, and what earlier rolls
/// filled for them to claim.
#[account]
#[derive(InitSpace)]
pub struct Request {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub deposit_round: u64,
    pub deposit_assets: u64,
    pub redeem_round: u64,
    pub redeem_shares: u64,
    pub filled_deposit_assets: u64,
    pub filled_deposit_shares: u64,
    pub filled_redeem_shares: u64,
    pub filled_redeem_assets: u64,
    pub bump: u8,
}

/// The pool at the roll that ended a round: the price every request queued in
/// that round was filled at.
#[account]
#[derive(InitSpace)]
pub struct RoundRate {
    pub vault: Pubkey,
    pub round: u64,
    pub open_ts: i64,
    /// The pool's assets and share supply at the roll. Shares convert at
    /// (assets + 1) / (supply + 1): an empty pool starts at one share per unit.
    pub assets: u64,
    pub supply: u64,
    pub deposit_assets: u64,
    pub deposit_shares: u64,
    pub redeem_shares: u64,
    pub redeem_assets: u64,
    pub bump: u8,
}

/// A holder's standing order: protection on one stock renewed each night by any
/// keeper, within the holder's limits, paid from an allowance the holder gave
/// this account over their collateral. It is the quote's buyer; the NFT goes to
/// the holder.
#[account]
#[derive(InitSpace)]
pub struct Order {
    pub vault: Pubkey,
    pub holder: Pubkey,
    pub feed_id: [u8; 32],
    pub max_shares: u64,
    /// Where protection starts and stops, in bps below the price.
    pub start_bps: u16,
    pub depth_bps: u16,
    pub max_premium: u64,
    /// Renews for openings before this time.
    pub until: i64,
    /// The last opening renewed for, kept across a cancel so it can't renew twice.
    pub last_open_ts: i64,
    pub active: bool,
    pub bump: u8,
}
