/**
 * Wallet-side transport for a Cashu mint reached over Nostr relays (`nostr://<npub>`).
 *
 * Implements Maxplayer's mint wire protocol (see Maxplayer
 * `crates/maxplayer-core/src/mint_wire.rs`, protocol version 1 — Maxplayer-specific,
 * not a NUT):
 *
 * - **Request**: kind 23410, tag `["p", <mint hex>]`, NIP-44 v2 content encrypted to the
 *   mint key, signed by a fresh throwaway client key. Plaintext:
 *   `{"v":1,"id":<uuid>,"op":<op>,"body":<NUT JSON>,"exp":<unix>}`.
 * - **Response**: kind 23411, tags `["p", <client hex>]` and `["e", <request event id>]`,
 *   NIP-44 v2 to the client, signed by the mint key. Plaintext:
 *   `{"v":1,"id":…,"ok":<NUT JSON>}` or `{"v":1,"id":…,"err":{"code":…,"detail":…}}`.
 * - Lost replies: re-publish the IDENTICAL signed event (same id) every
 *   RESEND_EVERY until WINDOW elapses, then fail ambiguously (Timeout). The mint replays
 *   the original reply for a repeated request id.
 * - Relays: caller-supplied plus FALLBACK_RELAYS. Ephemeral kinds are not stored.
 *
 * Exposed as a cashu-ts `RequestFn` (`customRequest`): maps the HTTP endpoint cashu-ts
 * would call onto a wire op, throws `MintOperationError` for wire errors so the wallet's
 * NUT error-code branching engages exactly as it would over HTTPS.
 */

import {
  MintOperationError,
  type RequestArgs,
} from "@cashu/cashu-ts";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  nip19,
  verifyEvent,
  type Event as NostrEvent,
  type EventTemplate,
} from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils";
import { SimplePool } from "nostr-tools";

/** Nostr event kind of a wallet → mint request (ephemeral range). */
export const REQUEST_KIND = 23410;
/** Nostr event kind of a mint → wallet response (ephemeral range). */
export const RESPONSE_KIND = 23411;
/** Envelope version carried in every request/response plaintext (`"v"`). */
export const PROTOCOL_VERSION = 1;
/** Total time one request may wait for a reply, re-sends included. */
export const WINDOW_MS = 30_000;
/** Interval between identical re-sends while no valid reply has arrived. */
export const RESEND_EVERY_MS = 5_000;
/** Extra room past WINDOW for relay teardown before we hand back a timeout. */
const OUTER_MARGIN_MS = 10_000;
/** Public relays used IN ADDITION to any caller-supplied ones (spec decision 15). */
export const FALLBACK_RELAYS = [
  "wss://relay.ditto.pub",
  "wss://nostr-pub.wellorder.net",
];

/** URL scheme of a Nostr-transported mint. */
export const NOSTR_MINT_SCHEME = "nostr://";

/**
 * True when `url` uses the `nostr://` scheme (case-insensitive). A `nostr://` URL is
 * never handed to an HTTP client, well-formed or not.
 */
export function isNostrScheme(url: string): boolean {
  return (
    url.length >= NOSTR_MINT_SCHEME.length &&
    url.slice(0, NOSTR_MINT_SCHEME.length).toLowerCase() === NOSTR_MINT_SCHEME
  );
}

/**
 * The x-only public key hex of a well-formed `nostr://<npub>` mint URL, else null.
 * Well-formed means: lowercase `nostr://` scheme, exactly one lowercase bech32
 * `npub1…` (valid checksum, 32-byte payload), and nothing else except optional
 * trailing `/`.
 */
export function nostrMintNpubToHex(url: string): string | null {
  if (!isNostrScheme(url)) return null;
  const npub = url.slice(NOSTR_MINT_SCHEME.length).replace(/\/+$/, "");
  if (!/^[a-z0-9]+$/.test(npub) || !npub.startsWith("npub1")) return null;
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type !== "npub") return null;
    return decoded.data as string;
  } catch {
    return null;
  }
}

