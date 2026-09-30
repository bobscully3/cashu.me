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

const SERIALIZE_ORIG = "amount: e.blindedMessage.amount.toString(),";
const SERIALIZE_REPL =
  "amount: (b => typeof b === 'number' ? b : (typeof b.toNumber === 'function' ? b.toNumber() : Number(BigInt(b.toString().split(': ').pop()))))(e.blindedMessage.amount),"
const INPUTS_ORIG =
  "_prepareInputsForMint(e, t = !1, n = !1) {\n		return e.map((e) => {\n			let r = this._normalizeWitness(e), { dleq: i, p2pk_e: a, ...o } = e, s = {\n				...o,\n				witness: r\n			};";
const INPUTS_REPL =
  "_prepareInputsForMint(e, t = !1, n = !1) {\n		return e.map((e) => {\n			let r = this._normalizeWitness(e), { dleq: i, p2pk_e: a, ...o } = e, s = {\n				...o,\n				amount: (a => typeof a === 'string' ? Number(a) : (a && typeof a.toNumber === 'function' ? a.toNumber() : a))(o.amount),\n				witness: r\n			};";

let patched = 0;
for (const file of candidates) {
  if (!fs.existsSync(file)) continue;
  let s = fs.readFileSync(file, "utf8");
  let changed = false;
  if (!s.includes(REPLACEMENT) && s.includes(ORIG)) {
    s = s.split(ORIG).join(REPLACEMENT);
    changed = true;
    console.log("[nostr-mint-patch] nostr scheme patch applied to", file);
  }
  if (!s.includes(SERIALIZE_REPL) && s.includes(SERIALIZE_ORIG)) {
    s = s.split(SERIALIZE_ORIG).join(SERIALIZE_REPL);
    changed = true;
    console.log("[nostr-mint-patch] numeric output amounts applied to", file);
  }
  if (!s.includes("amount: typeof o.amount === 'string'") && s.includes(INPUTS_ORIG)) {
    s = s.split(INPUTS_ORIG).join(INPUTS_REPL);
    changed = true;
    console.log("[nostr-mint-patch] numeric input amounts applied to", file);
  }
  if (changed) {
    fs.writeFileSync(file, s);
  }
  patched++;
}
if (patched === 0) {
  console.warn("[nostr-mint-patch] no cashu-ts bundle found to patch");
}
