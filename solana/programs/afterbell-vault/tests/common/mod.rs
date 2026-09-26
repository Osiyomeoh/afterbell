//! LiteSVM harness: the compiled program, a 6-decimal collateral mint, funded
//! users, a quoter that signs real ed25519 quotes, a controllable clock, forged
//! Pyth price accounts, and a pool seeded by the authority.
#![allow(dead_code, clippy::result_large_err)]

use std::collections::HashMap;

use {
    afterbell_vault::{
        constants::*, error::VaultError, quote::quote_message, FeedConfig, Params, Position, QuoteArgs, Request,
        RoundRate, Series, Vault,
    },
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::{
        associated_token::{
            self, get_associated_token_address, get_associated_token_address_with_program_id,
            spl_associated_token_account::instruction::create_associated_token_account_idempotent,
        },
        token_2022::{
            self,
            spl_token_2022::{
                self,
                extension::{BaseStateWithExtensions, StateWithExtensions},
            },
        },
        token_interface::spl_token_metadata_interface::state::TokenMetadata,
    },
    litesvm::{types::TransactionResult, LiteSVM},
    litesvm_token::{get_spl_account, spl_token, CreateAssociatedTokenAccount, CreateMint, MintTo, TOKEN_ID},
    pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, PriceUpdateV2, VerificationLevel},
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

pub const T0: i64 = 1_790_000_000;
pub const OPEN: i64 = T0 + 86_400;
pub const FEED: [u8; 32] = [7u8; 32];
pub const FEED2: [u8; 32] = [8u8; 32];
pub const USD: u64 = 1_000_000;
pub const SETTLE_WINDOW: u32 = 60;
pub const VOID_DELAY: u32 = 86_400;
pub const MAX_CONF_BPS: u16 = 100;
pub const SEED: u64 = 100_000 * USD;
pub const ART: &str = "https://afterbell.test/art/";
pub const COMPUTE_BUDGET: Pubkey = anchor_lang::pubkey!("ComputeBudget111111111111111111111111111111");

pub struct User {
    pub kp: Keypair,
    /// The user's collateral account.
    pub ata: Pubkey,
}

impl User {
    pub fn key(&self) -> Pubkey {
        self.kp.pubkey()
    }
    pub fn clone(&self) -> User {
        User { kp: self.kp.insecure_clone(), ata: self.ata }
    }
}

pub struct Env {
    pub svm: LiteSVM,
    pub program_id: Pubkey,
    pub payer: Keypair,
    pub mint: Pubkey,
    pub authority: User,
    pub quoter: Keypair,
    pub buyer: User,
    pub keeper: User,
    pub vault: Pubkey,
    pub vault_token: Pubkey,
    pub share_mint: Pubkey,
    pub share_escrow: Pubkey,
    /// Who holds each position's NFT, as the tests move them.
    pub holders: HashMap<Pubkey, Pubkey>,
    /// Compute units the last successful transaction used.
    pub last_cu: u64,
    nonce: u16,
}

pub fn params() -> Params {
    Params {
        settle_window_secs: SETTLE_WINDOW,
        void_delay_secs: VOID_DELAY,
        max_conf_bps: MAX_CONF_BPS,
        max_utilization_bps: 5_000,
        max_feed_bps: 2_000,
        keeper_tip_bps: 200,
    }
}

impl Env {
    /// A vault with FEED (and FEED2) allowed and SEED in the pool, owned by the authority.
    pub fn new() -> Self {
        let mut env = Self::empty();
        let authority = env.authority.clone();
        env.request_deposit(&authority, SEED).unwrap();
        env.roll().unwrap();
        env.claim_deposit(&authority).unwrap();
        env
    }

