//! Buying Afterbell protection from another program.
//!
//! A lending desk (or any program) holds positions under its own PDA. The
//! quote is signed for the desk's address, and the transaction carries the
//! quoter's Ed25519 instruction right before `protect`: Afterbell reads the
//! instruction before the top-level one, so the check works through CPI too.
use afterbell_vault::{cpi::accounts::Buy, program::AfterbellVault, QuoteArgs};
use anchor_lang::prelude::*;

declare_id!("G1ZWgvzoNehAhqJxmrEYHfUeSXBD3eu9CKprtRCkSQr1");

pub const DESK_SEED: &[u8] = b"desk";

#[program]
pub mod cover_desk {
    use super::*;

    /// Buys the quoted protection, paid and held by the desk.
    pub fn protect(ctx: Context<Protect>, q: QuoteArgs) -> Result<()> {
        let seeds: &[&[u8]] = &[DESK_SEED, &[ctx.bumps.desk]];
        let a = &ctx.accounts;
        afterbell_vault::cpi::buy(
            CpiContext::new_with_signer(
                a.afterbell.key(),
                Buy {
                    buyer: a.desk.to_account_info(),
                    vault: a.vault.to_account_info(),
                    feed_config: a.feed_config.to_account_info(),
                    series: a.series.to_account_info(),
                    position: a.position.to_account_info(),
                    position_mint: a.position_mint.to_account_info(),
                    buyer_nft: a.desk_nft.to_account_info(),
                    collateral_mint: a.collateral_mint.to_account_info(),
                    buyer_token: a.desk_token.to_account_info(),
                    vault_token: a.vault_token.to_account_info(),
                    instructions: a.instructions.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                    nft_token_program: a.nft_token_program.to_account_info(),
                    associated_token_program: a.associated_token_program.to_account_info(),
                    system_program: a.system_program.to_account_info(),
                },
                &[seeds],
            ),
            q,
        )
    }
}

/// Afterbell checks every account; the desk only fixes who buys.
#[derive(Accounts)]
pub struct Protect<'info> {
    /// CHECK: the desk's PDA, which pays and signs for the purchase.
    #[account(mut, seeds = [DESK_SEED], bump)]
    pub desk: UncheckedAccount<'info>,
    /// CHECK: checked by Afterbell.
    pub vault: UncheckedAccount<'info>,
    /// CHECK: checked by Afterbell.
    pub feed_config: UncheckedAccount<'info>,
    /// CHECK: checked by Afterbell.
    #[account(mut)]
    pub series: UncheckedAccount<'info>,
    /// CHECK: checked by Afterbell.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: checked by Afterbell.
    #[account(mut)]
    pub position_mint: UncheckedAccount<'info>,
    /// CHECK: checked by Afterbell.
    #[account(mut)]
    pub desk_nft: UncheckedAccount<'info>,
    /// CHECK: checked by Afterbell.
    pub collateral_mint: UncheckedAccount<'info>,
    /// CHECK: checked by Afterbell.
    #[account(mut)]
    pub desk_token: UncheckedAccount<'info>,
    /// CHECK: checked by Afterbell.
    #[account(mut)]
    pub vault_token: UncheckedAccount<'info>,
    /// CHECK: checked by Afterbell.
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: checked by Afterbell.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: checked by Afterbell.
    pub nft_token_program: UncheckedAccount<'info>,
    /// CHECK: checked by Afterbell.
    pub associated_token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub afterbell: Program<'info, AfterbellVault>,
}
