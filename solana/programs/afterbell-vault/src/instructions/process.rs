use anchor_lang::prelude::*;
use anchor_spl::{
    token::{Mint, Token, TokenAccount},
    token_2022,
    token_interface::{Mint as NftMint, TokenAccount as NftAccount},
};

use crate::{
    error::VaultError,
    events::{Forfeited, Paid, Processed},
    instructions::admin::transfer_from_vault,
    math,
    state::*,
};

#[derive(Accounts)]
pub struct Process<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, has_one = collateral_mint, has_one = vault_token)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, has_one = vault)]
    pub series: Box<Account<'info, Series>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    /// Where the keeper's tips go.
    #[account(mut, token::mint = collateral_mint)]
    pub keeper_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Pays out positions of a settled or voided series, each to whoever holds its
/// NFT now, and pays the caller their keepers' tips. Anyone can call it, for
/// any number of positions; a holder paying out their own is a claim.
///
/// A program sees only the accounts a transaction passes it, so each position
/// comes as three remaining accounts: the position, the token account holding
/// its NFT, and that holder's collateral account. The first two prove who the
/// holder is; the payout can only go to the holder's own account.
///
/// Token-2022 lets a holder burn their NFT. Then nobody holds the position and
/// nobody can be paid, but the round can't end until every position is closed.
/// So in place of the holder's account, the position's own mint may be passed:
/// with a supply of zero (and no way to mint more), the position is forfeited
/// and its payout stays in the pool. The third account is then unused.
pub fn handle_process<'info>(ctx: Context<'info, Process<'info>>) -> Result<()> {
    let series = &mut ctx.accounts.series;
    require!(series.state != SeriesState::Open, VaultError::SeriesStillOpen);
    let rest = ctx.remaining_accounts;
    require!(!rest.is_empty() && rest.len() % 3 == 0, VaultError::BadPositionAccounts);

    let refund = series.state == SeriesState::Voided;
    let mut tips: u64 = 0;
    let mut count: u32 = 0;
    for three in rest.chunks(3) {
        let (position_info, nft_info, payee_info) = (&three[0], &three[1], &three[2]);
        require!(position_info.is_writable, VaultError::BadPositionAccounts);
        // Owned by this program with the Position discriminator.
        let mut position: Account<Position> = Account::try_from(position_info)?;
        require_keys_eq!(position.series, series.key(), VaultError::WrongSeries);
        // Already paid: skip, so a keeper's batch doesn't fail on a holder's own claim.
        if position.closed {
            continue;
        }

        let vault = &mut ctx.accounts.vault;
        // A voided position gets its whole premium back, the tip included.
        let amount = if refund {
            position.premium
        } else {
            math::payout_at(position.shares, position.upper, position.lower, series.price, vault.collateral_unit)?
        };
        require_keys_eq!(*nft_info.owner, token_2022::ID, VaultError::NotHolder);
        // The holder, or nobody if the NFT was burned.
        let holder = if nft_info.key() == position.mint {
            let mint: InterfaceAccount<NftMint> = InterfaceAccount::try_from(nft_info)?;
            require!(mint.supply == 0, VaultError::NotHolder);
            None
        } else {
            // The NFT's supply is one, so the account holding it names the holder.
            let nft: InterfaceAccount<NftAccount> = InterfaceAccount::try_from(nft_info)?;
            require!(nft.mint == position.mint && nft.amount == 1, VaultError::NotHolder);
            require!(payee_info.is_writable, VaultError::BadPositionAccounts);
            let payee: Account<TokenAccount> = Account::try_from(payee_info)?;
            require!(payee.mint == vault.collateral_mint && payee.owner == nft.owner, VaultError::WrongPayee);
            Some(nft.owner)
        };

        let tip = if refund { 0 } else { position.tip };
        vault.locked = vault.locked.checked_sub(position.max_payout).ok_or(VaultError::MathOverflow)?;
        vault.tips_owed = vault.tips_owed.checked_sub(position.tip).ok_or(VaultError::MathOverflow)?;
        vault.round_unpaid = vault.round_unpaid.checked_sub(1).ok_or(VaultError::MathOverflow)?;
        series.locked = series.locked.checked_sub(position.max_payout).ok_or(VaultError::MathOverflow)?;
        series.paid += 1;
        position.closed = true;
        position.paid = if holder.is_some() { amount } else { 0 };
        position.paid_to = holder.unwrap_or_default();
        position.exit(&crate::ID)?;
        tips += tip;
        count += 1;

        let Some(holder) = holder else {
            emit!(Forfeited { position: position.key(), amount });
            continue;
        };

        if amount > 0 {
            transfer_from_vault(
                &ctx.accounts.vault,
                &ctx.accounts.token_program,
                &ctx.accounts.vault_token,
                &ctx.accounts.collateral_mint,
                payee_info,
                amount,
            )?;
        }
        emit!(Paid { position: position.key(), holder, amount, refund });
    }

    if tips > 0 {
        transfer_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.token_program,
            &ctx.accounts.vault_token,
            &ctx.accounts.collateral_mint,
            &ctx.accounts.keeper_token.to_account_info(),
            tips,
        )?;
    }
    emit!(Processed { series: series.key(), positions: count, keeper: ctx.accounts.keeper.key(), tips });
    Ok(())
}