/** Whether `url` is a well-formed `nostr://<npub>` mint URL. */
export function isNostrMintUrl(url: string): boolean {
  return nostrMintNpubToHex(url) !== null;
}

/** One wire operation per cashu-ts endpoint that reaches the mint. */
const ENDPOINT_TO_OP: Array<{
  pattern: RegExp;
  op: string;
  body: (m: RegExpMatchArray) => unknown;
}> = [
  { pattern: /^\/v1\/info$/, op: "info", body: () => null },
  { pattern: /^\/v1\/keys$/, op: "keys", body: () => null },
  {
    pattern: /^\/v1\/keys\/([^/]+)$/,
    op: "keyset",
    body: (m) => ({ id: decodeURIComponent(m[1]) }),
  },
  { pattern: /^\/v1\/keysets$/, op: "keysets", body: () => null },
  { pattern: /^\/v1\/swap$/, op: "swap", body: () => null }, // body injected by caller
  { pattern: /^\/v1\/checkstate$/, op: "checkstate", body: () => null },
  { pattern: /^\/v1\/restore$/, op: "restore", body: () => null },
  {
    pattern: /^\/v1\/mint\/quote\/([^/]+)\/check$/,
    op: "mint_quote_check_batch",
    body: (m) => ({ method: m[1] }), // request injected by caller
  },
  {
    pattern: /^\/v1\/mint\/quote\/([^/]+)$/,
    op: "mint_quote",
    body: (m) => ({ method: m[1] }), // request injected by caller
  },
  {
    pattern: /^\/v1\/mint\/quote\/([^/]+)\/([^/]+)$/,
    op: "mint_quote_status",
    body: (m) => ({ method: m[1], quote: decodeURIComponent(m[2]) }),
  },
  {
    pattern: /^\/v1\/mint\/([^/]+)\/batch$/,
    op: "mint_batch",
    body: (m) => ({ method: m[1] }),
  },
  {
    pattern: /^\/v1\/mint\/([^/]+)$/,
    op: "mint",
    body: (m) => ({ method: m[1] }), // request injected by caller
  },
  {
    pattern: /^\/v1\/melt\/quote\/([^/]+)$/,
    op: "melt_quote",
    body: (m) => ({ method: m[1] }), // request injected by caller
  },
  {
    pattern: /^\/v1\/melt\/quote\/([^/]+)\/([^/]+)$/,
    op: "melt_quote_status",
    body: (m) => ({ method: m[1], quote: decodeURIComponent(m[2]) }),
  },
  {
    pattern: /^\/v1\/melt\/([^/]+)$/,
    op: "melt",
    body: (m) => ({ method: m[1] }), // request injected by caller
  },
];

/**
 * Endpoints whose entire `requestBody` IS the NUT op body (POSTs) versus those where
 * the body carries `{"method", "request"}` wrapping. For wrapped POSTs the wire body is
 * `{...httpBody}` and we add the `request` field from the POST's `request` key.
 */
function buildOpBody(
  op: string,
  match: RegExpMatchArray,
  requestBody?: Record<string, unknown>
): unknown {
  switch (op) {
    case "info":
    case "keys":
    case "keysets":
      return null;
    case "keyset":
      return { id: decodeURIComponent(match[1]) };
    case "swap":
    case "checkstate":
    case "restore":
      return requestBody ?? null;
    case "mint_quote":
    case "melt_quote":
    case "mint_quote_check_batch":
    case "mint_batch":
    case "mint":
    case "melt":
      // cashu-ts POSTs the method's request object; the wire body wraps it.
      return { method: match[1], request: requestBody ?? null };
    case "mint_quote_status":
    case "melt_quote_status":
      return {
        method: match[1],
        quote: decodeURIComponent(match[2]),
      };
    default:
      return requestBody ?? null;
  }
}

/** Extract the endpoint path from the cashu-ts RequestArgs endpoint (absolute URL). */
function endpointPath(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return url.pathname;
  } catch {
    // Already a path.
    return endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  }
}

