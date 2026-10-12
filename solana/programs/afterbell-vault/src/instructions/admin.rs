use anchor_lang::{
    prelude::*,
    system_program::{self, Transfer},
};
use anchor_spl::{
    token::{self, Mint, Token, TokenAccount, TransferChecked},
    token_2022::Token2022,
    token_interface::{
        spl_token_metadata_interface::state::Field, token_metadata_initialize, token_metadata_update_field,
        Mint as ShareMint, TokenAccount as ShareAccount, TokenMetadataInitialize, TokenMetadataUpdateField,
    },
};

use crate::{
    constants::*,
    error::VaultError,
    events::{ParamsQueued, ParamsSet},
    math,
    state::*,
};

pub fn validate(p: &Params) -> Result<()> {
    require!(
        (MIN_SETTLE_WINDOW_SECS..=MAX_SETTLE_WINDOW_SECS).contains(&p.settle_window_secs)
            && (MIN_VOID_DELAY_SECS..=MAX_VOID_DELAY_SECS).contains(&p.void_delay_secs)
            && p.void_delay_secs > p.settle_window_secs
            && p.max_conf_bps > 0
            && p.max_conf_bps <= MAX_CONF_BPS_LIMIT
            // One stock can't have more room than the whole round.
            && p.max_utilization_bps > 0
            && p.max_utilization_bps as u128 <= BPS_DENOMINATOR
            && p.max_feed_bps > 0
            && p.max_feed_bps <= p.max_utilization_bps
            && p.keeper_tip_bps <= MAX_KEEPER_TIP_BPS,
        VaultError::InvalidConfig
    );
    Ok(())
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
        token::token_program = token_program,
    )]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    /// The pool's shares, in the collateral's decimals, with their name on the mint itself.
    #[account(
        init,
        payer = authority,
        seeds = [SHARE_MINT_SEED, vault.key().as_ref()],
        bump,
        mint::decimals = collateral_mint.decimals,
        mint::authority = vault,
        mint::token_program = share_token_program,
        extensions::metadata_pointer::metadata_address = share_mint,
    )]
    pub share_mint: Box<InterfaceAccount<'info, ShareMint>>,
    #[account(
        init,
        payer = authority,
        seeds = [SHARE_ESCROW_SEED, vault.key().as_ref()],
        bump,
        token::mint = share_mint,
        token::authority = vault,
        token::token_program = share_token_program,
    )]
    pub share_escrow: Box<InterfaceAccount<'info, ShareAccount>>,
    pub token_program: Program<'info, Token>,
    pub share_token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_vault(
    ctx: Context<InitializeVault>,
    quoter: Pubkey,
    params: Params,
    art_uri: String,
) -> Result<()> {
    validate(&params)?;
    require!(quoter != Pubkey::default(), VaultError::InvalidConfig);
    require!(art_uri.len() <= MAX_ART_URI_LEN, VaultError::TooLong);
    let unit = 10u64.checked_pow(ctx.accounts.collateral_mint.decimals as u32).ok_or(VaultError::MathOverflow)?;
    let vault = &mut ctx.accounts.vault;
    vault.authority = ctx.accounts.authority.key();
    vault.quoter = quoter;
    vault.collateral_mint = ctx.accounts.collateral_mint.key();
    vault.vault_token = ctx.accounts.vault_token.key();
    vault.share_mint = ctx.accounts.share_mint.key();
    vault.share_escrow = ctx.accounts.share_escrow.key();
    vault.collateral_unit = unit;
    vault.params = params;
    vault.next_params = params;
    vault.round = 1;
    vault.art_uri = art_uri;
    vault.bump = ctx.bumps.vault;
    vault.token_bump = ctx.bumps.vault_token;
    vault.share_mint_bump = ctx.bumps.share_mint;
    vault.share_escrow_bump = ctx.bumps.share_escrow;

    let (authority, mint, bump) = (vault.authority, vault.collateral_mint, vault.bump);
    write_metadata(
        &ctx.accounts.authority.to_account_info(),
        &ctx.accounts.share_mint.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.share_token_program.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &[&[VAULT_SEED, authority.as_ref(), mint.as_ref(), &[bump]]],
        SHARE_NAME.to_string(),
        SHARE_SYMBOL.to_string(),
        String::new(),
        &[],
    )?;
    emit!(ParamsSet { vault: ctx.accounts.vault.key(), params });
    Ok(())
}

