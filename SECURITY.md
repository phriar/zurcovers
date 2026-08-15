# zurcovers — Security Review: Wallet Address Handling

Ad-hoc review (2026-08-15) of how `wallet.html` and `slideshow.html` handle the public Solana wallet address a visitor enters, prompted by a question about whether entering an address exposes visitors to any risk. Verified directly against `zurcovers-proxy-worker.js`, `wallet.html`, and `slideshow.html` as they stood at the time — not a general audit, and not a substitute for re-checking after future changes to those files.

## What gets stored, and where

- **Client-side (the visitor's own browser)**: the address is saved to `localStorage` under the key `zurcovers_wallet`, purely so a repeat visit doesn't require retyping it. This never leaves the visitor's device except for the lookup request itself.
- **Server-side (Cloudflare KV, `ZURCOVERS_CACHE`)**: the Worker caches a wallet's resolved asset list under `walletassets:{address}` for **90 seconds** (`WALLET_CACHE_TTL_SECONDS`), so a page refresh doesn't re-hit Helius. It auto-expires — no permanent log, no database, nothing tied to a specific wallet persists beyond that window.
- **Server-side rate limiting**: a separate KV entry (`ratelimit:wallet:{ip}:{hourBucket}`) tracks request counts per IP for **1 hour**, unrelated to which wallet was queried.

A Solana wallet's address and on-chain holdings are already public — visible to anyone via any block explorer, independent of this site. Pasting an address into zurcovers doesn't expose anything that wasn't already public.

## XSS review (malicious NFT metadata)

A known attack pattern against wallet-display apps: an attacker airdrops an NFT whose name/trait fields contain a script payload, hoping the display app renders it unsafely. Checked both pages for this:

- Every NFT-supplied text field (`name`, `collection`, trait type/value) is passed through an `esc()` helper (escapes `&`, `<`, `"`) before being inserted via `innerHTML`.
- Several fields (`m-name`, `m-coll`) are set via `.textContent` instead, which is inherently immune to HTML injection.
- Image URLs are inserted into `src="${esc(...)}"` attributes (escaped) or set via direct property assignment (`artEl.src = ...`, `.style.backgroundImage`), neither of which parses/executes HTML.

No injection path found as of this review.

## Known residual risk: Helius-quota abuse

`GET /v2/wallet-assets` has no authentication beyond:
- CORS headers restricting which **browser-based** origins can call it (does not stop a direct script/`curl` request — CORS is a browser-enforced restriction, not a server-side access control)
- A 30-requests-per-hour-per-IP limit, counted only against actual Helius calls (cache hits are free)

This means someone could script repeated calls with arbitrary wallet addresses and consume Helius API quota/cost. This is an **availability/cost risk, not a data-exposure risk** — no private data leaks (wallet contents are public regardless), and the rate limit exists specifically to blunt it. Worth revisiting only if Helius billing looks unexpectedly high.

## Bottom line

- No wallet address history retained server-side beyond a 90-second cache.
- No confirmed injection/XSS path.
- The one real exposure is potential Helius quota abuse via unauthenticated (rate-limited) endpoint access — a cost/availability concern, not a privacy one.
