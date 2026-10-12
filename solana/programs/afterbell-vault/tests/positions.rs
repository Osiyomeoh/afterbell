//! Positions as NFTs: `process` pays whoever holds one, checks the accounts
//! that prove it, pays keepers their tips, and pays each position once.

mod common;

use {
    afterbell_vault::{error::VaultError, QuoteArgs},
    anchor_lang::{prelude::Pubkey, solana_program::instruction::AccountMeta},
    common::*,
    litesvm_token::{CreateAssociatedTokenAccount, CreateMint},
};

/// A sold position, settled at `price` (expo -5).
fn settled(price: i64) -> (Env, QuoteArgs, Pubkey, Pubkey) {
    let mut env = Env::new();
    let q = env.quote();
    ok(env.buy(q));
    ok(env.settle_at(price));
    let (position, series) = (env.position_pda(q.nonce), env.series_pda(FEED, OPEN));
    (env, q, position, series)
}

#[test]
fn process_pays_whoever_holds_the_nft_and_tips_the_keeper() {
    let mut env = Env::new();
    let q = env.quote();
    ok(env.buy(q));
    let position = env.position_pda(q.nonce);
    let carol = env.new_user(0);
    let buyer = env.buyer.clone();
    ok(env.transfer_nft(&position, &buyer, &carol.key()));
    ok(env.settle_at(35_500_000)); // $355: 10 x ($360 - $355)

    ok(env.process(&env.series_pda(FEED, OPEN), &[position]));
    assert_eq!(env.balance(&carol.ata), 50 * USD, "the holder is paid");
    assert_eq!(env.balance(&buyer.ata), 980 * USD, "not the buyer, who sold the NFT");
    assert_eq!(env.balance(&env.keeper.ata), 400_000, "2% of the premium");

    let p = env.position(&position).unwrap();
    assert_eq!((p.closed, p.paid, p.paid_to), (true, 50 * USD, carol.key()));
    // The NFT stays with its holder, and the position stays on-chain with its outcome.
    assert_eq!(env.balance(&Env::nft_account(&carol.key(), &p.mint)), 1);
    let s = env.series(FEED, OPEN);
    assert_eq!((s.locked, s.sold, s.paid), (0, 1, 1));
    let v = env.vault_state();
    assert_eq!((v.locked, v.tips_owed, v.round_unpaid), (0, 0, 0));
    // The pool kept the premium less the payout and the tip.
    assert_eq!(env.total_assets(), SEED + 20 * USD - 50 * USD - 400_000);
}

#[test]
fn payouts_cap_at_the_maximum_and_are_nothing_above_the_upper_strike() {
    for (price, paid) in [(30_000_000, 200 * USD), (34_000_000, 200 * USD), (36_000_000, 0), (36_500_000, 0)] {
        let (mut env, _, position, series) = settled(price);
        ok(env.process(&series, &[position]));
        assert_eq!(env.balance(&env.buyer.ata), 980 * USD + paid, "open at {price}");
        assert_eq!(env.balance(&env.keeper.ata), 400_000, "tipped whatever it paid");
        assert_eq!(env.vault_state().locked, 0);
    }
}

#[test]
fn process_waits_for_the_series_to_settle_or_void() {
    let mut env = Env::new();
    let q = env.quote();
    ok(env.buy(q));
    let series = env.series_pda(FEED, OPEN);
    assert_vault_error(env.process(&series, &[env.position_pda(q.nonce)]), VaultError::SeriesStillOpen);
}

#[test]
fn a_position_is_paid_once() {
    let (mut env, _, position, series) = settled(35_500_000);
    // Twice in one transaction, then again in another: paid and tipped once.
    let triple = env.triple(&position);
    let keeper = env.keeper.clone();
    let ix = env.ix_process(&series, &keeper.key(), &keeper.ata, &[triple, triple]);
    ok(env.send(&[ix], &[&keeper.kp]));
    ok(env.process(&series, &[position]));
    assert_eq!(env.balance(&env.buyer.ata), 1_030 * USD);
    assert_eq!(env.balance(&env.keeper.ata), 400_000);
}

