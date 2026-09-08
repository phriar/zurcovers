# zurcovers

zurcovers.com — a DC digital comic-cover **wallet viewer**, a companion to [ZurVault](https://zurvault.com): *ZurVault helps you find the books, ZurCovers lets you enjoy the collection.* Originally spun off as a sandbox to fix a security issue in an old ZurVault feature (a hardcoded, client-side Helius API key) without risking zurvault.com's working site — see `CLAUDE.md` for that history. Now a standalone product in its own right.

Same no-build architecture as ZurVault: no build step, no package manager, no framework — each page is a single self-contained HTML file with inline CSS/JS. Fully separate from ZurVault's repo, Worker, and KV namespace — nothing here touches `zurvault-proxy` or `ZURVAULT_DC_CACHE`.

## Pages

| File | What it does |
|---|---|
| `index.html` | Landing page — wallet-address input, the "find vs. enjoy" mental-model pitch, and links out to the rest of the site. |
| `MyComics.html` | **Flagship "Long Box" page.** One shelf card per collection; open a card to see every comic/rarity variant owned, missing-rarity ("Complete Set") detection, Spares, My Listings (Magic Eden + OpenSea), and a shareable Flex Card for a completed set. |
| `wallet.html` | "Grid" view — every cover as its own card (rarity variants not collapsed together), search and sort across the whole wallet. |
| `collections.html` | "Collections" view — browse by collection first, drill into rarity tiers owned and the current lowest listed price per tier. |
| `quests.html` | Checks a wallet against Candy Digital's weekly "Collect the Universe" quests — requirement data is hand-maintained in the file itself once each week's quest is announced. |
| `slideshow.html` | Full-screen kiosk-style playback of a wallet's covers — collection picker, shuffle, attributes per frame. |
| `trade-board.html` / `trade-alerts.html` | Public trade-proposal and buy-offer board (no wallet needed to browse), plus a private check-in page with new-since-last-visit badges. |
| `activity.html` | Magic Eden buying-activity log for a wallet, by collection. Not in site nav, still reachable directly. |
| `metrics.html` | Site-owner usage/click dashboard. Not in site nav, `noindex`. |
| `wallet-2.html` | Superseded predecessor of the Long Box, kept as an unlinked fallback. |
| `sw.js` | Service worker — caches comic cover images across pages so a wallet already opened once loads instantly elsewhere on the site. |
| `zurcovers-proxy-worker.js` | Source for the Cloudflare Worker (`zurcovers-proxy`). **In this repo, but not auto-deployed on push** — see Deploying below. |
| `CNAME` | GitHub Pages custom domain (`zurcovers.com`). |

See `CLAUDE.md` for the full, actively-maintained breakdown of each page's features and the Worker's architecture — this table is a quick map, that file is the source of truth.

There is intentionally no marketplace-wide listings/sales feed here — that's ZurVault's job. Every page is wallet-based: nothing renders until a visitor supplies their own public address (except the no-wallet-needed Trade Board browse).

## Why these pages work the way they do

No page has a "Connect Wallet" button, and none ever ask a visitor for an API key. The Worker holds a `HELIUS_API_KEY` secret server-side and does wallet lookups on a visitor's behalf (`GET /v2/wallet-assets?address={pubkey}`) — the browser only ever sends a public wallet address. This is the actual fix for whatever got the old ZurVault slideshow flagged by Google Safe Browsing.

**Get a fresh Helius API key for this — do not reuse ZurVault's old exposed key even server-side; treat it as permanently compromised.**

The Worker also proxies generic Magic Eden requests (CORS + edge caching), backs a per-wallet OpenSea listings lookup (`OPENSEA_API_KEY`, separate from ZurVault's own key), computes on-chain "true supply"/rarity distribution per collection straight from Helius (not Magic Eden's listings, which under-represent scarce tiers), and runs the Trade Board's KV-backed post/offer endpoints. See `CLAUDE.md`'s Architecture section for the full endpoint list.

## Deploying the Worker

**As of 2026-08-26, deploy via Wrangler CLI**, not the Cloudflare dashboard's code editor — the dashboard replaced "Edit code" with a static-assets uploader for this Worker, and uploading the `.js` file there serves it as a static file instead of running it. `wrangler.toml` is checked into this repo and already points at `zurcovers-proxy-worker.js` and the real `ZURCOVERS_CACHE` KV namespace.

1. `npx wrangler login` once per machine.
2. `npx wrangler deploy --dry-run` to sanity-check what's about to ship.
3. `npx wrangler deploy` for real.
4. **Re-verify `HELIUS_API_KEY` and `OPENSEA_API_KEY` after every deploy with a live curl** — confirmed live that `wrangler deploy` does not reliably preserve secrets, and that `wrangler secret put` can silently report success while setting an empty value in some terminals. `/v2/collections/{symbol}/stats` returning 200 does **not** prove the Helius secret survived (it never calls Helius) — hit `/v2/wallet-assets` or `/v2/onchain-collections/{key}/rarities` instead, and check for `Helius HTTP 401` in the body.
5. If a secret needs resetting and the CLI prompt won't take it, set it directly: dash.cloudflare.com → Workers & Pages → `zurcovers-proxy` → Settings → Variables → add as a Secret.
6. Never pass a secret value as a CLI argument — it lands in shell history and wrangler's own log file.

Full incident history (a Git-deploy misconfiguration that took the Worker down entirely, and the secret-wipe/leak incident above) is in `CLAUDE.md` — read it before touching the deploy process, since both failure modes are easy to repeat.

No Cron Trigger — everything in this Worker runs per-request, no scheduled aggregation.

## What's in use

- **Hosting**: GitHub Pages, custom domain via `CNAME`, DNS on Cloudflare (proxied).
- **Proxy/compute**: Cloudflare Workers (`zurcovers-proxy`), Workers KV.
- **Data sources**: Helius RPC (server-side wallet lookups and on-chain rarity/supply, via `HELIUS_API_KEY`), Magic Eden public API (collection symbol/floor-price resolution, listed-token lookups), OpenSea public API (per-wallet listings, via its own `OPENSEA_API_KEY`, kept separate from ZurVault's).
- **Explorers linked out to**: Magic Eden, OpenSea.

See `SECURITY.md` for the point-in-time wallet-address-handling review (scoped to `wallet.html`/`slideshow.html` as of 2026-08-15 — re-check before treating it as covering newer pages).
