pub const VAULT_SEED: &[u8] = b"vault";
pub const VAULT_TOKEN_SEED: &[u8] = b"vault_token";
pub const FEED_SEED: &[u8] = b"feed";
pub const SERIES_SEED: &[u8] = b"series";
pub const POSITION_SEED: &[u8] = b"position";

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
pub const BPS_DENOMINATOR: u128 = 10_000;

#[cfg(test)]
mod tests {
    use anchor_lang::prelude::Pubkey;

    use super::*;

    fn pda(seeds: &[&[u8]]) -> String {
        Pubkey::find_program_address(seeds, &crate::ID).0.to_string()
    }

    // The same addresses solana/client/vault.test.ts pins for the TypeScript client.
    #[test]
    fn addresses_match_the_typescript_client() {
        let (authority, mint) = ([1u8; 32], [2u8; 32]);
        let feed_id: [u8; 32] = [
            0x16, 0xda, 0xd5, 0x06, 0xd7, 0xdb, 0x8d, 0xa0, 0x1c, 0x87, 0x58, 0x1c, 0x87, 0xca, 0x89, 0x7a,
            0x01, 0x2a, 0x15, 0x35, 0x57, 0xd4, 0xd5, 0x78, 0xc3, 0xb9, 0xc9, 0xe1, 0xbc, 0x06, 0x32, 0xf1,
        ];
        let vault = Pubkey::find_program_address(&[VAULT_SEED, &authority, &mint], &crate::ID).0;
        assert_eq!(vault.to_string(), "4SNGem1v12XZkASk7QhYfP3GYDPFNBcjC9d5kHQGJnqW");
        assert_eq!(pda(&[VAULT_TOKEN_SEED, vault.as_ref()]), "5aFQv22J7Td3KSSmLRFGsCiVwmWpgwQMa1QrcGp1JZ34");
        assert_eq!(pda(&[FEED_SEED, vault.as_ref(), &feed_id]), "5GeZKgS3pLT3maKqxmRExD2r9grFQ4NFDjVfi2k4DVC8");
        assert_eq!(
            pda(&[SERIES_SEED, vault.as_ref(), &feed_id, &1_790_343_000i64.to_le_bytes()]),
            "ta6rLUJrPAs4y72igr8yjmH7Yk7DfowMowVtj61epG9"
        );
        assert_eq!(pda(&[POSITION_SEED, vault.as_ref(), &[9u8; 32]]), "8c8ZCLuP7sR42CNwBdWVkZmFJxUr41kTk12zjeZs7pqp");
    }
}
