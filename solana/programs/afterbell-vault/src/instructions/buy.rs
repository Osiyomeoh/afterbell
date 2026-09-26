use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::{
    constants::*,
    error::VaultError,
    events::ProtectionBought,
    math,
    quote::{quote_message, verify_ed25519_ix, QuoteArgs},
    state::*,
};

#[derive(Accounts)]
#[instruction(q: QuoteArgs)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, has_one = collateral_mint, has_one = vault_token)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        seeds = [FEED_SEED, vault.key().as_ref(), q.feed_id.as_ref()],
        bump = feed_config.bump,
        constraint = feed_config.allowed @ VaultError::FeedNotAllowed,
    )]
    pub feed_config: Box<Account<'info, FeedConfig>>,
    #[account(
        init_if_needed,
        payer = buyer,
        space = 8 + Series::INIT_SPACE,
        seeds = [SERIES_SEED, vault.key().as_ref(), q.feed_id.as_ref(), &q.open_ts.to_le_bytes()],
        bump
    )]
    pub series: Box<Account<'info, Series>>,
    /// Derived from the quote's nonce: a second purchase with the same quote fails here.
    #[account(
        init,
        payer = buyer,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, vault.key().as_ref(), q.nonce.as_ref()],
        bump
    )]
    pub position: Box<Account<'info, Position>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = collateral_mint, token::authority = buyer)]
    pub buyer_token: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: the instructions sysvar, checked by address; read to find the ed25519 verification.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Buys protection at a price the vault's quoter signed for this buyer. The
/// instruction right before this one must be the Ed25519 program verifying
/// that signature over `quote_message(...)`.
pub fn handle_buy(ctx: Context<Buy>, q: QuoteArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now <= q.expiry, VaultError::QuoteExpired);
    require!(now < q.open_ts, VaultError::AlreadyOpen);
    require!(q.shares > 0 && q.upper > q.lower, VaultError::InvalidProtection);

    let vault_key = ctx.accounts.vault.key();
    let vault = &mut ctx.accounts.vault;
    let max_payout = math::payout_units(q.shares, q.upper - q.lower, vault.collateral_unit)?;
    require!(max_payout > 0 && q.premium <= max_payout, VaultError::InvalidProtection);

    // The signature: the previous instruction verified this exact quote with the quoter's key.
    let ixs = ctx.accounts.instructions.to_account_info();
    let current = load_current_index_checked(&ixs)? as usize;
    require!(current > 0, VaultError::MissingSignature);
    let prev = load_instruction_at_checked(current - 1, &ixs)?;
    let message = quote_message(ctx.program_id, &vault_key, &ctx.accounts.buyer.key(), &q);
    verify_ed25519_ix(&prev, &vault.quoter, &message)?;

    let series = &mut ctx.accounts.series;
    if series.vault == Pubkey::default() {
        series.vault = vault_key;
        series.feed_id = q.feed_id;
        series.open_ts = q.open_ts;
        series.state = SeriesState::Open;
        series.bump = ctx.bumps.series;
    }
    require!(series.state == SeriesState::Open, VaultError::SeriesNotOpen);

    let position = &mut ctx.accounts.position;
    position.vault = vault_key;
    position.series = series.key();
    position.buyer = ctx.accounts.buyer.key();
    position.nonce = q.nonce;
    position.shares = q.shares;
    position.upper = q.upper;
    position.lower = q.lower;
    position.premium = q.premium;
    position.max_payout = max_payout;
    position.bump = ctx.bumps.position;

    vault.locked = vault.locked.checked_add(max_payout).ok_or(VaultError::MathOverflow)?;

    if q.premium > 0 {
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.buyer_token.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.vault_token.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            q.premium,
            ctx.accounts.collateral_mint.decimals,
        )?;
    }
    // The premium counts toward the collateral that backs the payout.
    ctx.accounts.vault_token.reload()?;
    require!(
        vault.locked <= ctx.accounts.vault_token.amount,
        VaultError::InsufficientCollateral
    );

    emit!(ProtectionBought {
        vault: vault_key,
        position: position.key(),
        buyer: position.buyer,
        feed_id: q.feed_id,
        open_ts: q.open_ts,
        shares: q.shares,
        upper: q.upper,
        lower: q.lower,
        premium: q.premium,
        max_payout,
    });
    Ok(())
}
