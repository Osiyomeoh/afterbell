use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
    token_2022::{self, spl_token_2022::instruction::AuthorityType, MintTo, SetAuthority, Token2022},
    token_interface::{Mint as NftMint, TokenAccount as NftAccount},
};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::{
    constants::*,
    error::VaultError,
    events::ProtectionBought,
    instructions::admin::write_metadata,
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
    /// The position's NFT: no decimals, its metadata on the mint itself. The
    /// vault mints one and then gives up the mint authority.
    #[account(
        init,
        payer = buyer,
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
        payer = buyer,
        associated_token::mint = position_mint,
        associated_token::authority = buyer,
        associated_token::token_program = nft_token_program,
    )]
    pub buyer_nft: Box<InterfaceAccount<'info, NftAccount>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = collateral_mint, token::authority = buyer)]
    pub buyer_token: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: the instructions sysvar, checked by address; read to find the ed25519 verification.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub nft_token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Buys protection at a price the vault's quoter signed for this buyer, as an
/// NFT in the buyer's wallet. The instruction right before this one must be the
/// Ed25519 program verifying that signature over `quote_message(...)`.
pub fn handle_buy(ctx: Context<Buy>, q: QuoteArgs) -> Result<()> {
    let a = ctx.accounts;
    check_quote(&a.instructions, ctx.program_id, &a.vault, &a.buyer.key(), &q)?;
    if q.premium > 0 {
        token::transfer_checked(
            CpiContext::new(
                a.token_program.key(),
                TransferChecked {
                    from: a.buyer_token.to_account_info(),
                    mint: a.collateral_mint.to_account_info(),
                    to: a.vault_token.to_account_info(),
                    authority: a.buyer.to_account_info(),
                },
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
            owner_nft: &a.buyer_nft,
            owner: a.buyer.key(),
            payer: a.buyer.to_account_info(),
            vault_token: &mut a.vault_token,
            nft_token_program: &a.nft_token_program,
            system_program: &a.system_program,
        },
        &q,
        (ctx.bumps.series, ctx.bumps.position, ctx.bumps.position_mint),
    )
}

/// Checks the quote's terms and that the instruction right before this one
/// verified the quoter's signature over it for `buyer`.
pub fn check_quote(instructions: &AccountInfo, program_id: &Pubkey, vault: &Account<Vault>, buyer: &Pubkey, q: &QuoteArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now <= q.expiry, VaultError::QuoteExpired);
    require!(now < q.open_ts, VaultError::AlreadyOpen);
    require!(q.shares > 0 && q.upper > q.lower, VaultError::InvalidProtection);
    let current = load_current_index_checked(instructions)? as usize;
    require!(current > 0, VaultError::MissingSignature);
    let prev = load_instruction_at_checked(current - 1, instructions)?;
    let message = quote_message(program_id, &vault.key(), buyer, q);
    verify_ed25519_ix(&prev, &vault.quoter, &message)
}

/// The accounts a sale writes, from `buy` or a standing order's `renew`.
pub struct Sale<'a, 'info> {
    pub vault: &'a mut Box<Account<'info, Vault>>,
    pub feed_config: &'a Account<'info, FeedConfig>,
    pub series: &'a mut Box<Account<'info, Series>>,
    pub position: &'a mut Box<Account<'info, Position>>,
    pub position_mint: &'a InterfaceAccount<'info, NftMint>,
    pub owner_nft: &'a InterfaceAccount<'info, NftAccount>,
    /// Who the position is recorded as bought by, and whose wallet gets its NFT.
    pub owner: Pubkey,
    /// Pays the rent the NFT's metadata adds.
    pub payer: AccountInfo<'info>,
    pub vault_token: &'a mut Box<Account<'info, TokenAccount>>,
    pub nft_token_program: &'a Program<'info, Token2022>,
    pub system_program: &'a Program<'info, System>,
}

