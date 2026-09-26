use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};

use crate::{
    error::VaultError,
    events::{SeriesSettled, SeriesVoided},
    math,
    state::*,
};

// ---------------------------------------------------------------------- settle

/// Permissionless: anyone settles a series by supplying the Pyth update that is
/// the first print at or after the open.
#[derive(Accounts)]
pub struct Settle<'info> {
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, has_one = vault)]
    pub series: Box<Account<'info, Series>>,
    /// `Account` checks this is owned by the Pyth receiver program, so its
    /// contents were posted (and signature-checked) by Pyth, not by the caller.
    pub price_update: Box<Account<'info, PriceUpdateV2>>,
}

pub fn handle_settle(ctx: Context<Settle>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault = &ctx.accounts.vault;
    let series = &mut ctx.accounts.series;
    require!(series.state == SeriesState::Open, VaultError::SeriesNotOpen);
    require!(now >= series.open_ts, VaultError::TooEarly);

    let update = &ctx.accounts.price_update;
    require!(
        update.verification_level == VerificationLevel::Full,
        VaultError::InsufficientVerification
    );
    let msg = &update.price_message;
    require!(msg.feed_id == series.feed_id, VaultError::FeedMismatch);
    math::check_settlement_timing(
        msg.publish_time,
        msg.prev_publish_time,
        series.open_ts,
        vault.settle_window_secs,
    )?;
    require!(msg.price > 0, VaultError::NonPositivePrice);
    require!(
        math::confidence_ok(msg.price, msg.conf, vault.max_conf_bps),
        VaultError::ConfidenceTooWide
    );

    series.price = math::to_price_8(msg.price, msg.exponent)?;
    series.publish_time = msg.publish_time;
    series.state = SeriesState::Settled;
    emit!(SeriesSettled {
        series: series.key(),
        price: series.price,
        publish_time: msg.publish_time,
    });
    Ok(())
}

// ----------------------------------------------------------------- void_series

#[derive(Accounts)]
pub struct VoidSeries<'info> {
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, has_one = vault)]
    pub series: Box<Account<'info, Series>>,
}

/// Permissionless: a series nobody settled within the void delay voids, and
/// every premium in it is refunded.
pub fn handle_void_series(ctx: Context<VoidSeries>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let series = &mut ctx.accounts.series;
    require!(series.state == SeriesState::Open, VaultError::SeriesNotOpen);
    let deadline = series
        .open_ts
        .checked_add(ctx.accounts.vault.void_delay_secs as i64)
        .ok_or(VaultError::MathOverflow)?;
    require!(now > deadline, VaultError::VoidTooEarly);
    series.state = SeriesState::Voided;
    emit!(SeriesVoided { series: series.key() });
    Ok(())
}
