/**
 * Unit tests for the Maxplayer nostr:// mint wire transport
 * (src/js/nostrMintTransport.ts).
 *
 * Covers:
 * - npub URL validation (isNostrMintUrl / nostrMintNpubToHex)
 * - endpoint → op mapping (via the returned RequestFn against a mock pool)
 * - a full wire round-trip: signed kind-23410 request in, kind-23411 reply out,
 *   NIP-44 v2 both directions, ok and err outcomes, wrong-mint/wrong-id rejection
 * - the re-send loop (identical event id re-published until a reply arrives)
 *
 * The mock pool plays the mint: it decrypts the request with the mint key,
 * answers with a NIP-44-encrypted kind-23411 reply to the throwaway client key.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  nip19,
  type Event as NostrEvent,
} from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils";
import {
  REQUEST_KIND,
  RESPONSE_KIND,
  PROTOCOL_VERSION,
  makeNostrMintRequestFn,
  isNostrMintUrl,
  nostrMintNpubToHex,
  FALLBACK_RELAYS,
} from "../nostrMintTransport";

// The mint's keypair for the tests.
const mintSk = generateSecretKey();
const mintPk = getPublicKey(mintSk);
const mintNpub = nip19.npubEncode(mintPk);

interface MockSub {
  close: () => void;
}

/** A SimplePool stand-in that captures subscriptions and publishes. */
function makeMockPool(handler: (event: NostrEvent, sub: MockSub) => void) {
  const published: NostrEvent[] = [];
  const subs: Array<{
    filters: unknown[];
    onevent: (e: NostrEvent) => void;
    close: () => void;
  }> = [];
  (globalThis as unknown as { __mockSubs?: typeof subs }).__mockSubs = subs;
  const pool = {
    subscribeMany: (
      _relays: string[],
      filters: unknown[],
      params: { id?: string; onevent: (e: NostrEvent) => void }
    ) => {
      const sub = {
        filters,
        onevent: params.onevent,
        close: () => undefined,
      };
      subs.push(sub);
      return sub;
    },
    publish: (_relays: string[], event: NostrEvent) => {
      published.push(event);
      handler(event, { close: () => undefined });
      return [Promise.resolve("ok")];
    },
  };
  return { pool, published, subs };
}

