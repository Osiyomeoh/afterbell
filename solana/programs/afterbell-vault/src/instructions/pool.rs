use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
    token_2022::{self, Burn, MintTo, Token2022},
    token_interface::{self, Mint as ShareMint, TokenAccount as ShareAccount},
};

use crate::{
    constants::{RATE_SEED, REQUEST_SEED},
    error::VaultError,
    events::{DepositClaimed, DepositRequested, ParamsSet, RedeemRequested, RedemptionClaimed, Rolled},
    instructions::admin::transfer_from_vault,
    math,
    state::*,
};

/// Moves a request queued in a round already rolled into its claimable
/// balance, at that roll's rate. The deposit and the redemption fill
/// separately, so each instruction needs the rate of only the side it touches.
fn fill_deposit(r: &mut Request, round: u64, vault: &Pubkey, rate: Option<&RoundRate>) -> Result<()> {
    if r.deposit_assets == 0 || r.deposit_round >= round {
        return Ok(());
    }
    let rate = rate.ok_or(VaultError::RateMissing)?;
    require!(rate.vault == *vault && rate.round == r.deposit_round, VaultError::WrongRate);
    let shares = math::shares_for(r.deposit_assets, rate.assets, rate.supply)?;
    r.filled_deposit_assets = r.filled_deposit_assets.checked_add(r.deposit_assets).ok_or(VaultError::MathOverflow)?;
    r.filled_deposit_shares = r.filled_deposit_shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;
    r.deposit_assets = 0;
    Ok(())
}

fn fill_redeem(r: &mut Request, round: u64, vault: &Pubkey, rate: Option<&RoundRate>) -> Result<()> {
    if r.redeem_shares == 0 || r.redeem_round >= round {
        return Ok(());
    }
    let rate = rate.ok_or(VaultError::RateMissing)?;
    require!(rate.vault == *vault && rate.round == r.redeem_round, VaultError::WrongRate);
    let assets = math::assets_for(r.redeem_shares, rate.assets, rate.supply)?;
    r.filled_redeem_shares = r.filled_redeem_shares.checked_add(r.redeem_shares).ok_or(VaultError::MathOverflow)?;
    r.filled_redeem_assets = r.filled_redeem_assets.checked_add(assets).ok_or(VaultError::MathOverflow)?;
    r.redeem_shares = 0;
    Ok(())
}

fn start_request(r: &mut Request, vault: Pubkey, owner: Pubkey, bump: u8) {
    if r.vault == Pubkey::default() {
        r.vault = vault;
        r.owner = owner;
        r.bump = bump;
    }
}

// ------------------------------------------------------------ request_deposit

#[derive(Accounts)]
pub struct RequestDeposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, has_one = collateral_mint, has_one = vault_token)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Request::INIT_SPACE,
        seeds = [REQUEST_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub request: Box<Account<'info, Request>>,
    /// The rate of the round that filled an earlier deposit request, if one is waiting.
    pub rate: Option<Box<Account<'info, RoundRate>>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = collateral_mint, token::authority = owner)]
    pub owner_token: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Queues `assets` to join the pool at the next roll, at the pool's value then.
pub fn handle_request_deposit(ctx: Context<RequestDeposit>, assets: u64) -> Result<()> {
    require!(assets > 0, VaultError::ZeroAmount);
    let vault = &mut ctx.accounts.vault;
    let r = &mut ctx.accounts.request;
    start_request(r, vault.key(), ctx.accounts.owner.key(), ctx.bumps.request);
    fill_deposit(r, vault.round, &vault.key(), ctx.accounts.rate.as_deref().map(|a| &**a))?;
    r.deposit_round = vault.round;
    r.deposit_assets = r.deposit_assets.checked_add(assets).ok_or(VaultError::MathOverflow)?;
    vault.pending_deposit_assets = vault.pending_deposit_assets.checked_add(assets).ok_or(VaultError::MathOverflow)?;
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.owner_token.to_account_info(),
                mint: ctx.accounts.collateral_mint.to_account_info(),
                to: ctx.accounts.vault_token.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        assets,
        ctx.accounts.collateral_mint.decimals,
    )?;
    emit!(DepositRequested { vault: vault.key(), owner: r.owner, round: vault.round, assets });
    Ok(())
}

// ------------------------------------------------------------- request_redeem

