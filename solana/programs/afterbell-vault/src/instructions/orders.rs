use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Approve, Mint, Revoke, Token, TokenAccount, TransferChecked},
    token_2022::Token2022,
    token_interface::{Mint as NftMint, TokenAccount as NftAccount},
};
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};

use crate::{
    constants::*,
    error::VaultError,
    events::{OrderCancelled, OrderSet},
    instructions::buy::{check_quote, sell, Sale},
    math,
    quote::QuoteArgs,
    state::*,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct OrderTerms {
    pub max_shares: u64,
    pub start_bps: u16,
    pub depth_bps: u16,
    pub max_premium: u64,
    pub until: i64,
    /// What renewals may spend in all: the order's allowance over the holder's collateral.
    pub allowance: u64,
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct SetOrder<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(has_one = collateral_mint)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        seeds = [FEED_SEED, vault.key().as_ref(), feed_id.as_ref()],
        bump = feed_config.bump,
        constraint = feed_config.allowed @ VaultError::FeedNotAllowed,
    )]
    pub feed_config: Box<Account<'info, FeedConfig>>,
    #[account(
        init_if_needed,
        payer = holder,
        space = 8 + Order::INIT_SPACE,
        seeds = [ORDER_SEED, vault.key().as_ref(), holder.key().as_ref(), feed_id.as_ref()],
        bump
    )]
    pub order: Box<Account<'info, Order>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = collateral_mint, token::authority = holder)]
    pub holder_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Sets (or replaces) the holder's standing order on one stock, and lets it
/// spend up to `allowance` of their collateral on renewals.
pub fn handle_set_order(ctx: Context<SetOrder>, feed_id: [u8; 32], t: OrderTerms) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        t.max_shares > 0
            && t.max_premium > 0
            && t.start_bps > 0
            && t.start_bps < t.depth_bps
            && (t.depth_bps as u128) < BPS_DENOMINATOR
            && t.until > now,
        VaultError::InvalidOrder
    );
    let a = ctx.accounts;
    let order = &mut a.order;
    if order.vault == Pubkey::default() {
        order.vault = a.vault.key();
        order.holder = a.holder.key();
        order.feed_id = feed_id;
        order.bump = ctx.bumps.order;
    }
    order.max_shares = t.max_shares;
    order.start_bps = t.start_bps;
    order.depth_bps = t.depth_bps;
    order.max_premium = t.max_premium;
    order.until = t.until;
    order.active = true;

    token::approve(
        CpiContext::new(
            a.token_program.key(),
            Approve {
                to: a.holder_token.to_account_info(),
                delegate: order.to_account_info(),
                authority: a.holder.to_account_info(),
            },
        ),
        t.allowance,
    )?;
    emit!(OrderSet {
        vault: order.vault,
        order: order.key(),
        holder: order.holder,
        feed_id,
        max_shares: t.max_shares,
        start_bps: t.start_bps,
        depth_bps: t.depth_bps,
        max_premium: t.max_premium,
        until: t.until,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub holder: Signer<'info>,
    #[account(mut, has_one = holder)]
    pub order: Box<Account<'info, Order>>,
    /// The allowance is revoked only if it's still this order's.
    #[account(mut, token::authority = holder)]
    pub holder_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Stops renewals. The order stays, remembering the last opening it renewed for.
pub fn handle_cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
    let a = ctx.accounts;
    a.order.active = false;
    if a.holder_token.delegate == Some(a.order.key()).into() {
        token::revoke(CpiContext::new(
            a.token_program.key(),
            Revoke { source: a.holder_token.to_account_info(), authority: a.holder.to_account_info() },
        ))?;
    }
    emit!(OrderCancelled { vault: a.order.vault, order: a.order.key(), holder: a.holder.key() });
    Ok(())
}

#[derive(Accounts)]
#[instruction(q: QuoteArgs)]
pub struct Renew<'info> {
    /// Anyone: pays the new accounts' rent, as a buyer would.
    #[account(mut)]
    pub keeper: Signer<'info>,
    /// CHECK: the order's holder, checked against the order; receives the NFT.
    #[account(address = order.holder)]
    pub holder: UncheckedAccount<'info>,
    #[account(
        mut,
        has_one = vault,
        seeds = [ORDER_SEED, vault.key().as_ref(), order.holder.as_ref(), q.feed_id.as_ref()],
        bump = order.bump,
    )]
    pub order: Box<Account<'info, Order>>,
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
        payer = keeper,
        space = 8 + Series::INIT_SPACE,
        seeds = [SERIES_SEED, vault.key().as_ref(), q.feed_id.as_ref(), &q.open_ts.to_le_bytes()],
        bump
    )]
    pub series: Box<Account<'info, Series>>,
    #[account(
        init,
        payer = keeper,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, vault.key().as_ref(), q.nonce.as_ref()],
        bump
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(
        init,
        payer = keeper,
        seeds = [POSITION_MINT_SEED, vault.key().as_ref(), q.nonce.as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = vault,
        mint::token_program = nft_token_program,
        extensions::metadata_pointer::metadata_address = position_mint,
    )]
    pub position_mint: Box<InterfaceAccount<'info, NftMint>>,
    #[account(
        init,
        payer = keeper,
        associated_token::mint = position_mint,
        associated_token::authority = holder,
        associated_token::token_program = nft_token_program,
    )]
    pub holder_nft: Box<InterfaceAccount<'info, NftAccount>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = collateral_mint, token::authority = holder)]
    pub holder_token: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    /// The stock's latest price, which the strikes are checked against.
    pub price_update: Box<Account<'info, PriceUpdateV2>>,
    /// CHECK: the instructions sysvar, checked by address; read to find the ed25519 verification.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub nft_token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Renews a standing order for the next opening, at a quote the quoter signed
