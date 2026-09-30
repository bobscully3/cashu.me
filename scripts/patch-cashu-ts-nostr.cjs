#!/usr/bin/env node
/**
 * Postinstall patch: allow `nostr://npub1…` mint URLs in @cashu/cashu-ts's
 * normalizeMintUrl. Upstream (cashu-ts 4.9.0 and git main as of 2026-09-30)
 * hard-rejects any non-http(s) scheme, which breaks receiving tokens whose
 * embedded mint URL is nostr:// — the Maxplayer seller-credits transport
 * handles those via customRequest, but Wallet.receive() normalizes the token's
 * mint URL before reaching the connector. Upstream PR candidate.
 */
const fs = require("fs");
const path = require("path");

const candidates = [
  path.join(__dirname, "..", "node_modules", "@cashu", "cashu-ts", "lib", "cashu-ts.es.js"),
  path.join(__dirname, "..", "..", "node_modules", "@cashu", "cashu-ts", "lib", "cashu-ts.es.js"),
];

const ORIG =
  'if (t.protocol !== "http:" && t.protocol !== "https:") throw new v(`Invalid mint URL scheme: ${t.protocol}`);';
const REPLACEMENT =
  'if (t.protocol !== "http:" && t.protocol !== "https:") { if (!(t.protocol === "nostr:" && /^npub1[a-z0-9]+$/.test(t.href.slice("nostr://".length)))) throw new v(`Invalid mint URL scheme: ${t.protocol}`); }';

let patched = 0;
for (const file of candidates) {
  if (!fs.existsSync(file)) continue;
  let s = fs.readFileSync(file, "utf8");
  if (s.includes(REPLACEMENT)) {
    patched++;
    continue;
  }
  if (!s.includes(ORIG)) continue;
  fs.writeFileSync(file, s.split(ORIG).join(REPLACEMENT));
  console.log("[nostr-mint-patch] patched", file);
  patched++;
}
if (patched === 0) {
  console.warn("[nostr-mint-patch] no cashu-ts bundle found to patch");
}
