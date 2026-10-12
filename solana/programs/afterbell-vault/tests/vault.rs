mod common;

use {
    afterbell_vault::{error::VaultError, Params, QuoteArgs, SeriesState},
    anchor_lang::prelude::Pubkey,
    common::*,
    pyth_solana_receiver_sdk::price_update::VerificationLevel,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

// ------------------------------------------------------------------- set-up

#[test]
fn initialize_records_the_rules_and_seeds_the_pool() {
    let env = Env::new();
    let v = env.vault_state();
    assert_eq!(v.authority, env.authority.key());
    assert_eq!(v.quoter, env.quoter.pubkey());
    assert_eq!((v.collateral_mint, v.vault_token), (env.mint, env.vault_token));
    assert_eq!((v.share_mint, v.share_escrow), (env.share_mint, env.share_escrow));
    assert_eq!(v.collateral_unit, USD);
    assert_eq!(v.params, params());
    assert!(!v.params_queued);
    assert_eq!(v.art_uri, ART);
    // Seeded: the authority's deposit was filled at round 1's roll, one share per unit.
    assert_eq!((v.round, v.round_open_ts, v.round_nav), (2, 0, SEED));
    assert_eq!((v.locked, v.tips_owed, v.pending_deposit_assets, v.reserved_assets), (0, 0, 0, 0));
    assert_eq!(env.shares_of(&env.authority.key()), SEED);
    assert_eq!(env.share_supply(), SEED);
    assert_eq!(env.balance(&env.vault_token), SEED);
    let f = env.feed_config(FEED);
    assert!(f.allowed);
    assert_eq!(f.symbol, "TSLA");

    // The shares are a Token-2022 token with its name on the mint, in the collateral's decimals.
    let (mint, metadata) = env.mint_with_metadata(&env.share_mint);
    assert_eq!(mint.decimals, 6);
    assert_eq!(Option::<Pubkey>::from(mint.mint_authority), Some(env.vault));
    assert_eq!((metadata.name.as_str(), metadata.symbol.as_str()), ("Afterbell Pool", "BELLPOOL"));
}

#[test]
fn params_are_validated_queued_to_the_roll_and_authority_only() {
    let mut env = Env::new();
    let auth = env.authority.kp.insecure_clone();
    type Mutate = fn(&mut Params);
    let bad: Vec<Mutate> = vec![
        |p| p.settle_window_secs = 0,
        |p| p.settle_window_secs = 3_601,
        |p| p.void_delay_secs = 3_599,
        |p| p.void_delay_secs = 7 * 86_400 + 1,
        |p| {
            p.settle_window_secs = 3_600;
            p.void_delay_secs = 3_600;
        },
        |p| p.max_conf_bps = 0,
        |p| p.max_conf_bps = 1_001,
        |p| p.max_utilization_bps = 0,
        |p| p.max_utilization_bps = 10_001,
        |p| p.max_feed_bps = 0,
        |p| p.max_feed_bps = 5_001, // above the round's limit
        |p| p.keeper_tip_bps = 1_001,
    ];
    for mutate in bad {
        let mut p = params();
        mutate(&mut p);
        let ix = env.ix_set_params(&auth.pubkey(), p);
        assert_vault_error(env.send(&[ix], &[&auth]), VaultError::InvalidConfig);
    }

    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    for ix in [
        env.ix_set_params(&stranger.pubkey(), params()),
        env.ix_set_quoter(&stranger.pubkey(), stranger.pubkey()),
        env.ix_set_art_uri(&stranger.pubkey(), "https://evil/"),
    ] {
        assert_fails(env.send(&[ix], &[&stranger]));
    }
    let ix = env.ix_set_quoter(&auth.pubkey(), Pubkey::default());
    assert_vault_error(env.send(&[ix], &[&auth]), VaultError::InvalidConfig);

    // A valid change waits for the roll.
    let tighter = Params { max_utilization_bps: 1_000, max_feed_bps: 500, keeper_tip_bps: 0, ..params() };
    let ix = env.ix_set_params(&auth.pubkey(), tighter);
    ok(env.send(&[ix], &[&auth]));
    let v = env.vault_state();
    assert_eq!((v.params, v.next_params, v.params_queued), (params(), tighter, true));
    ok(env.roll());
    let v = env.vault_state();
    assert_eq!((v.params, v.params_queued), (tighter, false));
}

#[test]
fn feed_symbols_and_the_art_address_are_checked() {
    let mut env = Env::new();
    let auth = env.authority.kp.insecure_clone();
    for symbol in ["", "THIRTEENCHARS"] {
        let ix = env.ix_allow_feed([9u8; 32], symbol, true);
        assert_vault_error(env.send(&[ix], &[&auth]), VaultError::TooLong);
    }
    let ix = env.ix_set_art_uri(&auth.pubkey(), &"x".repeat(129));
    assert_vault_error(env.send(&[ix], &[&auth]), VaultError::TooLong);
    let ix = env.ix_set_art_uri(&auth.pubkey(), "https://afterbell.example/art/");
    ok(env.send(&[ix], &[&auth]));
    assert_eq!(env.vault_state().art_uri, "https://afterbell.example/art/");
}

// ------------------------------------------------------------------- buying

#[test]
fn buy_takes_the_premium_locks_the_max_payout_and_mints_an_nft() {
    let mut env = Env::new();
    let q = env.quote();
    ok(env.buy(q));

    let address = env.position_pda(q.nonce);
    let p = env.position(&address).unwrap();
    assert_eq!(p.buyer, env.buyer.key());
    assert_eq!(p.series, env.series_pda(FEED, OPEN));
    assert_eq!(p.mint, env.position_mint_pda(q.nonce));
    assert_eq!(p.number, 1);
    assert_eq!((p.shares, p.upper, p.lower, p.premium), (q.shares, q.upper, q.lower, q.premium));
    assert_eq!(p.max_payout, 200 * USD, "10 shares x $20 spread");
    assert_eq!(p.tip, 400_000, "2% of the $20 premium");
    assert!(!p.closed);

    let v = env.vault_state();
    assert_eq!(
        (v.locked, v.tips_owed, v.round_unpaid, v.round_open_ts, v.positions_sold),
        (200 * USD, 400_000, 1, OPEN, 1)
    );
    assert_eq!(env.balance(&env.buyer.ata), 980 * USD);
    assert_eq!(env.balance(&env.vault_token), SEED + 20 * USD);
    let s = env.series(FEED, OPEN);
    assert_eq!((s.state, s.open_ts, s.feed_id), (SeriesState::Open, OPEN, FEED));
    assert_eq!((s.lowest_lower, s.highest_upper, s.locked, s.sold, s.paid), (q.lower, q.upper, 200 * USD, 1, 0));

    // The NFT: one in the buyer's wallet, none can ever be minted again, and it names its position.
    assert_eq!(env.balance(&Env::nft_account(&env.buyer.key(), &p.mint)), 1);
    let (mint, metadata) = env.mint_with_metadata(&p.mint);
    assert_eq!((mint.supply, mint.decimals), (1, 0));
    assert_eq!(Option::<Pubkey>::from(mint.mint_authority), None);
    assert_eq!(Option::<Pubkey>::from(mint.freeze_authority), None);
    assert_eq!(metadata.name, "Afterbell #1 TSLA");
    assert_eq!(metadata.symbol, "BELL");
    assert_eq!(metadata.uri, format!("{ART}{address}"));
    assert_eq!(metadata.additional_metadata, vec![("position".to_string(), address.to_string())]);
    assert_eq!(Option::<Pubkey>::from(metadata.update_authority), Some(env.vault));
}

#[test]
fn a_buy_fits_one_transaction_without_a_compute_budget() {
    let mut env = Env::new();
    let q = env.quote();
    let buyer = env.buyer.clone();
    let ixs = env.buy_ixs(&buyer, q);
    let tx = env.tx(&ixs, &[&buyer.kp]);
    let bytes = 1 + 64 * tx.signatures.len() + tx.message.serialize().len();
    assert!(bytes <= 1_232, "{bytes} bytes");
    ok(env.buy(q));
    assert!(env.last_cu < 200_000, "{} compute units", env.last_cu);
}

#[test]
fn buy_needs_the_signature_instruction_right_before_it() {
    let mut env = Env::new();
    let q = env.quote();
    let buyer = env.buyer.clone();

    let ix = env.ix_buy(&buyer, q);
    assert_vault_error(env.send(&[ix], &[&buyer.kp]), VaultError::MissingSignature);

    // A valid signature, but not immediately before `buy`.
    let sig = Env::ed25519_ix(&env.quoter, &env.message(&buyer.key(), &q));
    let other = env.ix_allow_feed([9u8; 32], "NINE", false); // any other instruction in between
    let ix = env.ix_buy(&buyer, q);
    let auth = env.authority.kp.insecure_clone();
    assert_vault_error(env.send(&[sig, other, ix], &[&buyer.kp, &auth]), VaultError::MissingSignature);
}

#[test]
fn buy_rejects_a_signature_from_anyone_but_the_quoter() {
    let mut env = Env::new();
    let q = env.quote();
    let buyer = env.buyer.clone();
    let sig = Env::ed25519_ix(&Keypair::new(), &env.message(&buyer.key(), &q));
    let ix = env.ix_buy(&buyer, q);
    assert_vault_error(env.send(&[sig, ix], &[&buyer.kp]), VaultError::InvalidSignature);
}

#[test]
fn buy_rejects_a_quote_changed_after_signing() {
    let mut env = Env::new();
    let q = env.quote();
    let buyer = env.buyer.clone();
    let sig = Env::ed25519_ix(&env.quoter, &env.message(&buyer.key(), &q));
    let ix = env.ix_buy(&buyer, QuoteArgs { premium: USD, ..q });
    assert_vault_error(env.send(&[sig, ix], &[&buyer.kp]), VaultError::InvalidSignature);
}

#[test]
fn buy_rejects_someone_else_using_a_buyers_quote() {
    let mut env = Env::new();
    let q = env.quote();
    let thief = env.new_user(1_000 * USD);
    // Signed for the buyer; the thief replays it with the same signature.
    let sig = Env::ed25519_ix(&env.quoter, &env.message(&env.buyer.key(), &q));
    let ix = env.ix_buy(&thief, q);
    assert_vault_error(env.send(&[sig, ix], &[&thief.kp]), VaultError::InvalidSignature);
}

#[test]
fn a_forged_signature_fails_the_whole_transaction() {
    let mut env = Env::new();
    let q = env.quote();
    let buyer = env.buyer.clone();
    let mut sig = Env::ed25519_ix(&env.quoter, &env.message(&buyer.key(), &q));
    sig.data[48] ^= 1; // flip a bit of the signature
    let ix = env.ix_buy(&buyer, q);
    let err = env.send(&[sig, ix], &[&buyer.kp]).expect_err("forged signature accepted");
    // The runtime's signature check (instruction 0) fails before `buy` ever runs.
    assert!(format!("{:?}", err.err).contains("InstructionError(0"), "got {:?}", err.err);
    assert!(env.position(&env.position_pda(q.nonce)).is_none());
}

#[test]
fn buy_rejects_expired_quotes_and_passed_opens() {
    let mut env = Env::new();
    let q = env.quote();
    env.set_time(q.expiry + 1);
    assert_vault_error(env.buy(q), VaultError::QuoteExpired);

    let mut env = Env::new();
    let q = QuoteArgs { open_ts: T0, ..env.quote() };
    assert_vault_error(env.buy(q), VaultError::AlreadyOpen);
}

#[test]
fn buy_rejects_feeds_the_vault_does_not_sell() {
    let mut env = Env::new();
    let auth = env.authority.kp.insecure_clone();
    let ix = env.ix_allow_feed(FEED, "TSLA", false);
    ok(env.send(&[ix], &[&auth]));
    let q = env.quote();
    assert_vault_error(env.buy(q), VaultError::FeedNotAllowed);

    // A feed never configured has no config account at all.
    let q = QuoteArgs { feed_id: [3u8; 32], ..env.quote() };
    assert_fails(env.buy(q));
}

#[test]
fn a_quote_buys_once() {
    let mut env = Env::new();
    let q = env.quote();
    ok(env.buy(q));
    assert_fails(env.buy(q));
    assert_eq!(env.vault_state().locked, 200 * USD);
}

#[test]
fn buy_rejects_malformed_protection() {
    let mut env = Env::new();
    for q in [
        QuoteArgs { upper: 34_000_000_000, ..env.quote() },
        QuoteArgs { shares: 0, ..env.quote() },
        QuoteArgs { premium: 200 * USD + 1, ..env.quote() },
    ] {
        assert_vault_error(env.buy(q), VaultError::InvalidProtection);
    }
}

#[test]
fn positions_are_numbered_in_order_of_sale() {
    let mut env = Env::new();
    for n in 1..=3u64 {
        let q = env.quote();
        ok(env.buy(q));
        let p = env.position(&env.position_pda(q.nonce)).unwrap();
        assert_eq!(p.number, n);
        assert_eq!(env.mint_with_metadata(&p.mint).1.name, format!("Afterbell #{n} TSLA"));
    }
}

// --------------------------------------------------------------- settlement

#[test]
fn settles_on_the_first_print_at_or_after_the_open() {
    let mut env = Env::new();
    let q = env.quote();
    ok(env.buy(q));
    ok(env.settle_at(35_500_000));
    let s = env.series(FEED, OPEN);
    assert_eq!(s.state, SeriesState::Settled);
    assert_eq!(s.price, 35_500_000_000, "$355 with 8 decimals");
    assert_eq!(s.publish_time, OPEN);
}

#[test]
fn settlement_rejects_the_wrong_print() {
    let cases = [
        (
            PriceSpec { publish_time: OPEN - 1, prev_publish_time: OPEN - 2, ..Default::default() },
            VaultError::PriceBeforeOpen,
        ),
        (
            PriceSpec { publish_time: OPEN + SETTLE_WINDOW as i64 + 1, ..Default::default() },
            VaultError::PriceAfterWindow,
        ),
        (
            PriceSpec { publish_time: OPEN + 5, prev_publish_time: OPEN, ..Default::default() },
            VaultError::NotFirstPriceAfterOpen,
        ),
        (PriceSpec { feed_id: [8u8; 32], ..Default::default() }, VaultError::FeedMismatch),
        (
            PriceSpec { verification: VerificationLevel::Partial { num_signatures: 5 }, ..Default::default() },
            VaultError::InsufficientVerification,
        ),
        (PriceSpec { price: 0, ..Default::default() }, VaultError::NonPositivePrice),
        (PriceSpec { conf: 355_001, ..Default::default() }, VaultError::ConfidenceTooWide), // just over 1%
        // More than 10 times the highest strike ($360), or under a tenth of the lowest ($340).
        (PriceSpec { price: 360_000_001, conf: 0, ..Default::default() }, VaultError::ImplausiblePrice),
        (PriceSpec { price: 3_399_999, conf: 0, ..Default::default() }, VaultError::ImplausiblePrice),
    ];
    for (spec, err) in cases {
        let mut env = Env::new();
        let q = env.quote();
        ok(env.buy(q));
        env.set_time(OPEN + 30);
        let update = env.price(spec);
        let ix = env.ix_settle(&env.series_pda(FEED, OPEN), &update);
        let payer = env.payer.insecure_clone();
        assert_vault_error(env.send(&[ix], &[&payer]), err);
    }
}

#[test]
fn settlement_accepts_prices_at_the_plausible_bounds() {
    for price in [360_000_000, 3_400_000] {
        let mut env = Env::new();
        let q = env.quote();
        ok(env.buy(q));
        env.set_time(OPEN + 30);
        let update = env.price(PriceSpec { price, conf: 0, ..Default::default() });
        let ix = env.ix_settle(&env.series_pda(FEED, OPEN), &update);
        let payer = env.payer.insecure_clone();
        ok(env.send(&[ix], &[&payer]));
    }
}

#[test]
fn settlement_rejects_a_price_not_posted_by_pyth() {
    let mut env = Env::new();
    let q = env.quote();
    ok(env.buy(q));
    env.set_time(OPEN + 30);
    let forged = env.put_price_update(Keypair::new().pubkey(), PriceSpec::default().build());
    let ix = env.ix_settle(&env.series_pda(FEED, OPEN), &forged);
    let payer = env.payer.insecure_clone();
    assert_fails(env.send(&[ix], &[&payer]));
}

#[test]
fn settlement_waits_for_the_open_and_happens_once() {
    let mut env = Env::new();
    let q = env.quote();
    ok(env.buy(q));
    env.set_time(OPEN - 1);
    let update = env.price(PriceSpec::default());
    let ix = env.ix_settle(&env.series_pda(FEED, OPEN), &update);
    let payer = env.payer.insecure_clone();
    assert_vault_error(env.send(&[ix], &[&payer]), VaultError::TooEarly);

    ok(env.settle_at(35_500_000));
    assert_vault_error(env.settle_at(35_500_000), VaultError::SeriesNotOpen);
}

// --------------------------------------------------------------------- void

#[test]
fn an_unsettled_series_voids_after_the_delay_and_refunds_in_full() {
    let mut env = Env::new();
    let q = env.quote();
    ok(env.buy(q));
    let series = env.series_pda(FEED, OPEN);

    env.set_time(OPEN + VOID_DELAY as i64);
    assert_vault_error(env.void(FEED), VaultError::VoidTooEarly);
    env.set_time(OPEN + VOID_DELAY as i64 + 1);
    ok(env.void(FEED));
    assert_eq!(env.series(FEED, OPEN).state, SeriesState::Voided);

    // The whole premium back, tip included; the keeper earns nothing on a void.
    let position = env.position_pda(q.nonce);
    ok(env.process(&series, &[position]));
    assert_eq!(env.balance(&env.buyer.ata), 1_000 * USD);
    assert_eq!(env.balance(&env.keeper.ata), 0);
    let p = env.position(&position).unwrap();
    assert_eq!((p.closed, p.paid, p.paid_to), (true, 20 * USD, env.buyer.key()));
    let v = env.vault_state();
    assert_eq!((v.locked, v.tips_owed, v.round_unpaid), (0, 0, 0));
    assert_eq!(env.total_assets(), SEED, "the pool is back where it started");

    let payer = env.payer.insecure_clone();
    let update = env.price(PriceSpec::default());
    let ix = env.ix_settle(&series, &update);
    assert_vault_error(env.send(&[ix], &[&payer]), VaultError::SeriesNotOpen);
}
