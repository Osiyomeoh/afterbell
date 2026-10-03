/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/afterbell_vault.json`.
 */
export type AfterbellVault = {
  "address": "J6n3JUafVkx4MpKTnAnZSwTcGFueRrjxgiXWMC4L7RGG",
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
          "name": "symbol",
          "type": "string"
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
          "name": "positionMint",
          "docs": [
            "The position's NFT: no decimals, its metadata on the mint itself. The",
            "vault mints one and then gives up the mint authority."
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
                  110,
                  95,
                  109,
                  105,
                  110,
                  116
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
          "name": "buyerNft",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "buyer"
              },
              {
                "kind": "account",
                "path": "nftTokenProgram"
              },
              {
                "kind": "account",
                "path": "positionMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
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
          "name": "nftTokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
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
      "name": "cancelOrder",
      "discriminator": [
        95,
        129,
        237,
        240,
        8,
        49,
        223,
        132
      ],
      "accounts": [
        {
          "name": "holder",
          "signer": true,
          "relations": [
            "order"
          ]
        },
        {
          "name": "order",
          "writable": true
        },
        {
          "name": "holderToken",
          "docs": [
            "The allowance is revoked only if it's still this order's."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "claimDeposit",
      "discriminator": [
        201,
        106,
        1,
        224,
        122,
        144,
        210,
        155
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault"
        },
        {
          "name": "request",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "rate",
          "docs": [
            "The rate of the round that filled the deposit, unless it's already filled."
          ],
          "optional": true
        },
        {
          "name": "shareMint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "ownerShares",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "shareTokenProgram"
              },
              {
                "kind": "account",
                "path": "shareMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "shareEscrow",
          "writable": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "shareTokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "claimRedemption",
      "discriminator": [
        109,
        110,
        9,
        188,
        195,
        217,
        112,
        83
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "request",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "rate",
          "docs": [
            "The rate of the round that filled the redemption, unless it's already filled."
          ],
          "optional": true
        },
        {
          "name": "collateralMint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "ownerToken",
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
          "name": "shareMint",
          "docs": [
            "The pool's shares, in the collateral's decimals, with their name on the mint itself."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  95,
                  109,
                  105,
                  110,
                  116
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
          "name": "shareEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
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
          "name": "shareTokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "quoter",
          "type": "pubkey"
        },
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "params"
            }
          }
        },
        {
          "name": "artUri",
          "type": "string"
        }
      ]
    },
    {
      "name": "process",
      "discriminator": [
        147,
        104,
        175,
        139,
        110,
        254,
        236,
        21
      ],
      "accounts": [
        {
          "name": "keeper",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "series"
          ]
        },
        {
          "name": "series",
          "writable": true
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
          "name": "keeperToken",
          "docs": [
            "Where the keeper's tips go."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "removeSizer",
      "discriminator": [
        140,
        186,
        45,
        232,
        4,
        248,
        117,
        21
      ],
      "accounts": [
        {
          "name": "holder",
          "writable": true,
          "signer": true,
          "relations": [
            "order"
          ]
        },
        {
          "name": "order"
        },
        {
          "name": "sizer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  105,
                  122,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "renew",
      "discriminator": [
        43,
        239,
        15,
        46,
        27,
        7,
        163,
        73
      ],
      "accounts": [
        {
          "name": "keeper",
          "docs": [
            "Anyone: pays the new accounts' rent, as a buyer would."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "holder"
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "order.holder",
                "account": "order"
              },
              {
                "kind": "arg",
                "path": "q.feedId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "order"
          ]
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
          "name": "positionMint",
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
                  110,
                  95,
                  109,
                  105,
                  110,
                  116
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
          "name": "holderNft",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "holder"
              },
              {
                "kind": "account",
                "path": "nftTokenProgram"
              },
              {
                "kind": "account",
                "path": "positionMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "collateralMint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "holderToken",
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
          "name": "priceUpdate",
          "docs": [
            "The stock's latest price, which the strikes are checked against."
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
          "name": "nftTokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
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
      "name": "requestDeposit",
      "discriminator": [
        243,
        202,
        197,
        215,
        135,
        97,
        213,
        109
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "request",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "rate",
          "docs": [
            "The rate of the round that filled an earlier deposit request, if one is waiting."
          ],
          "optional": true
        },
        {
          "name": "collateralMint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "ownerToken",
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
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "assets",
          "type": "u64"
        }
      ]
    },
    {
      "name": "requestRedeem",
      "discriminator": [
        105,
        49,
        44,
        38,
        207,
        241,
        33,
        173
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "request",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "rate",
          "docs": [
            "The rate of the round that filled an earlier redemption request, if one is waiting."
          ],
          "optional": true
        },
        {
          "name": "shareMint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "ownerShares",
          "writable": true
        },
        {
          "name": "shareEscrow",
          "writable": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "shareTokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "shares",
          "type": "u64"
        }
      ]
    },
    {
      "name": "resizeOrder",
      "discriminator": [
        103,
        36,
        20,
        197,
        193,
        54,
        21,
        49
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "order",
          "writable": true
        },
        {
          "name": "sizer",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  105,
                  122,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "maxShares",
          "type": "u64"
        },
        {
          "name": "startBps",
          "type": "u16"
        },
        {
          "name": "depthBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "roll",
      "discriminator": [
        143,
        143,
        93,
        91,
        13,
        254,
        64,
        93
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Pays the rent of the round's rate record."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "rate",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "vault.round",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "vaultToken",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "shareMint",
          "writable": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "shareEscrow",
          "writable": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "shareTokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "setArtUri",
      "discriminator": [
        244,
        114,
        102,
        153,
        123,
        220,
        85,
        202
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
          "name": "artUri",
          "type": "string"
        }
      ]
    },
    {
      "name": "setOrder",
      "discriminator": [
        90,
        197,
        72,
        169,
        67,
        133,
        252,
        202
      ],
      "accounts": [
        {
          "name": "holder",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault"
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
                "path": "feedId"
              }
            ]
          }
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "holder"
              },
              {
                "kind": "arg",
                "path": "feedId"
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
          "name": "holderToken",
          "writable": true
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
          "name": "feedId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "terms",
          "type": {
            "defined": {
              "name": "orderTerms"
            }
          }
        }
      ]
    },
    {
      "name": "setParams",
      "discriminator": [
        27,
        234,
        178,
        52,
        147,
        2,
        187,
        141
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
          "name": "params",
          "type": {
            "defined": {
              "name": "params"
            }
          }
        }
      ]
    },
    {
      "name": "setQuoter",
      "discriminator": [
        166,
        227,
        170,
        78,
        187,
        71,
        1,
        57
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
          "name": "quoter",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setSizer",
      "discriminator": [
        204,
        69,
        163,
        62,
        129,
        33,
        189,
        192
      ],
      "accounts": [
        {
          "name": "holder",
          "writable": true,
          "signer": true,
          "relations": [
            "order"
          ]
        },
        {
          "name": "order"
        },
        {
          "name": "sizer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  105,
                  122,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "order"
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
          "name": "bounds",
          "type": {
            "defined": {
              "name": "sizerBounds"
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
      "name": "order",
      "discriminator": [
        134,
        173,
        223,
        185,
        77,
        86,
        28,
        51
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
      "name": "request",
      "discriminator": [
        125,
        172,
        150,
        161,
        162,
        115,
        39,
        71
      ]
    },
    {
      "name": "roundRate",
      "discriminator": [
        15,
        134,
        80,
        114,
        79,
        234,
        162,
        55
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
      "name": "sizer",
      "discriminator": [
        155,
        122,
        248,
        38,
        102,
        234,
        100,
        181
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
      "name": "depositClaimed",
      "discriminator": [
        119,
        147,
        244,
        76,
        141,
        103,
        170,
        176
      ]
    },
    {
      "name": "depositRequested",
      "discriminator": [
        35,
        33,
        229,
        138,
        116,
        238,
        192,
        22
      ]
    },
    {
      "name": "forfeited",
      "discriminator": [
        80,
        140,
        117,
        204,
        15,
        230,
        158,
        241
      ]
    },
    {
      "name": "orderCancelled",
      "discriminator": [
        108,
        56,
        128,
        68,
        168,
        113,
        168,
        239
      ]
    },
    {
      "name": "orderResized",
      "discriminator": [
        127,
        198,
        252,
        10,
        181,
        26,
        101,
        123
      ]
    },
    {
      "name": "orderSet",
      "discriminator": [
        176,
        13,
        15,
        108,
        99,
        155,
        160,
        234
      ]
    },
    {
      "name": "paid",
      "discriminator": [
        240,
        193,
        17,
        238,
        238,
        210,
        129,
        235
      ]
    },
    {
      "name": "paramsQueued",
      "discriminator": [
        154,
        201,
        187,
        11,
        75,
        245,
        205,
        20
      ]
    },
    {
      "name": "paramsSet",
      "discriminator": [
        57,
        111,
        33,
        252,
        120,
        76,
        98,
        245
      ]
    },
    {
      "name": "processed",
      "discriminator": [
        36,
        1,
        88,
        53,
        65,
        92,
        150,
        6
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
      "name": "redeemRequested",
      "discriminator": [
        5,
        130,
        67,
        249,
        243,
        168,
        11,
        88
      ]
    },
    {
      "name": "redemptionClaimed",
      "discriminator": [
        107,
        251,
        199,
        213,
        59,
        173,
        53,
        189
      ]
    },
    {
      "name": "rolled",
      "discriminator": [
        243,
        213,
        137,
        215,
        92,
        162,
        11,
        192
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
    },
    {
      "name": "sizerRemoved",
      "discriminator": [
        143,
        175,
        113,
        93,
        231,
        170,
        170,
        88
      ]
    },
    {
      "name": "sizerSet",
      "discriminator": [
        217,
        108,
        102,
        10,
        115,
        100,
        49,
        82
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidConfig",
      "msg": "Settle window, void delay, confidence, risk limits or tip out of range"
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
      "name": "wrongRound",
      "msg": "The round sells protection on another opening"
    },
    {
      "code": 6009,
      "name": "overCapacity",
      "msg": "The pool can't cover more protection this round"
    },
    {
      "code": 6010,
      "name": "overStockLimit",
      "msg": "The pool can't cover more protection on this stock this round"
    },
    {
      "code": 6011,
      "name": "seriesNotOpen",
      "msg": "The series is not open"
    },
    {
      "code": 6012,
      "name": "seriesStillOpen",
      "msg": "The series has not settled or voided"
    },
    {
      "code": 6013,
      "name": "tooEarly",
      "msg": "Too early: the open has not happened yet"
    },
    {
      "code": 6014,
      "name": "feedMismatch",
      "msg": "The price update is for a different feed"
    },
    {
      "code": 6015,
      "name": "insufficientVerification",
      "msg": "The price update is not fully verified"
    },
    {
      "code": 6016,
      "name": "priceBeforeOpen",
      "msg": "The price was published before the open"
    },
    {
      "code": 6017,
      "name": "priceAfterWindow",
      "msg": "The price was published after the settle window"
    },
    {
      "code": 6018,
      "name": "notFirstPriceAfterOpen",
      "msg": "Not the first price at or after the open"
    },
    {
      "code": 6019,
      "name": "nonPositivePrice",
      "msg": "Price must be positive"
    },
    {
      "code": 6020,
      "name": "confidenceTooWide",
      "msg": "Price confidence interval is too wide"
    },
    {
      "code": 6021,
      "name": "implausiblePrice",
      "msg": "The price is too far from the strikes sold to be real"
    },
    {
      "code": 6022,
      "name": "voidTooEarly",
      "msg": "The void delay has not passed"
    },
    {
      "code": 6023,
      "name": "badPositionAccounts",
      "msg": "Positions come in threes: position, its NFT's token account, the holder's collateral account"
    },
    {
      "code": 6024,
      "name": "wrongSeries",
      "msg": "The position is not in this series"
    },
    {
      "code": 6025,
      "name": "notHolder",
      "msg": "That token account doesn't hold the position's NFT"
    },
    {
      "code": 6026,
      "name": "wrongPayee",
      "msg": "The payout account must be the NFT holder's, in the vault's collateral"
    },
    {
      "code": 6027,
      "name": "roundNotOver",
      "msg": "The round isn't over: its opening hasn't passed or a position is unpaid"
    },
    {
      "code": 6028,
      "name": "rateMissing",
      "msg": "The rate of the round that filled this request is needed"
    },
    {
      "code": 6029,
      "name": "wrongRate",
      "msg": "That is not the rate of the round that filled this request"
    },
    {
      "code": 6030,
      "name": "nothingToClaim",
      "msg": "Nothing to claim"
    },
    {
      "code": 6031,
      "name": "tooLong",
      "msg": "Name or address too long"
    },
    {
      "code": 6032,
      "name": "invalidOrder",
      "msg": "Standing order: start below the price, depth below that, both under 100%; shares, premium cap and end date set"
    },
    {
      "code": 6033,
      "name": "orderNotActive",
      "msg": "The standing order is cancelled"
    },
    {
      "code": 6034,
      "name": "orderEnded",
      "msg": "The standing order has ended"
    },
    {
      "code": 6035,
      "name": "alreadyRenewed",
      "msg": "The standing order already renewed for this opening"
    },
    {
      "code": 6036,
      "name": "overOrderLimit",
      "msg": "The quote is beyond the standing order's shares or premium cap"
    },
    {
      "code": 6037,
      "name": "stalePrice",
      "msg": "The price is too old to renew against"
    },
    {
      "code": 6038,
      "name": "strikesOffOrder",
      "msg": "The quote's strikes aren't where the standing order puts them"
    },
    {
      "code": 6039,
      "name": "invalidSizer",
      "msg": "Sizer bounds: shares set, start below depth, both under 100%"
    },
    {
      "code": 6040,
      "name": "notSizer",
      "msg": "Only the sizer the holder named may re-size this order"
    },
    {
      "code": 6041,
      "name": "outsideSizerBounds",
      "msg": "The new size is outside the bounds the holder gave the sizer"
    },
    {
      "code": 6042,
      "name": "mathOverflow",
      "msg": "Math overflow"
    }
  ],
  "types": [
    {
      "name": "depositClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "assets",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "depositRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "round",
            "type": "u64"
          },
          {
            "name": "assets",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "feedConfig",
      "docs": [
        "Whether the vault sells protection on a Pyth feed, and the stock's ticker",
        "(the positions' NFTs show it). Disallowing a feed stops new sales; positions",
        "already sold still settle and pay."
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
            "name": "symbol",
            "type": "string"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "forfeited",
      "docs": [
        "A position whose NFT was burned: nobody holds it, so its payout stays in the pool."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "docs": [
              "What it would have paid."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "order",
      "docs": [
        "A holder's standing order: protection on one stock renewed each night by any",
        "keeper, within the holder's limits, paid from an allowance the holder gave",
        "this account over their collateral. It is the quote's buyer; the NFT goes to",
        "the holder."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "holder",
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
            "name": "maxShares",
            "type": "u64"
          },
          {
            "name": "startBps",
            "docs": [
              "Where protection starts and stops, in bps below the price."
            ],
            "type": "u16"
          },
          {
            "name": "depthBps",
            "type": "u16"
          },
          {
            "name": "maxPremium",
            "type": "u64"
          },
          {
            "name": "until",
            "docs": [
              "Renews for openings before this time."
            ],
            "type": "i64"
          },
          {
            "name": "lastOpenTs",
            "docs": [
              "The last opening renewed for, kept across a cancel so it can't renew twice."
            ],
            "type": "i64"
          },
          {
            "name": "active",
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
      "name": "orderCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "holder",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "orderResized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "sizer",
            "type": "pubkey"
          },
          {
            "name": "maxShares",
            "type": "u64"
          },
          {
            "name": "startBps",
            "type": "u16"
          },
          {
            "name": "depthBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "orderSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "holder",
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
            "name": "maxShares",
            "type": "u64"
          },
          {
            "name": "startBps",
            "type": "u16"
          },
          {
            "name": "depthBps",
            "type": "u16"
          },
          {
            "name": "maxPremium",
            "type": "u64"
          },
          {
            "name": "until",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "orderTerms",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maxShares",
            "type": "u64"
          },
          {
            "name": "startBps",
            "type": "u16"
          },
          {
            "name": "depthBps",
            "type": "u16"
          },
          {
            "name": "maxPremium",
            "type": "u64"
          },
          {
            "name": "until",
            "type": "i64"
          },
          {
            "name": "allowance",
            "docs": [
              "What renewals may spend in all: the order's allowance over the holder's collateral."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "paid",
      "docs": [
        "A position paid out to whoever held its NFT (or refunded, if its series voided)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "holder",
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
      "name": "params",
      "docs": [
        "Settlement timings and risk limits. Changes wait for the next roll, so a",
        "round runs to the end on the rules it started with."
      ],
      "type": {
        "kind": "struct",
        "fields": [
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
            "name": "maxUtilizationBps",
            "docs": [
              "The most a round may lock, as a share of the pool at its roll."
            ],
            "type": "u16"
          },
          {
            "name": "maxFeedBps",
            "docs": [
              "The most one stock may lock in a round, as a share of the pool at its roll."
            ],
            "type": "u16"
          },
          {
            "name": "keeperTipBps",
            "docs": [
              "The keeper's cut of each premium, paid to whoever pays the position out."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "paramsQueued",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "params",
            "type": {
              "defined": {
                "name": "params"
              }
            }
          }
        ]
      }
    },
    {
      "name": "paramsSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "params",
            "type": {
              "defined": {
                "name": "params"
              }
            }
          }
        ]
      }
    },
    {
      "name": "position",
      "docs": [
        "One sale. Its address comes from the quote's nonce, so a quote buys once.",
        "It's paid to whoever holds its NFT, and stays on-chain afterwards with what",
        "it paid."
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
            "name": "mint",
            "docs": [
              "Its NFT: a Token-2022 mint with a supply of one."
            ],
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
            "name": "number",
            "docs": [
              "Numbered in order of sale, from 1."
            ],
            "type": "u64"
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
            "name": "tip",
            "type": "u64"
          },
          {
            "name": "closed",
            "type": "bool"
          },
          {
            "name": "paid",
            "docs": [
              "What it paid, and to whom: the payout, or the premium if its series voided."
            ],
            "type": "u64"
          },
          {
            "name": "paidTo",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "mintBump",
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
      "name": "processed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "positions",
            "type": "u32"
          },
          {
            "name": "keeper",
            "type": "pubkey"
          },
          {
            "name": "tips",
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
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "number",
            "type": "u64"
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
      "name": "redeemRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "round",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "redemptionClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "assets",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "request",
      "docs": [
        "An underwriter's queued deposit and redemption, and what earlier rolls",
        "filled for them to claim."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "depositRound",
            "type": "u64"
          },
          {
            "name": "depositAssets",
            "type": "u64"
          },
          {
            "name": "redeemRound",
            "type": "u64"
          },
          {
            "name": "redeemShares",
            "type": "u64"
          },
          {
            "name": "filledDepositAssets",
            "type": "u64"
          },
          {
            "name": "filledDepositShares",
            "type": "u64"
          },
          {
            "name": "filledRedeemShares",
            "type": "u64"
          },
          {
            "name": "filledRedeemAssets",
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
      "name": "rolled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "round",
            "type": "u64"
          },
          {
            "name": "openTs",
            "type": "i64"
          },
          {
            "name": "assets",
            "type": "u64"
          },
          {
            "name": "supply",
            "type": "u64"
          },
          {
            "name": "depositAssets",
            "type": "u64"
          },
          {
            "name": "depositShares",
            "type": "u64"
          },
          {
            "name": "redeemShares",
            "type": "u64"
          },
          {
            "name": "redeemAssets",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "roundRate",
      "docs": [
        "The pool at the roll that ended a round: the price every request queued in",
        "that round was filled at."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "round",
            "type": "u64"
          },
          {
            "name": "openTs",
            "type": "i64"
          },
          {
            "name": "assets",
            "docs": [
              "The pool's assets and share supply at the roll. Shares convert at",
              "(assets + 1) / (supply + 1): an empty pool starts at one share per unit."
            ],
            "type": "u64"
          },
          {
            "name": "supply",
            "type": "u64"
          },
          {
            "name": "depositAssets",
            "type": "u64"
          },
          {
            "name": "depositShares",
            "type": "u64"
          },
          {
            "name": "redeemShares",
            "type": "u64"
          },
          {
            "name": "redeemAssets",
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
            "name": "lowestLower",
            "docs": [
              "The strikes sold, bounding the price it can settle at."
            ],
            "type": "u64"
          },
          {
            "name": "highestUpper",
            "type": "u64"
          },
          {
            "name": "locked",
            "docs": [
              "Maximum payouts of its positions not yet paid out."
            ],
            "type": "u64"
          },
          {
            "name": "sold",
            "type": "u32"
          },
          {
            "name": "paid",
            "type": "u32"
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
      "name": "sizer",
      "docs": [
        "Someone the holder lets re-size their standing order before each close, as",
        "a lending position's risk changes, within bounds the holder set. The order's",
        "premium cap and allowance still bound what any renewal spends."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "sizer",
            "type": "pubkey"
          },
          {
            "name": "maxShares",
            "docs": [
              "The most shares the sizer may set."
            ],
            "type": "u64"
          },
          {
            "name": "minStartBps",
            "docs": [
              "The sizer's start and depth stay within these, in bps below the price."
            ],
            "type": "u16"
          },
          {
            "name": "maxDepthBps",
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "sizerBounds",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "sizer",
            "type": "pubkey"
          },
          {
            "name": "maxShares",
            "type": "u64"
          },
          {
            "name": "minStartBps",
            "type": "u16"
          },
          {
            "name": "maxDepthBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "sizerRemoved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "sizerSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "sizer",
            "type": "pubkey"
          },
          {
            "name": "maxShares",
            "type": "u64"
          },
          {
            "name": "minStartBps",
            "type": "u16"
          },
          {
            "name": "maxDepthBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "vault",
      "docs": [
        "An underwriters' pool selling protection in one collateral mint. Its token",
        "account holds the pool, premiums, queued deposits and redemptions owed.",
        "",
        "Deposits and redemptions are requests filled at `roll`, which ends a round",
        "once everything it sold is paid out: nothing is at risk then, so the pool's",
        "value is exact and nobody joins or leaves at a stale price."
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
            "name": "shareMint",
            "docs": [
              "The pool's shares (Token-2022, minted by the vault) and the vault's own",
              "account of them: queued redemptions wait there, filled deposits too."
            ],
            "type": "pubkey"
          },
          {
            "name": "shareEscrow",
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
            "name": "params",
            "type": {
              "defined": {
                "name": "params"
              }
            }
          },
          {
            "name": "nextParams",
            "type": {
              "defined": {
                "name": "params"
              }
            }
          },
          {
            "name": "paramsQueued",
            "type": "bool"
          },
          {
            "name": "round",
            "docs": [
              "The round in progress, its opening (0 until its first sale) and the",
              "pool's assets at the roll that began it, which its risk limits use."
            ],
            "type": "u64"
          },
          {
            "name": "roundOpenTs",
            "type": "i64"
          },
          {
            "name": "roundNav",
            "type": "u64"
          },
          {
            "name": "roundUnpaid",
            "docs": [
              "Positions the round sold that aren't paid out yet. A position is paid",
              "only once its series settles or voids, so zero means the round is over."
            ],
            "type": "u32"
          },
          {
            "name": "positionsSold",
            "type": "u64"
          },
          {
            "name": "locked",
            "docs": [
              "The most the open positions could still pay."
            ],
            "type": "u64"
          },
          {
            "name": "tipsOwed",
            "docs": [
              "Keepers' tips on positions not yet paid out."
            ],
            "type": "u64"
          },
          {
            "name": "pendingDepositAssets",
            "type": "u64"
          },
          {
            "name": "pendingRedeemShares",
            "type": "u64"
          },
          {
            "name": "reservedAssets",
            "docs": [
              "Filled redemptions not yet claimed."
            ],
            "type": "u64"
          },
          {
            "name": "artUri",
            "docs": [
              "Where a position NFT's image is served: this plus the position's address."
            ],
            "type": "string"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "tokenBump",
            "type": "u8"
          },
          {
            "name": "shareMintBump",
            "type": "u8"
          },
          {
            "name": "shareEscrowBump",
            "type": "u8"
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