/// for the order. Any keeper may send it; the order's limits and the price
/// decide whether it goes through, and the holder's allowance pays.
pub fn handle_renew(ctx: Context<Renew>, q: QuoteArgs) -> Result<()> {
    let a = ctx.accounts;
    let order_key = a.order.key();
    check_quote(&a.instructions, ctx.program_id, &a.vault, &order_key, &q)?;

    let now = Clock::get()?.unix_timestamp;
    let order = &mut a.order;
    require!(order.active, VaultError::OrderNotActive);
    require!(q.open_ts < order.until, VaultError::OrderEnded);
    require!(q.open_ts > order.last_open_ts, VaultError::AlreadyRenewed);
    require!(q.shares <= order.max_shares && q.premium <= order.max_premium, VaultError::OverOrderLimit);
    order.last_open_ts = q.open_ts;

    let update = &a.price_update;
    require!(update.verification_level == VerificationLevel::Full, VaultError::InsufficientVerification);
    let msg = &update.price_message;
    require!(msg.feed_id == q.feed_id, VaultError::FeedMismatch);
    require!(now - msg.publish_time <= MAX_ORDER_PRICE_AGE_SECS, VaultError::StalePrice);
    let price = math::to_price_8(msg.price, msg.exponent)? as u128;
    require!(
        strike_ok(q.upper, price, order.start_bps) && strike_ok(q.lower, price, order.depth_bps),
        VaultError::StrikesOffOrder
    );

    if q.premium > 0 {
        let (vault, holder, bump) = (order.vault, order.holder, order.bump);
        let seeds: &[&[u8]] = &[ORDER_SEED, vault.as_ref(), holder.as_ref(), q.feed_id.as_ref(), &[bump]];
        token::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.holder_token.to_account_info(),
                    mint: a.collateral_mint.to_account_info(),
                    to: a.vault_token.to_account_info(),
                    authority: order.to_account_info(),
                },
                &[seeds],
            ),
            q.premium,
            a.collateral_mint.decimals,
        )?;
    }
    sell(
        Sale {
            vault: &mut a.vault,
            feed_config: &a.feed_config,
            series: &mut a.series,
            position: &mut a.position,
            position_mint: &a.position_mint,
            owner_nft: &a.holder_nft,
            owner: a.holder.key(),
            payer: a.keeper.to_account_info(),
            vault_token: &mut a.vault_token,
            nft_token_program: &a.nft_token_program,
            system_program: &a.system_program,
        },
        &q,
        (ctx.bumps.series, ctx.bumps.position, ctx.bumps.position_mint),
    )
}

/// Whether `strike` sits within the tolerance of `bps` below `price` (both 8 decimals).
fn strike_ok(strike: u64, price: u128, bps: u16) -> bool {
    let target = price * (BPS_DENOMINATOR - bps as u128) / BPS_DENOMINATOR;
    let tolerance = price * STRIKE_TOLERANCE_BPS / BPS_DENOMINATOR;
    (strike as u128).abs_diff(target) <= tolerance
}
