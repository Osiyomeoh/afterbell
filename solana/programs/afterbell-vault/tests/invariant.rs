//! Randomized sequences: the nine things anyone can do to the vault, in random
//! order with random amounts, and after every step the four properties the
//! Foundry invariant suite checks on the EVM vault. Seeded, so a failure names
//! the run and step that reproduce it.

mod common;

use std::collections::HashMap;

use {
    afterbell_vault::{error::VaultError, math, Position, QuoteArgs, SeriesState},
    anchor_lang::prelude::Pubkey,
    common::*,
};

const RUNS: u64 = 64;
const STEPS: usize = 60;
const ACTIONS: [&str; 9] = [
    "buy",
    "settle_or_void",
    "claim",
    "process_and_roll",
    "request_deposit",
    "request_redeem",
    "claim_deposit",
    "claim_redemption",
    "transfer_position",
];

/// xorshift64*: small, deterministic, good enough to pick actions and amounts.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// Uniform in lo..=hi.
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo + 1)
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[(self.next() % items.len() as u64) as usize]
    }
}

struct Handler {
    env: Env,
    rng: Rng,
    users: HashMap<Pubkey, User>,
    buyers: Vec<Pubkey>,
    lps: Vec<Pubkey>,
    positions: Vec<Pubkey>,
    /// The opening the current round sells.
    open: i64,
    done: [u32; 9],
}

impl Handler {
    fn new(seed: u64) -> Self {
        let mut env = Env::new();
        let mut users = HashMap::new();
        let (mut buyers, mut lps) = (vec![], vec![]);
        for i in 0..6 {
            let u = env.new_user(1_000_000_000 * USD);
            if i < 3 { buyers.push(u.key()) } else { lps.push(u.key()) }
            users.insert(u.key(), u);
        }
        let auth = env.authority.clone();
        lps.push(auth.key());
        users.insert(auth.key(), auth);
        Handler { env, rng: Rng(seed * 0x9E37_79B9 + 1), users, buyers, lps, positions: vec![], open: OPEN, done: [0; 9] }
    }

    fn user(&self, key: &Pubkey) -> User {
        self.users[key].clone()
    }

    fn unpaid(&self) -> Vec<(Pubkey, Position)> {
        self.positions.iter().map(|p| (*p, self.env.position(p).unwrap())).filter(|(_, p)| !p.closed).collect()
    }

    fn step(&mut self, action: usize) -> bool {
        match action {
            0 => self.buy(),
            1 => self.settle_or_void(),
            2 => self.claim(),
            3 => self.process_and_roll(),
            4 => self.request_deposit(),
            5 => self.request_redeem(),
            6 => self.claim_deposit(),
            7 => self.claim_redemption(),
            _ => self.transfer_position(),
        }
    }

    fn buy(&mut self) -> bool {
        let env = &mut self.env;
        let v = env.vault_state();
        if env.now() >= self.open - 1 {
            return false;
        }
        let buyer = self.users[self.rng.pick(&self.buyers)].clone();
        let feed = *self.rng.pick(&[FEED, FEED2]);
        let upper = self.rng.range(300, 400) * 100_000_000;
        let lower = upper - self.rng.range(1, 40) * 100_000_000;
        let shares = self.rng.range(1, 400) * 1_000_000;
        let max = math::payout_units(shares, upper - lower, USD).unwrap();
        let premium = self.rng.range(0, max / 4);
        let q = QuoteArgs { feed_id: feed, open_ts: self.open, shares, upper, lower, premium, ..env.quote() };

        let series = series_locked(env, feed, self.open);
        let res = env.buy_as(&buyer, q);
        if v.locked + max > math::bps_of(v.round_nav, v.params.max_utilization_bps) {
            assert_vault_error(res, VaultError::OverCapacity);
            false
        } else if series + max > math::bps_of(v.round_nav, v.params.max_feed_bps) {
            assert_vault_error(res, VaultError::OverStockLimit);
            false
        } else {
            ok(res);
            self.positions.push(env.position_pda(q.nonce));
            true
        }
    }

