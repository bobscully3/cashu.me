import { describe, it, expect, beforeEach } from 'vitest';
import { generateSecretKey, getPublicKey, nip44, nip19, finalizeEvent, type Event as NostrEvent } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';
import { makeNostrMintRequestFn } from '../nostrMintTransport';

const mintSk = generateSecretKey();
const mintNpub = nip19.npubEncode(getPublicKey(mintSk));

class MockWS {
  listeners = new Map<string, Array<(ev: unknown) => void>>();
  static lastBody: unknown = null;
  sent: string[] = [];
  constructor(public url: string) {}
  addEventListener(t: string, cb: (ev: unknown) => void) {
    const l = this.listeners.get(t) ?? []; l.push(cb); this.listeners.set(t, l);
    if (t === 'open') setTimeout(() => cb({}), 0);
  }
  send(data: string) {
    this.sent.push(data);
    const msg = JSON.parse(data);
    if (msg[0] === 'EVENT' && msg[1].kind === 23410) {
      const ev = msg[1] as NostrEvent;
      const plain = nip44.v2.decrypt(ev.content, nip44.v2.utils.getConversationKey(bytesToHex(mintSk), ev.pubkey));
      const req = JSON.parse(plain);
      if (req.op === 'swap') MockWS.lastBody = req.body;
      // reply ok so the call completes
      const replyPlain = JSON.stringify({ v: 1, id: req.id, ok: { swapped: true } });
      const reply = finalizeEvent({
        kind: 23411, created_at: Math.floor(Date.now() / 1000),
        tags: [['p', ev.pubkey], ['e', ev.id]],
        content: nip44.v2.encrypt(replyPlain, nip44.v2.utils.getConversationKey(bytesToHex(mintSk), ev.pubkey)),
      }, mintSk);
      setTimeout(() => this.deliver(['EVENT', 'sub', reply]), 0);
    }
  }
  close() {}
  deliver(msg: unknown[]) {
    (this.listeners.get('message') ?? []).forEach((cb) => cb({ data: JSON.stringify(msg) }));
  }
}

beforeEach(() => {
  MockWS.lastBody = null;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWS as unknown as typeof WebSocket;
});

describe('wire body normalizer', () => {
  it('converts Amount-like objects and numeric strings in amount fields', async () => {
    const fn = makeNostrMintRequestFn(`nostr://${mintNpub}`);
    const amountLike = { toNumber: () => 8 };       // Amount instance stand-in
    const result = await fn<Record<string, unknown>>({
      endpoint: 'https://nostr-mint.invalid/v1/swap',
      requestBody: {
        inputs: [
          { id: 'k1', amount: amountLike, secret: 's', C: 'c' },
          { id: 'k1', amount: '64', secret: 's2', C: 'c2' },
        ],
        outputs: [{ amount: { toNumber: () => 32 }, B_: 'B', id: 'k1' }],
      },
    });
    expect(result).toEqual({ swapped: true });
    const body = MockWS.lastBody as { inputs: Array<{ amount: number }>; outputs: Array<{ amount: number }> };
    expect(typeof body.inputs[0].amount).toBe('number');
    expect(body.inputs[0].amount).toBe(8);
    expect(body.inputs[1].amount).toBe(64);
    expect(typeof body.outputs[0].amount).toBe('number');
    expect(body.outputs[0].amount).toBe(32);
  });

  it('leaves non-amount string fields alone', async () => {
    const fn = makeNostrMintRequestFn(`nostr://${mintNpub}`);
    await fn({
      endpoint: 'https://nostr-mint.invalid/v1/swap',
      requestBody: { inputs: [], outputs: [], extra: { note: '42' } },
    });
    const body = MockWS.lastBody as { extra: { note: string } };
    expect(body.extra.note).toBe('42');
  });
});
