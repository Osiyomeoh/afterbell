//! Signed quotes. The quoter prices protection off-chain and signs the quote
//! with ed25519. A Solana program can't verify ed25519 cheaply itself, so the
//! buyer's transaction carries a call to the native Ed25519 program right
//! before `buy`; the runtime fails the whole transaction if that signature is
//! invalid, and `buy` reads the instruction to check it verified *this* quote
//! with *the vault's* quoter key.

use anchor_lang::{prelude::*, solana_program::instruction::Instruction};

use crate::error::VaultError;

/// Domain prefix, so a quote signature can't be mistaken for any other message.
pub const QUOTE_PREFIX: &[u8] = b"afterbell:quote:v1";
pub const QUOTE_MESSAGE_LEN: usize = 18 + 32 * 4 + 8 * 6 + 32;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct QuoteArgs {
    pub feed_id: [u8; 32],
    /// Unix seconds of the 09:30 ET open the protection settles on.
    pub open_ts: i64,
    /// Shares with 6 decimals.
    pub shares: u64,
    /// Prices with 8 decimals.
    pub upper: u64,
    pub lower: u64,
    /// Collateral units.
    pub premium: u64,
    /// Unix seconds after which the quote can't be used.
    pub expiry: i64,
    pub nonce: [u8; 32],
}

/// The exact bytes the quoter signs:
/// prefix ‖ program id ‖ vault ‖ buyer ‖ feed id ‖ open_ts ‖ shares ‖ upper ‖
/// lower ‖ premium ‖ expiry ‖ nonce, integers little-endian.
pub fn quote_message(program_id: &Pubkey, vault: &Pubkey, buyer: &Pubkey, q: &QuoteArgs) -> Vec<u8> {
    let mut m = Vec::with_capacity(QUOTE_MESSAGE_LEN);
    m.extend_from_slice(QUOTE_PREFIX);
    m.extend_from_slice(program_id.as_ref());
    m.extend_from_slice(vault.as_ref());
    m.extend_from_slice(buyer.as_ref());
    m.extend_from_slice(&q.feed_id);
    m.extend_from_slice(&q.open_ts.to_le_bytes());
    m.extend_from_slice(&q.shares.to_le_bytes());
    m.extend_from_slice(&q.upper.to_le_bytes());
    m.extend_from_slice(&q.lower.to_le_bytes());
    m.extend_from_slice(&q.premium.to_le_bytes());
    m.extend_from_slice(&q.expiry.to_le_bytes());
    m.extend_from_slice(&q.nonce);
    m
}

/// Offsets header of the Ed25519 program's instruction data: a signature
/// count, a padding byte, then one 14-byte offsets struct per signature.
const HEADER_LEN: usize = 16;
/// `instruction_index` value meaning "this instruction's own data".
const THIS_INSTRUCTION: u16 = u16::MAX;

fn u16_at(data: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([data[at], data[at + 1]])
}

