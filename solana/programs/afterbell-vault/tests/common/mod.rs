//! LiteSVM harness: the compiled program, a 6-decimal collateral mint, funded
//! users, a quoter that signs real ed25519 quotes, a controllable clock and
//! forged Pyth price accounts.
#![allow(dead_code, clippy::result_large_err)]

use {
    afterbell_vault::{
        constants::*, error::VaultError, quote::quote_message, FeedConfig, Position, QuoteArgs, Series, Vault,
        VaultConfig,
    },
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
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
pub const USD: u64 = 1_000_000;
pub const SETTLE_WINDOW: u32 = 60;
pub const VOID_DELAY: u32 = 86_400;
pub const MAX_CONF_BPS: u16 = 100;
pub const SEED: u64 = 100_000 * USD;

pub struct User {
    pub kp: Keypair,
    pub ata: Pubkey,
}

pub struct Env {
    pub svm: LiteSVM,
    pub program_id: Pubkey,
    pub payer: Keypair,
    pub mint: Pubkey,
    pub authority: User,
    pub quoter: Keypair,
    pub buyer: User,
    pub vault: Pubkey,
    pub vault_token: Pubkey,
    nonce: u8,
}

impl Env {
    /// A vault with SEED collateral deposited and FEED allowed.
    pub fn new() -> Self {
        let program_id = afterbell_vault::id();
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/afterbell_vault.so"));
        svm.add_program(program_id, bytes).unwrap();

        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
        let mint = CreateMint::new(&mut svm, &payer).decimals(6).send().unwrap();

        let mut env = Env {
            svm,
            program_id,
            payer,
            mint,
            authority: User { kp: Keypair::new(), ata: Pubkey::default() },
            quoter: Keypair::new(),
            buyer: User { kp: Keypair::new(), ata: Pubkey::default() },
            vault: Pubkey::default(),
            vault_token: Pubkey::default(),
            nonce: 0,
        };
        env.set_time(T0);
        env.authority = env.new_user(SEED);
        env.buyer = env.new_user(1_000 * USD);
        env.vault = env.vault_pda(&env.authority.kp.pubkey());
        env.vault_token = env.vault_token_pda(&env.vault);

        let ix = env.ix_initialize(env.config());
        env.send(&[ix], &[&env.authority.kp.insecure_clone()]).unwrap();
        let ix = env.ix_allow_feed(FEED, true);
        env.send(&[ix], &[&env.authority.kp.insecure_clone()]).unwrap();
        let ix = env.ix_deposit(&env.authority.kp.pubkey(), &env.authority.ata, SEED);
        env.send(&[ix], &[&env.authority.kp.insecure_clone()]).unwrap();
        env
    }

    pub fn config(&self) -> VaultConfig {
        VaultConfig {
            quoter: self.quoter.pubkey(),
            settle_window_secs: SETTLE_WINDOW,
            void_delay_secs: VOID_DELAY,
            max_conf_bps: MAX_CONF_BPS,
        }
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

    pub fn set_time(&mut self, ts: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = ts;
        self.svm.set_sysvar(&clock);
    }

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
        self.svm.expire_blockhash();
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        self.svm.send_transaction(tx)
    }

    // ------------------------------------------------------------------- PDAs

    pub fn vault_pda(&self, authority: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[VAULT_SEED, authority.as_ref(), self.mint.as_ref()], &self.program_id).0
    }
    pub fn vault_token_pda(&self, vault: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[VAULT_TOKEN_SEED, vault.as_ref()], &self.program_id).0
    }
    pub fn feed_pda(&self, feed_id: [u8; 32]) -> Pubkey {
        Pubkey::find_program_address(&[FEED_SEED, self.vault.as_ref(), feed_id.as_ref()], &self.program_id).0
    }
    pub fn series_pda(&self, feed_id: [u8; 32], open_ts: i64) -> Pubkey {
        Pubkey::find_program_address(
            &[SERIES_SEED, self.vault.as_ref(), feed_id.as_ref(), &open_ts.to_le_bytes()],
            &self.program_id,
        )
        .0
    }
    pub fn position_pda(&self, nonce: [u8; 32]) -> Pubkey {
        Pubkey::find_program_address(&[POSITION_SEED, self.vault.as_ref(), nonce.as_ref()], &self.program_id).0
    }

    // ---------------------------------------------------- instruction builders

    pub fn ix_initialize(&self, config: VaultConfig) -> Instruction {
        Instruction::new_with_bytes(
            self.program_id,
            &afterbell_vault::instruction::InitializeVault { config }.data(),
            afterbell_vault::accounts::InitializeVault {
                authority: self.authority.kp.pubkey(),
                vault: self.vault,
                collateral_mint: self.mint,
                vault_token: self.vault_token,
                token_program: TOKEN_ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_set_config(&self, authority: &Pubkey, config: VaultConfig) -> Instruction {
        Instruction::new_with_bytes(
            self.program_id,
            &afterbell_vault::instruction::SetConfig { config }.data(),
            afterbell_vault::accounts::SetConfig { authority: *authority, vault: self.vault }.to_account_metas(None),
        )
    }

    pub fn ix_allow_feed(&self, feed_id: [u8; 32], allowed: bool) -> Instruction {
        Instruction::new_with_bytes(
            self.program_id,
            &afterbell_vault::instruction::AllowFeed { feed_id, allowed }.data(),
            afterbell_vault::accounts::AllowFeed {
                authority: self.authority.kp.pubkey(),
                vault: self.vault,
                feed_config: self.feed_pda(feed_id),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_deposit(&self, depositor: &Pubkey, depositor_token: &Pubkey, amount: u64) -> Instruction {
        Instruction::new_with_bytes(
            self.program_id,
            &afterbell_vault::instruction::Deposit { amount }.data(),
            afterbell_vault::accounts::Deposit {
                depositor: *depositor,
                vault: self.vault,
                collateral_mint: self.mint,
                depositor_token: *depositor_token,
                vault_token: self.vault_token,
                token_program: TOKEN_ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_withdraw(&self, authority: &Pubkey, to: &Pubkey, amount: u64) -> Instruction {
        Instruction::new_with_bytes(
            self.program_id,
            &afterbell_vault::instruction::Withdraw { amount }.data(),
            afterbell_vault::accounts::Withdraw {
                authority: *authority,
                vault: self.vault,
                collateral_mint: self.mint,
                vault_token: self.vault_token,
                to: *to,
                token_program: TOKEN_ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_buy(&self, buyer: &User, q: QuoteArgs) -> Instruction {
        Instruction::new_with_bytes(
            self.program_id,
            &afterbell_vault::instruction::Buy { q }.data(),
            afterbell_vault::accounts::Buy {
                buyer: buyer.kp.pubkey(),
                vault: self.vault,
                feed_config: self.feed_pda(q.feed_id),
                series: self.series_pda(q.feed_id, q.open_ts),
                position: self.position_pda(q.nonce),
                collateral_mint: self.mint,
                buyer_token: buyer.ata,
                vault_token: self.vault_token,
                instructions: solana_sdk_ids::sysvar::instructions::ID,
                token_program: TOKEN_ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_settle(&self, series: &Pubkey, price_update: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            self.program_id,
            &afterbell_vault::instruction::Settle {}.data(),
            afterbell_vault::accounts::Settle { vault: self.vault, series: *series, price_update: *price_update }
                .to_account_metas(None),
        )
    }

    pub fn ix_void(&self, series: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            self.program_id,
            &afterbell_vault::instruction::VoidSeries {}.data(),
            afterbell_vault::accounts::VoidSeries { vault: self.vault, series: *series }.to_account_metas(None),
        )
    }

    pub fn ix_claim(&self, position: &Pubkey, series: &Pubkey, buyer: &Pubkey, buyer_token: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            self.program_id,
            &afterbell_vault::instruction::Claim {}.data(),
            afterbell_vault::accounts::Claim {
                vault: self.vault,
                series: *series,
                position: *position,
                buyer: *buyer,
                collateral_mint: self.mint,
                buyer_token: *buyer_token,
                vault_token: self.vault_token,
                token_program: TOKEN_ID,
            }
            .to_account_metas(None),
        )
    }

    // ---------------------------------------------------------------- quotes

    /// 10 shares, protection from $360 down to $340 (max $200), $20 premium, a fresh nonce.
    pub fn quote(&mut self) -> QuoteArgs {
        self.nonce += 1;
        QuoteArgs {
            feed_id: FEED,
            open_ts: OPEN,
            shares: 10_000_000,
            upper: 36_000_000_000,
            lower: 34_000_000_000,
            premium: 20 * USD,
            expiry: T0 + 120,
            nonce: [self.nonce; 32],
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

    /// Buy with the quoter's signature, as a real client would.
    pub fn buy_as(&mut self, buyer: &User, q: QuoteArgs) -> TransactionResult {
        let sig_ix = Self::ed25519_ix(&self.quoter, &self.message(&buyer.kp.pubkey(), &q));
        let ix = self.ix_buy(buyer, q);
        self.send(&[sig_ix, ix], &[&buyer.kp.insecure_clone()])
    }

    pub fn buy(&mut self, q: QuoteArgs) -> TransactionResult {
        let buyer = User { kp: self.buyer.kp.insecure_clone(), ata: self.buyer.ata };
        self.buy_as(&buyer, q)
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

    /// Settle the default series at `price` (expo -5), published at the open.
    pub fn settle_at(&mut self, price: i64) -> TransactionResult {
        self.set_time(OPEN + 30);
        let update = self.price(PriceSpec { price, ..Default::default() });
        let ix = self.ix_settle(&self.series_pda(FEED, OPEN), &update);
        self.send(&[ix], &[&self.payer.insecure_clone()])
    }

    pub fn claim(&mut self, q: &QuoteArgs, buyer: &User) -> TransactionResult {
        let ix = self.ix_claim(&self.position_pda(q.nonce), &self.series_pda(q.feed_id, q.open_ts), &buyer.kp.pubkey(), &buyer.ata);
        self.send(&[ix], &[&self.payer.insecure_clone()])
    }

    // ----------------------------------------------------------------- reads

    pub fn vault_state(&self) -> Vault {
        read(&self.svm, &self.vault)
    }
    pub fn series(&self, feed_id: [u8; 32], open_ts: i64) -> Series {
        read(&self.svm, &self.series_pda(feed_id, open_ts))
    }
    pub fn position(&self, nonce: [u8; 32]) -> Option<Position> {
        let acc = self.svm.get_account(&self.position_pda(nonce))?;
        if acc.data.is_empty() {
            return None;
        }
        Some(Position::try_deserialize(&mut acc.data.as_slice()).unwrap())
    }
    pub fn feed_config(&self, feed_id: [u8; 32]) -> FeedConfig {
        read(&self.svm, &self.feed_pda(feed_id))
    }
    pub fn balance(&self, token_account: &Pubkey) -> u64 {
        get_spl_account::<spl_token::state::Account>(&self.svm, token_account).unwrap().amount
    }
    pub fn lamports(&self, address: &Pubkey) -> u64 {
        self.svm.get_account(address).map(|a| a.lamports).unwrap_or(0)
    }
}

fn read<T: AccountDeserialize>(svm: &LiteSVM, address: &Pubkey) -> T {
    let acc = svm.get_account(address).expect("account");
    T::try_deserialize(&mut acc.data.as_slice()).unwrap()
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
