import { it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { Wallet, Mint } from '@cashu/cashu-ts';
import { makeNostrMintRequestFn } from '../nostrMintTransport';

const mintSk = generateSecretKey();
const mintNpub = nip19.npubEncode(getPublicKey(mintSk));

/**
 * Regression test for the "CTSError: Invalid mint URL scheme: nostr:" receive
 * failure: cashu-ts's normalizeMintUrl (patched via scripts/patch-cashu-ts-nostr.cjs)
 * must accept a token whose embedded mint URL is nostr://npub1... and get PAST URL
 * validation (any later failure is fine - this mint is a mock).
 */
it('patched cashu-ts accepts a nostr:// mint token in Wallet.receive', async () => {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
    constructor(public url: string) {}
    addEventListener() {}
    send() {}
    close() {}
  };
  const fn = makeNostrMintRequestFn(`nostr://${mintNpub}`);
  const mint = new Mint(`nostr://${mintNpub}`, { customRequest: fn });
  const wallet = new Wallet(mint, { unit: 'sat', bip39seed: new Uint8Array(64) });
  const token = {
    mint: `nostr://${mintNpub}`,
    proofs: [{ id: '015aaddbf06a8ea1', amount: 1, secret: 'aa', C: 'bb' }],
    unit: 'sat',
  };
  let threw: string | null = null;
  try {
    await wallet.receive(token as never);
  } catch (e) {
    threw = String((e as Error).message);
  }
  console.log('receive error (if any):', threw);
  expect(threw).not.toContain('Invalid mint URL scheme');
  expect(threw).not.toContain('different mint');
}, 20_000);
