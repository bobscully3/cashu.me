/**
 * Unit tests for the Maxplayer nostr:// mint wire transport
 * (src/js/nostrMintTransport.ts) with a mock WebSocket.
 *
 * Covers:
 * - npub URL validation (isNostrMintUrl / nostrMintNpubToHex)
 * - endpoint → op mapping and the full wire round-trip: signed kind-23410 request in,
 *   kind-23411 reply out, NIP-44 v2 both directions, ok and err outcomes,
 *   wrong-mint/wrong-id rejection
 * - REQ+EVENT on the same socket, and the identical-event re-send loop
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
} from "../nostrMintTransport";

const mintSk = generateSecretKey();
const mintPk = getPublicKey(mintSk);
const mintNpub = nip19.npubEncode(mintPk);

interface MockWs {
  url: string;
  sent: string[];
  emit: (t: string, ev: unknown) => void;
  deliverToClient: (msg: unknown[]) => void;
}

let mockSockets: MockWs[] = [];
let serverHandler: (socket: MockWs, event: NostrEvent) => void =
  () => undefined;

function installMockWebSocket() {
  class MockWebSocket {
    url: string;
    sent: string[] = [];
    listeners = new Map<string, Array<(ev: unknown) => void>>();
    constructor(url: string) {
      this.url = url;
      mockSockets.push(this as unknown as MockWs);
      setTimeout(() => {
        (this.listeners.get("open") ?? []).forEach((cb) => cb({}));
      }, 0);
    }
    addEventListener(t: string, cb: (ev: unknown) => void) {
      const list = this.listeners.get(t) ?? [];
      list.push(cb);
      this.listeners.set(t, list);
    }
    send(data: string) {
      this.sent.push(data);
      const msg = JSON.parse(data);
      if (msg[0] === "EVENT") {
        setTimeout(
          () => serverHandler(this as unknown as MockWs, msg[1] as NostrEvent),
          0
        );
      }
    }
    close() {
      (this.listeners.get("close") ?? []).forEach((cb) => cb({}));
    }
    emit(t: string, ev: unknown) {
      (this.listeners.get(t) ?? []).forEach((cb) => cb(ev));
    }
    deliverToClient(msg: unknown[]) {
      this.emit("message", { data: JSON.stringify(msg) });
    }
  }
  (globalThis as unknown as { WebSocket: unknown }).WebSocket =
    MockWebSocket as unknown as typeof WebSocket;
}

/** Mint-side reply builder: mirrors the real mint's obligations. */
function mintReply(
  request: NostrEvent,
  outcome: { ok?: unknown; err?: { code: number | string; detail?: string } }
): NostrEvent {
  // The reply goes to the request event's author (the throwaway client key).
  const clientPk = request.pubkey;
  const reqId = JSON.parse(
    nip44.v2.decrypt(
      request.content,
      nip44.v2.utils.getConversationKey(bytesToHex(mintSk), clientPk)
    )
  ).id as string;
  const plaintext = JSON.stringify({
    v: PROTOCOL_VERSION,
    id: reqId,
    ...(outcome.ok !== undefined ? { ok: outcome.ok } : { err: outcome.err }),
  });
  return finalizeEvent(
    {
      kind: RESPONSE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["p", clientPk],
        ["e", request.id],
      ],
      content: nip44.v2.encrypt(
        plaintext,
        nip44.v2.utils.getConversationKey(bytesToHex(mintSk), clientPk)
      ),
    },
    mintSk
  );
}