/**
 * Thrown when the wire round-trip itself fails (no relay, no reply in window). Ambiguous,
 * mirroring a network-level HTTP failure — cashu-ts treats these as retriable/cached.
 */
export class NostrMintTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NostrMintTimeoutError";
  }
}

/** A wire error response, mapped to the HTTP status the same failure would produce. */
function throwWireError(code: number | string, detail: string): never {
  if (typeof code === "number") {
    // NUT error code: same shape the mint would return over HTTPS.
    throw new MintOperationError(code, detail || "mint error");
  }
  // MintOperationError takes (nutCode, detail); transport codes carry no NUT code, so
  // encode the HTTP-ish status in the detail and mark ambiguous vs definitive there.
  switch (code) {
    case "unsupported":
      throw new MintOperationError(0, `404 unsupported: ${detail}`);
    case "rate_limited":
      throw new MintOperationError(0, `429 rate limited: ${detail}`);
    case "bad_request":
      throw new MintOperationError(0, `400 bad request: ${detail}`);
    case "expired":
      throw new MintOperationError(0, `400 expired: ${detail}`);
    default:
      // `internal` and unknown names are ambiguous: the mint may have committed.
      throw new MintOperationError(0, detail || "internal error");
  }
}

/**
 * Validate a reply event against the protocol rules (mirror of Maxplayer's
 * `NostrMintConnector::accept`): right kind, from the mint, answering our request
 * event, validly signed, decryptable to us, correct version + request id.
 * Returns the parsed plaintext or null if the event must be ignored.
 */
function acceptReply(
  reply: NostrEvent,
  mintPk: string,
  clientSk: Uint8Array,
  clientPk: string,
  requestEventId: string,
  requestId: string
): { ok?: unknown; err?: { code: number | string; detail: string } } | null {
  if (reply.kind !== RESPONSE_KIND || reply.pubkey !== mintPk) return null;
  const eTag = reply.tags.find((t) => t[0] === "e");
  if (!eTag || eTag[1] !== requestEventId) return null;
  let plain: string;
  try {
    if (!verifyEvent(reply)) return null;
    const conversationKey = nip44.v2.utils.getConversationKey(
      bytesToHex(clientSk),
      mintPk
    );
    plain = nip44.v2.decrypt(reply.content, conversationKey);
  } catch {
    return null;
  }
  void clientPk;
  let parsed: {
    v?: number;
    id?: string;
    ok?: unknown;
    err?: { code: number | string; detail?: string };
  };
  try {
    parsed = JSON.parse(plain);
  } catch {
    return null;
  }
  if (parsed.v !== PROTOCOL_VERSION || parsed.id !== requestId) return null;
  if ("ok" in parsed) return { ok: parsed.ok };
  if ("err" in parsed && parsed.err) {
    return { err: { code: parsed.err.code, detail: parsed.err.detail ?? "" } };
  }
  return null;
}

function randomId(): string {
  return crypto.randomUUID();
}

/**
 * Build and sign the request event once; every re-send republishes the IDENTICAL event.
 */
function buildRequestEvent(
  mintPk: string,
  op: string,
  body: unknown,
  nowUnix: number
): { event: NostrEvent; requestId: string; clientSk: Uint8Array } {
  const clientSk = generateSecretKey();
  const requestId = randomId();
  const plaintext = JSON.stringify({
    v: PROTOCOL_VERSION,
    id: requestId,
    op,
    body,
    exp: nowUnix + Math.ceil((WINDOW_MS + OUTER_MARGIN_MS) / 1000),
  });
  const content = nip44.v2.encrypt(
    plaintext,
    nip44.v2.utils.getConversationKey(bytesToHex(clientSk), mintPk)
  );
  const template: EventTemplate = {
    kind: REQUEST_KIND,
    created_at: nowUnix,
    tags: [["p", mintPk]],
    content,
  };
  const event = finalizeEvent(template, clientSk);
  return { event, requestId, clientSk };
}

export interface NostrMintTransportOptions {
  /** Extra relays to publish/subscribe on, ahead of the fallbacks. */
  relays?: string[];
  /** Test seam: override the pool. */
  pool?: SimplePool;
}

