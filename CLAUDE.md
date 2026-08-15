# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

zurcovers.com is a sandbox/staging domain for a DC digital comic-cover **wallet viewer**, spun off from [ZurVault](https://zurvault.com). ZurVault's earlier version of this feature (`slideshow-legacy.html`, now in a separate `zurvault-archive` checkout, not this repo) hardcoded a live Helius API key directly in client-side JavaScript — readable by anyone via view-source, and almost certainly why that page kept getting flagged by Google. This repo exists to build and test the fixed, server-side-key version without risking zurvault.com's working, Google-approved site. Once proven safe/working here, it may get folded back into zurvault.com or stay standalone — undecided, don't assume either direction.

No build step, no package manager, no framework — each page is a single self-contained HTML file with inline CSS/JS. No `package.json`, no test suite, no linter; nothing to build or install. `node --check <file>.js` (or extracting a `<script>` block to a `.js` temp file first) is the only "test" available — use it after editing the Worker or any page's inline script.

**Fully separate from ZurVault's repo, Worker, and KV namespace.** Nothing here touches `zurvault-proxy` or `ZURVAULT_DC_CACHE`. The Worker in this repo (`zurcovers-proxy`) has its own KV namespace (`ZURCOVERS_CACHE`).

**Scope is intentionally narrow: two wallet-based pages, nothing else.** There is no marketplace-wide listings/sales feed in this repo (that's ZurVault's job) — a `listings.html` mirroring ZurVault's aggregator was built and explicitly rejected in this repo's history; don't reintroduce it without being asked. Both pages require a visitor-supplied wallet address before anything renders.

## Files

| File | What it does |
|---|---|
| `index.html` | Landing page — read-only disclosure, links to `wallet.html` and `slideshow.html`. |
| `wallet.html` | Public page. Visitor pastes a public Solana wallet address; shows every DC comic cover it holds, grouped by collection, with the current Magic Eden floor price where that collection is still resolvable there. |
| `slideshow.html` | Public page. Same wallet-address input, but full-screen kiosk-style playback instead of a grid — collection picker → shuffle/playback, NFT attributes (traits, rarity) shown at the bottom of each frame. |
| `zurcovers-proxy-worker.js` | Source for the Cloudflare Worker. **In this repo but not auto-deployed** — committing/pushing has zero effect on the live Worker until it's manually pasted into the Cloudflare dashboard. |
| `CNAME` | GitHub Pages custom domain (`zurcovers.com`). |

## Architecture

**Worker (`zurcovers-proxy-worker.js`)** is a Cloudflare Worker with two jobs, both stateless/per-request (no cron, no scheduled aggregation):
- `GET /v2/wallet-assets?address={pubkey}` — looks up everything a public wallet holds via Helius's `getAssetsByOwner`, server-side. Requires the `HELIUS_API_KEY` secret (bound in the Cloudflare dashboard, never in this file). Responses are cached per-address in `ZURCOVERS_CACHE` for 90s (`WALLET_CACHE_TTL_SECONDS`) and rate-limited per IP to 30 calls/hour (`WALLET_RATE_LIMIT_PER_HOUR`) — only actual Helius calls count against the limit, cache hits are free. **Why this exists**: the entire reason this sandbox domain exists — see "What this is" above. Neither page has a "Connect Wallet" button; visitors only ever supply a public address, never a key.
- Generic pass-through proxy to `api-mainnet.magiceden.dev`, adding CORS headers for the allowed origins (`zurcovers.com`, `phriar.github.io`, `localhost:8000`) and edge-caching GET responses via the Cache API. `wallet.html` uses this for `/v2/tokens/{mint}` (resolve a held mint's collection symbol) and `/v2/collections/{symbol}/stats` (that collection's current floor price, returned in **lamports** — divide by 1e9 for SOL, unlike the `/listings` endpoint's `price` field which is already in SOL).
- Also serves `POST /v2/click-log` and `POST /v2/gallery-view` / `GET /v2/gallery-views` for lightweight analytics (pre-existing, not tied to the wallet feature specifically).

**Do not reuse ZurVault's old exposed Helius key even server-side** — get a fresh key and treat the old one as permanently compromised.

**`wallet.html`'s** floor-price lookups are sequential with a ~900ms pace between collections (same pattern ZurVault's `discover.html` uses) — Magic Eden enforces a real per-minute rate limit, confirmed via live 429s.

## Deploying the Worker

Manual, dashboard-based deploy — there is no CI/CD wiring this up:

1. dash.cloudflare.com → Workers & Pages → Create → Worker, name it `zurcovers-proxy`.
2. Paste the full contents of `zurcovers-proxy-worker.js`, Deploy.
3. Create a KV namespace named exactly `ZURCOVERS_CACHE`, bind it to the Worker under Worker Settings → Variables → KV Namespace Bindings (variable name must match exactly — the code references it by that name).
4. Add the `HELIUS_API_KEY` secret (Worker Settings → Variables → Secrets, or `wrangler secret put HELIUS_API_KEY`) — required for `/v2/wallet-assets`; without it that endpoint 502s.
5. Update `ME_PROXY_BASE` in `wallet.html` and `slideshow.html` to the real `*.workers.dev` URL if deploying under a different account/subdomain than `zurcovers-proxy.stholt.workers.dev`.

**Every Worker code change needs a manual redeploy** — pushing to GitHub does not touch the live Worker.

## What's in use

- **Hosting**: GitHub Pages, custom domain via `CNAME`, DNS on Cloudflare (proxied).
- **Proxy/compute**: Cloudflare Workers (`zurcovers-proxy`), Workers KV.
- **Data sources**: Helius RPC (server-side wallet asset lookup, via the Worker's `HELIUS_API_KEY` secret), Magic Eden public API (collection symbol/floor-price resolution, via the proxy).