    /// A vault with nothing in its pool.
    pub fn empty() -> Self {
        let program_id = afterbell_vault::id();
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/afterbell_vault.so"));
        svm.add_program(program_id, bytes).unwrap();

        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
        let mint = CreateMint::new(&mut svm, &payer).decimals(6).send().unwrap();

        let mut env = Env {
            svm,
            program_id,
            payer,
            mint,
            authority: User { kp: Keypair::new(), ata: Pubkey::default() },
            quoter: Keypair::new(),
            buyer: User { kp: Keypair::new(), ata: Pubkey::default() },
            keeper: User { kp: Keypair::new(), ata: Pubkey::default() },
            vault: Pubkey::default(),
            vault_token: Pubkey::default(),
            share_mint: Pubkey::default(),
            share_escrow: Pubkey::default(),
            holders: HashMap::new(),
            last_cu: 0,
            nonce: 0,
        };
        env.set_time(T0);
        env.authority = env.new_user(SEED);
        env.buyer = env.new_user(1_000 * USD);
        env.keeper = env.new_user(0);
        env.vault = env.pda(&[VAULT_SEED, env.authority.key().as_ref(), env.mint.as_ref()]);
        env.vault_token = env.pda(&[VAULT_TOKEN_SEED, env.vault.as_ref()]);
        env.share_mint = env.pda(&[SHARE_MINT_SEED, env.vault.as_ref()]);
        env.share_escrow = env.pda(&[SHARE_ESCROW_SEED, env.vault.as_ref()]);

        let authority = env.authority.clone();
        let ix = env.ix_initialize(env.quoter.pubkey(), params(), ART.to_string());
        env.send(&[ix], &[&authority.kp]).unwrap();
        for (feed, symbol) in [(FEED, "TSLA"), (FEED2, "QQQ")] {
            let ix = env.ix_allow_feed(feed, symbol, true);
            env.send(&[ix], &[&authority.kp]).unwrap();
        }
        env
    }

    pub fn new_user(&mut self, balance: u64) -> User {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        let ata = CreateAssociatedTokenAccount::new(&mut self.svm, &self.payer, &self.mint)
            .owner(&kp.pubkey())
            .send()
            .unwrap();
        if balance > 0 {
            MintTo::new(&mut self.svm, &self.payer, &self.mint, &ata, balance).send().unwrap();
        }
        User { kp, ata }
    }

    pub fn fund(&mut self, user: &User, amount: u64) {
        MintTo::new(&mut self.svm, &self.payer, &self.mint, &user.ata, amount).send().unwrap();
    }

    pub fn set_time(&mut self, ts: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = ts;
        self.svm.set_sysvar(&clock);
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    /// A legacy transaction; its first signer pays.
    pub fn tx(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> VersionedTransaction {
        self.svm.expire_blockhash();
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &blockhash);
        VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap()
    }

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
        let tx = self.tx(ixs, signers);
        let res = self.svm.send_transaction(tx);
        if let Ok(meta) = &res {
            self.last_cu = meta.compute_units_consumed;
        }
        res
    }

    pub fn pda(&self, seeds: &[&[u8]]) -> Pubkey {
        Pubkey::find_program_address(seeds, &self.program_id).0
    }

    // ------------------------------------------------------------------- PDAs

    pub fn feed_pda(&self, feed_id: [u8; 32]) -> Pubkey {
        self.pda(&[FEED_SEED, self.vault.as_ref(), feed_id.as_ref()])
    }
    pub fn series_pda(&self, feed_id: [u8; 32], open_ts: i64) -> Pubkey {
        self.pda(&[SERIES_SEED, self.vault.as_ref(), feed_id.as_ref(), &open_ts.to_le_bytes()])
    }
    pub fn position_pda(&self, nonce: [u8; 32]) -> Pubkey {
        self.pda(&[POSITION_SEED, self.vault.as_ref(), nonce.as_ref()])
    }
    pub fn position_mint_pda(&self, nonce: [u8; 32]) -> Pubkey {
        self.pda(&[POSITION_MINT_SEED, self.vault.as_ref(), nonce.as_ref()])
    }
    pub fn request_pda(&self, owner: &Pubkey) -> Pubkey {
        self.pda(&[REQUEST_SEED, self.vault.as_ref(), owner.as_ref()])
    }
    pub fn rate_pda(&self, round: u64) -> Pubkey {
        self.pda(&[RATE_SEED, self.vault.as_ref(), &round.to_le_bytes()])
    }
    pub fn nft_account(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
        get_associated_token_address_with_program_id(owner, mint, &token_2022::ID)
    }
    pub fn share_account(&self, owner: &Pubkey) -> Pubkey {
        get_associated_token_address_with_program_id(owner, &self.share_mint, &token_2022::ID)
    }
    pub fn collateral_account(&self, owner: &Pubkey) -> Pubkey {
        get_associated_token_address(owner, &self.mint)
    }

