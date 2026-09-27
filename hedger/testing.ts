/** For tests only: stand-ins for the networks the hedger reads. */
import { Connection, PublicKey, type GetProgramAccountsConfig } from "@solana/web3.js";
import bs58 from "bs58";

/** A cluster holding the given accounts, answering getProgramAccounts with its memcmp filters applied, as an RPC node does. */
export function fakeCluster(accounts: { owner: PublicKey; pubkey: PublicKey; data: Buffer }[]) {
  const matches = (data: Buffer, f: { offset: number; bytes: string }) => {
    const want = Buffer.from(bs58.decode(f.bytes));
    return data.subarray(f.offset, f.offset + want.length).equals(want);
  };
  return {
    commitment: "confirmed",
    getProgramAccounts: async (programId: PublicKey, config: GetProgramAccountsConfig) =>
      accounts
        .filter((a) => a.owner.equals(programId))
        .filter((a) => (config.filters ?? []).every((f) => ("memcmp" in f ? matches(a.data, f.memcmp) : a.data.length === f.dataSize)))
        .map((a) => ({ pubkey: a.pubkey, account: { data: a.data, owner: programId, lamports: 1, executable: false } })),
  } as unknown as Connection;
}
