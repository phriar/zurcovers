# zurcovers

zurcovers.com — a sandbox/staging domain for a DC digital comic-cover wallet viewer, spun off from [ZurVault](https://zurvault.com). ZurVault's earlier version of this feature (`slideshow-legacy.html`, since pulled) hardcoded a live Helius API key directly in client-side JavaScript — readable by anyone via view-source, and almost certainly why that page kept getting flagged by Google. This repo exists to build and test the fixed, server-side-key version without risking zurvault.com's working, Google-approved site. Once it's proven working here, it may get folded back into zurvault.com or stay standalone.

Same no-build architecture as ZurVault: no build step, no package manager, no framework — each page is a single self-contained HTML file with inline CSS/JS. Fully separate from ZurVault's repo, Worker, and KV namespace — nothing here touches `zurvault-proxy` or `ZURVAULT_DC_CACHE`.

## Pages

| File | What it does |
|---|---|
| `index.html` | Landing page — what this is, the read-only disclosure, links to `wallet.html` and `slideshow.html`. |
| `wallet.html` | Paste a public Solana wallet address; shows every DC digital comic cover it holds, grouped by collection, with the current Magic Eden floor price where that collection is still resolvable there. |
| `slideshow.html` | Same wallet-address input, but a full-screen kiosk-style slideshow instead of a grid — collection picker, shuffle/playback, NFT attributes (traits, rarity) shown at the bottom of each frame. |
| `zurcovers-proxy-worker.js` | Source for the Cloudflare Worker. **In this repo, but not auto-deployed** — same manual paste-into-Cloudflare-dashboard story as ZurVault's `me-proxy-worker.js`. See Deploy steps below. |
| `CNAME` | GitHub Pages custom domain (`zurcovers.com`). |

There is intentionally no marketplace-wide listings/sales feed here — that's ZurVault's job. Both pages are wallet-based only: nothing renders until a visitor supplies their own public address.

## Why these pages work the way they do

Neither page has a "Connect Wallet" button, and neither page ever asks a visitor for an API key. `zurcovers-proxy-worker.js` exposes `GET /v2/wallet-assets?address={pubkey}`: the Worker holds a Helius API key server-side (bound as the `HELIUS_API_KEY` secret, never committed to this repo) and does the `getAssetsByOwner` lookup on the visitor's behalf. The browser only ever sends a public wallet address — public-address-only, view-only, by design. This is the actual fix for whatever got the old ZurVault page flagged.

**Get a fresh Helius API key for this — do not reuse ZurVault's old exposed key even server-side; treat it as permanently compromised.**

The Worker also proxies generic Magic Eden requests (adds CORS, edge-caches GETs) — `wallet.html` uses this to resolve a held mint's collection symbol (`/v2/tokens/{mint}`) and that collection's current floor price (`/v2/collections/{symbol}/stats`), the same per-mint resolution approach ZurVault's own `discover.html` uses, paced client-side to stay under Magic Eden's rate limit.

## Deploying the Worker

Cloudflare Workers get their own `*.workers.dev` subdomain automatically — the Worker does **not** need to live under the zurcovers.com domain or touch its DNS at all, same as ZurVault's `zurvault-proxy.stholt.workers.dev`.

1. Go to **dash.cloudflare.com → Workers & Pages → Create → Worker**.
2. Name it — `zurcovers-proxy` is the suggested match for the file name.
3. Delete the default starter code, paste in the full contents of `zurcovers-proxy-worker.js`, click **Deploy**.
4. Note the URL Cloudflare gives you (something like `zurcovers-proxy.<your-account-name>.workers.dev`).
5. Create a KV namespace: **Workers & Pages → KV → Create**, name it `ZURCOVERS_CACHE`.
6. Bind it to the Worker: **Worker Settings → Variables → KV Namespace Bindings** — variable name must be exactly `ZURCOVERS_CACHE` (the code references it by that name), pointing at the namespace just created.
7. Add the Helius secret: **Worker Settings → Variables → Secrets → Add** (or `wrangler secret put HELIUS_API_KEY`) — name it exactly `HELIUS_API_KEY`, value is your own Helius API key. Without this, `GET /v2/wallet-assets` (used by both pages) returns a 502.

No Cron Trigger needed — there's no scheduled aggregation in this Worker, everything runs per-request.

Once deployed, update `ME_PROXY_BASE` in `wallet.html` and `slideshow.html` (currently pointed at `zurcovers-proxy.stholt.workers.dev`) if you deploy under a different account/subdomain.

**Worker changes need a manual redeploy, every time.** Committing/pushing `zurcovers-proxy-worker.js` to GitHub has zero effect on the live Worker until you paste it into the Cloudflare dashboard yourself — this bit ZurVault more than once, expect the same risk here.

## What's in use

- **Hosting**: GitHub Pages, custom domain via `CNAME`, DNS on Cloudflare (proxied, same setup as zurvault.com).
- **Proxy/compute**: Cloudflare Workers (`zurcovers-proxy`, once deployed), Workers KV.
- **Data sources**: Helius RPC (server-side wallet asset lookup, via the Worker's `HELIUS_API_KEY` secret), Magic Eden public API (collection symbol/floor-price resolution, via the proxy).
- **Explorers linked out to**: Magic Eden.
