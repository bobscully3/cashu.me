# Plan: nostr:// mint support in cashu.me (web wallet)

Goal: Bob holds and spends Maxplayer seller credits (crush mint, `nostr://npub1qtxf0kt…`)
in the cashu.me PWA. Fork: `bobscully3/cashu.me`, local clone `~/src/cashume-nostr`.

## Verified facts (2026-09-30, from source)

- cashu.me = Quasar/Vue PWA, `@cashu/cashu-ts` ^4.9.0, nostr-tools + NDK already deps.
- cashu-ts **Mint** ctor takes `{customRequest: RequestFn}` — npm 4.9.0 confirmed in
  `lib/cashu-ts.es.js:3457`. `Wallet` ctor does NOT forward customRequest, but accepts a
  Mint instance: `new Wallet(new Mint(url, {customRequest}), {unit, bip39seed, counterSource})`.
- **Blocker in npm 4.9.0**: `normalizeMintUrl` (`pi()`, es.js:2360) rejects any non-http(s)
  scheme → `nostr://` throws "Invalid mint URL scheme". Two options:
  a) override `mint.url` post-construction (fragile), or
  b) pin cashu-ts to git main, which adds `customRequest` to Wallet ctor
     (src/wallet/Wallet.ts:295-321 on main as of 2026-09-30) — but main still normalizes URL.
  Chosen: construct Mint with a placeholder https URL and swap `_mintUrl` … NO — cleaner:
  **subclass/wrap Mint**: `_mintUrl` is private but we can construct `new Mint('https://nostr.invalid', {customRequest})`
  and pass our own RequestFn which ignores the URL entirely and keys off the npub closed over
  in the closure. Placeholder URL never hits the network because customRequest replaces `ra`.
  cashu.me UI displays the stored mint url from its own store, not cashu-ts's normalized one.
- cashu.me stores mints in `src/stores/mints.ts` `addMint()` (sanitizes to https:// — must
  special-case `nostr://`), instantiates wallets in `src/stores/wallet.ts:410`
  `createWalletInstance()` — inject customRequest there when url starts with nostr://.
- Wire protocol (Maxplayer rc1 `crates/maxplayer-core/src/mint_wire.rs`, NOT a NUT):
  - Request: kind 23410, tag ["p", mint_hex], NIP-44 v2 to mint key, per-request throwaway
    client key. Plaintext `{"v":1,"id":<uuid>,"op":<op>,"body":<NUT JSON>,"exp":<unix>}`.
  - Response: kind 23411, tags ["p", client_hex], ["e", request event id], NIP-44 to client.
    Plaintext `{"v":1,"id":…,"ok":…}` or `{"v":1,"id":…,"err":{"code":…,"detail":…}}`.
  - code: numeric NUT code or "unsupported"|"rate_limited"|"bad_request"|"expired" (definitive)
    | "internal" (ambiguous).
  - Re-send IDENTICAL signed event (same id) every 5s up to 30s window; mint replays original reply.
  - Fallback relays: `wss://relay.ditto.pub`, `wss://nostr-pub.wellorder.net` + home relay.
  - npub must be lowercase bech32, 32-byte payload, nothing after optional trailing '/'.
- Op mapping (endpoint → op):
  - /v1/info → info (null) ; /v1/keys → keys (null) ; /v1/keys/<id> → keyset {"id"}
  - /v1/keysets → keysets (null) ; /v1/swap → swap (SwapRequest)
  - /v1/checkstate → checkstate (CheckStateRequest) ; /v1/restore → restore (RestoreRequest)
  - /v1/mint/quote/<m> → mint_quote {"method","request"} ; /v1/mint/quote/<m>/<q> → mint_quote_status
  - /v1/mint/<m> → mint {"method","request"} ; /v1/mint/quote/<m>/check → mint_quote_check_batch
  - /v1/melt/quote/<m> → melt_quote ; /v1/melt/quote/<m>/<q> → melt_quote_status ; /v1/melt/<m> → melt
- Error contract: customRequest must throw `MintOperationError` (cashu-ts) with NUT code for
  JSON `code`/`detail` errors, else wallet branching (NUT-20 retry) won't engage.

## Implementation steps

1. `src/js/nostr-mint-transport.ts` — RequestFn impl: parse endpoint → op+body, build+sign
   kind 23410 (nostr-tools nip44 + EventTemplate), subscribe kind 23411 via NDK or raw WS,
   verify p/e tags + nip44 decrypt to client key, re-send loop (5s/30s), map err →
   MintOperationError. Validate npub bech32 (nostr-tools nip19).
2. `src/stores/mints.ts` addMint: allow `nostr://npub1…` (skip https prefix, validate npub).
3. `src/stores/wallet.ts` createWalletInstance: if url is nostr:// →
   `new Wallet(new Mint('https://nostr-mint.invalid', {customRequest: makeNostrRequestFn(url)}), opts)`.
4. Guard all HTTP-only paths (NWC melt? on-chain?) — credits mint supports swap/receive/send only.
5. Tests: vitest, unit-test transport against a fake relay WS + fixture events from rc1 tests.
6. Run `quasar dev`, add crush mint, receive Bob's 1,000-credit token, balance + send round-trip
   to Sage (crush mint), verify proofs spent on mint db.

## Gotchas
- npm ci needs `--ignore-scripts` (pngquant postinstall fails on this Mac).
- Relay connections: browser WS fine; need ephemeral kinds (23410/11) — relays verified to forward.
- exp = first invalid second; set exp = now + 40s (> window), skew 60s tolerated.
- Never log full proofs/keys. PWA service worker may cache old bundle during dev (disable SW in dev).