/// Checks `ix` is a single-signature Ed25519 verification of `message` by
/// `signer`, with the key, signature and message all inside `ix` itself.
/// (The runtime has already checked the signature is valid, or the
/// transaction would not be running.)
pub fn verify_ed25519_ix(ix: &Instruction, signer: &Pubkey, message: &[u8]) -> Result<()> {
    require_keys_eq!(ix.program_id, solana_sdk_ids::ed25519_program::ID, VaultError::MissingSignature);
    require!(ix.accounts.is_empty(), VaultError::InvalidSignature);
    let d = &ix.data;
    require!(d.len() >= HEADER_LEN && d[0] == 1, VaultError::InvalidSignature);

    let sig_offset = u16_at(d, 2) as usize;
    let sig_ix = u16_at(d, 4);
    let key_offset = u16_at(d, 6) as usize;
    let key_ix = u16_at(d, 8);
    let msg_offset = u16_at(d, 10) as usize;
    let msg_len = u16_at(d, 12) as usize;
    let msg_ix = u16_at(d, 14);

    // Data pointed at in another instruction could be anything the attacker put there.
    require!(
        sig_ix == THIS_INSTRUCTION && key_ix == THIS_INSTRUCTION && msg_ix == THIS_INSTRUCTION,
        VaultError::InvalidSignature
    );
    require!(sig_offset.checked_add(64).is_some_and(|end| end <= d.len()), VaultError::InvalidSignature);
    let key = d.get(key_offset..key_offset + 32).ok_or(VaultError::InvalidSignature)?;
    let msg = d.get(msg_offset..msg_offset + msg_len).ok_or(VaultError::InvalidSignature)?;
    require!(key == signer.as_ref(), VaultError::InvalidSignature);
    require!(msg == message, VaultError::InvalidSignature);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quote() -> QuoteArgs {
        QuoteArgs {
            feed_id: [7; 32],
            open_ts: 1_790_343_000,
            shares: 10_000_000,
            upper: 36_000_000_000,
            lower: 34_000_000_000,
            premium: 20_000_000,
            expiry: 1_790_300_000,
            nonce: [9; 32],
        }
    }

    /// The Ed25519 program's layout: header, then key, signature, message.
    pub fn ed25519_data(key: &[u8; 32], sig: &[u8; 64], msg: &[u8], index: u16) -> Vec<u8> {
        let key_offset = HEADER_LEN as u16;
        let sig_offset = key_offset + 32;
        let msg_offset = sig_offset + 64;
        let mut d = vec![1u8, 0];
        for v in [sig_offset, index, key_offset, index, msg_offset, msg.len() as u16, index] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        d.extend_from_slice(key);
        d.extend_from_slice(sig);
        d.extend_from_slice(msg);
        d
    }

    fn ix(data: Vec<u8>) -> Instruction {
        Instruction { program_id: solana_sdk_ids::ed25519_program::ID, accounts: vec![], data }
    }

    #[test]
    fn message_layout_is_fixed() {
        let (p, v, b) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        let m = quote_message(&p, &v, &b, &quote());
        assert_eq!(m.len(), QUOTE_MESSAGE_LEN);
        assert_eq!(&m[..18], QUOTE_PREFIX);
        assert_eq!(&m[18..50], p.as_ref());
        assert_eq!(&m[50..82], v.as_ref());
        assert_eq!(&m[82..114], b.as_ref());
        assert_eq!(&m[114..146], &[7; 32]);
        assert_eq!(&m[146..154], &1_790_343_000i64.to_le_bytes());
        assert_eq!(&m[m.len() - 32..], &[9; 32]);
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    // The same bytes pricing/solanaQuote.test.ts pins for the TypeScript signer.
    const VECTOR_MESSAGE: &str = "616674657262656c6c3a71756f74653a763101010101010101010101010101010101010101010101010101010101010101010202020202020202020202020202020202020202020202020202020202020202030303030303030303030303030303030303030303030303030303030303030307070707070707070707070707070707070707070707070707070707070707075877b66a0000000080969800000000000068c4610800000000d48eea07000000002d31010000000060cfb56a000000000909090909090909090909090909090909090909090909090909090909090909";

    #[test]
    fn message_matches_the_typescript_signer() {
        let m = quote_message(
            &Pubkey::new_from_array([1; 32]),
            &Pubkey::new_from_array([2; 32]),
            &Pubkey::new_from_array([3; 32]),
            &quote(),
        );
        assert_eq!(hex(&m), VECTOR_MESSAGE);
    }

    #[test]
    fn accepts_an_instruction_built_by_the_typescript_client() {
        // ed25519InstructionData(...) for seed [5; 32] over VECTOR_MESSAGE.
        let key = unhex("6e7a1cdd29b0b78fd13af4c5598feff4ef2a97166e3ca6f2e4fbfccd80505bf1");
        let data = unhex(concat!(
            "01003000ffff1000ffff7000e200ffff",
            "6e7a1cdd29b0b78fd13af4c5598feff4ef2a97166e3ca6f2e4fbfccd80505bf1",
            "7cff11bc562afb8cd2b4962cc628a856f8cc7266115e18f02f70eb26b23e363f",
            "276a97fd4a269b3d553b3dd714e1a7cfa2a60c8488de54583e498f425a836e02",
        ))
        .into_iter()
        .chain(unhex(VECTOR_MESSAGE))
        .collect();
        let signer = Pubkey::new_from_array(key.try_into().unwrap());
        assert!(verify_ed25519_ix(&ix(data), &signer, &unhex(VECTOR_MESSAGE)).is_ok());
    }

    #[test]
    fn accepts_the_quoters_signature_over_the_quote() {
        let signer = Pubkey::new_unique();
        let msg = quote_message(&Pubkey::new_unique(), &Pubkey::new_unique(), &Pubkey::new_unique(), &quote());
        let data = ed25519_data(&signer.to_bytes(), &[1; 64], &msg, THIS_INSTRUCTION);
        assert!(verify_ed25519_ix(&ix(data), &signer, &msg).is_ok());
    }

    #[test]
    fn rejects_another_signer_or_message() {
        let signer = Pubkey::new_unique();
        let msg = vec![5u8; 40];
        let data = ed25519_data(&signer.to_bytes(), &[1; 64], &msg, THIS_INSTRUCTION);
        assert!(verify_ed25519_ix(&ix(data.clone()), &Pubkey::new_unique(), &msg).is_err());
        assert!(verify_ed25519_ix(&ix(data), &signer, &[6u8; 40]).is_err());
    }

    #[test]
    fn rejects_data_pointing_into_another_instruction() {
        let signer = Pubkey::new_unique();
        let msg = vec![5u8; 40];
        let data = ed25519_data(&signer.to_bytes(), &[1; 64], &msg, 0);
        assert!(verify_ed25519_ix(&ix(data), &signer, &msg).is_err());
    }

    #[test]
    fn rejects_other_programs_multiple_signatures_and_short_data() {
        let signer = Pubkey::new_unique();
        let msg = vec![5u8; 40];
        let data = ed25519_data(&signer.to_bytes(), &[1; 64], &msg, THIS_INSTRUCTION);

        let mut other = ix(data.clone());
        other.program_id = Pubkey::new_unique();
        assert!(verify_ed25519_ix(&other, &signer, &msg).is_err());

        let mut two = data.clone();
        two[0] = 2;
        assert!(verify_ed25519_ix(&ix(two), &signer, &msg).is_err());

        assert!(verify_ed25519_ix(&ix(data[..10].to_vec()), &signer, &msg).is_err());

        let mut truncated = data;
        truncated.truncate(HEADER_LEN + 32 + 64 + 10); // message cut short
        assert!(verify_ed25519_ix(&ix(truncated), &signer, &msg).is_err());
    }
}
