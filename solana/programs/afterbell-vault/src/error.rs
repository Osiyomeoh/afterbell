use anchor_lang::prelude::*;

#[error_code]
#[derive(PartialEq, Eq)]
pub enum VaultError {
    #[msg("Settle window, void delay, confidence, risk limits or tip out of range")]
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
    #[msg("The round sells protection on another opening")]
    WrongRound,
    #[msg("The pool can't cover more protection this round")]
    OverCapacity,
    #[msg("The pool can't cover more protection on this stock this round")]
    OverStockLimit,
    #[msg("The series is not open")]
    SeriesNotOpen,
    #[msg("The series has not settled or voided")]
    SeriesStillOpen,
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
    #[msg("The price is too far from the strikes sold to be real")]
    ImplausiblePrice,
    #[msg("The void delay has not passed")]
    VoidTooEarly,
    #[msg("Positions come in threes: position, its NFT's token account, the holder's collateral account")]
    BadPositionAccounts,
    #[msg("The position is not in this series")]
    WrongSeries,
    #[msg("That token account doesn't hold the position's NFT")]
    NotHolder,
    #[msg("The payout account must be the NFT holder's, in the vault's collateral")]
    WrongPayee,
    #[msg("The round isn't over: its opening hasn't passed or a position is unpaid")]
    RoundNotOver,
    #[msg("The rate of the round that filled this request is needed")]
    RateMissing,
    #[msg("That is not the rate of the round that filled this request")]
    WrongRate,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Name or address too long")]
    TooLong,
    #[msg("Standing order: start below the price, depth below that, both under 100%; shares, premium cap and end date set")]
    InvalidOrder,
    #[msg("The standing order is cancelled")]
    OrderNotActive,
    #[msg("The standing order has ended")]
    OrderEnded,
    #[msg("The standing order already renewed for this opening")]
    AlreadyRenewed,
    #[msg("The quote is beyond the standing order's shares or premium cap")]
    OverOrderLimit,
    #[msg("The price is too old to renew against")]
    StalePrice,
    #[msg("The quote's strikes aren't where the standing order puts them")]
    StrikesOffOrder,
    #[msg("Sizer bounds: shares set, start below depth, both under 100%")]
    InvalidSizer,
    #[msg("Only the sizer the holder named may re-size this order")]
    NotSizer,
    #[msg("The new size is outside the bounds the holder gave the sizer")]
    OutsideSizerBounds,
    #[msg("Math overflow")]
    MathOverflow,
}
