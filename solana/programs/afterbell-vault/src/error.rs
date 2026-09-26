use anchor_lang::prelude::*;

#[error_code]
#[derive(PartialEq, Eq)]
pub enum VaultError {
    #[msg("Settle window, void delay or confidence limit out of range")]
    InvalidConfig,
    #[msg("Amount must be positive")]
    ZeroAmount,
    #[msg("This feed is not allowed on the vault")]
    FeedNotAllowed,
    #[msg("The quote has expired")]
    QuoteExpired,
    #[msg("The open this protection settles on has already passed")]
    AlreadyOpen,
    #[msg("Protection needs shares, upper above lower, and a premium no larger than its maximum payout")]
    InvalidProtection,
    #[msg("buy must follow an ed25519 instruction that verifies the quote")]
    MissingSignature,
    #[msg("The ed25519 instruction does not verify this quote from the vault's quoter")]
    InvalidSignature,
    #[msg("Not enough free collateral to cover the maximum payout")]
    InsufficientCollateral,
    #[msg("The series is not open")]
    SeriesNotOpen,
    #[msg("Too early: the open has not happened yet")]
    TooEarly,
    #[msg("The price update is for a different feed")]
    FeedMismatch,
    #[msg("The price update is not fully verified")]
    InsufficientVerification,
    #[msg("The price was published before the open")]
    PriceBeforeOpen,
    #[msg("The price was published after the settle window")]
    PriceAfterWindow,
    #[msg("Not the first price at or after the open")]
    NotFirstPriceAfterOpen,
    #[msg("Price must be positive")]
    NonPositivePrice,
    #[msg("Price confidence interval is too wide")]
    ConfidenceTooWide,
    #[msg("The void delay has not passed")]
    VoidTooEarly,
    #[msg("The series has not settled or voided")]
    NotClaimable,
    #[msg("Math overflow")]
    MathOverflow,
}
