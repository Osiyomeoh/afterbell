use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::VaultError,
    events::{OrderResized, SizerRemoved, SizerSet},
    state::*,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct SizerBounds {
    pub sizer: Pubkey,
    pub max_shares: u64,
    pub min_start_bps: u16,
    pub max_depth_bps: u16,
}

#[derive(Accounts)]
pub struct SetSizer<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(has_one = holder)]
    pub order: Box<Account<'info, Order>>,
    #[account(
        init_if_needed,
        payer = holder,
        space = 8 + Sizer::INIT_SPACE,
        seeds = [SIZER_SEED, order.key().as_ref()],
        bump
    )]
    pub sizer: Box<Account<'info, Sizer>>,
    pub system_program: Program<'info, System>,
}

/// Names (or replaces) who may re-size the holder's order, and how far.
pub fn handle_set_sizer(ctx: Context<SetSizer>, b: SizerBounds) -> Result<()> {
    require!(
        b.sizer != Pubkey::default()
            && b.max_shares > 0
            && b.min_start_bps > 0
            && b.min_start_bps < b.max_depth_bps
            && (b.max_depth_bps as u128) < BPS_DENOMINATOR,
        VaultError::InvalidSizer
    );
    let order = ctx.accounts.order.key();
    let s = &mut ctx.accounts.sizer;
    s.order = order;
    s.sizer = b.sizer;
    s.max_shares = b.max_shares;
    s.min_start_bps = b.min_start_bps;
    s.max_depth_bps = b.max_depth_bps;
    s.bump = ctx.bumps.sizer;
    emit!(SizerSet { order, sizer: b.sizer, max_shares: b.max_shares, min_start_bps: b.min_start_bps, max_depth_bps: b.max_depth_bps });
    Ok(())
}

#[derive(Accounts)]
pub struct RemoveSizer<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(has_one = holder)]
    pub order: Box<Account<'info, Order>>,
    #[account(mut, close = holder, seeds = [SIZER_SEED, order.key().as_ref()], bump = sizer.bump)]
    pub sizer: Box<Account<'info, Sizer>>,
}

pub fn handle_remove_sizer(ctx: Context<RemoveSizer>) -> Result<()> {
    emit!(SizerRemoved { order: ctx.accounts.order.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct ResizeOrder<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub order: Box<Account<'info, Order>>,
    #[account(
        seeds = [SIZER_SEED, order.key().as_ref()],
        bump = sizer.bump,
        constraint = sizer.sizer == signer.key() @ VaultError::NotSizer,
    )]
    pub sizer: Box<Account<'info, Sizer>>,
}

/// The sizer sets the order's shares and band; the premium cap and allowance stay the holder's.
pub fn handle_resize_order(ctx: Context<ResizeOrder>, max_shares: u64, start_bps: u16, depth_bps: u16) -> Result<()> {
    let s = &ctx.accounts.sizer;
    require!(
        max_shares > 0
            && max_shares <= s.max_shares
            && start_bps >= s.min_start_bps
            && start_bps < depth_bps
            && depth_bps <= s.max_depth_bps,
        VaultError::OutsideSizerBounds
    );
    let order = &mut ctx.accounts.order;
    order.max_shares = max_shares;
    order.start_bps = start_bps;
    order.depth_bps = depth_bps;
    emit!(OrderResized { order: order.key(), sizer: s.sizer, max_shares, start_bps, depth_bps });
    Ok(())
}
