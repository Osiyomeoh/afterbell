/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/afterbell_vault.json`.
 */
export type AfterbellVault = {
  "address": "6J5BHSf1yWup7SXae5xS2nzNUbtz7Bq3VpfJTtxr7Dsc",
  "metadata": {
    "name": "afterbellVault",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Protection on a tokenized stock's next opening print, sold against signed quotes and settled by the first Pyth print after the bell"
  },
  "instructions": [
    {
      "name": "allowFeed",
      "discriminator": [
        157,
        181,
        89,
        163,
        171,
        97,
        78,
        44
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault"
        },
        {
          "name": "feedConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "arg",
                "path": "feedId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "feedId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "allowed",
          "type": "bool"
        }
      ]
    },
    {
      "name": "buy",
      "discriminator": [
        102,
        6,
        61,
        18,
        1,
        218,
        235,
        234
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "feedConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "arg",
                "path": "q.feedId"
              }
            ]
          }
        },
        {
          "name": "series",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  114,
                  105,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "arg",
                "path": "q.feedId"
              },
              {
                "kind": "arg",
                "path": "q.openTs"
              }
            ]
          }
        },
        {
          "name": "position",
          "docs": [
            "Derived from the quote's nonce: a second purchase with the same quote fails here."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "arg",
                "path": "q.nonce"
              }
            ]
          }
        },
        {
          "name": "collateralMint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "buyerToken",
          "writable": true
        },
        {
          "name": "vaultToken",
          "writable": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "q",
          "type": {
            "defined": {
              "name": "quoteArgs"
            }
          }
        }
      ]
    },
    {
      "name": "claim",
      "discriminator": [
        62,
        198,
        214,
        193,
        213,
        159,
        108,
        210
      ],
      "accounts": [
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "series",
            "position"
          ]
        },
        {
          "name": "series",
          "relations": [
            "position"
          ]
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "position.nonce",
                "account": "position"
              }
            ]
          }
        },
        {
          "name": "buyer",
          "writable": true,
          "relations": [
            "position"
          ]
        },
        {
          "name": "collateralMint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "buyerToken",
          "writable": true
        },
        {
          "name": "vaultToken",
          "writable": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "deposit",
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "depositor",
          "signer": true
        },
        {
          "name": "vault"
        },
        {
          "name": "collateralMint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "depositorToken",
          "writable": true
        },
        {
          "name": "vaultToken",
          "writable": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initializeVault",
      "discriminator": [
        48,
        191,
        163,
        44,
        71,
        129,
        63,
        164
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              },
              {
                "kind": "account",
                "path": "collateralMint"
              }
            ]
          }
        },
        {
          "name": "collateralMint",
          "docs": [
            "Classic SPL Token only: Token-2022 transfer fees and hooks would break the accounting."
          ]
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "config",
          "type": {
            "defined": {
              "name": "vaultConfig"
            }
          }
        }
      ]
    },
    {
      "name": "setConfig",
      "discriminator": [
        108,
        158,
        154,
        175,
        212,
        98,
        52,
        66
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "config",
          "type": {
            "defined": {
              "name": "vaultConfig"
            }
          }
        }
      ]
    },
    {
      "name": "settle",
      "discriminator": [
        175,
        42,
        185,
        87,
        144,
        131,
        102,
        212
      ],
      "accounts": [
        {
          "name": "vault",
          "relations": [
            "series"
          ]
        },
        {
          "name": "series",
          "writable": true
        },
        {
          "name": "priceUpdate",
          "docs": [
            "`Account` checks this is owned by the Pyth receiver program, so its",
            "contents were posted (and signature-checked) by Pyth, not by the caller."
          ]
        }
      ],
      "args": []
    },
    {
      "name": "voidSeries",
      "discriminator": [
        166,
        121,
        101,
        68,
        174,
        18,
        57,
        34
      ],
      "accounts": [
        {
          "name": "vault",
          "relations": [
            "series"
          ]
        },
        {
          "name": "series",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "withdraw",
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault"
        },
        {
          "name": "collateralMint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vaultToken",
          "writable": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "to",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "feedConfig",
      "discriminator": [
        75,
        97,
        12,
        15,
        89,
        221,
        78,
        71
      ]
    },
    {
      "name": "position",
      "discriminator": [
        170,
        188,
        143,
        228,
        122,
        64,
        247,
        208
      ]
    },
    {
      "name": "series",
      "discriminator": [
        240,
        97,
        8,
        183,
        139,
        77,
        250,
        162
      ]
    },
    {
      "name": "vault",
      "discriminator": [
        211,
        8,
        232,
        43,
        2,
        152,
        117,
        119
      ]
    }
  ],
  "events": [
    {
      "name": "claimed",
      "discriminator": [
        217,
        192,
        123,
        72,
        108,
        150,
        248,
        33
      ]
    },
    {
      "name": "protectionBought",
      "discriminator": [
        213,
        185,
        233,
        133,
        29,
        127,
        108,
        223
      ]
    },
    {
      "name": "seriesSettled",
      "discriminator": [
        119,
        185,
        208,
        158,
        40,
        59,
        197,
        235
      ]
    },
    {
      "name": "seriesVoided",
      "discriminator": [
        98,
        41,
        248,
        229,
        32,
        6,
        107,
        60
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidConfig",
      "msg": "Settle window, void delay or confidence limit out of range"
    },
    {
      "code": 6001,
      "name": "zeroAmount",
      "msg": "Amount must be positive"
    },
    {
      "code": 6002,
      "name": "feedNotAllowed",
      "msg": "This feed is not allowed on the vault"
    },
    {
      "code": 6003,
      "name": "quoteExpired",
      "msg": "The quote has expired"
    },
    {
      "code": 6004,
      "name": "alreadyOpen",
      "msg": "The open this protection settles on has already passed"
    },
    {
      "code": 6005,
      "name": "invalidProtection",
      "msg": "Protection needs shares, upper above lower, and a premium no larger than its maximum payout"
    },
    {
      "code": 6006,
      "name": "missingSignature",
      "msg": "buy must follow an ed25519 instruction that verifies the quote"
    },
    {
      "code": 6007,
      "name": "invalidSignature",
      "msg": "The ed25519 instruction does not verify this quote from the vault's quoter"
    },
    {
      "code": 6008,
      "name": "insufficientCollateral",
      "msg": "Not enough free collateral to cover the maximum payout"
    },
    {
      "code": 6009,
      "name": "seriesNotOpen",
      "msg": "The series is not open"
    },
    {
      "code": 6010,
      "name": "tooEarly",
      "msg": "Too early: the open has not happened yet"
    },
    {
      "code": 6011,
      "name": "feedMismatch",
      "msg": "The price update is for a different feed"
    },
    {
      "code": 6012,
      "name": "insufficientVerification",
      "msg": "The price update is not fully verified"
    },
    {
      "code": 6013,
      "name": "priceBeforeOpen",
      "msg": "The price was published before the open"
    },
    {
      "code": 6014,
      "name": "priceAfterWindow",
      "msg": "The price was published after the settle window"
    },
    {
      "code": 6015,
      "name": "notFirstPriceAfterOpen",
      "msg": "Not the first price at or after the open"
    },
    {
      "code": 6016,
      "name": "nonPositivePrice",
      "msg": "Price must be positive"
    },
    {
      "code": 6017,
      "name": "confidenceTooWide",
      "msg": "Price confidence interval is too wide"
    },
    {
      "code": 6018,
      "name": "voidTooEarly",
      "msg": "The void delay has not passed"
    },
    {
      "code": 6019,
      "name": "notClaimable",
      "msg": "The series has not settled or voided"
    },
    {
      "code": 6020,
      "name": "mathOverflow",
      "msg": "Math overflow"
    }
  ],
  "types": [
    {
      "name": "claimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "refund",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "feedConfig",
      "docs": [
        "Whether the vault sells protection on a Pyth feed. Disallowing a feed stops",
        "new sales; positions already sold still settle and claim."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "feedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "allowed",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "position",
      "docs": [
        "One sale. Its address comes from the quote's nonce, so a quote buys once."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "upper",
            "type": "u64"
          },
          {
            "name": "lower",
            "type": "u64"
          },
          {
            "name": "premium",
            "type": "u64"
          },
          {
            "name": "maxPayout",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "priceFeedMessage",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feedId",
            "docs": [
              "`FeedId` but avoid the type alias because of compatibility issues with Anchor's `idl-build` feature."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "price",
            "type": "i64"
          },
          {
            "name": "conf",
            "type": "u64"
          },
          {
            "name": "exponent",
            "type": "i32"
          },
          {
            "name": "publishTime",
            "docs": [
              "The timestamp of this price update in seconds"
            ],
            "type": "i64"
          },
          {
            "name": "prevPublishTime",
            "docs": [
              "The timestamp of the previous price update. This field is intended to allow users to",
              "identify the single unique price update for any moment in time:",
              "for any time t, the unique update is the one such that prev_publish_time < t <= publish_time.",
              "",
              "Note that there may not be such an update while we are migrating to the new message-sending logic,",
              "as some price updates on pythnet may not be sent to other chains (because the message-sending",
              "logic may not have triggered). We can solve this problem by making the message-sending mandatory",
              "(which we can do once publishers have migrated over).",
              "",
              "Additionally, this field may be equal to publish_time if the message is sent on a slot where",
              "where the aggregation was unsuccesful. This problem will go away once all publishers have",
              "migrated over to a recent version of pyth-agent."
            ],
            "type": "i64"
          },
          {
            "name": "emaPrice",
            "type": "i64"
          },
          {
            "name": "emaConf",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "priceUpdateV2",
      "docs": [
        "A price update account. This account is used by the Pyth Receiver program to store a verified price update from a Pyth price feed.",
        "It contains:",
        "- `write_authority`: The write authority for this account. This authority can close this account to reclaim rent or update the account to contain a different price update.",
        "- `verification_level`: The [`VerificationLevel`] of this price update. This represents how many Wormhole guardian signatures have been verified for this price update.",
        "- `price_message`: The actual price update.",
        "- `posted_slot`: The slot at which this price update was posted."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "writeAuthority",
            "type": "pubkey"
          },
          {
            "name": "verificationLevel",
            "type": {
              "defined": {
                "name": "verificationLevel"
              }
            }
          },
          {
            "name": "priceMessage",
            "type": {
              "defined": {
                "name": "priceFeedMessage"
              }
            }
          },
          {
            "name": "postedSlot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "protectionBought",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "feedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "openTs",
            "type": "i64"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "upper",
            "type": "u64"
          },
          {
            "name": "lower",
            "type": "u64"
          },
          {
            "name": "premium",
            "type": "u64"
          },
          {
            "name": "maxPayout",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "quoteArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "openTs",
            "docs": [
              "Unix seconds of the 09:30 ET open the protection settles on."
            ],
            "type": "i64"
          },
          {
            "name": "shares",
            "docs": [
              "Shares with 6 decimals."
            ],
            "type": "u64"
          },
          {
            "name": "upper",
            "docs": [
              "Prices with 8 decimals."
            ],
            "type": "u64"
          },
          {
            "name": "lower",
            "type": "u64"
          },
          {
            "name": "premium",
            "docs": [
              "Collateral units."
            ],
            "type": "u64"
          },
          {
            "name": "expiry",
            "docs": [
              "Unix seconds after which the quote can't be used."
            ],
            "type": "i64"
          },
          {
            "name": "nonce",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "series",
      "docs": [
        "Every position on one feed for one open settles together, on one price."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "feedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "openTs",
            "type": "i64"
          },
          {
            "name": "state",
            "type": {
              "defined": {
                "name": "seriesState"
              }
            }
          },
          {
            "name": "price",
            "docs": [
              "Settlement price with 8 decimals."
            ],
            "type": "u64"
          },
          {
            "name": "publishTime",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "seriesSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "publishTime",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "seriesState",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "settled"
          },
          {
            "name": "voided"
          }
        ]
      }
    },
    {
      "name": "seriesVoided",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "vault",
      "docs": [
        "Sells protection in one collateral mint. Its token account holds deposits",
        "and premiums; `locked` is what open positions could still pay out."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "quoter",
            "docs": [
              "The ed25519 key whose signature prices every sale."
            ],
            "type": "pubkey"
          },
          {
            "name": "collateralMint",
            "type": "pubkey"
          },
          {
            "name": "vaultToken",
            "type": "pubkey"
          },
          {
            "name": "collateralUnit",
            "docs": [
              "10^decimals of the collateral mint."
            ],
            "type": "u64"
          },
          {
            "name": "locked",
            "type": "u64"
          },
          {
            "name": "settleWindowSecs",
            "type": "u32"
          },
          {
            "name": "voidDelaySecs",
            "type": "u32"
          },
          {
            "name": "maxConfBps",
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "tokenBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "vaultConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "quoter",
            "type": "pubkey"
          },
          {
            "name": "settleWindowSecs",
            "type": "u32"
          },
          {
            "name": "voidDelaySecs",
            "type": "u32"
          },
          {
            "name": "maxConfBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "verificationLevel",
      "docs": [
        "Pyth price updates are bridged to all blockchains via Wormhole.",
        "Using the price updates on another chain requires verifying the signatures of the Wormhole guardians.",
        "The usual process is to check the signatures for two thirds of the total number of guardians, but this can be cumbersome on Solana because of the transaction size limits,",
        "so we also allow for partial verification.",
        "",
        "This enum represents how much a price update has been verified:",
        "- If `Full`, we have verified the signatures for two thirds of the current guardians.",
        "- If `Partial`, only `num_signatures` guardian signatures have been checked.",
        "",
        "# Warning",
        "Using partially verified price updates is dangerous, as it lowers the threshold of guardians that need to collude to produce a malicious price update."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "partial",
            "fields": [
              {
                "name": "numSignatures",
                "type": "u8"
              }
            ]
          },
          {
            "name": "full"
          }
        ]
      }
    }
  ]
};