    fn settle_or_void(&mut self) -> bool {
        let env = &mut self.env;
        if env.vault_state().round_open_ts == 0 {
            return false;
        }
        let mut any = false;
        for feed in [FEED, FEED2] {
            let address = env.series_pda(feed, self.open);
            let Some(s) = try_read::<afterbell_vault::Series>(&env.svm, &address) else { continue };
            if s.state != SeriesState::Open {
                continue;
            }
            if self.rng.range(0, 3) == 0 {
                let deadline = self.open + VOID_DELAY as i64 + 1;
                if env.now() < deadline {
                    env.set_time(deadline);
                }
                // This round's series, not the harness's first opening.
                let ix = env.ix_void(&address);
                let payer = env.payer.insecure_clone();
                ok(env.send(&[ix], &[&payer]));
            } else {
                if env.now() < self.open + 30 {
                    env.set_time(self.open + 30);
                }
                // Anywhere from 20% under the lowest strike to 20% over the highest (expo -5).
                let (lo, hi) = (s.lowest_lower / 1_000 * 8 / 10, s.highest_upper / 1_000 * 12 / 10);
                let price = self.rng.range(lo, hi) as i64;
                let spec = PriceSpec { feed_id: feed, price, conf: 0, publish_time: self.open, prev_publish_time: self.open - 1, ..Default::default() };
                let update = env.price(spec);
                let ix = env.ix_settle(&address, &update);
                let payer = env.payer.insecure_clone();
                ok(env.send(&[ix], &[&payer]));
            }
            any = true;
        }
        any
    }

    /// A holder pays out their own position.
    fn claim(&mut self) -> bool {
        let payable: Vec<_> = self
            .unpaid()
            .into_iter()
            .filter(|(_, p)| read::<afterbell_vault::Series>(&self.env.svm, &p.series).state != SeriesState::Open)
            .collect();
        if payable.is_empty() {
            return false;
        }
        let (address, p) = self.rng.pick(&payable).clone();
        let holder = self.user(&self.env.holders[&address]);
        let triple = self.env.triple(&address);
        let ix = self.env.ix_process(&p.series, &holder.key(), &holder.ata, &[triple]);
        ok(self.env.send(&[ix], &[&holder.kp]));
        true
    }

    /// The keeper pays out everything payable, in batches, then rolls if the round is over.
    fn process_and_roll(&mut self) -> bool {
        let mut by_series: HashMap<Pubkey, Vec<Pubkey>> = HashMap::new();
        for (address, p) in self.unpaid() {
            if read::<afterbell_vault::Series>(&self.env.svm, &p.series).state != SeriesState::Open {
                by_series.entry(p.series).or_default().push(address);
            }
        }
        for (series, positions) in by_series {
            for batch in positions.chunks(7) {
                ok(self.env.process(&series, batch));
            }
        }
        let v = self.env.vault_state();
        let over = v.round_open_ts == 0 || (self.env.now() > v.round_open_ts && v.round_unpaid == 0);
        let res = self.env.roll();
        if over {
            ok(res);
            // The next round sells the next opening.
            self.open = self.env.now().max(self.open) + 86_400;
            true
        } else {
            assert_vault_error(res, VaultError::RoundNotOver);
            false
        }
    }

    fn request_deposit(&mut self) -> bool {
        let key = *self.rng.pick(&self.lps);
        let lp = self.user(&key);
        let assets = self.rng.range(1, 50_000 * USD);
        self.env.fund(&lp, assets);
        ok(self.env.request_deposit(&lp, assets));
        true
    }

    fn request_redeem(&mut self) -> bool {
        let key = *self.rng.pick(&self.lps);
        let lp = self.user(&key);
        let held = self.env.shares_of(&lp.key());
        if held == 0 {
            return false;
        }
        let shares = self.rng.range(1, held);
        ok(self.env.request_redeem(&lp, shares));
        true
    }

    fn claim_deposit(&mut self) -> bool {
        let key = *self.rng.pick(&self.lps);
        let lp = self.user(&key);
        let (shares, _) = claimable(&self.env, &lp.key());
        let res = self.env.claim_deposit(&lp);
        if shares > 0 {
            ok(res);
            true
        } else {
            assert_fails(res);
            false
        }
    }

    fn claim_redemption(&mut self) -> bool {
        let key = *self.rng.pick(&self.lps);
        let lp = self.user(&key);
        let r = self.env.request(&lp.key());
        let filled = r.map(|r| {
            r.filled_redeem_shares + if r.redeem_round < self.env.vault_state().round { r.redeem_shares } else { 0 }
        });
        let res = self.env.claim_redemption(&lp);
        if filled.unwrap_or(0) > 0 {
            ok(res);
            true
        } else {
            assert_fails(res);
            false
        }
    }

    fn transfer_position(&mut self) -> bool {
        let unpaid = self.unpaid();
        if unpaid.is_empty() {
            return false;
        }
        let address = self.rng.pick(&unpaid).0;
        let from = self.user(&self.env.holders[&address]);
        let everyone: Vec<Pubkey> = self.users.keys().copied().collect();
        let to = *self.rng.pick(&everyone);
        if to == from.key() {
            return false;
        }
        ok(self.env.transfer_nft(&address, &from, &to));
        true
    }

    // ------------------------------------------------------------ invariants