#[test]
fn a_holder_can_pay_out_their_own_position_and_keep_the_tip() {
    let (mut env, _, position, series) = settled(35_500_000);
    let buyer = env.buyer.clone();
    let triple = env.triple(&position);
    let ix = env.ix_process(&series, &buyer.key(), &buyer.ata, &[triple]);
    ok(env.send(&[ix], &[&buyer.kp]));
    assert_eq!(env.balance(&buyer.ata), 980 * USD + 50 * USD + 400_000);
}

#[test]
fn only_the_holder_can_be_paid() {
    let (mut env, _, position, series) = settled(35_500_000);
    let p = env.position(&position).unwrap();
    let buyer = env.buyer.clone();
    let thief = env.new_user(0);
    let keeper = env.keeper.clone();
    let nft = Env::nft_account(&buyer.key(), &p.mint);
    let try_with = |env: &mut Env, triple: [Pubkey; 3]| {
        let ix = env.ix_process(&series, &keeper.key(), &keeper.ata, &[triple]);
        env.send(&[ix], &[&keeper.kp])
    };

    // The holder's NFT account, but the thief's collateral account.
    assert_vault_error(try_with(&mut env, [position, nft, thief.ata]), VaultError::WrongPayee);
    // The holder's own account, but in another mint.
    let other_mint = CreateMint::new(&mut env.svm, &env.payer).decimals(6).send().unwrap();
    let other =
        CreateAssociatedTokenAccount::new(&mut env.svm, &env.payer, &other_mint).owner(&buyer.key()).send().unwrap();
    assert_vault_error(try_with(&mut env, [position, nft, other]), VaultError::WrongPayee);
    // An empty NFT account: the thief's, created for the mint but holding nothing.
    let thief_nft = Env::nft_account(&thief.key(), &p.mint);
    let create = anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent(
        &thief.key(),
        &thief.key(),
        &p.mint,
        &anchor_spl::token_2022::ID,
    );
    ok(env.send(&[create], &[&thief.kp]));
    assert_vault_error(try_with(&mut env, [position, thief_nft, thief.ata]), VaultError::NotHolder);
    // A token account of another mint, though its owner is the thief.
    assert_fails(try_with(&mut env, [position, thief.ata, thief.ata]));
    // After selling the NFT the old account holds nothing, so the buyer can't be paid either.
    ok(env.transfer_nft(&position, &buyer, &thief.key()));
    assert_vault_error(try_with(&mut env, [position, nft, buyer.ata]), VaultError::NotHolder);

    assert_eq!(env.balance(&buyer.ata), 980 * USD);
    assert!(!env.position(&position).unwrap().closed);
    // Now the thief does hold it, legitimately, and is paid.
    ok(try_with(&mut env, [position, thief_nft, thief.ata]));
    assert_eq!(env.balance(&thief.ata), 50 * USD);
}