    // ---------------------------------------------------- instruction builders

    fn ix(&self, data: Vec<u8>, accounts: impl ToAccountMetas) -> Instruction {
        Instruction::new_with_bytes(self.program_id, &data, accounts.to_account_metas(None))
    }

    pub fn ix_initialize(&self, quoter: Pubkey, params: Params, art_uri: String) -> Instruction {
        self.ix(
            afterbell_vault::instruction::InitializeVault { quoter, params, art_uri }.data(),
            afterbell_vault::accounts::InitializeVault {
                authority: self.authority.key(),
                vault: self.vault,
                collateral_mint: self.mint,
                vault_token: self.vault_token,
                share_mint: self.share_mint,
                share_escrow: self.share_escrow,
                token_program: TOKEN_ID,
                share_token_program: token_2022::ID,
                system_program: system_program::ID,
            },
        )
    }

    fn configure(&self, authority: &Pubkey) -> afterbell_vault::accounts::Configure {
        afterbell_vault::accounts::Configure { authority: *authority, vault: self.vault }
    }

    pub fn ix_set_params(&self, authority: &Pubkey, params: Params) -> Instruction {
        self.ix(afterbell_vault::instruction::SetParams { params }.data(), self.configure(authority))
    }

    pub fn ix_set_quoter(&self, authority: &Pubkey, quoter: Pubkey) -> Instruction {
        self.ix(afterbell_vault::instruction::SetQuoter { quoter }.data(), self.configure(authority))
    }

    pub fn ix_set_art_uri(&self, authority: &Pubkey, art_uri: &str) -> Instruction {
        self.ix(afterbell_vault::instruction::SetArtUri { art_uri: art_uri.to_string() }.data(), self.configure(authority))
    }

    pub fn ix_allow_feed(&self, feed_id: [u8; 32], symbol: &str, allowed: bool) -> Instruction {
        self.ix(
            afterbell_vault::instruction::AllowFeed { feed_id, symbol: symbol.to_string(), allowed }.data(),
            afterbell_vault::accounts::AllowFeed {
                authority: self.authority.key(),
                vault: self.vault,
                feed_config: self.feed_pda(feed_id),
                system_program: system_program::ID,
            },
        )
    }

    pub fn ix_buy(&self, buyer: &User, q: QuoteArgs) -> Instruction {
        let position_mint = self.position_mint_pda(q.nonce);
        self.ix(
            afterbell_vault::instruction::Buy { q }.data(),
            afterbell_vault::accounts::Buy {
                buyer: buyer.key(),
                vault: self.vault,
                feed_config: self.feed_pda(q.feed_id),
                series: self.series_pda(q.feed_id, q.open_ts),
                position: self.position_pda(q.nonce),
                position_mint,
                buyer_nft: Self::nft_account(&buyer.key(), &position_mint),
                collateral_mint: self.mint,
                buyer_token: buyer.ata,
                vault_token: self.vault_token,
                instructions: solana_sdk_ids::sysvar::instructions::ID,
                token_program: TOKEN_ID,
                nft_token_program: token_2022::ID,
                associated_token_program: associated_token::ID,
                system_program: system_program::ID,
            },
        )
    }

    pub fn ix_settle(&self, series: &Pubkey, price_update: &Pubkey) -> Instruction {
        self.ix(
            afterbell_vault::instruction::Settle {}.data(),
            afterbell_vault::accounts::Settle { vault: self.vault, series: *series, price_update: *price_update },
        )
    }

    pub fn ix_void(&self, series: &Pubkey) -> Instruction {
        self.ix(
            afterbell_vault::instruction::VoidSeries {}.data(),
            afterbell_vault::accounts::VoidSeries { vault: self.vault, series: *series },
        )
    }

