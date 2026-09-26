pub const VAULT_SEED: &[u8] = b"vault";
pub const VAULT_TOKEN_SEED: &[u8] = b"vault_token";
pub const SHARE_MINT_SEED: &[u8] = b"share_mint";
pub const SHARE_ESCROW_SEED: &[u8] = b"share_escrow";
pub const FEED_SEED: &[u8] = b"feed";
pub const SERIES_SEED: &[u8] = b"series";
pub const POSITION_SEED: &[u8] = b"position";
pub const POSITION_MINT_SEED: &[u8] = b"position_mint";
pub const REQUEST_SEED: &[u8] = b"request";
pub const RATE_SEED: &[u8] = b"rate";

/// Prices carry 8 decimals (as on the EVM vault); share amounts carry 6.
pub const PRICE_DECIMALS: i32 = 8;
pub const PRICE_SCALE: u128 = 100_000_000;
pub const SHARE_SCALE: u128 = 1_000_000;

/// How long after the open a settlement print may be published. Pyth equity
/// feeds print many times a second in session, so a minute is generous; an hour
/// is the most a vault may allow.
pub const MIN_SETTLE_WINDOW_SECS: u32 = 1;
pub const MAX_SETTLE_WINDOW_SECS: u32 = 3_600;

/// How long after the open anyone may void a series nobody settled. The floor
/// gives keepers time; the ceiling stops collateral being locked for no reason.
pub const MIN_VOID_DELAY_SECS: u32 = 3_600;
pub const MAX_VOID_DELAY_SECS: u32 = 7 * 24 * 3_600;

/// Widest Pyth confidence interval a vault may accept, as a share of price.
pub const MAX_CONF_BPS_LIMIT: u16 = 1_000;
/// Keepers' tips stay below a tenth of the premium.
pub const MAX_KEEPER_TIP_BPS: u16 = 1_000;
pub const BPS_DENOMINATOR: u128 = 10_000;

/// A series settles only at a price within this factor of the strikes it sold,
/// as on the EVM vault: a print that far off is a broken feed, and the series
/// voids and refunds instead.
pub const MAX_PRICE_RATIO: u128 = 10;

/// Pool shares and position NFTs are Token-2022 mints carrying their own metadata.
pub const SHARE_NAME: &str = "Afterbell Pool";
pub const SHARE_SYMBOL: &str = "BELLPOOL";
pub const POSITION_SYMBOL: &str = "BELL";
/// The metadata field on a position's NFT that names its `Position` account.
pub const POSITION_FIELD: &str = "position";
pub const MAX_ART_URI_LEN: usize = 128;
pub const MAX_SYMBOL_LEN: usize = 12;

#[cfg(test)]
mod tests {
    use anchor_lang::prelude::Pubkey;

    use super::*;

    fn pda(seeds: &[&[u8]]) -> Pubkey {
        Pubkey::find_program_address(seeds, &crate::ID).0
    }

    // solana/client/vault.test.ts pins the same addresses, so the client and the
    // program derive every account alike. They depend on the program id: when
    // `declare_id!` changes, both lists change together.
    const PINNED: [&str; 10] = [
        "4SNGem1v12XZkASk7QhYfP3GYDPFNBcjC9d5kHQGJnqW",
        "5aFQv22J7Td3KSSmLRFGsCiVwmWpgwQMa1QrcGp1JZ34",
        "8mu5FxnH7yoyexe73RgdrA8DyWY55Vhoeho3AVaV71By",
        "7PAosiVEmy5TRjMAj1mBWjkuVjVrwGRcyuCZ2bbCMzTh",
        "EEMXtkpgeZZzH6SZRk9Yy2U9iF5A8gqKLzqT6SKXssX1",
        "GMp3zVa9vyGk2Kj3dvvbQWki753SEfeTCgjRwdHsRQVU",
        "8c8ZCLuP7sR42CNwBdWVkZmFJxUr41kTk12zjeZs7pqp",
        "29TV96XxMEvQjUcAPH7s33y2y5ti5g8cXfGh9mYbi8s6",
        "J6TKLcwBUXyof4WbpQwWYH2hiDh34QW9ZqmNV3NPcYPf",
        "BmLtxAyVtYptUHXmD9XS72C5D65E8vhgzJ5TrndGPsdg",
    ];

    #[test]
    fn addresses_are_derived_from_their_seeds() {
        let (authority, mint) = ([1u8; 32], [2u8; 32]);
        let vault = pda(&[VAULT_SEED, &authority, &mint]);
        let nonce = [9u8; 32];
        let all = [
            vault,
            pda(&[VAULT_TOKEN_SEED, vault.as_ref()]),
            pda(&[SHARE_MINT_SEED, vault.as_ref()]),
            pda(&[SHARE_ESCROW_SEED, vault.as_ref()]),
            pda(&[FEED_SEED, vault.as_ref(), &[7u8; 32]]),
            pda(&[SERIES_SEED, vault.as_ref(), &[7u8; 32], &1_790_343_000i64.to_le_bytes()]),
            pda(&[POSITION_SEED, vault.as_ref(), &nonce]),
            pda(&[POSITION_MINT_SEED, vault.as_ref(), &nonce]),
            pda(&[REQUEST_SEED, vault.as_ref(), &authority]),
            pda(&[RATE_SEED, vault.as_ref(), &1u64.to_le_bytes()]),
        ];
        let got: Vec<String> = all.iter().map(|a| a.to_string()).collect();
        assert_eq!(got, PINNED);
        // All distinct: no two kinds of account can collide.
        for (i, a) in all.iter().enumerate() {
            for b in &all[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }
}
