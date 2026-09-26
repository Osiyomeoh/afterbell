//! The underwriters' pool: requests filled at the roll at the pool's exact
//! value, one opening per round, and risk limits measured against the pool at
//! the roll.

mod common;

use {
    afterbell_vault::{error::VaultError, QuoteArgs},
    anchor_lang::{solana_program::system_program, InstructionData, ToAccountMetas},
    anchor_spl::token::ID as TOKEN_ID,
    common::*,
};

/// One sale on FEED, settled at `price` and paid out, so the round can roll.
fn a_night(env: &mut Env, price: i64) {
    let q = env.quote();
    ok(env.buy(q));
    ok(env.settle_at(price));
    let series = env.series_pda(FEED, OPEN);
    ok(env.process(&series, &[env.position_pda(q.nonce)]));
}

/// A quote for `feed` whose maximum payout is `dollars` ($20 spread).
fn quote_paying(env: &mut Env, feed: [u8; 32], dollars: u64) -> QuoteArgs {
    QuoteArgs { feed_id: feed, shares: dollars * 50_000, ..env.quote() }
}

#[test]
fn a_deposit_joins_at_the_roll_at_the_pools_value_then() {
    let mut env = Env::new();
    let dave = env.new_user(1_000 * USD);
    ok(env.request_deposit(&dave, 1_000 * USD));
    let v = env.vault_state();
    assert_eq!(v.pending_deposit_assets, 1_000 * USD);
    assert_eq!(env.total_assets(), SEED, "queued money isn't the pool's yet");
    assert_eq!(env.request(&dave.key()).unwrap().deposit_round, 2);
    assert_vault_error(env.claim_deposit(&dave), VaultError::NothingToClaim);

    // A good night: the pool keeps the $20 premium less the keeper's 40 cents.
    a_night(&mut env, 36_500_000);
    ok(env.roll());
    let r = env.rate(2);
    assert_eq!((r.assets, r.supply, r.open_ts), (SEED + 20 * USD - 400_000, SEED, OPEN));
    assert_eq!((r.deposit_assets, r.deposit_shares), (1_000 * USD, 999_804_038));

    // Dave joined at the new price: fewer shares than dollars, and worth what he paid.
    ok(env.claim_deposit(&dave));
    assert_eq!(env.shares_of(&dave.key()), 999_804_038);
    let v = env.vault_state();
    assert_eq!((v.round, v.round_open_ts, v.pending_deposit_assets), (3, 0, 0));
    assert_eq!(v.round_nav, SEED + 20 * USD - 400_000 + 1_000 * USD);
    let worth = afterbell_vault::math::assets_for(999_804_038, v.round_nav, env.share_supply()).unwrap();
    assert!(worth <= 1_000 * USD && worth > 1_000 * USD - 2, "worth {worth}");
    assert_vault_error(env.claim_deposit(&dave), VaultError::NothingToClaim);
}

#[test]
fn a_bad_night_is_borne_by_those_in_the_pool_not_by_whoever_joins_after() {
    let mut env = Env::new();
    let dave = env.new_user(1_000 * USD);
    ok(env.request_deposit(&dave, 1_000 * USD));
    // The worst night: the position pays its $200 maximum.
    a_night(&mut env, 30_000_000);
    ok(env.roll());
    ok(env.claim_deposit(&dave));
    assert_eq!(env.shares_of(&dave.key()), 1_001_807_260, "more shares: the pool is worth less");
    assert_eq!(env.vault_state().round_nav, SEED + 20 * USD - 200 * USD - 400_000 + 1_000 * USD);
}

