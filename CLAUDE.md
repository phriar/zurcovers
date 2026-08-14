# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

zurcovers.com — a spin-off of [ZurVault](https://zurvault.com), doing the same thing for Spawn/OddKey (Todd McFarlane) comic NFTs on Solana instead of DC. No build step, no package manager, no framework — each page is a single self-contained HTML file with inline CSS/JS. There is no `package.json`, no test suite, and no linter; there is nothing to build or install.

**Fully separate from ZurVault's repo, Worker, and KV namespace.** Nothing here touches `zurvault-proxy`, `ZURVAULT_DC_CACHE`, or `DC_COLLECTIONS`. The Worker in this repo (`zurcovers-proxy`) has its own KV namespace (`ZURCOVERS_CACHE`) and its own collections config (`SPAWN_COLLECTIONS`) — never conflate the two projects' data.

## Files

| File | What it does |
|---|---|
| `index.html` | Landing page. "Coming soon" placeholder with an upfront unofficial-fan-project disclosure — no wallet UI, no forms, no live data dependency yet. |
| `discover.html` | **Internal tool, not linked from the public site.** Scans a wallet's owned assets via Helius, groups by on-chain collection, resolves each to a Magic Eden symbol, and outputs a `SPAWN_COLLECTIONS` config array to paste into `zurcovers-proxy-worker.js`. Plain wallet-address + Helius-API-key inputs (session-only key, never persisted) — no "Connect Wallet" button. |
| `zurcovers-proxy-worker.js` | Source for the Cloudflare Worker. **In this repo but not auto-deployed** — committing/pushing has zero effect on the live Worker until it's manually pasted into the Cloudflare dashboard. |
| `scripts/discover-spawn-collections.mjs` | One-off Magic Eden catalog scan for Spawn/OddKey collections by name/symbol match. Hit a hard wall (see Known limitations below); superseded by the wallet-based `discover.html` approach. Kept for reference, not part of the deployed site. Run with `node scripts/discover-spawn-collections.mjs`. |
| `CNAME` | GitHub Pages custom domain (`zurcovers.com`). |

## Architecture

**Worker (`zurcovers-proxy-worker.js`)** is a Cloudflare Worker that:
- Proxies requests to `api-mainnet.magiceden.dev`, adding CORS headers for the allowed origins (`zurcovers.com`, `phriar.github.io`, `localhost:8000`) and edge-caching GET responses via the Cache API.
- Runs a scheduled cron job (`*/20 * * * *`, configured in the Cloudflare dashboard, not in code) that fetches listings/activities for every entry in `SPAWN_COLLECTIONS` and writes per-collection summaries into `ZURCOVERS_CACHE` KV.
- Serves `GET /v2/spawn-summary` from KV (merging all cached per-collection entries into one payload), edge-cached separately for 30s. Returns `{ notReady: true }` until the cron has populated KV at least once.
- Serves `GET /v2/__trigger-refresh?key=<symbol>` as a manual on-demand refresh of one collection's KV entry, bypassing the cron cycle.
- Serves `POST /v2/click-log` and `POST /v2/gallery-view` / `GET /v2/gallery-views` for lightweight analytics, each KV entry timestamped with a 90-day TTL rather than using a shared counter (avoids lossy increments under concurrent writes).
- All outbound Magic Eden calls are paced through `throttleMagicEden()` (max 3 req/sec, global across the Worker) — Magic Eden enforces a real per-minute rate limit; anything that loops over ME requests must use this, not just bounded concurrency.

**`SPAWN_COLLECTIONS`** (top of the Worker file) starts **empty** on purpose — nothing auto-populates it. It's a hand-reviewed `{ sub, symbol }` array: `sub` is a human-readable sub-collection label for filter UIs, `symbol` is the exact Magic Eden collection symbol. Populate it using `discover.html`'s output, reviewing every entry before it goes live — not everything Spawn-named on Magic Eden is necessarily a comic (could be a toy, a PFP, an unrelated art drop, a name collision).

**`discover.html`** cannot call Magic Eden directly from the browser (CORS-blocked) — it routes ME lookups through the deployed Worker via `ME_PROXY_BASE`, a placeholder constant (`zurcovers-proxy.YOURNAME.workers.dev`) that must be updated to the real Worker URL post-deploy, and again in every future page that reads `/v2/spawn-summary`.

## Deploying the Worker

Manual, dashboard-based deploy — there is no CI/CD wiring this up:

1. dash.cloudflare.com → Workers & Pages → Create → Worker, name it `zurcovers-proxy`.
2. Paste the full contents of `zurcovers-proxy-worker.js`, Deploy.
3. Create a KV namespace named exactly `ZURCOVERS_CACHE`, bind it to the Worker under Worker Settings → Variables → KV Namespace Bindings (variable name must match exactly — the code references it by that name).
4. Add a Cron Trigger under Worker Settings → Triggers: `*/20 * * * *`. Without this, `/v2/spawn-summary` returns `notReady` forever.
5. Update `ME_PROXY_BASE` in `discover.html` (and any future page hitting `/v2/spawn-summary`) to the real `*.workers.dev` URL Cloudflare assigns.

**Every Worker code change needs a manual redeploy** — pushing to GitHub does not touch the live Worker.

## Known limitations

- Magic Eden's `GET /v2/collections` endpoint hard-caps at `offset=30000` (confirmed live; higher offsets return a misleading generic validation error, not a real ceiling error). `scripts/discover-spawn-collections.mjs` can therefore only ever see the first ~30,020 collections in ME's fixed return order — a clean run with zero matches is inconclusive, not confirmation those collections don't exist. This is why `discover.html`'s wallet-based approach (resolving specific owned mints via `GET /v2/tokens/{mint}`) is the current path forward instead.
- Magic Eden enforces a real per-minute rate limit (confirmed via live 429s). Any code looping over ME requests needs deliberate pacing (see `throttleMagicEden()` in the Worker and the equivalent pacing in `discover-spawn-collections.mjs`), not just bounded concurrency.

## What's in use

- **Hosting**: GitHub Pages, custom domain via `CNAME`, DNS on Cloudflare (proxied).
- **Proxy/compute**: Cloudflare Workers (`zurcovers-proxy`), Workers KV, Cron Triggers.
- **Data sources**: Magic Eden public API (via the proxy), Helius RPC (`discover.html`'s wallet scan only — session-only pasted key, never hardcoded).