beforeEach(() => {
  mockSockets = [];
  installMockWebSocket();
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

describe("wire round-trip over mock WebSocket", () => {
  it("sends REQ+EVENT on the same socket and returns the ok payload", async () => {
    serverHandler = (socket, event) => {
      socket.deliverToClient([
        "EVENT",
        "sub",
        mintReply(event, { ok: { keysets: [{ id: "k1", unit: "sat" }] } }),
      ]);
    };
    const fn = makeNostrMintRequestFn(`nostr://${mintNpub}`);
    const result = await fn<{ keysets: unknown[] }>({
      endpoint: "https://nostr-mint.invalid/v1/keysets",
    });
    expect(result.keysets).toEqual([{ id: "k1", unit: "sat" }]);
    // at least one socket per fallback relay; every socket got a REQ and an EVENT
    expect(mockSockets.length).toBeGreaterThanOrEqual(2);
    for (const ws of mockSockets) {
      const msgs = ws.sent.map((s) => JSON.parse(s));
      expect(msgs.map((m) => m[0])).toContain("REQ");
      const evMsg = msgs.find((m) => m[0] === "EVENT");
      expect(evMsg[1].kind).toBe(REQUEST_KIND);
      expect(evMsg[1].tags).toContainEqual(["p", mintPk]);
    }
  });

  it("request plaintext is a v1 envelope with op+body+exp", async () => {
    let seen: Record<string, unknown> | undefined;
    serverHandler = (socket, event) => {
      const plain = nip44.v2.decrypt(
        event.content,
        nip44.v2.utils.getConversationKey(bytesToHex(mintSk), event.pubkey)
      );
      seen = JSON.parse(plain);
      socket.deliverToClient(["EVENT", "sub", mintReply(event, { ok: {} })]);
    };
    const fn = makeNostrMintRequestFn(`nostr://${mintNpub}`);
    await fn({
      endpoint: "https://nostr-mint.invalid/v1/swap",
      requestBody: { inputs: [], outputs: [] },
    });
    expect(seen).toMatchObject({
      v: PROTOCOL_VERSION,
      op: "swap",
      body: { inputs: [], outputs: [] },
    });
    const pt = seen as Record<string, unknown>;
    expect(typeof pt.id).toBe("string");
    expect(
      (pt.exp as number) - Math.floor(Date.now() / 1000)
    ).toBeGreaterThan(30);
  });

  it("throws MintOperationError carrying the NUT code", async () => {
    serverHandler = (socket, event) => {
      socket.deliverToClient([
        "EVENT",
        "sub",
        mintReply(event, { err: { code: 11001, detail: "token already spent" } }),
      ]);
    };
    const fn = makeNostrMintRequestFn(`nostr://${mintNpub}`);
    await expect(
      fn({
        endpoint: "https://nostr-mint.invalid/v1/checkstate",
        requestBody: { proofs: [] },
      })
    ).rejects.toMatchObject({ code: 11001 });
  });

  it("maps transport error codes into the detail string", async () => {
    serverHandler = (socket, event) => {
      socket.deliverToClient([
        "EVENT",
        "sub",
        mintReply(event, { err: { code: "rate_limited", detail: "slow down" } }),
      ]);
    };
    const fn = makeNostrMintRequestFn(`nostr://${mintNpub}`);
    await expect(
      fn({ endpoint: "https://nostr-mint.invalid/v1/keys" })
    ).rejects.toThrow(/rate limited/);
  });

  it("ignores replies from the wrong mint and wrong request id", async () => {
    const otherSk = generateSecretKey();
    serverHandler = (socket, event) => {
      const wrong = finalizeEvent(
        {
          kind: RESPONSE_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["p", event.pubkey],
            ["e", event.id],
          ],
          content: "garbage",
        },
        otherSk
      );
      socket.deliverToClient(["EVENT", "sub", wrong]);
      socket.deliverToClient([
        "EVENT",
        "sub",
        mintReply(event, { ok: { info: "real" } }),
      ]);
    };
    const fn = makeNostrMintRequestFn(`nostr://${mintNpub}`);
    const result = await fn<{ info: string }>({
      endpoint: "https://nostr-mint.invalid/v1/info",
    });
    expect(result.info).toBe("real");
  });

  it("re-sends the IDENTICAL event on fresh sockets when no reply arrives", async () => {
    vi.useFakeTimers();
    let requestsSeen = 0;
    serverHandler = (socket, event) => {
      requestsSeen += 1;
      if (requestsSeen >= 2) {
        socket.deliverToClient([
          "EVENT",
          "sub",
          mintReply(event, { ok: { second: true } }),
        ]);
      }
    };
    const fn = makeNostrMintRequestFn(`nostr://${mintNpub}`);
    const pending = fn({ endpoint: "https://nostr-mint.invalid/v1/keysets" });
    await vi.advanceTimersByTimeAsync(5_100); // first re-send fires
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;
    expect(result).toEqual({ second: true });
    // two rounds x 2 fallback relays = at least 4 sockets
    expect(mockSockets.length).toBeGreaterThanOrEqual(4);
    const ids = new Set(
      mockSockets
        .flatMap((ws) => ws.sent.map((s) => JSON.parse(s)))
        .filter((m) => m[0] === "EVENT")
        .map((m) => m[1].id)
    );
    expect(ids.size).toBe(1);
    vi.useRealTimers();
  });
});
