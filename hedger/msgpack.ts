/**
 * MessagePack, only as much as Hyperliquid's actions need: maps, arrays,
 * strings, integers, booleans and nil. Encoded as Python's msgpack.packb does
 * by default (the smallest integer form, str8 for strings of 32 to 255 bytes),
 * because an action is signed over these bytes. Map keys keep the object's
 * order, as a Python dict does. Floats are refused: Hyperliquid sends prices
 * and sizes as strings.
 */
export type Packable = null | boolean | number | bigint | string | readonly Packable[] | { readonly [key: string]: Packable };

const utf8 = new TextEncoder();

export function pack(value: Packable): Uint8Array {
  const out: number[] = [];
  write(value, out);
  return Uint8Array.from(out);
}

function bytes(out: number[], n: bigint, size: number) {
  for (let i = size - 1; i >= 0; i--) out.push(Number((n >> BigInt(8 * i)) & 0xffn));
}

function header(out: number[], n: number, fix: { base: number; max: number } | null, forms: [tag: number, size: number][]) {
  if (fix && n <= fix.max) return out.push(fix.base | n);
  for (const [tag, size] of forms) {
    if (n < 2 ** (8 * size)) {
      out.push(tag);
      return bytes(out, BigInt(n), size);
    }
  }
  throw new Error(`too long for msgpack: ${n}`);
}

function writeInt(n: bigint, out: number[]) {
  if (n >= 0n) {
    if (n < 128n) return out.push(Number(n));
    for (const [tag, size] of [[0xcc, 1], [0xcd, 2], [0xce, 4], [0xcf, 8]] as const) {
      if (n < 1n << BigInt(8 * size)) {
        out.push(tag);
        return bytes(out, n, size);
      }
    }
  } else {
    if (n >= -32n) return out.push(Number(n & 0xffn));
    for (const [tag, size] of [[0xd0, 1], [0xd1, 2], [0xd2, 4], [0xd3, 8]] as const) {
      if (n >= -(1n << BigInt(8 * size - 1))) {
        out.push(tag);
        return bytes(out, BigInt.asUintN(8 * size, n), size);
      }
    }
  }
  throw new Error(`integer out of msgpack's range: ${n}`);
}

function write(v: Packable, out: number[]): void {
  if (v === null) {
    out.push(0xc0);
  } else if (typeof v === "boolean") {
    out.push(v ? 0xc3 : 0xc2);
  } else if (typeof v === "bigint") {
    writeInt(v, out);
  } else if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`msgpack here takes whole numbers only, not ${v}`);
    writeInt(BigInt(v), out);
  } else if (typeof v === "string") {
    const b = utf8.encode(v);
    header(out, b.length, { base: 0xa0, max: 31 }, [[0xd9, 1], [0xda, 2], [0xdb, 4]]);
    for (const x of b) out.push(x);
  } else if (Array.isArray(v)) {
    header(out, v.length, { base: 0x90, max: 15 }, [[0xdc, 2], [0xdd, 4]]);
    for (const x of v) write(x, out);
  } else if (typeof v === "object") {
    const entries = Object.entries(v);
    for (const [k, x] of entries) if (x === undefined) throw new Error(`"${k}" is undefined; leave it out instead`);
    header(out, entries.length, { base: 0x80, max: 15 }, [[0xde, 2], [0xdf, 4]]);
    for (const [k, x] of entries) {
      write(k, out);
      write(x, out);
    }
  } else {
    throw new Error(`msgpack can't encode ${typeof v}`);
  }
}
