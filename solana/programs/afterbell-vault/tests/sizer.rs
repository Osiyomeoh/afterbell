//! Sizers: a holder names a key that may re-size their standing order before
//! each close, within bounds they set, without the holder signing each night.

#![allow(clippy::result_large_err)]

mod common;

use {
    afterbell_vault::{
        constants::{ORDER_SEED, SIZER_SEED},
        error::VaultError,
        Order, OrderTerms, Sizer, SizerBounds,
    },
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        InstructionData, ToAccountMetas,
    },
    common::*,
    litesvm::types::TransactionResult,
    litesvm_token::TOKEN_ID,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

fn order_pda(env: &Env, holder: &Pubkey) -> Pubkey {
    env.pda(&[ORDER_SEED, env.vault.as_ref(), holder.as_ref(), FEED.as_ref()])
}

fn sizer_pda(env: &Env, order: &Pubkey) -> Pubkey {
    env.pda(&[SIZER_SEED, order.as_ref()])
}

fn set_order(env: &mut Env, holder: &User) -> TransactionResult {
    let terms = OrderTerms {
        max_shares: 10_000_000,
        start_bps: 1_000,
        depth_bps: 1_500,
        max_premium: 25 * USD,
        until: OPEN + 30 * 86_400,
        allowance: 200 * USD,
    };
    let ix = Instruction::new_with_bytes(
        env.program_id,
        &afterbell_vault::instruction::SetOrder { feed_id: FEED, terms }.data(),
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

fn bounds(sizer: Pubkey) -> SizerBounds {
    SizerBounds { sizer, max_shares: 20_000_000, min_start_bps: 500, max_depth_bps: 3_000 }
}

fn set_sizer(env: &mut Env, signer: &Keypair, order: Pubkey, b: SizerBounds) -> TransactionResult {
    let ix = Instruction::new_with_bytes(
        env.program_id,
        &afterbell_vault::instruction::SetSizer { bounds: b }.data(),
        afterbell_vault::accounts::SetSizer {
            holder: signer.pubkey(),
            order,
            sizer: sizer_pda(env, &order),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    env.send(&[ix], &[signer])
}

fn remove_sizer(env: &mut Env, signer: &Keypair, order: Pubkey) -> TransactionResult {
    let ix = Instruction::new_with_bytes(
        env.program_id,
        &afterbell_vault::instruction::RemoveSizer {}.data(),
        afterbell_vault::accounts::RemoveSizer { holder: signer.pubkey(), order, sizer: sizer_pda(env, &order) }
            .to_account_metas(None),
    );
    env.send(&[ix], &[signer])
}

fn resize(env: &mut Env, signer: &Keypair, order: Pubkey, shares: u64, start: u16, depth: u16) -> TransactionResult {
    let ix = Instruction::new_with_bytes(
        env.program_id,
        &afterbell_vault::instruction::ResizeOrder { max_shares: shares, start_bps: start, depth_bps: depth }.data(),
        afterbell_vault::accounts::ResizeOrder { signer: signer.pubkey(), order, sizer: sizer_pda(env, &order) }
            .to_account_metas(None),
    );
    env.send(&[ix], &[signer])
}

/// An order with a sizer named on it.
fn setup() -> (Env, User, Keypair, Pubkey) {
    let mut env = Env::new();
    let holder = env.new_user(1_000 * USD);
    ok(set_order(&mut env, &holder));
    let sizer = env.new_user(0).kp;
    let order = order_pda(&env, &holder.key());
    ok(set_sizer(&mut env, &holder.kp, order, bounds(sizer.pubkey())));
    (env, holder, sizer, order)
}

#[test]
fn the_sizer_resizes_the_order_within_its_bounds() {
    let (mut env, _holder, sizer, order) = setup();
    let s: Sizer = read(&env.svm, &sizer_pda(&env, &order));
    assert_eq!((s.order, s.sizer, s.max_shares), (order, sizer.pubkey(), 20_000_000));

    ok(resize(&mut env, &sizer, order, 18_000_000, 700, 1_700));
    let o: Order = read(&env.svm, &order);
    assert_eq!((o.max_shares, o.start_bps, o.depth_bps), (18_000_000, 700, 1_700));
    assert_eq!(o.max_premium, 25 * USD, "the premium cap stays the holder's");
}

#[test]
fn a_resize_outside_the_bounds_fails() {
    let (mut env, _holder, sizer, order) = setup();
    for (shares, start, depth) in
        [(20_000_001, 700, 1_700), (0, 700, 1_700), (1, 400, 1_700), (1, 700, 3_001), (1, 1_700, 1_700)]
    {
        assert_vault_error(resize(&mut env, &sizer, order, shares, start, depth), VaultError::OutsideSizerBounds);
    }
}

#[test]
fn only_the_named_sizer_resizes() {
    let (mut env, holder, _sizer, order) = setup();
    let stranger = env.new_user(0).kp;
    assert_vault_error(resize(&mut env, &stranger, order, 1, 700, 1_700), VaultError::NotSizer);
    assert_vault_error(resize(&mut env, &holder.kp, order, 1, 700, 1_700), VaultError::NotSizer);
}

#[test]
fn only_the_holder_names_or_removes_a_sizer() {
    let (mut env, _holder, sizer, order) = setup();
    let stranger = env.new_user(0).kp;
    assert_fails(set_sizer(&mut env, &stranger, order, bounds(stranger.pubkey())));
    assert_fails(remove_sizer(&mut env, &sizer, order));
}

#[test]
fn only_sensible_bounds_are_set() {
    let (mut env, holder, sizer, order) = setup();
    let k = sizer.pubkey();
    for b in [
        SizerBounds { sizer: Pubkey::default(), ..bounds(k) },
        SizerBounds { max_shares: 0, ..bounds(k) },
        SizerBounds { min_start_bps: 0, ..bounds(k) },
        SizerBounds { min_start_bps: 3_000, ..bounds(k) },
        SizerBounds { max_depth_bps: 10_000, ..bounds(k) },
    ] {
        assert_vault_error(set_sizer(&mut env, &holder.kp, order, b), VaultError::InvalidSizer);
    }
}

#[test]
fn a_removed_sizer_can_no_longer_resize() {
    let (mut env, holder, sizer, order) = setup();
    ok(remove_sizer(&mut env, &holder.kp, order));
    assert!(env.svm.get_account(&sizer_pda(&env, &order)).is_none_or(|a| a.lamports == 0));
    assert_fails(resize(&mut env, &sizer, order, 1, 700, 1_700));
}