/// Writes Token-2022 metadata onto a mint the vault controls (it's the mint and
/// update authority), after topping up the mint's rent for the bytes it adds.
#[allow(clippy::too_many_arguments)]
pub fn write_metadata<'info>(
    payer: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    signer: &[&[&[u8]]],
    name: String,
    symbol: String,
    uri: String,
    fields: &[(&str, String)],
) -> Result<()> {
    let extra =
        math::metadata_len(&name, &symbol, &uri, &fields.iter().map(|(k, v)| (*k, v.as_str())).collect::<Vec<_>>());
    let needed = Rent::get()?.minimum_balance(mint.data_len() + extra);
    let have = mint.lamports();
    if needed > have {
        system_program::transfer(
            CpiContext::new(system.key(), Transfer { from: payer.clone(), to: mint.clone() }),
            needed - have,
        )?;
    }
    token_metadata_initialize(
        CpiContext::new_with_signer(
            token_program.key(),
            TokenMetadataInitialize {
                program_id: token_program.clone(),
                metadata: mint.clone(),
                update_authority: vault.clone(),
                mint_authority: vault.clone(),
                mint: mint.clone(),
            },
            signer,
        ),
        name,
        symbol,
        uri,
    )?;
    for (key, value) in fields {
        token_metadata_update_field(
            CpiContext::new_with_signer(
                token_program.key(),
                TokenMetadataUpdateField {
                    program_id: token_program.clone(),
                    metadata: mint.clone(),
                    update_authority: vault.clone(),
                },
                signer,
            ),
            Field::Key(key.to_string()),
            value.clone(),
        )?;
    }
    Ok(())
}

// --------------------------------------------------------- authority settings

#[derive(Accounts)]
pub struct Configure<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority)]
    pub vault: Box<Account<'info, Vault>>,
}

pub fn handle_set_quoter(ctx: Context<Configure>, quoter: Pubkey) -> Result<()> {
    require!(quoter != Pubkey::default(), VaultError::InvalidConfig);
    ctx.accounts.vault.quoter = quoter;
    Ok(())
}

/// Queues new timings and risk limits for the next roll.
pub fn handle_set_params(ctx: Context<Configure>, params: Params) -> Result<()> {
    validate(&params)?;
    let vault = &mut ctx.accounts.vault;
    vault.next_params = params;
    vault.params_queued = true;
    emit!(ParamsQueued { vault: vault.key(), params });
    Ok(())
}

/// Where the images of positions sold from now on are served.
pub fn handle_set_art_uri(ctx: Context<Configure>, art_uri: String) -> Result<()> {
    require!(art_uri.len() <= MAX_ART_URI_LEN, VaultError::TooLong);
    ctx.accounts.vault.art_uri = art_uri;
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

pub fn handle_allow_feed(ctx: Context<AllowFeed>, feed_id: [u8; 32], symbol: String, allowed: bool) -> Result<()> {
    require!(feed_id != [0u8; 32], VaultError::FeedNotAllowed);
    require!(!symbol.is_empty() && symbol.len() <= MAX_SYMBOL_LEN, VaultError::TooLong);
    let f = &mut ctx.accounts.feed_config;
    f.vault = ctx.accounts.vault.key();
    f.feed_id = feed_id;
    f.allowed = allowed;
    f.symbol = symbol;
    f.bump = ctx.bumps.feed_config;
    Ok(())
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
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault_token.to_account_info(),
                mint: mint.to_account_info(),
                to: to.clone(),
                authority: vault.to_account_info(),
            },
            &[&vault.seeds()],
        ),
        amount,
        mint.decimals,
    )
}
