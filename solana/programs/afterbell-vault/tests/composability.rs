//! Another program buys protection through CPI: `cover_desk` (programs/cover-desk)
//! buys with its PDA as the buyer, and the payout goes to that PDA.
mod common;

use {
    afterbell_vault::QuoteArgs,
    anchor_lang::{
        prelude::{AccountMeta, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        InstructionData, ToAccountMetas,
    },
    anchor_spl::{associated_token, token_2022},
    common::*,
    litesvm_token::{CreateAssociatedTokenAccount, MintTo, TOKEN_ID},
};

const DESK_PROGRAM: Pubkey = Pubkey::from_str_const("G1ZWgvzoNehAhqJxmrEYHfUeSXBD3eu9CKprtRCkSQr1");
/// `protect`'s discriminator, from target/idl/cover_desk.json.
const PROTECT: [u8; 8] = [7, 200, 63, 183, 60, 48, 87, 142];

/// Loads the desk program and gives its PDA SOL for rent and `usd` TestUSD.
fn desk(env: &mut Env, usd: u64) -> (Pubkey, Pubkey) {
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/cover_desk.so"));
    env.svm.add_program(DESK_PROGRAM, bytes).unwrap();
    let desk = Pubkey::find_program_address(&[b"desk"], &DESK_PROGRAM).0;
    env.svm.airdrop(&desk, 1_000_000_000).unwrap();
    let ata = CreateAssociatedTokenAccount::new(&mut env.svm, &env.payer, &env.mint).owner(&desk).send().unwrap();
    MintTo::new(&mut env.svm, &env.payer, &env.mint, &ata, usd).send().unwrap();
    (desk, ata)
}

fn ix_protect(env: &Env, desk: &Pubkey, desk_token: &Pubkey, q: QuoteArgs) -> Instruction {
    let position_mint = env.position_mint_pda(q.nonce);
    let mut accounts = afterbell_vault::accounts::Buy {
        buyer: *desk,
        vault: env.vault,
        feed_config: env.feed_pda(q.feed_id),
        series: env.series_pda(q.feed_id, q.open_ts),
        position: env.position_pda(q.nonce),
        position_mint,
        buyer_nft: Env::nft_account(desk, &position_mint),
        collateral_mint: env.mint,
        buyer_token: *desk_token,
        vault_token: env.vault_token,
        instructions: solana_sdk_ids::sysvar::instructions::ID,
        token_program: TOKEN_ID,
        nft_token_program: token_2022::ID,
        associated_token_program: associated_token::ID,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    accounts[0].is_signer = false; // the desk program signs for its PDA
    accounts.push(AccountMeta::new_readonly(env.program_id, false));
    let mut data = afterbell_vault::instruction::Buy { q }.data();
    data[..8].copy_from_slice(&PROTECT);
    Instruction::new_with_bytes(DESK_PROGRAM, &data, accounts)
}

#[test]
fn a_program_buys_protection_and_is_paid() {
    let mut env = Env::new();
    let (desk, desk_token) = desk(&mut env, 100 * USD);
    let q = env.quote();
    let position = env.position_pda(q.nonce);

    // The quoter's signature for the desk's address, right before the desk's instruction.
    let sig = Env::ed25519_ix(&env.quoter, &env.message(&desk, &q));
    let ix = ix_protect(&env, &desk, &desk_token, q);
    let payer = env.buyer.kp.insecure_clone();
    ok(env.send(&[sig, ix], &[&payer]));

    let p = env.position(&position).unwrap();
    assert_eq!(p.buyer, desk, "the desk's PDA bought it");
    assert_eq!(env.balance(&Env::nft_account(&desk, &p.mint)), 1, "and holds the NFT");
    assert_eq!(env.balance(&desk_token), 80 * USD, "paying the $20 premium");

    env.holders.insert(position, desk);
    ok(env.settle_at(35_500_000)); // $355: 10 x ($360 - $355)
    ok(env.process(&env.series_pda(FEED, OPEN), &[position]));
    assert_eq!(env.balance(&desk_token), 130 * USD, "the payout goes to the desk");
}

#[test]
fn a_quote_signed_for_someone_else_is_refused() {
    let mut env = Env::new();
    let (desk, desk_token) = desk(&mut env, 100 * USD);
    let q = env.quote();
    let buyer = env.buyer.key();
    let sig = Env::ed25519_ix(&env.quoter, &env.message(&buyer, &q));
    let ix = ix_protect(&env, &desk, &desk_token, q);
    let payer = env.buyer.kp.insecure_clone();
    assert!(env.send(&[sig, ix], &[&payer]).is_err());
}
