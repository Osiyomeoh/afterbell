use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    constants::*,
    error::VaultError,
    events::Claimed,
    instructions::admin::transfer_from_vault,
    math,
    state::*,
};

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut, has_one = collateral_mint, has_one = vault_token)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(has_one = vault)]
    pub series: Box<Account<'info, Series>>,
    #[account(
        mut,
        close = buyer,
        seeds = [POSITION_SEED, vault.key().as_ref(), position.nonce.as_ref()],
        bump = position.bump,
        has_one = vault,
        has_one = series,
        has_one = buyer,
    )]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: the position's buyer (enforced by `has_one`); receives the position's rent.
    #[account(mut)]
    pub buyer: UncheckedAccount<'info>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = collateral_mint, token::authority = buyer)]
    pub buyer_token: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Pays a position out (or refunds its premium if the series voided) and
/// closes it. Anyone can call it; the money always goes to the buyer's own
/// token account, so a keeper can claim for everyone.
pub fn handle_claim(ctx: Context<Claim>) -> Result<()> {
    let series = &ctx.accounts.series;
    let position = &ctx.accounts.position;
    let vault = &mut ctx.accounts.vault;

    let (amount, refund) = match series.state {
        SeriesState::Open => return err!(VaultError::NotClaimable),
        SeriesState::Voided => (position.premium, true),
        SeriesState::Settled => (
            math::payout_at(position.shares, position.upper, position.lower, series.price, vault.collateral_unit)?,
            false,
        ),
    };
    vault.locked = vault
        .locked
        .checked_sub(position.max_payout)
        .ok_or(VaultError::MathOverflow)?;

    if amount > 0 {
        transfer_from_vault(
            vault,
            &ctx.accounts.token_program,
            &ctx.accounts.vault_token,
            &ctx.accounts.collateral_mint,
            &ctx.accounts.buyer_token.to_account_info(),
            amount,
        )?;
    }
    emit!(Claimed {
        position: position.key(),
        buyer: position.buyer,
        amount,
        refund,
    });
    Ok(())
}