#[derive(Accounts)]
pub struct RequestRedeem<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, has_one = share_mint, has_one = share_escrow)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Request::INIT_SPACE,
        seeds = [REQUEST_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub request: Box<Account<'info, Request>>,
    /// The rate of the round that filled an earlier redemption request, if one is waiting.
    pub rate: Option<Box<Account<'info, RoundRate>>>,
    pub share_mint: Box<InterfaceAccount<'info, ShareMint>>,
    #[account(mut, token::mint = share_mint, token::authority = owner, token::token_program = share_token_program)]
    pub owner_shares: Box<InterfaceAccount<'info, ShareAccount>>,
    #[account(mut)]
    pub share_escrow: Box<InterfaceAccount<'info, ShareAccount>>,
    pub share_token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// Queues `shares` to leave the pool at the next roll, at the pool's value then.
/// The shares wait in the vault's escrow, and are burned at the roll.
pub fn handle_request_redeem(ctx: Context<RequestRedeem>, shares: u64) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);
    let vault = &mut ctx.accounts.vault;
    let r = &mut ctx.accounts.request;
    start_request(r, vault.key(), ctx.accounts.owner.key(), ctx.bumps.request);
    fill_redeem(r, vault.round, &vault.key(), ctx.accounts.rate.as_deref().map(|a| &**a))?;
    r.redeem_round = vault.round;
    r.redeem_shares = r.redeem_shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;
    vault.pending_redeem_shares = vault.pending_redeem_shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.share_token_program.key(),
            token_interface::TransferChecked {
                from: ctx.accounts.owner_shares.to_account_info(),
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.share_escrow.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        shares,
        ctx.accounts.share_mint.decimals,
    )?;
    emit!(RedeemRequested { vault: vault.key(), owner: r.owner, round: vault.round, shares });
    Ok(())
}

// -------------------------------------------------------------- claim_deposit

#[derive(Accounts)]
pub struct ClaimDeposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(has_one = share_mint, has_one = share_escrow)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        mut,
        seeds = [REQUEST_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = request.bump,
    )]
    pub request: Box<Account<'info, Request>>,
    /// The rate of the round that filled the deposit, unless it's already filled.
    pub rate: Option<Box<Account<'info, RoundRate>>>,
    pub share_mint: Box<InterfaceAccount<'info, ShareMint>>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = share_mint,
        associated_token::authority = owner,
        associated_token::token_program = share_token_program,
    )]
    pub owner_shares: Box<InterfaceAccount<'info, ShareAccount>>,
    #[account(mut)]
    pub share_escrow: Box<InterfaceAccount<'info, ShareAccount>>,
    pub share_token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Takes the shares every filled deposit request bought.
pub fn handle_claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let r = &mut ctx.accounts.request;
    fill_deposit(r, vault.round, &vault.key(), ctx.accounts.rate.as_deref().map(|a| &**a))?;
    let (assets, shares) = (r.filled_deposit_assets, r.filled_deposit_shares);
    require!(shares > 0, VaultError::NothingToClaim);
    r.filled_deposit_assets = 0;
    r.filled_deposit_shares = 0;
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.share_token_program.key(),
            token_interface::TransferChecked {
                from: ctx.accounts.share_escrow.to_account_info(),
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.owner_shares.to_account_info(),
                authority: vault.to_account_info(),
            },
            &[&vault.seeds()],
        ),
        shares,
        ctx.accounts.share_mint.decimals,
    )?;
    emit!(DepositClaimed { vault: vault.key(), owner: r.owner, assets, shares });
    Ok(())
}

// ----------------------------------------------------------- claim_redemption

#[derive(Accounts)]
pub struct ClaimRedemption<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = collateral_mint, has_one = vault_token)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        mut,
        seeds = [REQUEST_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = request.bump,
    )]
    pub request: Box<Account<'info, Request>>,
    /// The rate of the round that filled the redemption, unless it's already filled.
    pub rate: Option<Box<Account<'info, RoundRate>>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = collateral_mint, token::authority = owner)]
    pub owner_token: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Takes the collateral every filled redemption request is owed.
