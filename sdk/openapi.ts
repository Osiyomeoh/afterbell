/**
 * Afterbell's public HTTP API as an OpenAPI 3.1 document, served at
 * /api/openapi.json. sdk/openapi.test.ts checks it lists every route the app
 * serves, with the methods each one answers, so the two can't drift apart.
 */
type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Schema, description = "OK") => ({ description, content: { "application/json": { schema } } });
const refused = { description: "Refused, not found or unavailable, with the reason", content: { "application/json": { schema: ref("Error") } } };
/** Solana Actions carry their errors as `message`, as the Actions spec has it. */
const actionRefused = { description: "Refused or failed, with the reason", content: { "application/json": { schema: ref("ActionError") } } };
const text = (description: string) => ({ description, content: { "text/plain": { schema: { type: "string" } } } });
const query = (name: string, description: string, required = false, schema: Schema = { type: "string" }) => ({ name, in: "query", required, description, schema });
const inPath = (name: string, description: string) => ({ name, in: "path", required: true, description, schema: { type: "string" } });
const num = (description?: string): Schema => ({ type: "number", ...(description && { description }) });
const str = (description?: string): Schema => ({ type: "string", ...(description && { description }) });
const obj = (properties: Record<string, Schema>, description?: string): Schema => ({ type: "object", properties, required: Object.keys(properties), ...(description && { description }) });
const nullable = (s: Schema): Schema => ({ oneOf: [s, { type: "null" }] });
const chain: Schema = { type: "string", enum: ["solana", "robinhood"] };
const seriesState: Schema = { type: "string", enum: ["open", "settled", "voided"] };
const owner = query("owner", "A Solana or EVM address", true);
const symbol = query("symbol", "A stock symbol, e.g. TSLA (default)");

const schemas: Record<string, Schema> = {
  Error: obj({ error: str() }),
  ActionError: obj({ message: str() }),
  Protection: obj(
    { shares: num("Shares covered, fractions allowed"), upper: num("Dollars: protection starts paying below this"), lower: num("Dollars: it pays the most at or below this") },
    "A put spread on one opening: it pays shares × (upper − open price), capped at shares × (upper − lower).",
  ),
  QuoteRequest: {
    allOf: [ref("Protection"), obj({ chain, symbol: str(), buyer: str("The wallet that will buy: the quote is signed for it alone") })],
  },
  PricedProtection: obj({
    symbol: str(),
    protection: ref("Protection"),
    openTs: num("Unix seconds of the 09:30 ET open it settles on"),
    expiry: num("Unix seconds after which the quote can't be used"),
    premium: num("Dollars"),
    expectedPayout: num(),
    maxPayout: num(),
    probabilityOfPayout: num(),
    model: obj({ source: { type: "string", enum: ["history", "lognormal"] }, sd: num(), openings: num() }),
    reference: obj({ price: num(), basis: str() }),
  }),
  SolanaQuote: obj({
    priced: ref("PricedProtection"),
    solana: obj({
      programId: str(),
      vault: str(),
      collateralMint: str(),
      quoter: str(),
      quote: { type: "object", description: "The quote's fields as strings: feedId and nonce in hex, the rest integers", additionalProperties: { type: "string" } },
      ed25519Data: str("Base64: the Ed25519 program's instruction data verifying the quoter's signature"),
    }),
  }),
  EvmQuote: obj({
    priced: ref("PricedProtection"),
    evm: obj({
      chainId: num(),
      vault: str(),
      testUsd: str(),
      positions: str(),
      quoter: str(),
      quote: { type: "object", description: "The EIP-712 Quote's fields as strings", additionalProperties: { type: "string" } },
      signature: str("The quoter's EIP-712 signature, for buyWithPermit"),
    }),
  }),
  Position: obj({
    address: str("A Solana position's address, or a Robinhood Chain position's number"),
    series: str(),
    symbol: str(),
    buyer: str("Whoever holds its NFT, who is paid"),
    openTs: num(),
    state: seriesState,
    shares: num(),
    upper: num(),
    lower: num(),
    premium: num(),
    maxPayout: num(),
    claimable: nullable(num("What it pays, or refunds if voided; null while open")),
    settlementPrice: nullable(num()),
  }),
  LedgerRow: obj({
    chain,
    series: str(),
    symbol: str(),
    openTs: num(),
    state: seriesState,
    price: nullable(num("The opening price it settled on")),
    priceTime: nullable(num()),
    settleTx: nullable(str()),
    sales: num(),
    premiums: num(),
    maxPayouts: num(),
    paid: num(),
    claims: num(),
  }),
  Vault: {
    type: "object",
    description: "A vault's collateral, locked maximum payouts, its underwriters' pool and every series",
    properties: { vault: str(), collateral: num(), locked: num(), openPositions: num(), pool: { type: "object" }, series: { type: "array", items: { type: "object" } } },
  },
  Status: obj({
    now: num(),
    checks: { type: "array", items: obj({ name: str(), state: { type: "string", enum: ["ok", "warn", "down"] }, detail: str() }) },
  }),
};

