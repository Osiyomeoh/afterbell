import { BaseSignerWalletAdapter, WalletNotConnectedError, WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { Keypair, Transaction, VersionedTransaction, type PublicKey } from "@solana/web3.js";

/**
 * A devnet wallet kept in this browser, so anyone can try Afterbell without
 * installing one. Test money only: its key sits in the browser's storage,
 * where anything that can read this site's storage can use it.
 */
export const TestWalletName = "Afterbell test wallet" as WalletName<"Afterbell test wallet">;

const STORAGE_KEY = "afterbell:test-wallet";

type KeyStore = Pick<Storage, "getItem" | "setItem">;

/** The wallet's keypair: the one this browser already has, or a new one, kept for next time. */
export function loadOrCreateKeypair(store: KeyStore): Keypair {
  const saved = store.getItem(STORAGE_KEY);
  if (saved) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved) as number[]));
    } catch {
      // Unreadable: start a new wallet rather than fail to connect.
    }
  }
  const keypair = Keypair.generate();
  store.setItem(STORAGE_KEY, JSON.stringify(Array.from(keypair.secretKey)));
  return keypair;
}

// The app's bell, in brass on ink.
const ICON =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="5" fill="#0b0d10"/><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" stroke="#d9a441" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 20.5a2 2 0 0 0 4 0" stroke="#d9a441" stroke-width="1.8" stroke-linecap="round"/></svg>',
  );

export class TestWalletAdapter extends BaseSignerWalletAdapter<"Afterbell test wallet"> {
  name = TestWalletName;
  url = "https://afterbell-nine.vercel.app";
  icon = ICON;
  readyState = typeof window === "undefined" ? WalletReadyState.Unsupported : WalletReadyState.Loadable;
  supportedTransactionVersions = new Set(["legacy", 0] as const);
  connecting = false;
  private keypair: Keypair | null = null;

  constructor(private readonly store: () => KeyStore = () => window.localStorage) {
    super();
  }

  get publicKey(): PublicKey | null {
    return this.keypair?.publicKey ?? null;
  }

  async connect(): Promise<void> {
    if (this.keypair) return;
    this.keypair = loadOrCreateKeypair(this.store());
    this.emit("connect", this.keypair.publicKey);
  }

  /** Forgets the key in memory only: connecting again brings back the same wallet and what it holds. */
  async disconnect(): Promise<void> {
    this.keypair = null;
    this.emit("disconnect");
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    if (!this.keypair) throw new WalletNotConnectedError();
    if (transaction instanceof VersionedTransaction) transaction.sign([this.keypair]);
    else transaction.partialSign(this.keypair);
    return transaction;
  }
}
