//! Standing orders: a holder sets limits once, and any keeper renews their
//! protection each night within them, paid from the order's allowance.

#![allow(clippy::result_large_err)]

mod common;

use {
    afterbell_vault::{constants::ORDER_SEED, error::VaultError, Order, OrderTerms, QuoteArgs},
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        InstructionData, ToAccountMetas,
    },
    anchor_spl::{associated_token, token_2022},
    common::*,
    litesvm::types::TransactionResult,
    litesvm_token::{get_spl_account, spl_token, TOKEN_ID},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

/// $400 at expo -5: an order 10%–15% down protects $360 to $340, as `Env::quote` does.
const PRICE: i64 = 40_000_000;

fn terms() -> OrderTerms {
    OrderTerms {
        max_shares: 10_000_000,
        start_bps: 1_000,
        depth_bps: 1_500,
        max_premium: 25 * USD,
        until: OPEN + 30 * 86_400,
        allowance: 200 * USD,
    }
}

fn order_pda(env: &Env, holder: &Pubkey) -> Pubkey {
    env.pda(&[ORDER_SEED, env.vault.as_ref(), holder.as_ref(), FEED.as_ref()])
}

fn set_order(env: &mut Env, holder: &User, t: OrderTerms) -> TransactionResult {
    let ix = Instruction::new_with_bytes(
        env.program_id,
        &afterbell_vault::instruction::SetOrder { feed_id: FEED, terms: t }.data(),
        afterbell_vault::accounts::SetOrder {
            holder: holder.key(),
            vault: env.vault,
            feed_config: env.feed_pda(FEED),
            order: order_pda(env, &holder.key()),
            collateral_mint: env.mint,
            holder_token: holder.ata,
            token_program: TOKEN_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    env.send(&[ix], &[&holder.kp])
}

fn cancel(env: &mut Env, holder: &User) -> TransactionResult {
    let ix = Instruction::new_with_bytes(
        env.program_id,
        &afterbell_vault::instruction::CancelOrder {}.data(),
        afterbell_vault::accounts::CancelOrder {
            holder: holder.key(),
            order: order_pda(env, &holder.key()),
            holder_token: holder.ata,
            token_program: TOKEN_ID,
        }
        .to_account_metas(None),
    );
    env.send(&[ix], &[&holder.kp])
}

/// A keeper renews `holder`'s order at `q`, signed by the quoter for the order, against `price`.
fn renew_at(env: &mut Env, keeper: &Keypair, holder: &User, q: QuoteArgs, price: Pubkey) -> TransactionResult {
    let order = order_pda(env, &holder.key());
    renew_signed_for(env, keeper, holder, q, price, order)
}

fn renew_signed_for(
    env: &mut Env,
    keeper: &Keypair,
    holder: &User,
    q: QuoteArgs,
    price: Pubkey,
    signed_for: Pubkey,
) -> TransactionResult {
    let order = order_pda(env, &holder.key());
    let position_mint = env.position_mint_pda(q.nonce);
    let ix = Instruction::new_with_bytes(
        env.program_id,
        &afterbell_vault::instruction::Renew { q }.data(),
        afterbell_vault::accounts::Renew {
            keeper: keeper.pubkey(),
            holder: holder.key(),
            order,
            vault: env.vault,
            feed_config: env.feed_pda(FEED),
            series: env.series_pda(q.feed_id, q.open_ts),
            position: env.position_pda(q.nonce),
            position_mint,
            holder_nft: Env::nft_account(&holder.key(), &position_mint),
            collateral_mint: env.mint,
            holder_token: holder.ata,
            vault_token: env.vault_token,
            price_update: price,
            instructions: solana_sdk_ids::sysvar::instructions::ID,
            token_program: TOKEN_ID,
            nft_token_program: token_2022::ID,
            associated_token_program: associated_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    let sig = Env::ed25519_ix(&env.quoter, &env.message(&signed_for, &q));
    env.send(&[sig, ix], &[keeper])
}

fn fresh_price(env: &mut Env) -> Pubkey {
    let now = env.now();
    env.price(PriceSpec { price: PRICE, publish_time: now, prev_publish_time: now - 1, ..Default::default() })
}

fn renew(env: &mut Env, keeper: &Keypair, holder: &User, q: QuoteArgs) -> TransactionResult {
    let price = fresh_price(env);
    renew_at(env, keeper, holder, q, price)
}

fn setup() -> (Env, User, Keypair) {
    let mut env = Env::new();
    let holder = env.new_user(1_000 * USD);
    ok(set_order(&mut env, &holder, terms()));
    let keeper = env.new_user(0).kp;
    (env, holder, keeper)
}

fn delegated(env: &Env, holder: &User) -> (Option<Pubkey>, u64) {
    let a = get_spl_account::<spl_token::state::Account>(&env.svm, &holder.ata).unwrap();
    (a.delegate.into(), a.delegated_amount)
}

#[test]
fn a_keeper_renews_and_the_holder_gets_the_nft_and_pays_from_the_allowance() {
    let (mut env, holder, keeper) = setup();
    let order = order_pda(&env, &holder.key());
    assert_eq!(delegated(&env, &holder), (Some(order), 200 * USD));

    let q = env.quote();
    let before = env.balance(&holder.ata);
    ok(renew(&mut env, &keeper, &holder, q));

    assert_eq!(env.balance(&holder.ata), before - q.premium);
    assert_eq!(delegated(&env, &holder).1, 200 * USD - q.premium);
    let position = env.position(&env.position_pda(q.nonce)).unwrap();
    assert_eq!(position.buyer, holder.key());
    assert_eq!(env.balance(&Env::nft_account(&holder.key(), &position.mint)), 1);
    let o: Order = read(&env.svm, &order);
    assert_eq!(o.last_open_ts, OPEN);
}

#[test]
fn an_order_renews_once_per_opening() {
    let (mut env, holder, keeper) = setup();
    let q = env.quote();
    ok(renew(&mut env, &keeper, &holder, q));
    let again = env.quote();
    assert_vault_error(renew(&mut env, &keeper, &holder, again), VaultError::AlreadyRenewed);
}

#[test]
fn a_renewal_stays_within_the_orders_limits() {
    let (mut env, holder, keeper) = setup();
    let mut q = env.quote();
    q.shares += 1;
    assert_vault_error(renew(&mut env, &keeper, &holder, q), VaultError::OverOrderLimit);
    let mut q = env.quote();
    q.premium = 26 * USD;
    assert_vault_error(renew(&mut env, &keeper, &holder, q), VaultError::OverOrderLimit);
}

#[test]
fn the_strikes_follow_the_price() {
    let (mut env, holder, keeper) = setup();
    // At $300 the order wants $270 to $255, not $360 to $340.
    let now = env.now();
    let low = env.price(PriceSpec { price: 30_000_000, publish_time: now, ..Default::default() });
    let q = env.quote();
    assert_vault_error(renew_at(&mut env, &keeper, &holder, q, low), VaultError::StrikesOffOrder);
    // Within 5% of the price either way is fine: $378 puts the strikes at $340.20 and $321.30.
    let near = env.price(PriceSpec { price: 37_800_000, publish_time: now, ..Default::default() });
    let mut q = env.quote();
    q.lower = 32_200_000_000;
    q.upper = 35_000_000_000;
    ok(renew_at(&mut env, &keeper, &holder, q, near));
}

#[test]
fn a_renewal_needs_a_recent_verified_price_for_the_stock() {
    let (mut env, holder, keeper) = setup();
    let now = env.now();
    let old = env.price(PriceSpec { price: PRICE, publish_time: now - 5 * 86_400, ..Default::default() });
    let q = env.quote();
    assert_vault_error(renew_at(&mut env, &keeper, &holder, q, old), VaultError::StalePrice);
    let other = env.price(PriceSpec { feed_id: FEED2, price: PRICE, publish_time: now, ..Default::default() });
    assert_vault_error(renew_at(&mut env, &keeper, &holder, q, other), VaultError::FeedMismatch);
}

#[test]
fn a_quote_signed_for_the_holder_not_the_order_does_not_renew() {
    let (mut env, holder, keeper) = setup();
    let q = env.quote();
    let price = fresh_price(&mut env);
    let res = renew_signed_for(&mut env, &keeper, &holder, q, price, holder.key());
    assert_vault_error(res, VaultError::InvalidSignature);
}

#[test]
fn a_cancelled_or_ended_order_does_not_renew() {
    let (mut env, holder, keeper) = setup();
    ok(cancel(&mut env, &holder));
    assert_eq!(delegated(&env, &holder), (None, 0));
    let q = env.quote();
    assert_vault_error(renew(&mut env, &keeper, &holder, q), VaultError::OrderNotActive);

    let mut t = terms();
    t.until = OPEN;
    ok(set_order(&mut env, &holder, t));
    let q = env.quote();
    assert_vault_error(renew(&mut env, &keeper, &holder, q), VaultError::OrderEnded);
}

#[test]
fn only_sensible_orders_are_set() {
    let mut env = Env::new();
    let holder = env.new_user(1_000 * USD);
    let now = env.now();
    for bad in [
        OrderTerms { max_shares: 0, ..terms() },
        OrderTerms { max_premium: 0, ..terms() },
        OrderTerms { start_bps: 0, ..terms() },
        OrderTerms { depth_bps: 1_000, ..terms() },
        OrderTerms { depth_bps: 10_000, ..terms() },
        OrderTerms { until: now, ..terms() },
    ] {
        assert_vault_error(set_order(&mut env, &holder, bad), VaultError::InvalidOrder);
    }
}

#[test]
fn only_the_holder_cancels() {
    let (mut env, holder, _) = setup();
    let mallory = env.new_user(0);
    let ix = Instruction::new_with_bytes(
        env.program_id,
        &afterbell_vault::instruction::CancelOrder {}.data(),
        afterbell_vault::accounts::CancelOrder {
            holder: mallory.key(),
            order: order_pda(&env, &holder.key()),
            holder_token: mallory.ata,
            token_program: TOKEN_ID,
        }
        .to_account_metas(None),
    );
    assert_fails(env.send(&[ix], &[&mallory.kp]));
}
