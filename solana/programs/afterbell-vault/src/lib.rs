//! Afterbell vault: protection on a tokenized stock's next opening print, a put
//! spread paying `shares × clamp(upper − open, 0, upper − lower)`. Sold against
//! quotes the vault's quoter signs (ed25519), backed by collateral locked at
//! the maximum payout, and settled permissionlessly by the first Pyth print at
//! or after the open.

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

declare_id!("6J5BHSf1yWup7SXae5xS2nzNUbtz7Bq3VpfJTtxr7Dsc");

#[program]
pub mod afterbell_vault {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>, config: VaultConfig) -> Result<()> {
        instructions::admin::handle_initialize_vault(ctx, config)
    }

    pub fn set_config(ctx: Context<SetConfig>, config: VaultConfig) -> Result<()> {
        instructions::admin::handle_set_config(ctx, config)
    }

    pub fn allow_feed(ctx: Context<AllowFeed>, feed_id: [u8; 32], allowed: bool) -> Result<()> {
        instructions::admin::handle_allow_feed(ctx, feed_id, allowed)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::admin::handle_deposit(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::admin::handle_withdraw(ctx, amount)
    }

    pub fn buy(ctx: Context<Buy>, q: QuoteArgs) -> Result<()> {
        instructions::buy::handle_buy(ctx, q)
    }

    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        instructions::settle::handle_settle(ctx)
    }

    pub fn void_series(ctx: Context<VoidSeries>) -> Result<()> {
        instructions::settle::handle_void_series(ctx)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::handle_claim(ctx)
    }
}
