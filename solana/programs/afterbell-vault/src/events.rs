use anchor_lang::prelude::*;

use crate::state::Params;

#[event]
pub struct ProtectionBought {
    pub vault: Pubkey,
    pub position: Pubkey,
    pub mint: Pubkey,
    pub number: u64,
    pub buyer: Pubkey,
    pub feed_id: [u8; 32],
    pub open_ts: i64,
    pub shares: u64,
    pub upper: u64,
    pub lower: u64,
    pub premium: u64,
    pub max_payout: u64,
}

#[event]
pub struct SeriesSettled {
    pub series: Pubkey,
    pub price: u64,
    pub publish_time: i64,
}

#[event]
pub struct SeriesVoided {
    pub series: Pubkey,
}

/// A position paid out to whoever held its NFT (or refunded, if its series voided).
#[event]
pub struct Paid {
    pub position: Pubkey,
    pub holder: Pubkey,
    pub amount: u64,
    pub refund: bool,
}

/// A position whose NFT was burned: nobody holds it, so its payout stays in the pool.
#[event]
pub struct Forfeited {
    pub position: Pubkey,
    /// What it would have paid.
    pub amount: u64,
}

#[event]
pub struct Processed {
    pub series: Pubkey,
    pub positions: u32,
    pub keeper: Pubkey,
    pub tips: u64,
}

#[event]
pub struct Rolled {
    pub vault: Pubkey,
    pub round: u64,
    pub open_ts: i64,
    pub assets: u64,
    pub supply: u64,
    pub deposit_assets: u64,
    pub deposit_shares: u64,
    pub redeem_shares: u64,
    pub redeem_assets: u64,
}

#[event]
pub struct DepositRequested {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub round: u64,
    pub assets: u64,
}

#[event]
pub struct RedeemRequested {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub round: u64,
    pub shares: u64,
}

#[event]
pub struct DepositClaimed {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub assets: u64,
    pub shares: u64,
}

#[event]
pub struct RedemptionClaimed {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub shares: u64,
    pub assets: u64,
}

#[event]
pub struct ParamsQueued {
    pub vault: Pubkey,
    pub params: Params,
}

#[event]
pub struct ParamsSet {
    pub vault: Pubkey,
    pub params: Params,
}

#[event]
pub struct OrderSet {
    pub vault: Pubkey,
    pub order: Pubkey,
    pub holder: Pubkey,
    pub feed_id: [u8; 32],
    pub max_shares: u64,
    pub start_bps: u16,
    pub depth_bps: u16,
    pub max_premium: u64,
    pub until: i64,
}

#[event]
pub struct OrderCancelled {
    pub vault: Pubkey,
    pub order: Pubkey,
    pub holder: Pubkey,
}

#[event]
pub struct SizerSet {
    pub order: Pubkey,
    pub sizer: Pubkey,
    pub max_shares: u64,
    pub min_start_bps: u16,
    pub max_depth_bps: u16,
}

#[event]
pub struct SizerRemoved {
    pub order: Pubkey,
}

#[event]
pub struct OrderResized {
    pub order: Pubkey,
    pub sizer: Pubkey,
    pub max_shares: u64,
    pub start_bps: u16,
    pub depth_bps: u16,
}