#[test]
fn a_redemption_leaves_at_the_roll_at_the_pools_value_then() {
    let mut env = Env::new();
    let auth = env.authority.clone();
    ok(env.request_redeem(&auth, 10_000 * USD));
    assert_eq!(env.shares_of(&auth.key()), SEED - 10_000 * USD);
    assert_eq!(env.balance(&env.share_escrow), 10_000 * USD, "waiting in the vault");
    assert_eq!(env.share_supply(), SEED, "still shares until the roll");
    assert_vault_error(env.claim_redemption(&auth), VaultError::NothingToClaim);

    a_night(&mut env, 36_500_000);
    ok(env.roll());
    assert_eq!(env.share_supply(), SEED - 10_000 * USD, "burned at the roll");
    assert_eq!(env.balance(&env.share_escrow), 0);
    let v = env.vault_state();
    assert_eq!(v.reserved_assets, 10_001_959_999);
    assert_eq!(v.round_nav, SEED + 20 * USD - 400_000 - 10_001_959_999, "what's owed isn't the pool's");

    let before = env.balance(&auth.ata);
    ok(env.claim_redemption(&auth));
    assert_eq!(env.balance(&auth.ata) - before, 10_001_959_999);
    assert_eq!(env.vault_state().reserved_assets, 0);
    assert_vault_error(env.claim_redemption(&auth), VaultError::NothingToClaim);
}

#[test]
fn the_roll_waits_for_the_open_and_every_payout() {
    let mut env = Env::new();
    let q = env.quote();
    ok(env.buy(q));
    assert_vault_error(env.roll(), VaultError::RoundNotOver);
    env.set_time(OPEN);
    assert_vault_error(env.roll(), VaultError::RoundNotOver);
    ok(env.settle_at(35_500_000));
    assert_vault_error(env.roll(), VaultError::RoundNotOver);
    ok(env.process(&env.series_pda(FEED, OPEN), &[env.position_pda(q.nonce)]));
    ok(env.roll());
    // Its rate is recorded once: the round can't roll twice.
    assert_eq!(env.vault_state().round, 3);
}

#[test]
fn a_round_that_sold_nothing_rolls_at_any_time() {
    let mut env = Env::new();
    for round in 2..5 {
        ok(env.roll());
        let r = env.rate(round);
        assert_eq!((r.assets, r.supply, r.open_ts), (SEED, SEED, 0));
    }
    assert_eq!(env.vault_state().round, 5);
}

#[test]
fn a_round_sells_one_opening() {
    let mut env = Env::new();
    let q = env.quote();
    ok(env.buy(q));
    let later = QuoteArgs { open_ts: OPEN + 86_400, ..env.quote() };
    assert_vault_error(env.buy(later), VaultError::WrongRound);
    // Another stock on the same opening is fine.
    let q2 = QuoteArgs { feed_id: FEED2, ..env.quote() };
    ok(env.buy(q2));

    // Once the round is paid and rolled, the next one sells the next opening.
    ok(env.settle_feed_at(FEED, 36_500_000));
    ok(env.settle_feed_at(FEED2, 36_500_000));
    let positions: Vec<_> = env.holders.keys().copied().collect();
    for p in positions {
        let series = env.position(&p).unwrap().series;
        ok(env.process(&series, &[p]));
    }
    ok(env.roll());
    let next = QuoteArgs { open_ts: OPEN + 86_400, ..env.quote() };
    ok(env.buy(next));
    assert_eq!(env.vault_state().round_open_ts, OPEN + 86_400);
}

#[test]
fn a_round_locks_at_most_half_the_pool_and_a_fifth_on_one_stock() {
    let mut env = Env::new();
    let feed3 = [9u8; 32];
    let auth = env.authority.kp.insecure_clone();
    let ix = env.ix_allow_feed(feed3, "NVDA", true);
    ok(env.send(&[ix], &[&auth]));

    // A fifth of $100,000 on TSLA, and not a cent more.
    let q = quote_paying(&mut env, FEED, 20_000);
    ok(env.buy(q));
    let q = QuoteArgs { shares: 1, premium: 0, ..env.quote() };
    let q = QuoteArgs { shares: 50, ..q }; // $0.001 more
    assert_vault_error(env.buy(q), VaultError::OverStockLimit);
    let q = quote_paying(&mut env, FEED2, 20_000);
    ok(env.buy(q));
    let q = quote_paying(&mut env, feed3, 10_000);
    ok(env.buy(q));
    assert_eq!(env.vault_state().locked, 50_000 * USD, "exactly half the pool");
    let q = QuoteArgs { feed_id: feed3, shares: 50, premium: 0, ..env.quote() };
    assert_vault_error(env.buy(q), VaultError::OverCapacity);

    // Money queued mid-round doesn't raise the limits: they're measured at the roll.
    let whale = env.new_user(1_000_000 * USD);
    ok(env.request_deposit(&whale, 1_000_000 * USD));
    let q = QuoteArgs { feed_id: feed3, shares: 50, premium: 0, ..env.quote() };
    assert_vault_error(env.buy(q), VaultError::OverCapacity);
}