    /// `process` for positions given as (position, NFT token account, payee collateral account).
    pub fn ix_process(&self, series: &Pubkey, keeper: &Pubkey, keeper_token: &Pubkey, triples: &[[Pubkey; 3]]) -> Instruction {
        let mut ix = self.ix(
            afterbell_vault::instruction::Process {}.data(),
            afterbell_vault::accounts::Process {
                keeper: *keeper,
                vault: self.vault,
                series: *series,
                collateral_mint: self.mint,
                vault_token: self.vault_token,
                keeper_token: *keeper_token,
                token_program: TOKEN_ID,
            },
        );
        for [position, nft, payee] in triples {
            ix.accounts.push(anchor_lang::solana_program::instruction::AccountMeta::new(*position, false));
            ix.accounts.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(*nft, false));
            ix.accounts.push(anchor_lang::solana_program::instruction::AccountMeta::new(*payee, false));
        }
        ix
    }

    /// The rate a request's `side` needs filled with, if it has one from a rolled round.
    fn rate_for(&self, owner: &Pubkey, deposit: bool) -> Option<Pubkey> {
        let r = self.request(owner)?;
        let (amount, round) = if deposit { (r.deposit_assets, r.deposit_round) } else { (r.redeem_shares, r.redeem_round) };
        let v = self.vault_state();
        (amount > 0 && round < v.round).then(|| self.rate_pda(round))
    }

    pub fn ix_request_deposit(&self, owner: &User, assets: u64) -> Instruction {
        self.ix(
            afterbell_vault::instruction::RequestDeposit { assets }.data(),
            afterbell_vault::accounts::RequestDeposit {
                owner: owner.key(),
                vault: self.vault,
                request: self.request_pda(&owner.key()),
                rate: self.rate_for(&owner.key(), true),
                collateral_mint: self.mint,
                owner_token: owner.ata,
                vault_token: self.vault_token,
                token_program: TOKEN_ID,
                system_program: system_program::ID,
            },
        )
    }

    pub fn ix_request_redeem(&self, owner: &User, shares: u64) -> Instruction {
        self.ix(
            afterbell_vault::instruction::RequestRedeem { shares }.data(),
            afterbell_vault::accounts::RequestRedeem {
                owner: owner.key(),
                vault: self.vault,
                request: self.request_pda(&owner.key()),
                rate: self.rate_for(&owner.key(), false),
                share_mint: self.share_mint,
                owner_shares: self.share_account(&owner.key()),
                share_escrow: self.share_escrow,
                share_token_program: token_2022::ID,
                system_program: system_program::ID,
            },
        )
    }

    pub fn ix_claim_deposit(&self, owner: &User) -> Instruction {
        self.ix(
            afterbell_vault::instruction::ClaimDeposit {}.data(),
            afterbell_vault::accounts::ClaimDeposit {
                owner: owner.key(),
                vault: self.vault,
                request: self.request_pda(&owner.key()),
                rate: self.rate_for(&owner.key(), true),
                share_mint: self.share_mint,
                owner_shares: self.share_account(&owner.key()),
                share_escrow: self.share_escrow,
                share_token_program: token_2022::ID,
                associated_token_program: associated_token::ID,
                system_program: system_program::ID,
            },
        )
    }

    pub fn ix_claim_redemption(&self, owner: &User) -> Instruction {
        self.ix(
            afterbell_vault::instruction::ClaimRedemption {}.data(),
            afterbell_vault::accounts::ClaimRedemption {
                owner: owner.key(),
                vault: self.vault,
                request: self.request_pda(&owner.key()),
                rate: self.rate_for(&owner.key(), false),
                collateral_mint: self.mint,
                owner_token: owner.ata,
                vault_token: self.vault_token,
                token_program: TOKEN_ID,
            },
        )
    }

    pub fn ix_roll(&self, payer: &Pubkey) -> Instruction {
        self.ix(
            afterbell_vault::instruction::Roll {}.data(),
            afterbell_vault::accounts::Roll {
                payer: *payer,
                vault: self.vault,
                rate: self.rate_pda(self.vault_state().round),
                vault_token: self.vault_token,
                share_mint: self.share_mint,
                share_escrow: self.share_escrow,
                share_token_program: token_2022::ID,
                system_program: system_program::ID,
            },
        )
    }

    pub fn compute_limit(units: u32) -> Instruction {
        let mut data = vec![2u8];
        data.extend_from_slice(&units.to_le_bytes());
        Instruction { program_id: COMPUTE_BUDGET, accounts: vec![], data }
    }

    // ---------------------------------------------------------------- quotes

    /// 10 shares, protection from $360 down to $340 (max $200), $20 premium, a fresh nonce.
    pub fn quote(&mut self) -> QuoteArgs {
        self.nonce += 1;
        let mut nonce = [0u8; 32];
        nonce[..2].copy_from_slice(&self.nonce.to_le_bytes());
        QuoteArgs {
            feed_id: FEED,
            open_ts: OPEN,
            shares: 10_000_000,
            upper: 36_000_000_000,
            lower: 34_000_000_000,
            premium: 20 * USD,
            expiry: self.now() + 120,
            nonce,
        }
    }

    /// The Ed25519 program instruction verifying `signer`'s signature over `message`.
    pub fn ed25519_ix(signer: &Keypair, message: &[u8]) -> Instruction {
        let sig = signer.sign_message(message);
        let (key_off, sig_off, msg_off) = (16u16, 48u16, 112u16);
        let mut data = vec![1u8, 0];
        for v in [sig_off, u16::MAX, key_off, u16::MAX, msg_off, message.len() as u16, u16::MAX] {
            data.extend_from_slice(&v.to_le_bytes());
        }
        data.extend_from_slice(signer.pubkey().as_ref());
        data.extend_from_slice(sig.as_ref());
        data.extend_from_slice(message);
        Instruction { program_id: solana_sdk_ids::ed25519_program::ID, accounts: vec![], data }
    }

    pub fn message(&self, buyer: &Pubkey, q: &QuoteArgs) -> Vec<u8> {
        quote_message(&self.program_id, &self.vault, buyer, q)
    }

    /// The instructions a real client sends to buy: the quoter's signature, then buy.
    pub fn buy_ixs(&self, buyer: &User, q: QuoteArgs) -> Vec<Instruction> {
        vec![Self::ed25519_ix(&self.quoter, &self.message(&buyer.key(), &q)), self.ix_buy(buyer, q)]
    }

    pub fn buy_as(&mut self, buyer: &User, q: QuoteArgs) -> TransactionResult {
        let ixs = self.buy_ixs(buyer, q);
        let res = self.send(&ixs, &[&buyer.kp]);
        if res.is_ok() {
            self.holders.insert(self.position_pda(q.nonce), buyer.key());
        }
        res
    }

    pub fn buy(&mut self, q: QuoteArgs) -> TransactionResult {
        let buyer = self.buyer.clone();
        self.buy_as(&buyer, q)
    }

    // -------------------------------------------------------------- NFTs

    /// Moves a position's NFT to `to`, creating their account for it.
    pub fn transfer_nft(&mut self, position: &Pubkey, from: &User, to: &Pubkey) -> TransactionResult {
        let mint = self.position(position).unwrap().mint;
        let dest = Self::nft_account(to, &mint);
        let create = create_associated_token_account_idempotent(&from.key(), to, &mint, &token_2022::ID);
        let transfer = spl_token_2022::instruction::transfer_checked(
            &token_2022::ID,
            &Self::nft_account(&from.key(), &mint),
            &mint,
            &dest,
            &from.key(),
            &[],
            1,
            0,
        )
        .unwrap();
        let res = self.send(&[create, transfer], &[&from.kp]);
        if res.is_ok() {
            self.holders.insert(*position, *to);
        }
        res
    }

    /// The (position, NFT account, payee) triple for a position's current holder.
    pub fn triple(&self, position: &Pubkey) -> [Pubkey; 3] {
        let holder = self.holders[position];
        let mint = self.position(position).unwrap().mint;
        [*position, Self::nft_account(&holder, &mint), self.collateral_account(&holder)]
    }

    /// The keeper processes these positions of a series.
    pub fn process(&mut self, series: &Pubkey, positions: &[Pubkey]) -> TransactionResult {
        let triples: Vec<_> = positions.iter().map(|p| self.triple(p)).collect();
        let keeper = self.keeper.clone();
        let ix = self.ix_process(series, &keeper.key(), &keeper.ata, &triples);
        self.send(&[ix], &[&keeper.kp])
    }

    // ------------------------------------------------------------------ pool

    pub fn request_deposit(&mut self, owner: &User, assets: u64) -> TransactionResult {
        let ix = self.ix_request_deposit(owner, assets);
        self.send(&[ix], &[&owner.kp])
    }
    pub fn request_redeem(&mut self, owner: &User, shares: u64) -> TransactionResult {
        let ix = self.ix_request_redeem(owner, shares);
        self.send(&[ix], &[&owner.kp])
    }
    pub fn claim_deposit(&mut self, owner: &User) -> TransactionResult {
        let ix = self.ix_claim_deposit(owner);
        self.send(&[ix], &[&owner.kp])
    }
    pub fn claim_redemption(&mut self, owner: &User) -> TransactionResult {
        let ix = self.ix_claim_redemption(owner);
        self.send(&[ix], &[&owner.kp])
    }
    pub fn roll(&mut self) -> TransactionResult {
        let payer = self.payer.insecure_clone();
        let ix = self.ix_roll(&payer.pubkey());
        self.send(&[ix], &[&payer])
    }

    // ------------------------------------------------------------------ Pyth

    pub fn put_price_update(&mut self, owner: Pubkey, update: PriceUpdateV2) -> Pubkey {
        let address = Pubkey::new_unique();
        let mut data = Vec::new();
        update.try_serialize(&mut data).unwrap();
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(address, Account { lamports, data, owner, executable: false, rent_epoch: 0 })
            .unwrap();
        address
    }

    pub fn price(&mut self, spec: PriceSpec) -> Pubkey {
        self.put_price_update(pyth_solana_receiver_sdk::ID, spec.build())
    }

    /// Settle a feed's series for OPEN at `price` (expo -5), published at the open.
    pub fn settle_feed_at(&mut self, feed: [u8; 32], price: i64) -> TransactionResult {
        if self.now() < OPEN + 30 {
            self.set_time(OPEN + 30);
        }
        let update = self.price(PriceSpec { feed_id: feed, price, ..Default::default() });
        let ix = self.ix_settle(&self.series_pda(feed, OPEN), &update);
        let payer = self.payer.insecure_clone();
        self.send(&[ix], &[&payer])
    }

    pub fn settle_at(&mut self, price: i64) -> TransactionResult {
        self.settle_feed_at(FEED, price)
    }

    pub fn void(&mut self, feed: [u8; 32]) -> TransactionResult {
        let ix = self.ix_void(&self.series_pda(feed, OPEN));
        let payer = self.payer.insecure_clone();
        self.send(&[ix], &[&payer])
    }

    // ----------------------------------------------------------------- reads

    pub fn vault_state(&self) -> Vault {
        read(&self.svm, &self.vault)
    }
    pub fn series(&self, feed_id: [u8; 32], open_ts: i64) -> Series {
        read(&self.svm, &self.series_pda(feed_id, open_ts))
    }
    pub fn position(&self, address: &Pubkey) -> Option<Position> {
        try_read(&self.svm, address)
    }
    pub fn request(&self, owner: &Pubkey) -> Option<Request> {
        try_read(&self.svm, &self.request_pda(owner))
    }
    pub fn rate(&self, round: u64) -> RoundRate {
        read(&self.svm, &self.rate_pda(round))
    }
    pub fn feed_config(&self, feed_id: [u8; 32]) -> FeedConfig {
        read(&self.svm, &self.feed_pda(feed_id))
    }
    /// A token account's balance, classic or Token-2022 (same base layout); 0 if it doesn't exist.
    pub fn balance(&self, token_account: &Pubkey) -> u64 {
        get_spl_account::<spl_token::state::Account>(&self.svm, token_account).map(|a| a.amount).unwrap_or(0)
    }
    pub fn shares_of(&self, owner: &Pubkey) -> u64 {
        self.balance(&self.share_account(owner))
    }
    pub fn share_supply(&self) -> u64 {
        get_spl_account::<spl_token::state::Mint>(&self.svm, &self.share_mint).unwrap().supply
    }
    pub fn lamports(&self, address: &Pubkey) -> u64 {
        self.svm.get_account(address).map(|a| a.lamports).unwrap_or(0)
    }
    /// A Token-2022 mint's base state and the metadata stored on it.
    pub fn mint_with_metadata(&self, mint: &Pubkey) -> (spl_token_2022::state::Mint, TokenMetadata) {
        let acc = self.svm.get_account(mint).expect("mint");
        let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&acc.data).unwrap();
        let metadata = state.get_variable_len_extension::<TokenMetadata>().unwrap();
        (state.base, metadata)
    }

    /// The pool's assets as the program counts them.
    pub fn total_assets(&self) -> u64 {
        let v = self.vault_state();
        afterbell_vault::math::total_assets(self.balance(&self.vault_token), v.pending_deposit_assets, v.reserved_assets, v.tips_owed, v.locked)
            .unwrap()
    }
}