/// Records a sale whose quote is checked and premium paid in: the series, the
/// risk limits, the position and its NFT.
pub fn sell(s: Sale, q: &QuoteArgs, (series_bump, position_bump, mint_bump): (u8, u8, u8)) -> Result<()> {
    let vault_key = s.vault.key();
    let vault = &mut **s.vault;
    let max_payout = math::payout_units(q.shares, q.upper - q.lower, vault.collateral_unit)?;
    // A premium above the most it can pay makes no sense, and would let a voided
    // series refund more than the position ever locked.
    require!(max_payout > 0 && q.premium <= max_payout, VaultError::InvalidProtection);

    // One opening per round. The first sale after a roll fixes it; the quoter's
    // signature vouches that it's a real opening, which the program can't know (holidays).
    if vault.round_open_ts == 0 {
        vault.round_open_ts = q.open_ts;
    } else {
        require!(q.open_ts == vault.round_open_ts, VaultError::WrongRound);
    }

    let series = &mut **s.series;
    if series.vault == Pubkey::default() {
        series.vault = vault_key;
        series.feed_id = q.feed_id;
        series.open_ts = q.open_ts;
        series.state = SeriesState::Open;
        series.lowest_lower = q.lower;
        series.bump = series_bump;
    }
    require!(series.state == SeriesState::Open, VaultError::SeriesNotOpen);
    series.lowest_lower = series.lowest_lower.min(q.lower);
    series.highest_upper = series.highest_upper.max(q.upper);
    series.locked = series.locked.checked_add(max_payout).ok_or(VaultError::MathOverflow)?;
    series.sold += 1;

    // Measured against the pool at the roll, so the limits can't move within a round.
    vault.locked = vault.locked.checked_add(max_payout).ok_or(VaultError::MathOverflow)?;
    require!(
        vault.locked <= math::bps_of(vault.round_nav, vault.params.max_utilization_bps),
        VaultError::OverCapacity
    );
    require!(
        series.locked <= math::bps_of(vault.round_nav, vault.params.max_feed_bps),
        VaultError::OverStockLimit
    );

    let tip = math::bps_of(q.premium, vault.params.keeper_tip_bps);
    vault.tips_owed = vault.tips_owed.checked_add(tip).ok_or(VaultError::MathOverflow)?;
    vault.round_unpaid += 1;
    vault.positions_sold += 1;

    let series_key = s.series.key();
    let position_key = s.position.key();
    let position = &mut **s.position;
    position.vault = vault_key;
    position.series = series_key;
    position.buyer = s.owner;
    position.mint = s.position_mint.key();
    position.nonce = q.nonce;
    position.number = vault.positions_sold;
    position.shares = q.shares;
    position.upper = q.upper;
    position.lower = q.lower;
    position.premium = q.premium;
    position.max_payout = max_payout;
    position.tip = tip;
    position.bump = position_bump;
    position.mint_bump = mint_bump;

    // The NFT: named for its number and stock, pointing at its image and its position.
    let (authority, collateral, bump) = (vault.authority, vault.collateral_mint, vault.bump);
    let seeds: &[&[u8]] = &[VAULT_SEED, authority.as_ref(), collateral.as_ref(), &[bump]];
    let name = format!("Afterbell #{} {}", position.number, s.feed_config.symbol);
    let uri = format!("{}{}", vault.art_uri, position_key);
    let vault_info = s.vault.to_account_info();
    let mint_info = s.position_mint.to_account_info();
    let nft_program = s.nft_token_program.to_account_info();
    write_metadata(
        &s.payer,
        &mint_info,
        &vault_info,
        &nft_program,
        &s.system_program.to_account_info(),
        &[seeds],
        name,
        POSITION_SYMBOL.to_string(),
        uri,
        &[(POSITION_FIELD, position_key.to_string())],
    )?;
    token_2022::mint_to(
        CpiContext::new_with_signer(
            nft_program.key(),
            MintTo { mint: mint_info.clone(), to: s.owner_nft.to_account_info(), authority: vault_info.clone() },
            &[seeds],
        ),
        1,
    )?;
    // No more can ever be minted: the position has exactly one holder.
    token_2022::set_authority(
        CpiContext::new_with_signer(
            nft_program.key(),
            SetAuthority { current_authority: vault_info, account_or_mint: mint_info },
            &[seeds],
        ),
        AuthorityType::MintTokens,
        None,
    )?;

    // Solvent by construction (the limits are shares of the pool), checked anyway.
    s.vault_token.reload()?;
    let v = &s.vault;
    math::total_assets(s.vault_token.amount, v.pending_deposit_assets, v.reserved_assets, v.tips_owed, v.locked)?;

    let p = &s.position;
    emit!(ProtectionBought {
        vault: vault_key,
        position: position_key,
        mint: p.mint,
        number: p.number,
        buyer: p.buyer,
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