#[test]
fn an_empty_pool_sells_nothing_and_its_first_underwriter_gets_a_share_per_unit() {
    let mut env = Env::empty();
    let q = env.quote();
    assert_vault_error(env.buy(q), VaultError::OverCapacity);
    let dave = env.new_user(500 * USD);
    ok(env.request_deposit(&dave, 500 * USD));
    ok(env.roll());
    ok(env.claim_deposit(&dave));
    assert_eq!(env.shares_of(&dave.key()), 500 * USD);
}

#[test]
fn an_old_request_is_filled_at_its_own_rounds_rate() {
    let mut env = Env::new();
    let dave = env.new_user(2_000 * USD);
    ok(env.request_deposit(&dave, 1_000 * USD));
    a_night(&mut env, 36_500_000);
    ok(env.roll()); // round 2 filled Dave's request

    let build = |env: &Env, rate: Option<anchor_lang::prelude::Pubkey>| {
        anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
            env.program_id,
            &afterbell_vault::instruction::RequestDeposit { assets: 1_000 * USD }.data(),
            afterbell_vault::accounts::RequestDeposit {
                owner: dave.key(),
                vault: env.vault,
                request: env.request_pda(&dave.key()),
                rate,
                collateral_mint: env.mint,
                owner_token: dave.ata,
                vault_token: env.vault_token,
                token_program: TOKEN_ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    };
    let ix = build(&env, None);
    assert_vault_error(env.send(&[ix], &[&dave.kp]), VaultError::RateMissing);
    let ix = build(&env, Some(env.rate_pda(1)));
    assert_vault_error(env.send(&[ix], &[&dave.kp]), VaultError::WrongRate);
    let ix = build(&env, Some(env.rate_pda(2)));
    ok(env.send(&[ix], &[&dave.kp]));
    let r = env.request(&dave.key()).unwrap();
    assert_eq!((r.filled_deposit_assets, r.filled_deposit_shares), (1_000 * USD, 999_804_038));
    assert_eq!((r.deposit_round, r.deposit_assets), (3, 1_000 * USD));

    // The second request fills at round 3's roll; one claim takes both.
    ok(env.roll());
    ok(env.claim_deposit(&dave));
    let second = afterbell_vault::math::shares_for(1_000 * USD, env.rate(3).assets, env.rate(3).supply).unwrap();
    assert_eq!(env.shares_of(&dave.key()), 999_804_038 + second);
}

#[test]
fn only_the_owner_claims_a_request() {
    let mut env = Env::new();
    let dave = env.new_user(1_000 * USD);
    ok(env.request_deposit(&dave, 1_000 * USD));
    ok(env.roll());
    let eve = env.new_user(0);
    // Eve signs, naming Dave's request: its address is derived from the signer, so it doesn't match.
    let mut ix = env.ix_claim_deposit(&dave);
    ix.accounts[0].pubkey = eve.key();
    ix.accounts[5].pubkey = env.share_account(&eve.key());
    assert_fails(env.send(&[ix], &[&eve.kp]));
    ok(env.claim_deposit(&dave));
    assert_eq!(env.shares_of(&dave.key()), 1_000 * USD);
}

#[test]
fn nobody_redeems_shares_they_do_not_have() {
    let mut env = Env::new();
    let dave = env.new_user(1_000 * USD);
    ok(env.request_deposit(&dave, 1_000 * USD));
    ok(env.roll());
    ok(env.claim_deposit(&dave));
    assert_fails(env.request_redeem(&dave, 1_000 * USD + 1));
    ok(env.request_redeem(&dave, 1_000 * USD));
    assert_eq!(env.vault_state().pending_redeem_shares, 1_000 * USD);
}
