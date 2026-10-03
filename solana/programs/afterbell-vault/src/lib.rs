//! Afterbell vault: protection on a tokenized stock's next opening print, a put
//! spread paying `shares × clamp(upper − open, 0, upper − lower)`, underwritten
//! by a pool anyone can join. Sold against quotes the vault's quoter signs
//! (ed25519), each position an NFT paid to whoever holds it, settled
//! permissionlessly by the first Pyth print at or after the open.
//!
//! Rounds: one opening per round. Deposits and redemptions queue and fill at
//! `roll`, once everything the round sold is paid, at the pool's exact value.
//! Risk limits cap what a round, and one stock in it, may lock as shares of the
//! pool at its roll. Whoever pays positions out earns a tip from their premiums.
//! Standing orders renew a holder's protection each night through any keeper,
//! and a sizer the holder names may re-size one within the holder's bounds.

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod quote;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use quote::QuoteArgs;
pub use state::*;

declare_id!("J6n3JUafVkx4MpKTnAnZSwTcGFueRrjxgiXWMC4L7RGG");

#[program]
pub mod afterbell_vault {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>, quoter: Pubkey, params: Params, art_uri: String) -> Result<()> {
        instructions::admin::handle_initialize_vault(ctx, quoter, params, art_uri)
    }

    pub fn set_quoter(ctx: Context<Configure>, quoter: Pubkey) -> Result<()> {
        instructions::admin::handle_set_quoter(ctx, quoter)
    }

    pub fn set_params(ctx: Context<Configure>, params: Params) -> Result<()> {
        instructions::admin::handle_set_params(ctx, params)
    }

    pub fn set_art_uri(ctx: Context<Configure>, art_uri: String) -> Result<()> {
        instructions::admin::handle_set_art_uri(ctx, art_uri)
    }

    pub fn allow_feed(ctx: Context<AllowFeed>, feed_id: [u8; 32], symbol: String, allowed: bool) -> Result<()> {
        instructions::admin::handle_allow_feed(ctx, feed_id, symbol, allowed)
    }

    pub fn buy(ctx: Context<Buy>, q: QuoteArgs) -> Result<()> {
        instructions::buy::handle_buy(ctx, q)
    }

    pub fn set_order(ctx: Context<SetOrder>, feed_id: [u8; 32], terms: OrderTerms) -> Result<()> {
        instructions::orders::handle_set_order(ctx, feed_id, terms)
    }

    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        instructions::orders::handle_cancel_order(ctx)
    }

    pub fn set_sizer(ctx: Context<SetSizer>, bounds: SizerBounds) -> Result<()> {
        instructions::sizer::handle_set_sizer(ctx, bounds)
    }

    pub fn remove_sizer(ctx: Context<RemoveSizer>) -> Result<()> {
        instructions::sizer::handle_remove_sizer(ctx)
    }

    pub fn resize_order(ctx: Context<ResizeOrder>, max_shares: u64, start_bps: u16, depth_bps: u16) -> Result<()> {
        instructions::sizer::handle_resize_order(ctx, max_shares, start_bps, depth_bps)
    }

    pub fn renew(ctx: Context<Renew>, q: QuoteArgs) -> Result<()> {
        instructions::orders::handle_renew(ctx, q)
    }

    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        instructions::settle::handle_settle(ctx)
    }

    pub fn void_series(ctx: Context<VoidSeries>) -> Result<()> {
        instructions::settle::handle_void_series(ctx)
    }

    pub fn process<'info>(ctx: Context<'info, Process<'info>>) -> Result<()> {
        instructions::process::handle_process(ctx)
    }

    pub fn request_deposit(ctx: Context<RequestDeposit>, assets: u64) -> Result<()> {
        instructions::pool::handle_request_deposit(ctx, assets)
    }

    pub fn request_redeem(ctx: Context<RequestRedeem>, shares: u64) -> Result<()> {
        instructions::pool::handle_request_redeem(ctx, shares)
    }

    pub fn claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
        instructions::pool::handle_claim_deposit(ctx)
    }

    pub fn claim_redemption(ctx: Context<ClaimRedemption>) -> Result<()> {
        instructions::pool::handle_claim_redemption(ctx)
    }

    pub fn roll(ctx: Context<Roll>) -> Result<()> {
        instructions::pool::handle_roll(ctx)
    }
}
