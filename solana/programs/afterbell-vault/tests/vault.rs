mod common;

use {
    afterbell_vault::{error::VaultError, SeriesState, VaultConfig},
    common::*,
    pyth_solana_receiver_sdk::price_update::VerificationLevel,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

// ------------------------------------------------------------------- set-up

#[test]
fn initialize_records_the_config_and_holds_the_deposit() {
    let env = Env::new();
    let v = env.vault_state();
    assert_eq!(v.authority, env.authority.kp.pubkey());
    assert_eq!(v.quoter, env.quoter.pubkey());
    assert_eq!(v.collateral_mint, env.mint);
    assert_eq!(v.vault_token, env.vault_token);
    assert_eq!(v.collateral_unit, USD);
    assert_eq!(v.locked, 0);
    assert_eq!((v.settle_window_secs, v.void_delay_secs, v.max_conf_bps), (SETTLE_WINDOW, VOID_DELAY, MAX_CONF_BPS));
    assert_eq!(env.balance(&env.vault_token), SEED);
    assert!(env.feed_config(FEED).allowed);
}

#[test]
fn config_is_validated_and_authority_only() {
    let mut env = Env::new();
    let auth = env.authority.kp.insecure_clone();
    type Mutate = fn(&mut VaultConfig);
    let bad: Vec<Mutate> = vec![
        |c| c.settle_window_secs = 0,
        |c| c.settle_window_secs = 3_601,
        |c| c.void_delay_secs = 3_599,
        |c| c.void_delay_secs = 7 * 86_400 + 1,
        |c| c.max_conf_bps = 0,
        |c| c.max_conf_bps = 1_001,
        |c| c.quoter = Default::default(),
    ];
    for mutate in bad {
        let mut c = env.config();
        mutate(&mut c);
        let ix = env.ix_set_config(&auth.pubkey(), c);
        assert_vault_error(env.send(&[ix], &[&auth]), VaultError::InvalidConfig);
    }
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let ix = env.ix_set_config(&stranger.pubkey(), env.config());
    assert_fails(env.send(&[ix], &[&stranger]));
}

// ------------------------------------------------------------------- buying

#[test]
fn buy_takes_the_premium_and_locks_the_max_payout() {
    let mut env = Env::new();
    let q = env.quote();
    env.buy(q).unwrap();

    let p = env.position(q.nonce).unwrap();
    assert_eq!(p.buyer, env.buyer.kp.pubkey());
    assert_eq!((p.shares, p.upper, p.lower, p.premium), (q.shares, q.upper, q.lower, q.premium));
    assert_eq!(p.max_payout, 200 * USD, "10 shares x $20 spread");
    assert_eq!(env.vault_state().locked, 200 * USD);
    assert_eq!(env.balance(&env.buyer.ata), 980 * USD);
    assert_eq!(env.balance(&env.vault_token), SEED + 20 * USD);
    let s = env.series(FEED, OPEN);
    assert_eq!((s.state, s.open_ts, s.feed_id), (SeriesState::Open, OPEN, FEED));
}

#[test]
fn buy_needs_the_signature_instruction_right_before_it() {
    let mut env = Env::new();
    let q = env.quote();
    let buyer = env.buyer.kp.insecure_clone();

    let ix = env.ix_buy(&env.buyer, q);
    assert_vault_error(env.send(&[ix], &[&buyer]), VaultError::MissingSignature);

    // A valid signature, but not immediately before `buy`.
    let sig = Env::ed25519_ix(&env.quoter, &env.message(&buyer.pubkey(), &q));
    let other = env.ix_allow_feed([9u8; 32], false); // any other instruction in between
    let ix = env.ix_buy(&env.buyer, q);
    let auth = env.authority.kp.insecure_clone();
    assert_vault_error(env.send(&[sig, other, ix], &[&buyer, &auth]), VaultError::MissingSignature);
}

#[test]
fn buy_rejects_a_signature_from_anyone_but_the_quoter() {
    let mut env = Env::new();
    let q = env.quote();
    let buyer = env.buyer.kp.insecure_clone();
    let impostor = Keypair::new();
    let sig = Env::ed25519_ix(&impostor, &env.message(&buyer.pubkey(), &q));
    let ix = env.ix_buy(&env.buyer, q);
    assert_vault_error(env.send(&[sig, ix], &[&buyer]), VaultError::InvalidSignature);
}

#[test]
fn buy_rejects_a_quote_changed_after_signing() {
    let mut env = Env::new();
    let q = env.quote();
    let buyer = env.buyer.kp.insecure_clone();
    let sig = Env::ed25519_ix(&env.quoter, &env.message(&buyer.pubkey(), &q));
    let cheaper = afterbell_vault::QuoteArgs { premium: USD, ..q };
    let ix = env.ix_buy(&env.buyer, cheaper);
    assert_vault_error(env.send(&[sig, ix], &[&buyer]), VaultError::InvalidSignature);
}

#[test]
fn buy_rejects_someone_else_using_a_buyers_quote() {
    let mut env = Env::new();
    let q = env.quote();
    let thief = env.new_user(1_000 * USD);
    // Signed for the buyer; the thief replays it with the same signature.
    let sig = Env::ed25519_ix(&env.quoter, &env.message(&env.buyer.kp.pubkey(), &q));
    let ix = env.ix_buy(&thief, q);
    assert_vault_error(env.send(&[sig, ix], &[&thief.kp.insecure_clone()]), VaultError::InvalidSignature);
}

#[test]
fn a_forged_signature_fails_the_whole_transaction() {
    let mut env = Env::new();
    let q = env.quote();
    let buyer = env.buyer.kp.insecure_clone();
    let mut sig = Env::ed25519_ix(&env.quoter, &env.message(&buyer.pubkey(), &q));
    sig.data[48] ^= 1; // flip a bit of the signature
    let ix = env.ix_buy(&env.buyer, q);
    let err = env.send(&[sig, ix], &[&buyer]).expect_err("forged signature accepted");
    // The runtime's signature check (instruction 0) fails before `buy` ever runs.
    assert!(format!("{:?}", err.err).contains("InstructionError(0"), "got {:?}", err.err);
    assert!(env.position(q.nonce).is_none());
}

#[test]
fn buy_rejects_expired_quotes_and_passed_opens() {
    let mut env = Env::new();
    let q = env.quote();
    env.set_time(q.expiry + 1);
    assert_vault_error(env.buy(q), VaultError::QuoteExpired);

    let mut env = Env::new();
    let q = afterbell_vault::QuoteArgs { open_ts: T0, ..env.quote() };
    assert_vault_error(env.buy(q), VaultError::AlreadyOpen);
}

#[test]
fn buy_rejects_feeds_the_vault_does_not_sell() {
    let mut env = Env::new();
    let auth = env.authority.kp.insecure_clone();
    let ix = env.ix_allow_feed(FEED, false);
    env.send(&[ix], &[&auth]).unwrap();
    let q = env.quote();
    assert_vault_error(env.buy(q), VaultError::FeedNotAllowed);

    // A feed never configured has no config account at all.
    let q = afterbell_vault::QuoteArgs { feed_id: [3u8; 32], ..env.quote() };
    assert_fails(env.buy(q));
}

#[test]
fn a_quote_buys_once() {
    let mut env = Env::new();
    let q = env.quote();
    env.buy(q).unwrap();
    assert_fails(env.buy(q));
    assert_eq!(env.vault_state().locked, 200 * USD);
}

#[test]
fn buy_rejects_malformed_protection() {
    let mut env = Env::new();
    for q in [
        afterbell_vault::QuoteArgs { upper: 34_000_000_000, ..env.quote() },
        afterbell_vault::QuoteArgs { shares: 0, ..env.quote() },
        afterbell_vault::QuoteArgs { premium: 200 * USD + 1, ..env.quote() },
    ] {
        assert_vault_error(env.buy(q), VaultError::InvalidProtection);
    }
}

#[test]
fn buy_rejects_protection_the_collateral_cannot_cover() {
    let mut env = Env::new();
    // Max payout $120,000 against $100,000 deposited plus the premium.
    let q = afterbell_vault::QuoteArgs { shares: 6_000_000_000, ..env.quote() };
    assert_vault_error(env.buy(q), VaultError::InsufficientCollateral);
}

// --------------------------------------------------------------- settlement

#[test]
fn settles_on_the_first_print_at_or_after_the_open() {
    let mut env = Env::new();
    let q = env.quote();
    env.buy(q).unwrap();
    env.settle_at(35_500_000).unwrap();
    let s = env.series(FEED, OPEN);
    assert_eq!(s.state, SeriesState::Settled);
    assert_eq!(s.price, 35_500_000_000, "$355 with 8 decimals");
    assert_eq!(s.publish_time, OPEN);
}

#[test]
fn settlement_rejects_the_wrong_print() {
    let cases = [
        (PriceSpec { publish_time: OPEN - 1, prev_publish_time: OPEN - 2, ..Default::default() }, VaultError::PriceBeforeOpen),
        (PriceSpec { publish_time: OPEN + SETTLE_WINDOW as i64 + 1, ..Default::default() }, VaultError::PriceAfterWindow),
        (PriceSpec { publish_time: OPEN + 5, prev_publish_time: OPEN, ..Default::default() }, VaultError::NotFirstPriceAfterOpen),
        (PriceSpec { feed_id: [8u8; 32], ..Default::default() }, VaultError::FeedMismatch),
        (PriceSpec { verification: VerificationLevel::Partial { num_signatures: 5 }, ..Default::default() }, VaultError::InsufficientVerification),
        (PriceSpec { price: 0, ..Default::default() }, VaultError::NonPositivePrice),
        (PriceSpec { conf: 355_001, ..Default::default() }, VaultError::ConfidenceTooWide), // just over 1%
    ];
    for (spec, err) in cases {
        let mut env = Env::new();
        let q = env.quote();
        env.buy(q).unwrap();
        env.set_time(OPEN + 30);
        let update = env.price(spec);
        let ix = env.ix_settle(&env.series_pda(FEED, OPEN), &update);
        let payer = env.payer.insecure_clone();
        assert_vault_error(env.send(&[ix], &[&payer]), err);
    }
}

#[test]
fn settlement_rejects_a_price_not_posted_by_pyth() {
    let mut env = Env::new();
    let q = env.quote();
    env.buy(q).unwrap();
    env.set_time(OPEN + 30);
    let forged = env.put_price_update(solana_keypair::Keypair::new().pubkey(), PriceSpec::default().build());
    let ix = env.ix_settle(&env.series_pda(FEED, OPEN), &forged);
    let payer = env.payer.insecure_clone();
    assert_fails(env.send(&[ix], &[&payer]));
}

#[test]
fn settlement_waits_for_the_open_and_happens_once() {
    let mut env = Env::new();
    let q = env.quote();
    env.buy(q).unwrap();
    env.set_time(OPEN - 1);
    let update = env.price(PriceSpec::default());
    let ix = env.ix_settle(&env.series_pda(FEED, OPEN), &update);
    let payer = env.payer.insecure_clone();
    assert_vault_error(env.send(&[ix], &[&payer]), VaultError::TooEarly);

    env.settle_at(35_500_000).unwrap();
    assert_vault_error(env.settle_at(35_500_000), VaultError::SeriesNotOpen);
}

// ------------------------------------------------------------------- claims

#[test]
fn claim_pays_the_loss_and_closes_the_position() {
    let mut env = Env::new();
    let q = env.quote();
    env.buy(q).unwrap();
    env.settle_at(35_500_000).unwrap(); // $355: 10 x ($360 - $355)
    let buyer = User { kp: env.buyer.kp.insecure_clone(), ata: env.buyer.ata };
    let lamports_before = env.lamports(&buyer.kp.pubkey());
    env.claim(&q, &buyer).unwrap();

    assert_eq!(env.balance(&buyer.ata), 980 * USD + 50 * USD);
    assert_eq!(env.vault_state().locked, 0);
    assert!(env.position(q.nonce).is_none(), "position closed");
    assert!(env.lamports(&buyer.kp.pubkey()) > lamports_before, "rent returned to the buyer");
    assert_fails(env.claim(&q, &buyer));
}

#[test]
fn claim_caps_at_the_max_payout_and_pays_nothing_above_upper() {
    for (price, paid) in [(30_000_000, 200 * USD), (36_500_000, 0), (36_000_000, 0), (34_000_000, 200 * USD)] {
        let mut env = Env::new();
        let q = env.quote();
        env.buy(q).unwrap();
        env.settle_at(price).unwrap();
        let buyer = User { kp: env.buyer.kp.insecure_clone(), ata: env.buyer.ata };
        env.claim(&q, &buyer).unwrap();
        assert_eq!(env.balance(&buyer.ata), 980 * USD + paid, "open at {price}");
        assert_eq!(env.vault_state().locked, 0);
    }
}

#[test]
fn claim_before_settlement_fails() {
    let mut env = Env::new();
    let q = env.quote();
    env.buy(q).unwrap();
    let buyer = User { kp: env.buyer.kp.insecure_clone(), ata: env.buyer.ata };
    assert_vault_error(env.claim(&q, &buyer), VaultError::NotClaimable);
}

#[test]
fn claim_can_only_pay_the_buyer() {
    let mut env = Env::new();
    let q = env.quote();
    env.buy(q).unwrap();
    env.settle_at(35_500_000).unwrap();
    let thief = env.new_user(0);
    // The thief names themselves as the buyer: `has_one = buyer` refuses.
    assert_fails(env.claim(&q, &thief));
    // The real buyer with the thief's token account: the token-authority check refuses.
    let ix = env.ix_claim(&env.position_pda(q.nonce), &env.series_pda(FEED, OPEN), &env.buyer.kp.pubkey(), &thief.ata);
    let payer = env.payer.insecure_clone();
    assert_fails(env.send(&[ix], &[&payer]));
    assert_eq!(env.balance(&thief.ata), 0);
}

// --------------------------------------------------------------------- void

#[test]
fn an_unsettled_series_voids_after_the_delay_and_refunds() {
    let mut env = Env::new();
    let q = env.quote();
    env.buy(q).unwrap();
    let series = env.series_pda(FEED, OPEN);
    let payer = env.payer.insecure_clone();

    env.set_time(OPEN + VOID_DELAY as i64);
    let ix = env.ix_void(&series);
    assert_vault_error(env.send(&[ix], &[&payer]), VaultError::VoidTooEarly);

    env.set_time(OPEN + VOID_DELAY as i64 + 1);
    let ix = env.ix_void(&series);
    env.send(&[ix], &[&payer]).unwrap();
    assert_eq!(env.series(FEED, OPEN).state, SeriesState::Voided);

    let buyer = User { kp: env.buyer.kp.insecure_clone(), ata: env.buyer.ata };
    env.claim(&q, &buyer).unwrap();
    assert_eq!(env.balance(&buyer.ata), 1_000 * USD, "premium refunded");
    assert_eq!(env.vault_state().locked, 0);

    let update = env.price(PriceSpec::default());
    let ix = env.ix_settle(&series, &update);
    assert_vault_error(env.send(&[ix], &[&payer]), VaultError::SeriesNotOpen);
}

// ------------------------------------------------------------------ capital

#[test]
fn withdraw_is_limited_to_free_collateral_and_the_authority() {
    let mut env = Env::new();
    let q = env.quote();
    env.buy(q).unwrap();
    let auth = env.authority.kp.insecure_clone();
    let free = SEED + 20 * USD - 200 * USD;

    let ix = env.ix_withdraw(&auth.pubkey(), &env.authority.ata, free + 1);
    assert_vault_error(env.send(&[ix], &[&auth]), VaultError::InsufficientCollateral);
    let ix = env.ix_withdraw(&auth.pubkey(), &env.authority.ata, free);
    env.send(&[ix], &[&auth]).unwrap();
    assert_eq!(env.balance(&env.vault_token), 200 * USD);

    let stranger = env.new_user(0);
    let ix = env.ix_withdraw(&stranger.kp.pubkey(), &stranger.ata, 1);
    assert_fails(env.send(&[ix], &[&stranger.kp.insecure_clone()]));
}

#[test]
fn stays_solvent_across_many_positions() {
    let mut env = Env::new();
    let mut quotes = vec![];
    let mut premiums = 0;
    for i in 0..12u64 {
        let q = afterbell_vault::QuoteArgs {
            shares: 1_000_000 * (i + 1),
            upper: 36_000_000_000 - i * 100_000_000,
            lower: 33_000_000_000 - i * 100_000_000,
            premium: 5 * USD + i,
            ..env.quote()
        };
        env.buy(q).unwrap();
        premiums += q.premium;
        quotes.push(q);
    }
    assert!(env.vault_state().locked <= env.balance(&env.vault_token));

    env.settle_at(34_250_000).unwrap(); // $342.50
    let buyer = User { kp: env.buyer.kp.insecure_clone(), ata: env.buyer.ata };
    let before = env.balance(&buyer.ata);
    for q in &quotes {
        env.claim(q, &buyer).unwrap();
    }
    let paid = env.balance(&buyer.ata) - before;
    assert_eq!(env.vault_state().locked, 0);
    assert_eq!(env.balance(&env.vault_token), SEED + premiums - paid);
}