/**
 * The core wire round-trip: build → subscribe → publish → await validated reply.
 * Re-sends the identical event every RESEND_EVERY_MS until WINDOW_MS.
 */
async function callWire(
  mintPk: string,
  op: string,
  body: unknown,
  relays: string[],
  pool: SimplePool
): Promise<unknown> {
  const startedAt = Math.floor(Date.now() / 1000);
  const { event, requestId, clientSk } = buildRequestEvent(
    mintPk,
    op,
    body,
    startedAt
  );
  const clientPk = getPublicKey(clientSk);

  // Subscribe BEFORE publishing so a fast reply isn't missed. Replies are pushed into
  // a queue by the onevent callback; the loop below drains it between re-sends.
  const replies: NostrEvent[] = [];
  let notify: (() => void) | null = null;
  const sub = pool.subscribeMany(
    relays,
    [
      {
        kinds: [RESPONSE_KIND],
        authors: [mintPk],
        "#p": [clientPk],
        since: startedAt - 10,
      },
    ],
    {
      id: `maxplayer-mint-${requestId}`,
      onevent: (e: NostrEvent) => {
        replies.push(e);
        notify?.();
      },
    }
  );

  const deadline = Date.now() + WINDOW_MS;
  let nextSend = 0;
  try {
    while (Date.now() < deadline) {
      if (Date.now() >= nextSend) {
        // A publish error is not a result; keep waiting and re-send.
        const publishes: Array<Promise<string>> = pool.publish(relays, event);
        publishes.forEach((p) => p.catch(() => undefined));
        nextSend = Date.now() + RESEND_EVERY_MS;
      }
      // Wait for the next reply, the next re-send tick, or the deadline.
      const waitMs = Math.max(1, Math.min(nextSend, deadline) - Date.now());
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, waitMs);
        function done() {
          clearTimeout(timer);
          notify = null;
          resolve();
        }
        notify = done;
      });
      while (replies.length > 0) {
        const reply = replies.shift() as NostrEvent;
        const outcome = acceptReply(
          reply,
          mintPk,
          clientSk,
          clientPk,
          event.id,
          requestId
        );
        if (outcome) {
          if (outcome.err) throwWireError(outcome.err.code, outcome.err.detail);
          return outcome.ok;
        }
      }
    }
    throw new NostrMintTimeoutError(
      `no mint reply within ${WINDOW_MS / 1000}s (op: ${op})`
    );
  } finally {
    sub.close();
  }
}

/**
 * Build a cashu-ts `RequestFn` that routes every mint API call over the Maxplayer
 * nostr wire protocol instead of HTTP. Pass this as `customRequest` to a `Mint`
 * constructed with a placeholder https URL (cashu-ts refuses `nostr://` scheme URLs;
 * the placeholder never touches the network because this function replaces fetch).
 */
export function makeNostrMintRequestFn(
  mintUrl: string,
  options: NostrMintTransportOptions = {}
) {
  const mintPk = nostrMintNpubToHex(mintUrl);
  if (!mintPk) {
    throw new Error(`not a nostr:// mint URL: ${mintUrl}`);
  }
  const relays = [...new Set([...(options.relays ?? []), ...FALLBACK_RELAYS])];
  const pool = options.pool ?? new SimplePool();

  return async function nostrMintRequest<T = unknown>(
    args: RequestArgs
  ): Promise<T> {
    const path = endpointPath(args.endpoint);
    let matched: { op: string; match: RegExpMatchArray } | null = null;
    for (const entry of ENDPOINT_TO_OP) {
      const match = path.match(entry.pattern);
      if (match) {
        matched = { op: entry.op, match };
        break;
      }
    }
    if (!matched) {
      throw new MintOperationError(0, `404 no wire op for endpoint ${path}`);
    }
    const body = buildOpBody(matched.op, matched.match, args.requestBody);
    const result = await callWire(mintPk, matched.op, body, relays, pool);
    return result as T;
  };
}