#[test]
fn process_checks_the_accounts_come_in_threes_and_belong_to_the_series() {
    let mut env = Env::new();
    let q = env.quote();
    ok(env.buy(q));
    let q2 = QuoteArgs { feed_id: FEED2, ..env.quote() };
    ok(env.buy(q2));
    ok(env.settle_feed_at(FEED, 35_500_000));
    ok(env.settle_feed_at(FEED2, 35_500_000));
    let (series, keeper) = (env.series_pda(FEED, OPEN), env.keeper.clone());
    let (p1, p2) = (env.position_pda(q.nonce), env.position_pda(q2.nonce));

    let ix = env.ix_process(&series, &keeper.key(), &keeper.ata, &[]);
    assert_vault_error(env.send(&[ix], &[&keeper.kp]), VaultError::BadPositionAccounts);
    let mut ix = env.ix_process(&series, &keeper.key(), &keeper.ata, &[env.triple(&p1)]);
    ix.accounts.pop();
    assert_vault_error(env.send(&[ix], &[&keeper.kp]), VaultError::BadPositionAccounts);
    // A read-only position can't be marked paid.
    let mut ix = env.ix_process(&series, &keeper.key(), &keeper.ata, &[env.triple(&p1)]);
    let n = ix.accounts.len();
    ix.accounts[n - 3] = AccountMeta::new_readonly(p1, false);
    assert_vault_error(env.send(&[ix], &[&keeper.kp]), VaultError::BadPositionAccounts);
    // A position of the other stock's series.
    let ix = env.ix_process(&series, &keeper.key(), &keeper.ata, &[env.triple(&p2)]);
    assert_vault_error(env.send(&[ix], &[&keeper.kp]), VaultError::WrongSeries);
    // Anything that isn't a position.
    let ix = env.ix_process(&series, &keeper.key(), &keeper.ata, &[[keeper.ata, keeper.ata, keeper.ata]]);
    assert_fails(env.send(&[ix], &[&keeper.kp]));
}

#[test]
fn a_keeper_pays_a_batch_in_one_transaction() {
    let mut env = Env::new();
    let mut positions = vec![];
    for _ in 0..8 {
        let q = env.quote();
        ok(env.buy(q));
        positions.push(env.position_pda(q.nonce));
    }
    ok(env.settle_at(35_500_000));
    let series = env.series_pda(FEED, OPEN);
    let keeper = env.keeper.clone();
    // Seven positions fit a legacy transaction's 1,232 bytes; the keeper batches by that.
    let triples: Vec<_> = positions[..7].iter().map(|p| env.triple(p)).collect();
    let ix = env.ix_process(&series, &keeper.key(), &keeper.ata, &triples);
    let tx = env.tx(std::slice::from_ref(&ix), &[&keeper.kp]);
    let bytes = 1 + 64 * tx.signatures.len() + tx.message.serialize().len();
    assert!(bytes <= 1_232, "{bytes} bytes");
    ok(env.send(&[ix], &[&keeper.kp]));
    assert!(env.last_cu < 200_000, "{} compute units", env.last_cu);
    ok(env.process(&series, &positions[7..]));
    assert_eq!(env.balance(&env.buyer.ata), 1_000 * USD - 8 * 20 * USD + 8 * 50 * USD);
    assert_eq!(env.balance(&keeper.ata), 8 * 400_000);
    assert_eq!(env.vault_state().round_unpaid, 0);
}

#[test]
fn a_burned_nft_forfeits_its_payout_to_the_pool_so_the_round_can_end() {
    let (mut env, q, position, series) = settled(35_500_000); // would pay 10 x $5
    let buyer = env.buyer.clone();
    // Passing the mint while someone still holds the NFT proves nothing.
    let keeper = env.keeper.clone();
    let mint = env.position(&position).unwrap().mint;
    let ix = env.ix_process(&series, &keeper.key(), &keeper.ata, &[[position, mint, mint]]);
    assert_vault_error(env.send(&[ix], &[&keeper.kp]), VaultError::NotHolder);

    ok(env.burn_nft(&position, &buyer));
    ok(env.process(&series, &[position]));
    let p = env.position(&position).unwrap();
    assert_eq!((p.closed, p.paid, p.paid_to), (true, 0, Pubkey::default()));
    assert_eq!(env.balance(&buyer.ata), 980 * USD, "nobody is paid");
    assert_eq!(env.balance(&env.keeper.ata), 400_000, "the keeper is still tipped for closing it");
    let v = env.vault_state();
    assert_eq!((v.locked, v.tips_owed, v.round_unpaid), (0, 0, 0));
    // The pool keeps the premium and the payout nobody could take, less the tip.
    assert_eq!(env.total_assets(), SEED + q.premium - 400_000);
    env.set_time(OPEN + 60);
    ok(env.roll());
}
