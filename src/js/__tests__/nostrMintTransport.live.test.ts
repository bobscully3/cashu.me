
import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, nip44, nip19, finalizeEvent, verifyEvent, type Event as NE } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';
import { w3cwebsocket as NodeWS } from 'websocket';
(globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWS;
(globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWS;
import { Wallet, Mint } from '@cashu/cashu-ts';
import { makeNostrMintRequestFn } from '../nostrMintTransport';

const MINT_NPUB = 'npub1qtxf0kttdwr6nm9xsydzg7vd3up9hjqk7sshn4vj9nhv4wdek28qd8z6e9';
const mintPk = nip19.decode(MINT_NPUB).data as string;
const RELAYS = ['wss://relay.ditto.pub', 'wss://nostr-pub.wellorder.net'];

class RelayPool {
  conns: WebSocket[] = [];
  subscribed = false;
  listeners: Array<(e: NE) => void> = [];
  subscribeMany(relays: string[], _filters: unknown, params: { onevent: (e: NE) => void }) {
    this.listeners.push(params.onevent);
    for (const url of relays) {
      const ws = new WebSocket(url);
      this.conns.push(ws);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify(['REQ', 'mint-web', { kinds: [23411], authors: [mintPk], '#p': [], since: Math.floor(Date.now()/1000) - 10 }]));
      });
      ws.addEventListener('message', (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data));
        if (msg[0] === 'EVENT') this.listeners.forEach((l) => l(msg[2]));
      });
      ws.addEventListener('error', () => {});
    }
    return { close: () => { this.listeners.pop(); } };
  }
  publish(relays: string[], event: NE) {
    for (const url of relays) {
      const ws = new WebSocket(url);
      this.conns.push(ws);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify(['REQ', 'mint-reply', { kinds: [23411], '#p': [event.pubkey], since: Math.floor(Date.now()/1000) - 10 }]));
        ws.send(JSON.stringify(['EVENT', event]));
      });
      ws.addEventListener('message', (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data));
        if (msg[0] === 'EVENT') this.listeners.forEach((l) => l(msg[2]));
      });
      ws.addEventListener('error', () => {});
    }
    return [Promise.resolve('ok')];
  }
}

describe.skipIf(process.env.SKIP_LIVE)('live crush mint (relay.maxplayer ecosystem)', () => {
  it('cashu-ts Wallet loads mint info + keysets over the nostr wire', async () => {
    const pool = new RelayPool();
    const requestFn = makeNostrMintRequestFn(`nostr://${MINT_NPUB}`, { pool: pool as never });
    const mint = new Mint('https://nostr-mint.invalid', { customRequest: requestFn });
    const info = await mint.getInfo();
    expect(info.name).toBe('Maxplayer credits');
    const keysets = await mint.getKeySets();
    expect(keysets.keysets.length).toBeGreaterThan(0);
    expect(keysets.keysets[0].unit).toBe('sat');
  }, 60_000);
});