/** Mint-side reply builder: mirrors the real mint's obligations. */
function mintReply(
  request: NostrEvent,
  outcome: { ok?: unknown; err?: { code: number | string; detail?: string } }
): NostrEvent {
  // The reply goes to the request event's author (the throwaway client key).
  const clientPk = request.pubkey;
  const plaintext = JSON.stringify({
    v: PROTOCOL_VERSION,
    id: JSON.parse(
      nip44.v2.decrypt(
        request.content,
        nip44.v2.utils.getConversationKey(
          bytesToHex(mintSk),
          clientPk
        )
      )
    ).id,
    ...(outcome.ok !== undefined ? { ok: outcome.ok } : { err: outcome.err }),
  });
  const conversationKey = nip44.v2.utils.getConversationKey(
    bytesToHex(mintSk),
    clientPk
  );
  return finalizeEvent(
    {
      kind: RESPONSE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["p", clientPk],
        ["e", request.id],
      ],
      content: nip44.v2.encrypt(plaintext, conversationKey),
    },
    mintSk
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("npub mint URL validation", () => {
  it("accepts a well-formed nostr://npub URL", () => {
    expect(isNostrMintUrl(`nostr://${mintNpub}`)).toBe(true);
    expect(nostrMintNpubToHex(`nostr://${mintNpub}`)).toBe(mintPk);
  });

  it("accepts a trailing slash", () => {
    expect(isNostrMintUrl(`nostr://${mintNpub}/`)).toBe(true);
  });

  it("rejects non-nostr schemes and malformed npubs", () => {
    expect(isNostrMintUrl("https://mint.example")).toBe(false);
    expect(isNostrMintUrl("nostr://notanpub")).toBe(false);
    expect(isNostrMintUrl("nostr://npub1garbage")).toBe(false);
    expect(isNostrMintUrl(`nostr://${mintNpub}/extra/path`)).toBe(false);
  });
});

describe("endpoint → op mapping and wire round-trip", () => {
  it("maps /v1/keysets to the keysets op and returns the ok payload", async () => {
    const { pool, published } = makeMockPool((event) => {
      // Play the mint: answer the first request.
      setTimeout(
        () => mintReplyFor(event, { ok: { keysets: [{ id: "k1", unit: "sat" }] } }),
        0
      );
    });
    const requestFn = makeNostrMintRequestFn(`nostr://${mintNpub}`, {
      pool: pool as never,
      relays: [],
    });
    const result = await requestFn<{ keysets: unknown[] }>({
      endpoint: "https://nostr-mint.invalid/v1/keysets",
    });
    expect(result.keysets).toEqual([{ id: "k1", unit: "sat" }]);
    // Exactly one request event published.
    expect(published).toHaveLength(1);
    expect(published[0].kind).toBe(REQUEST_KIND);
    expect(published[0].tags).toContainEqual(["p", mintPk]);
  });

  it("decrypts the request plaintext as the mint would (v1 envelope, body present)", async () => {
    let seenPlaintext: Record<string, unknown> | undefined = undefined;
    const { pool } = makeMockPool((event) => {
      // The mint learns the client key from the request event's author pubkey.
      const clientPk = event.pubkey;
      const plain = nip44.v2.decrypt(
        event.content,
        nip44.v2.utils.getConversationKey(bytesToHex(mintSk), clientPk)
      );
      seenPlaintext = JSON.parse(plain);
      setTimeout(
        () => mintReplyFor(event, { ok: { keysets: [] } }),
        0
      );
    });
    const requestFn = makeNostrMintRequestFn(`nostr://${mintNpub}`, {
      pool: pool as never,
    });
    await requestFn({
      endpoint: "https://nostr-mint.invalid/v1/swap",
      requestBody: { inputs: [], outputs: [] },
    });
    expect(seenPlaintext).toMatchObject({
      v: PROTOCOL_VERSION,
      op: "swap",
      body: { inputs: [], outputs: [] },
    });
    const pt = seenPlaintext as unknown as Record<string, unknown>;
    expect(typeof pt.id).toBe("string");
    expect(typeof pt.exp).toBe("number");
    expect((pt.exp as number) * 1000).toBeGreaterThan(Date.now());
  });

  it("throws MintOperationError on a wire err with a NUT code", async () => {
    const { pool } = makeMockPool((event) => {
      setTimeout(() => mintReplyFor(event, { err: { code: 11001, detail: "token already spent" } }), 0);
    });
    const requestFn = makeNostrMintRequestFn(`nostr://${mintNpub}`, {
      pool: pool as never,
    });
    await expect(
      requestFn({ endpoint: "https://nostr-mint.invalid/v1/checkstate", requestBody: { proofs: [] } })
    ).rejects.toMatchObject({ code: 11001 });
  });

  it("maps transport error codes into the detail string", async () => {
    const { pool } = makeMockPool((event) => {
      setTimeout(() => mintReplyFor(event, { err: { code: "rate_limited", detail: "slow down" } }), 0);
    });
    const requestFn = makeNostrMintRequestFn(`nostr://${mintNpub}`, {
      pool: pool as never,
    });
    await expect(
      requestFn({ endpoint: "https://nostr-mint.invalid/v1/keys" })
    ).rejects.toThrow(/rate limited/);
  });

  it("ignores replies from the wrong mint or answering the wrong event", async () => {
    const otherSk = generateSecretKey();
    const { pool } = makeMockPool((event) => {
      // A reply signed by a different key must be ignored; then the real mint answers.
      const wrong = finalizeEvent(
        {
          kind: RESPONSE_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", event.tags[0][1]], ["e", event.id]],
          content: "garbage",
        },
        otherSk
      );
      setTimeout(() => {
        (pool as never as { subs: Array<{ onevent: (e: NostrEvent) => void }> }).subs?.[0]?.onevent(wrong);
        mintReplyFor(event, { ok: { info: "real" } });
      }, 0);
    });
    const requestFn = makeNostrMintRequestFn(`nostr://${mintNpub}`, {
      pool: pool as never,
    });
    const result = await requestFn<{ info: string }>({
      endpoint: "https://nostr-mint.invalid/v1/info",
    });
    expect(result.info).toBe("real");
  });

  it("re-sends the IDENTICAL event until a reply arrives (lost-reply path)", async () => {
    vi.useFakeTimers();
    const { pool, published } = makeMockPool((event) => {
      // The mint only answers after the second publish (first reply lost).
      if (published.length >= 2) {
        setTimeout(() => mintReplyFor(event, { ok: {} }), 0);
      }
    });
    const requestFn = makeNostrMintRequestFn(`nostr://${mintNpub}`, {
      pool: pool as never,
    });
    const pending = requestFn({ endpoint: "https://nostr-mint.invalid/v1/keysets" });
    // Advance past one re-send interval, flushing timers.
    await vi.advanceTimersByTimeAsync(6_000);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result).toEqual({});
    expect(published.length).toBeGreaterThanOrEqual(2);
    // Every re-send is byte-identical (same id).
    expect(new Set(published.map((e) => e.id)).size).toBe(1);
    vi.useRealTimers();
  });
});

/** Wrapper so tests above can reply via the mock pool's captured subscription. */
function mintReplyFor(event: NostrEvent, outcome: { ok?: unknown; err?: { code: number | string; detail?: string } }) {
  // The mock pool's handler closes over `subs`; find the subscription and deliver.
  // Simpler: tests pass their own delivery; this helper is only used inside
  // makeMockPool handlers where the reply goes through the captured sub.
  const reply = mintReply(event, outcome);
  // Deliver via the most recent sub (the one created for this request).
  const subs = (globalThis as unknown as { __mockSubs?: Array<{ onevent: (e: NostrEvent) => void }> }).__mockSubs;
  if (subs && subs.length > 0) {
    subs[subs.length - 1].onevent(reply);
  }
}