pub fn handle_claim_redemption(ctx: Context<ClaimRedemption>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let r = &mut ctx.accounts.request;
    fill_redeem(r, vault.round, &vault.key(), ctx.accounts.rate.as_deref().map(|a| &**a))?;
    let (shares, assets) = (r.filled_redeem_shares, r.filled_redeem_assets);
    require!(shares > 0, VaultError::NothingToClaim);
    r.filled_redeem_shares = 0;
    r.filled_redeem_assets = 0;
    vault.reserved_assets = vault.reserved_assets.checked_sub(assets).ok_or(VaultError::MathOverflow)?;
    if assets > 0 {
        transfer_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.token_program,
            &ctx.accounts.vault_token,
            &ctx.accounts.collateral_mint,
            &ctx.accounts.owner_token.to_account_info(),
            assets,
        )?;
    }
    emit!(RedemptionClaimed { vault: ctx.accounts.vault.key(), owner: r.owner, shares, assets });
    Ok(())
}

// ----------------------------------------------------------------------- roll

#[derive(Accounts)]
pub struct Roll<'info> {
    /// Pays the rent of the round's rate record.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, has_one = vault_token, has_one = share_mint, has_one = share_escrow)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        init,
        payer = payer,
        space = 8 + RoundRate::INIT_SPACE,
        seeds = [RATE_SEED, vault.key().as_ref(), &vault.round.to_le_bytes()],
        bump
    )]
    pub rate: Box<Account<'info, RoundRate>>,
    pub vault_token: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub share_mint: Box<InterfaceAccount<'info, ShareMint>>,
    #[account(mut)]
    pub share_escrow: Box<InterfaceAccount<'info, ShareAccount>>,
    pub share_token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// Ends the round and fills the queued deposits and redemptions at the pool's
/// exact value. Anyone can call it once the round's opening has passed and
/// every position it sold is paid out, or at any time if it sold nothing.
/// Queued parameter changes take effect here.
pub fn handle_roll(ctx: Context<Roll>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    if vault.round_open_ts != 0 {
        let now = Clock::get()?.unix_timestamp;
        require!(now > vault.round_open_ts && vault.round_unpaid == 0, VaultError::RoundNotOver);
    }
    // Everything the round sold is paid, so nothing is at risk and the pool's value is exact.
    let balance = ctx.accounts.vault_token.amount;
    let assets = math::total_assets(balance, vault.pending_deposit_assets, vault.reserved_assets, vault.tips_owed, vault.locked)?;
    let supply = ctx.accounts.share_mint.supply;
    let deposit_assets = vault.pending_deposit_assets;
    let redeem_shares = vault.pending_redeem_shares;
    let deposit_shares = math::shares_for(deposit_assets, assets, supply)?;
    let redeem_assets = math::assets_for(redeem_shares, assets, supply)?;

    let rate = &mut ctx.accounts.rate;
    rate.vault = vault.key();
    rate.round = vault.round;
    rate.open_ts = vault.round_open_ts;
    rate.assets = assets;
    rate.supply = supply;
    rate.deposit_assets = deposit_assets;
    rate.deposit_shares = deposit_shares;
    rate.redeem_shares = redeem_shares;
    rate.redeem_assets = redeem_assets;
    rate.bump = ctx.bumps.rate;

    vault.pending_deposit_assets = 0;
    vault.pending_redeem_shares = 0;
    vault.reserved_assets = vault.reserved_assets.checked_add(redeem_assets).ok_or(VaultError::MathOverflow)?;
    emit!(Rolled {
        vault: vault.key(),
        round: vault.round,
        open_ts: vault.round_open_ts,
        assets,
        supply,
        deposit_assets,
        deposit_shares,
        redeem_shares,
        redeem_assets,
    });
    vault.round += 1;
    vault.round_open_ts = 0;
    if vault.params_queued {
        vault.params = vault.next_params;
        vault.params_queued = false;
        emit!(ParamsSet { vault: vault.key(), params: vault.params });
    }
    vault.round_nav =
        math::total_assets(balance, vault.pending_deposit_assets, vault.reserved_assets, vault.tips_owed, vault.locked)?;

    let seeds = ctx.accounts.vault.seeds();
    let program = ctx.accounts.share_token_program.key();
    if redeem_shares > 0 {
        token_2022::burn(
            CpiContext::new_with_signer(
                program,
                Burn {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    from: ctx.accounts.share_escrow.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[&seeds],
            ),
            redeem_shares,
        )?;
    }
    if deposit_shares > 0 {
        token_2022::mint_to(
            CpiContext::new_with_signer(
                program,
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.share_escrow.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[&seeds],
            ),
            deposit_shares,
        )?;
    }
    Ok(())
}