    fn check(&self, run: u64, step: usize, action: &str) {
        let env = &self.env;
        let v = env.vault_state();
        let at = format!("run {run}, step {step} ({action})");

        // holdsEverythingItOwes: the vault's balance covers what isn't the pool's
        // and the most its open positions could pay.
        let balance = env.balance(&env.vault_token);
        assert!(
            balance >= v.pending_deposit_assets + v.reserved_assets + v.tips_owed + v.locked,
            "{at}: balance {balance} short of what it owes"
        );

        // everyPositionAccountedFor: what's locked and tipped is exactly the unpaid positions',
        // and every paid one paid what its series owed it.
        let (mut locked, mut tips, mut unpaid) = (0u64, 0u64, 0u32);
        for address in &self.positions {
            let p = env.position(address).unwrap();
            let s: afterbell_vault::Series = read(&env.svm, &p.series);
            if p.closed {
                let owed = match s.state {
                    SeriesState::Voided => p.premium,
                    SeriesState::Settled => math::payout_at(p.shares, p.upper, p.lower, s.price, USD).unwrap(),
                    SeriesState::Open => panic!("{at}: paid before its series closed"),
                };
                assert_eq!(p.paid, owed, "{at}: position {address}");
                assert!(p.paid <= p.max_payout);
            } else {
                locked += p.max_payout;
                tips += p.tip;
                unpaid += 1;
            }
        }
        assert_eq!((v.locked, v.tips_owed, v.round_unpaid), (locked, tips, unpaid), "{at}: accounting");

        // claimsAreBacked: filled deposits' shares are in the escrow beside the queued
        // redemptions, and filled redemptions' collateral is reserved.
        let (mut shares, mut assets) = (0u64, 0u64);
        for lp in &self.lps {
            let (s, a) = claimable(env, lp);
            shares += s;
            assets += a;
        }
        assert!(env.balance(&env.share_escrow) >= v.pending_redeem_shares + shares, "{at}: share claims unbacked");
        assert!(v.reserved_assets >= assets, "{at}: redemptions unbacked");
        let held: u64 = self.lps.iter().map(|lp| env.shares_of(lp)).sum();
        assert_eq!(env.share_supply(), held + env.balance(&env.share_escrow), "{at}: shares");

        // withinTheRiskLimit: the round, and each stock in it, within its share of the pool at the roll.
        if v.round_open_ts != 0 {
            assert!(v.locked <= math::bps_of(v.round_nav, v.params.max_utilization_bps), "{at}: over the round's limit");
            for feed in [FEED, FEED2] {
                if let Some(s) = try_read::<afterbell_vault::Series>(&env.svm, &env.series_pda(feed, v.round_open_ts)) {
                    assert!(s.locked <= math::bps_of(v.round_nav, v.params.max_feed_bps), "{at}: over a stock's limit");
                }
            }
        }
    }
}

/// An underwriter's claimable shares and collateral, counting requests a roll has filled.
fn claimable(env: &Env, owner: &Pubkey) -> (u64, u64) {
    let Some(r) = env.request(owner) else { return (0, 0) };
    let round = env.vault_state().round;
    let mut shares = r.filled_deposit_shares;
    if r.deposit_assets > 0 && r.deposit_round < round {
        let rate = env.rate(r.deposit_round);
        shares += math::shares_for(r.deposit_assets, rate.assets, rate.supply).unwrap();
    }
    let mut assets = r.filled_redeem_assets;
    if r.redeem_shares > 0 && r.redeem_round < round {
        let rate = env.rate(r.redeem_round);
        assets += math::assets_for(r.redeem_shares, rate.assets, rate.supply).unwrap();
    }
    (shares, assets)
}

/// What a series has locked so far, 0 if it has sold nothing.
fn series_locked(env: &Env, feed: [u8; 32], open: i64) -> u64 {
    try_read::<afterbell_vault::Series>(&env.svm, &env.series_pda(feed, open)).map_or(0, |s| s.locked)
}

#[test]
fn every_property_holds_after_every_step() {
    let mut done = [0u32; 9];
    for run in 0..RUNS {
        let mut h = Handler::new(run);
        h.check(run, 0, "setup");
        for step in 1..=STEPS {
            let action = (h.rng.next() % 9) as usize;
            if h.step(action) {
                h.done[action] += 1;
            }
            h.check(run, step, ACTIONS[action]);
        }
        for (d, n) in done.iter_mut().zip(h.done) {
            *d += n;
        }
    }
    println!("{RUNS} runs x {STEPS} steps; done per action:");
    for (name, n) in ACTIONS.iter().zip(done) {
        println!("  {name}: {n}");
        assert!(n > 0, "{name} never happened");
    }
}
