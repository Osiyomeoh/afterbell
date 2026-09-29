/**
 * Private balances on Helius's Solana Rings (devnet, alpha), through @heliuslabs/zolana: what the desk
 * needs and nothing more. A deposit moves public tokens into a private balance and shows everything; a
 * confidential transfer between private balances shows only who sent and who received, not the token
 * or the amount. Signing and sending follow Helius's own examples (helius-labs/zolana-examples).
 */
import {
  SigningKey,
  ShieldedAddress,
  ShieldedKeypair,
  Wallet,
  createZolanaClient,
  initializePoseidon,
  syncWallet,
  type Bytes32,
} from "@heliuslabs/zolana";
import { getSplAssetRegistryAddress, getSplAssetVaultAddress } from "@heliuslabs/zolana/addresses";
import { LocalKeys } from "@heliuslabs/zolana/client";
import { getCreateSplInterfaceInstructionAsync } from "@heliuslabs/zolana/instructions";
import { DepositAsset, decodeSplAssetRegistry, depositInstruction, transactInstruction } from "@heliuslabs/zolana/interface";
import { AssetRegistry, ConfidentialTransfer, LocalShieldedKeys, ProofInputUtxo } from "@heliuslabs/zolana/transaction";
import {
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendTransactionWithoutConfirmingFactory,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";

export type Client = Awaited<ReturnType<typeof createZolanaClient>>;

/** Helius's devnet indexer and prover, from its docs (helius.dev/docs/privacy/endpoints). */
const INDEXER_URL = "https://d2xah7tnhdhcom.cloudfront.net";
const PROVER_URL = "https://d21ni15goiip6l.cloudfront.net";
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** Connects to devnet: `rpc` is any devnet RPC, Helius's own or the public one. */
export async function connect(rpc: string): Promise<Client> {
  await initializePoseidon();
  return createZolanaClient({ solanaRpcUrl: rpc, indexerUrl: INDEXER_URL, proverUrl: PROVER_URL });
}

/** One party: its Solana signer and its private wallet, both from one Ed25519 seed. */
export type Party = { keypair: ShieldedKeypair; signer: TransactionSigner; solana: Address };

export function party(seed: Uint8Array): Party {
  const copy = Uint8Array.from(seed.slice(0, 32)) as Bytes32;
  try {
    const keypair = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(copy));
    const signer = keypair.toSolanaSigner();
    return { keypair, signer, solana: signer.address };
  } finally {
    copy.fill(0);
  }
}

/** A private address as hex, for the desk's book: public, but only the desk links it to a position. */
export const privateAddressHex = (p: Party) => Buffer.from(p.keypair.shieldedAddress().toBytes()).toString("hex");
export const privateAddressFromHex = (hex: string) => ShieldedAddress.fromBytes(Uint8Array.from(Buffer.from(hex, "hex")));

async function send(client: Client, payer: TransactionSigner, instructions: readonly Instruction[]): Promise<{ signature: Signature; slot: bigint }> {
  const { value: lifetime } = await client.solanaRpc.getLatestBlockhash().send();
  const signed = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 1 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      // The proofs are verified on-chain: Helius's examples ask for this much.
      (m) => setTransactionMessageConfig({ computeUnitLimit: 450_000, loadedAccountsDataSizeLimit: 64 * 1024 * 1024 }, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  assertIsTransactionWithBlockhashLifetime(signed);
  await sendTransactionWithoutConfirmingFactory({ rpc: client.solanaRpc })(signed, { commitment: "confirmed" });
  const signature = getSignatureFromTransaction(signed);
  return { signature, slot: await client.confirmTransaction(signature) };
}

/**
 * The registry that tells the SDK which asset id is `mint`, creating the mint's private interface (the
 * escrow that holds deposited tokens) first if nobody has. Anyone may create it; `payer` pays its rent.
 */
export async function assetsFor(client: Client, payer: Party, mint: Address): Promise<{ assets: AssetRegistry; created: Signature | null }> {
  let created: Signature | null = null;
  if (!(await client.getAccount(await getSplAssetVaultAddress(mint)))) {
    const ix = await getCreateSplInterfaceInstructionAsync({ authority: payer.signer, mint, tokenProgram: TOKEN_PROGRAM });
    created = (await send(client, payer.signer, [ix])).signature;
  }
  const account = await client.getAccount(await getSplAssetRegistryAddress(mint));
  if (!account) throw new Error("the mint has no private interface after creating one");
  const registry = decodeSplAssetRegistry(account.data);
  const assets = new AssetRegistry();
  assets.insert(registry.assetId, registry.mint);
  return { assets, created };
}

/** Moves `amount` of `mint` from `owner`'s public token account into its own private balance. Public: everything. */
export async function deposit(client: Client, owner: Party, mint: Address, tokenAccount: Address, amount: bigint): Promise<Signature> {
  const shielded = owner.keypair.shieldedAddress();
  const ix = await depositInstruction({
    tree: client.tree,
    depositor: owner.signer,
    deposits: [
      {
        asset: DepositAsset.spl({ mint, sourceTokenAccount: tokenAccount, tokenProgram: TOKEN_PROGRAM }),
        viewTag: shielded.confidentialViewTag(),
        recipientOwnerHash: shielded.ownerHash(),
        amount,
      },
    ],
  });
  return (await send(client, owner.signer, [ix])).signature;
}

/** `owner`'s private wallet, synced from the indexer: its balances and the transactions it can decrypt. */
export async function privateWallet(client: Client, owner: Party, assets: AssetRegistry): Promise<Wallet> {
  const wallet = new Wallet({ identity: owner.keypair.shieldedAddress(), registry: assets });
  await syncWallet({ wallet, keys: LocalShieldedKeys.fromKeypair(owner.keypair), client, config: { pageLimit: 50 } });
  return wallet;
}

/**
 * Sends `amount` of `mint` from `from`'s private balance to `to`'s, as one confidential transfer: the chain
 * shows the two parties, not the token or the amount. Spends its largest private outputs first; the
 * change comes back to `from`, privately.
 */
export async function payPrivately(client: Client, from: Party, to: ShieldedAddress, mint: Address, amount: bigint, assets: AssetRegistry): Promise<Signature> {
  const balance = (await privateWallet(client, from, assets)).balance(mint);
  const inputs = [];
  let total = 0n;
  for (const utxo of [...balance.utxos].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))) {
    if (total >= amount) break;
    inputs.push(utxo);
    total += utxo.amount;
  }
  if (total < amount) throw new Error(`the private balance holds ${balance.amount}, less than ${amount}`);

  const transfer = new ConfidentialTransfer(
    from.keypair.shieldedAddress(),
    inputs.map((u) => ProofInputUtxo.fromKeypair(u, from.keypair)),
    from.solana,
  );
  transfer.send(to, mint, amount);
  const data = await client.proveTransact(transfer.sign(from.keypair, assets), LocalKeys.fromKeypair(from.keypair, client.proofService));
  const ix = await transactInstruction({ payer: from.signer, inputTree: client.tree, outputTree: client.tree, data });
  return (await send(client, from.signer, [ix])).signature;
}
