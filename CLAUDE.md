# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

zurcovers.com is a sandbox/staging domain for a DC digital comic-cover **wallet viewer**, spun off from [ZurVault](https://zurvault.com). ZurVault's earlier version of this feature (`slideshow-legacy.html`, now in a separate `zurvault-archive` checkout, not this repo) hardcoded a live Helius API key directly in client-side JavaScript — readable by anyone via view-source, and almost certainly why that page kept getting flagged by Google. This repo exists to build and test the fixed, server-side-key version without risking zurvault.com's working, Google-approved site. Once proven safe/working here, it may get folded back into zurvault.com or stay standalone — undecided, don't assume either direction.

No build step, no package manager, no framework — each page is a single self-contained HTML file with inline CSS/JS. No `package.json`, no test suite, no linter; nothing to build or install. `node --check <file>.js` (or extracting a `<script>` block to a `.js` temp file first) is the only "test" available — use it after editing the Worker or any page's inline script.

**Fully separate from ZurVault's repo, Worker, and KV namespace.** Nothing here touches `zurvault-proxy` or `ZURVAULT_DC_CACHE`. The Worker in this repo (`zurcovers-proxy`) has its own KV namespace (`ZURCOVERS_CACHE`).

**Scope is intentionally narrow: wallet-based pages, nothing else.** There is no marketplace-wide listings/sales feed in this repo (that's ZurVault's job) — a `listings.html` mirroring ZurVault's aggregator was built and explicitly rejected in this repo's history; don't reintroduce it without being asked. Every page requires a visitor-supplied wallet address before anything renders.

## Product philosophy: ZurVault finds, ZurCovers enjoys

As of 2026-08, ZurCovers and ZurVault are deliberately positioned as complements, not overlapping tools:

- **ZurVault** = find comics. Search, discover, hunt listings, compare prices, find keys/low serials/deals.
- **ZurCovers** = enjoy the comics you already own. Enter a wallet, browse the covers, understand rarity and floor value, spot duplicates, eventually spot gaps in a run.

The mental model: *ZurVault helps you find the books. ZurCovers lets you enjoy the collection.* Keep that split in mind for any UX decision — if a feature primarily helps someone search for comics to buy, it probably belongs on ZurVault, not here. Don't visually merge the two products; family resemblance is fine, but ZurCovers should read as a collection/display experience (warm, tactile, comic-shop), not a search utility.

**`wallet-2.html` ("The Long Box") is the primary/flagship experience**, linked from `index.html`'s main CTA — a shelf-style browser (tilted covers, physical price tags, `×N` duplicate badges, collection divider tabs) meant to feel like flipping through a long box, not reading an analytics dashboard. `wallet.html` (Grid) and `collections.html` (Collections/rarity drill-down) remain as the deeper/utility views for visitors who want more data — preserved, just no longer the front door. Nav order across all pages, by convention: Long Box → Collections → Grid → Slideshow → Home.

**`activity.html` is intentionally unlinked from the nav** (as of 2026-08) — kept exactly as-is, still live and reachable by direct URL/bookmark, just not part of the new site structure. Don't add it back into any page's `nav-links` without being asked, and don't otherwise modify it.

**"Complete the Run" gap detection** (on the Long Box) works off issue numbers parsed from each comic's own name (e.g. trailing `#7`) — it can only spot a hole *between* the lowest and highest issue number already owned in a wallet, never whether a series continues past the highest owned issue or started before the lowest. There is no external catalog of full published runs wired into ZurCovers. One exists, though: ZurVault's own `collections-map.js` (in the separate `zurvault` repo) maintains a hand-curated `symbols` array per series — every known Magic Eden collection symbol for that series' issues. Cross-referencing a wallet's owned symbols against that list per series would enable *true* completion tracking (including issues before/after what's currently owned), but that requires either fetching/parsing that file live from zurvault.com or duplicating and syncing it here — real cross-repo infrastructure, not yet built. Don't fake this by hardcoding a partial issue-count; if it's built, it should read that real data.

**ZurVault deep links** ("Hunt the missing books on ZurVault") are a best-effort slug guess at `zurvault.com/collection.html?s=<slug>`, matching the `id` convention ZurVault's `collections-map.js` uses (e.g. "Absolute Batman" → `absolute-batman`) — not a synced lookup, so it degrades gracefully via ZurVault's own "no series matches" fallback when the guess misses.

## Files

| File | What it does |
|---|---|
| `index.html` | Landing page — wallet-address input front and center (hands off to `wallet-2.html`, no fetch logic of its own), disclosure, secondary links to the deeper views. |
| `wallet-2.html` | **Flagship "Long Box" page.** Visitor pastes a public Solana wallet address; shelf-style browse of every DC comic cover it holds — duplicate `×N` badges, rarity, collection divider tabs, collector summary (unique/total/collections/est. floor value), "Complete the Run" gap detection, current Magic Eden floor price on each price tag. |
| `wallet.html` | "Grid" utility view. Same wallet-address input, traditional data-dense grid — group by collection/rarity, sort, search, gap-summary-on-search, unopened-pack detection. |
| `collections.html` | "Collections" view — browse by collection first, drill into rarity tiers owned and current lowest listed price per tier. |
| `activity.html` | "Activity" view — Magic Eden buying-activity log for a wallet, by collection. |
| `slideshow.html` | "Slideshow" — full-screen kiosk-style playback, collection picker → shuffle/playback, NFT attributes (traits, rarity) shown on each frame. |
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
