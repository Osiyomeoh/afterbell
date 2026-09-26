use anchor_lang::prelude::*;

#[event]
pub struct ProtectionBought {
    pub vault: Pubkey,
    pub position: Pubkey,
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

#[event]
pub struct Claimed {
    pub position: Pubkey,
    pub buyer: Pubkey,
    pub amount: u64,
    pub refund: bool,
}