pub fn read<T: AccountDeserialize>(svm: &LiteSVM, address: &Pubkey) -> T {
    try_read(svm, address).expect("account")
}

pub fn try_read<T: AccountDeserialize>(svm: &LiteSVM, address: &Pubkey) -> Option<T> {
    let acc = svm.get_account(address)?;
    if acc.data.is_empty() {
        return None;
    }
    T::try_deserialize(&mut acc.data.as_slice()).ok()
}

/// A settlement price at OPEN for FEED, overridable field by field.
#[derive(Clone, Copy)]
pub struct PriceSpec {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
    pub prev_publish_time: i64,
    pub verification: VerificationLevel,
}

impl Default for PriceSpec {
    fn default() -> Self {
        PriceSpec {
            feed_id: FEED,
            price: 35_500_000, // $355.00000 at expo -5
            conf: 10_000,      // $0.10
            expo: -5,
            publish_time: OPEN,
            prev_publish_time: OPEN - 1,
            verification: VerificationLevel::Full,
        }
    }
}

impl PriceSpec {
    pub fn build(self) -> PriceUpdateV2 {
        PriceUpdateV2 {
            write_authority: Pubkey::new_unique(),
            verification_level: self.verification,
            price_message: PriceFeedMessage {
                feed_id: self.feed_id,
                price: self.price,
                conf: self.conf,
                exponent: self.expo,
                publish_time: self.publish_time,
                prev_publish_time: self.prev_publish_time,
                ema_price: self.price,
                ema_conf: self.conf,
            },
            posted_slot: 1,
        }
    }
}

// ------------------------------------------------------------ error assertions

pub fn assert_custom_error(res: TransactionResult, code: u32) {
    match res {
        Ok(_) => panic!("expected custom error {code}, transaction succeeded"),
        Err(failed) => {
            let got = format!("{:?}", failed.err);
            assert!(
                got.contains(&format!("Custom({code})")),
                "expected Custom({code}), got {got}\nlogs:\n{}",
                failed.meta.logs.join("\n")
            );
        }
    }
}

pub fn assert_vault_error(res: TransactionResult, e: VaultError) {
    assert_custom_error(res, anchor_lang::error::ERROR_CODE_OFFSET + e as u32);
}

pub fn assert_fails(res: TransactionResult) {
    assert!(res.is_err(), "expected the transaction to fail");
}

/// Unwraps a transaction, printing its logs if it failed.
pub fn ok(res: TransactionResult) -> litesvm::types::TransactionMetadata {
    match res {
        Ok(meta) => meta,
        Err(failed) => panic!("transaction failed: {:?}\nlogs:\n{}", failed.err, failed.meta.logs.join("\n")),
    }
}
