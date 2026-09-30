import { it, expect } from 'vitest';
import { w3cwebsocket } from 'websocket';
// raw WebSocket transport needs a real WebSocket impl in the happy-dom test env
(globalThis as unknown as { WebSocket: unknown }).WebSocket = w3cwebsocket;
import { makeNostrMintRequestFn } from '../nostrMintTransport';

const NPUB = 'npub1qtxf0kttdwr6nm9xsydzg7vd3up9hjqk7sshn4vj9nhv4wdek28qd8z6e9';

it('raw-WS transport against the REAL crush mint via real relays', async () => {
  const fn = makeNostrMintRequestFn(`nostr://${NPUB}`);
  const res = await fn({ endpoint: 'https://nostr-mint.invalid/v1/info' });
  console.log('RAW WS RESULT:', JSON.stringify(res).slice(0, 120));
  expect((res as { name?: string }).name).toBe('Maxplayer credits');
}, 45_000);
