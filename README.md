# zurcovers

zurcovers.com — a spin-off test property from [ZurVault](https://zurvault.com), doing the same thing for Spawn/OddKey (Todd McFarlane) comic NFTs on Solana instead of DC. Same architecture as ZurVault: no build step, no package manager, no framework — each page is a single self-contained HTML file with inline CSS/JS. Fully separate from ZurVault's repo, Worker, and KV namespace — nothing here touches `zurvault-proxy`, `ZURVAULT_DC_CACHE`, or `DC_COLLECTIONS`.

## Pages

| File | What it does |
|---|---|
| `index.html` | Landing page. "Coming soon" placeholder with an upfront unofficial-fan-project disclosure, plus links to `slideshow.html` and `wallet.html`. |
| `slideshow.html` | Public page. Paste a public Solana wallet address, get a full-screen slideshow of that wallet's NFT covers — kiosk-style, no wallet-connect button, no API key ever touches the browser. Grouped by on-chain collection, same picker/shuffle/fullscreen UX as ZurVault's old slideshow. |
| `wallet.html` | Public page. Same wallet-address input, but a list/grid view instead of full-screen playback — shows every held NFT grouped by collection, with the current Magic Eden floor price where that collection is still resolvable there. |
| `discover.html` | **Internal tool, not linked from the public site** (same treatment as ZurVault's `discover.html`). Scans a wallet's owned assets via Helius, groups by on-chain collection, resolves each to a Magic Eden symbol, and outputs a `SPAWN_COLLECTIONS` config array to paste into `zurcovers-proxy-worker.js`. Plain wallet-address + Helius-API-key inputs (session-only key, never persisted) — no "Connect Wallet" button anywhere. |
| `zurcovers-proxy-worker.js` | Source for the Cloudflare Worker. **In this repo, but not auto-deployed** — same manual paste-into-Cloudflare-dashboard story as ZurVault's `me-proxy-worker.js`. See Deploy steps below. |
| `scripts/discover-spawn-collections.mjs` | One-off Magic Eden catalog scan for Spawn/OddKey collections by name/symbol match. **Hit a hard wall** — see "Known limitations" below. Superseded by the wallet-based `discover.html` approach; kept for reference, not part of the deployed site. |
| `CNAME` | GitHub Pages custom domain (`zurcovers.com`). |

## Why slideshow.html and wallet.html work the way they do

ZurVault had an earlier version of this (`slideshow-legacy.html`, since pulled) that hardcoded a live Helius API key directly in client-side JavaScript — readable by anyone via view-source, and almost certainly why that page kept getting flagged. `zurcovers-proxy-worker.js` now exposes `GET /v2/wallet-assets?address={pubkey}` instead: the Worker holds the Helius key server-side (bound as the `HELIUS_API_KEY` secret, never committed to this repo), and the browser only ever sends a public wallet address. Neither page has a "Connect Wallet" button — public-address-only, view-only, by design, same reasoning `discover.html` already documented for its own key handling.

Get a fresh Helius API key for this — **do not reuse ZurVault's old exposed key even server-side**; treat it as permanently compromised.

## Deploying the Worker

Cloudflare Workers get their own `*.workers.dev` subdomain automatically — the Worker does **not** need to live under the zurcovers.com domain or touch its DNS at all, same as ZurVault's `zurvault-proxy.stholt.workers.dev`.

1. Go to **dash.cloudflare.com → Workers & Pages → Create → Worker**.
2. Name it — `zurcovers-proxy` is the suggested match for the file name.
3. Delete the default starter code, paste in the full contents of `zurcovers-proxy-worker.js`, click **Deploy**.
4. Note the URL Cloudflare gives you (something like `zurcovers-proxy.<your-account-name>.workers.dev`).
5. Create a KV namespace: **Workers & Pages → KV → Create**, name it `ZURCOVERS_CACHE`.
6. Bind it to the Worker: **Worker Settings → Variables → KV Namespace Bindings** — variable name must be exactly `ZURCOVERS_CACHE` (the code references it by that name), pointing at the namespace just created.
7. Add the Cron Trigger: **Worker Settings → Triggers → Cron Triggers** → add `*/20 * * * *` (every 20 minutes). Without this, `GET /v2/spawn-summary` just returns the `notReady` state forever — nothing else populates KV.
8. Add the Helius secret: **Worker Settings → Variables → Secrets → Add** (or `wrangler secret put HELIUS_API_KEY`) — name it exactly `HELIUS_API_KEY`, value is your own Helius API key. Without this, `GET /v2/wallet-assets` (used by `slideshow.html` and `wallet.html`) returns a 502.

Once deployed, update `ME_PROXY_BASE` in `discover.html` (currently a `zurcovers-proxy.YOURNAME.workers.dev` placeholder) to the real URL from step 4. The same constant will need updating in every future page that reads `/v2/spawn-summary` (listings page, gallery) once those exist.

**Worker changes need a manual redeploy, every time.** Committing/pushing `zurcovers-proxy-worker.js` to GitHub has zero effect on the live Worker until you paste it into the Cloudflare dashboard yourself — this bit ZurVault more than once, expect the same risk here.

## SPAWN_COLLECTIONS

`SPAWN_COLLECTIONS` in `zurcovers-proxy-worker.js` starts **empty** on purpose — nothing auto-populates it. Populate it by hand using `discover.html`'s output (or, once viable, a reviewed batch from the catalog-scan script — see limitations below), reviewing every entry before it goes live: not everything Spawn-named on Magic Eden is necessarily a comic (could be a toy, a PFP, an unrelated art drop, a name collision).

## Known limitations

- **Magic Eden's `GET /v2/collections` endpoint hard-caps at offset 30000.** Confirmed live: `offset=30000` succeeds, `offset=30020` and beyond return the same generic "offset and limit must be a multiple of 20" error regardless of actually satisfying that constraint — an undocumented deep-pagination ceiling, not a real validation error. `sort`/`direction` query params were tested and don't appear to change result order either. This means `scripts/discover-spawn-collections.mjs` can only ever see the first ~30,020 collections in whatever fixed order Magic Eden returns them — a clean run with zero matches is inconclusive, not confirmation those collections don't exist. **`discover.html`'s wallet-based approach sidesteps this entirely** (it resolves specific owned mints via `GET /v2/tokens/{mint}`, not the paginated catalog list) and is the current path forward.
- Magic Eden enforces a real per-minute rate limit (confirmed via live 429s during this repo's own development, same as ZurVault found before it) — anything that loops over many Magic Eden requests needs deliberate pacing, not just bounded concurrency. `zurcovers-proxy-worker.js`'s `throttleMagicEden()` handles this for the deployed Worker; `discover-spawn-collections.mjs` paces itself the same way for local runs.

## What's in use

- **Hosting**: GitHub Pages, custom domain via `CNAME`, DNS on Cloudflare (proxied, same setup as zurvault.com).
- **Proxy/compute**: Cloudflare Workers (`zurcovers-proxy`, once deployed), Workers KV, Cron Triggers.
- **Data sources**: Magic Eden public API (listings/activities, via the proxy), Helius RPC (`discover.html`'s wallet scan — session-only pasted key, never hardcoded).
- **Explorers linked out to**: Magic Eden.
