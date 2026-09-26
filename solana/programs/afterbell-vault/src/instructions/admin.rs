use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::*, error::VaultError, state::*};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct VaultConfig {
    pub quoter: Pubkey,
    pub settle_window_secs: u32,
    pub void_delay_secs: u32,
    pub max_conf_bps: u16,
}

fn validate(c: &VaultConfig) -> Result<()> {
    require!(
        (MIN_SETTLE_WINDOW_SECS..=MAX_SETTLE_WINDOW_SECS).contains(&c.settle_window_secs)
            && (MIN_VOID_DELAY_SECS..=MAX_VOID_DELAY_SECS).contains(&c.void_delay_secs)
            && c.void_delay_secs > c.settle_window_secs
            && c.max_conf_bps > 0
            && c.max_conf_bps <= MAX_CONF_BPS_LIMIT
            && c.quoter != Pubkey::default(),
        VaultError::InvalidConfig
    );
    Ok(())
}

fn apply(vault: &mut Vault, c: &VaultConfig) {
    vault.quoter = c.quoter;
    vault.settle_window_secs = c.settle_window_secs;
    vault.void_delay_secs = c.void_delay_secs;
    vault.max_conf_bps = c.max_conf_bps;
}

// ------------------------------------------------------------ initialize_vault

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, authority.key().as_ref(), collateral_mint.key().as_ref()],
        bump
    )]
    pub vault: Box<Account<'info, Vault>>,
    /// Classic SPL Token only: Token-2022 transfer fees and hooks would break the accounting.
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = authority,
        seeds = [VAULT_TOKEN_SEED, vault.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = vault,
    )]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_vault(ctx: Context<InitializeVault>, config: VaultConfig) -> Result<()> {
    validate(&config)?;
    let unit = 10u64
        .checked_pow(ctx.accounts.collateral_mint.decimals as u32)
        .ok_or(VaultError::MathOverflow)?;
    let vault = &mut ctx.accounts.vault;
    vault.authority = ctx.accounts.authority.key();
    vault.collateral_mint = ctx.accounts.collateral_mint.key();
    vault.vault_token = ctx.accounts.vault_token.key();
    vault.collateral_unit = unit;
    vault.locked = 0;
    vault.bump = ctx.bumps.vault;
    vault.token_bump = ctx.bumps.vault_token;
    apply(vault, &config);
    Ok(())
}

// ------------------------------------------------------------------ set_config

#[derive(Accounts)]
pub struct SetConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority)]
    pub vault: Box<Account<'info, Vault>>,
}

pub fn handle_set_config(ctx: Context<SetConfig>, config: VaultConfig) -> Result<()> {
    validate(&config)?;
    apply(&mut ctx.accounts.vault, &config);
    Ok(())
}

// ------------------------------------------------------------------ allow_feed

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct AllowFeed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + FeedConfig::INIT_SPACE,
        seeds = [FEED_SEED, vault.key().as_ref(), feed_id.as_ref()],
        bump
    )]
    pub feed_config: Box<Account<'info, FeedConfig>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_allow_feed(ctx: Context<AllowFeed>, feed_id: [u8; 32], allowed: bool) -> Result<()> {
    require!(feed_id != [0u8; 32], VaultError::FeedNotAllowed);
    let f = &mut ctx.accounts.feed_config;
    f.vault = ctx.accounts.vault.key();
    f.feed_id = feed_id;
    f.allowed = allowed;
    f.bump = ctx.bumps.feed_config;
    Ok(())
}

// --------------------------------------------------------------------- deposit

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub depositor: Signer<'info>,
    #[account(has_one = collateral_mint, has_one = vault_token)]
    pub vault: Box<Account<'info, Vault>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = collateral_mint, token::authority = depositor)]
    pub depositor_token: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.depositor_token.to_account_info(),
                mint: ctx.accounts.collateral_mint.to_account_info(),
                to: ctx.accounts.vault_token.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.collateral_mint.decimals,
    )
}

// -------------------------------------------------------------------- withdraw

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub authority: Signer<'info>,
    #[account(has_one = authority, has_one = collateral_mint, has_one = vault_token)]
    pub vault: Box<Account<'info, Vault>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = collateral_mint)]
    pub to: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// The authority may take out only what open positions can't claim.
pub fn handle_withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);
    let vault = &ctx.accounts.vault;
    let free = ctx
        .accounts
        .vault_token
        .amount
        .checked_sub(vault.locked)
        .ok_or(VaultError::InsufficientCollateral)?;
    require!(amount <= free, VaultError::InsufficientCollateral);
    transfer_from_vault(
        vault,
        &ctx.accounts.token_program,
        &ctx.accounts.vault_token,
        &ctx.accounts.collateral_mint,
        &ctx.accounts.to.to_account_info(),
        amount,
    )
}

/// Moves collateral out of the vault's token account, signed by the vault PDA.
pub fn transfer_from_vault<'info>(
    vault: &Account<'info, Vault>,
    token_program: &Program<'info, Token>,
    vault_token: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[VAULT_SEED, vault.authority.as_ref(), vault.collateral_mint.as_ref(), &[vault.bump]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault_token.to_account_info(),
                mint: mint.to_account_info(),
                to: to.clone(),
                authority: vault.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}