const paths = {
  "/api/market": {
    get: {
      summary: "A stock, its prices and the next open",
      description: "The close and live price, whether the exchange is open, the next 09:30 ET open protection settles on, the openings history the model prices from, and which chains sell the stock.",
      parameters: [symbol],
      responses: { 200: json({ type: "object" }), 404: refused, 503: refused },
    },
  },
  "/api/board": { get: { summary: "Standard protection priced for every stock", description: "2% to 10% below the price, for one share.", responses: { 200: json(obj({ rows: { type: "array", items: { type: "object" } } })), 503: refused } } },
  "/api/quote": {
    post: {
      summary: "A signed quote for one buyer",
      description:
        "Priced by the service from its own market data and signed for the buyer, who submits it within about a minute: on Solana with the Ed25519 check and `buy`, on Robinhood Chain with `buyWithPermit`. The SDK's solanaPurchase and robinhoodPurchase build those.",
      requestBody: { required: true, content: { "application/json": { schema: ref("QuoteRequest") } } },
      responses: { 200: json({ oneOf: [ref("SolanaQuote"), ref("EvmQuote")] }), 400: refused, 409: refused, 422: refused, 503: refused },
    },
  },
  "/api/positions": {
    get: { summary: "A wallet's protection", parameters: [owner], responses: { 200: json(obj({ positions: { type: "array", items: ref("Position") } })), 400: refused, 503: refused } },
  },
  "/api/vault": {
    get: {
      summary: "A vault, its pool and every series",
      parameters: [query("chain", "robinhood for the Robinhood Chain vault; Solana's otherwise")],
      responses: { 200: json(ref("Vault")), 404: refused, 503: refused },
    },
  },
  "/api/record": {
    get: { summary: "Every series either vault has sold, and how it settled", responses: { 200: json(obj({ series: { type: "array", items: ref("LedgerRow") } })), 503: refused } },
  },
  "/api/holdings": { get: { summary: "A Solana wallet's TSLAx and TSLAon on mainnet", parameters: [owner], responses: { 200: json({ type: "object" }), 400: refused, 503: refused } } },
  "/api/gap-report": {
    get: {
      summary: "What the closed hours could cost a book, and what protecting it costs",
      description: "Each stock's openings, its worst at today's price, and tonight's protection for the whole book.",
      parameters: [
        query("book", 'Stocks and sizes, e.g. "TSLA:100,NVDA:$25000"'),
        query("owner", "A Solana wallet, to use its TSLAx and TSLAon instead"),
        query("start", "Percent below the price protection starts (default 2)", false, { type: "number" }),
        query("stop", "Percent below the price it stops (default 10)", false, { type: "number" }),
      ],
      responses: { 200: json({ type: "object" }), 400: refused, 503: refused },
    },
  },
  "/api/overnight": { get: { summary: "The stock's price since the close, against its protection", parameters: [symbol], responses: { 200: json({ type: "object" }), 404: refused, 503: refused } } },
  "/api/hedge": { get: { summary: "The hedge on Hyperliquid: the short the open protection calls for, the short held, and its trades", responses: { 200: json({ type: "object" }), 503: refused } } },
  "/api/status": {
    get: {
      summary: "Whether each part of the service is running",
      description: "Each vault's keeper, the hedge, the quote keys and the faucet. Answers 503 when anything is down, with the same body.",
      responses: { 200: json(ref("Status")), 503: json(ref("Status"), "Something is down") },
    },
  },
  "/api/underwriter": { get: { summary: "A wallet's stake in a vault's underwriters' pool", parameters: [owner], responses: { 200: json({ type: "object" }), 400: refused, 404: refused, 503: refused } } },
  "/api/faucet": {
    post: {
      summary: "Devnet test money for a wallet",
      description: "Tops a Solana devnet wallet up to 1,000 TestUSD and a little SOL when it's short of them. TestUSD has no value.",
      requestBody: { required: true, content: { "application/json": { schema: obj({ owner: str() }) } } },
      responses: { 200: json({ type: "object" }), 400: refused, 404: refused, 500: refused, 503: refused },
    },
  },
  "/api/actions/protect": {
    get: { summary: "The Solana Action (Blink): what it offers", parameters: [symbol], responses: { 200: json({ type: "object" }), 404: actionRefused } },
    post: {
      summary: "The Solana Action (Blink): a purchase for the account to sign",
      parameters: [symbol, query("shares", 'Shares, or "held" for what the account holds')],
      requestBody: { required: true, content: { "application/json": { schema: obj({ account: str() }) } } },
      responses: { 200: json({ type: "object" }), 400: actionRefused, 422: actionRefused, 500: actionRefused },
    },
  },
  "/api/position-art/{id}": { get: { summary: "A Robinhood Chain position's NFT image (SVG)", parameters: [inPath("id", "The position's number")], responses: { 200: { description: "SVG" }, 400: text("Not a position number"), 404: text("No such position") } } },
  "/api/position-art/solana/{position}": {
    get: { summary: "A Solana position's NFT metadata", parameters: [inPath("position", "The position's address")], responses: { 200: json({ type: "object" }), 400: refused, 404: refused, 503: refused } },
  },
  "/api/position-art/solana/{position}/image": {
    get: { summary: "A Solana position's NFT image (SVG)", parameters: [inPath("position", "The position's address")], responses: { 200: { description: "SVG" }, 400: text("Not an address"), 404: text("No such position"), 503: text("Couldn't read it") } },
  },
  "/api/openapi.json": { get: { summary: "This document", responses: { 200: json({ type: "object" }) } } },
};

/** The document, with `serverUrl` as the one server it describes. */
export function openApiSpec(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Afterbell",
      version: "1.0.0",
      description:
        "Protection for tokenized stocks until the next opening bell, on Solana devnet and Robinhood Chain, with test money. Read-only routes need nothing; a purchase is a quote signed for one buyer, which that buyer's wallet submits. An MCP server for agents is at /mcp. TypeScript client: sdk/ in the repo.",
    },
    servers: [{ url: serverUrl }],
    paths,
    components: { schemas },
  };
}
