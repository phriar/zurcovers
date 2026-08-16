/**
 * zurcovers → Magic Eden proxy
 * ----------------------------
 * zurcovers.com is a sandbox/staging domain for a DC-comic wallet viewer
 * that got zurvault.com flagged by Google when it lived there — a new
 * domain to build and test against, fully separate from ZurVault's repo,
 * Worker, and KV namespace (own Worker `zurcovers-proxy`, own KV namespace
 * ZURCOVERS_CACHE; never reads or writes ZURVAULT_DC_CACHE or
 * DC_COLLECTIONS in zurvault-proxy). Once proven working/safe here, this
 * may get folded back into zurvault.com or stay standalone — undecided.
 *
 * Two pages, both wallet-based (paste a public address, nothing else):
 *   wallet.html    — grid of everything the wallet holds, with the
 *                    current Magic Eden floor price per collection where
 *                    resolvable there.
 *   slideshow.html — full-screen slideshow of the same holdings, with NFT
 *                    attributes shown at the bottom of each frame.
 * No marketplace-wide listings/sales feed here on purpose — that's
 * ZurVault's job, not this sandbox's.
 *
 * DEPLOY:
 * 1. https://dash.cloudflare.com → Workers & Pages → Create → Worker,
 *    name it zurcovers-proxy (or similar), paste this whole file in, Deploy.
 * 2. Create a KV namespace (Workers & Pages → KV → Create) named
 *    ZURCOVERS_CACHE, bind it to this Worker under that same name
 *    (Worker Settings → Variables → KV Namespace Bindings).
 * 3. Add the HELIUS_API_KEY secret (Worker Settings → Variables → add
 *    secret, or `wrangler secret put HELIUS_API_KEY`) — required for
 *    GET /v2/wallet-assets, see below.
 * 4. Note the URL Cloudflare gives you and point zurcovers.com's pages at
 *    it (ME_PROXY_BASE constant in each HTML file).
 *
 * No Cron Trigger needed — there's no scheduled aggregation in this file,
 * unlike ZurVault's me-proxy-worker.js. Everything here runs per-request.
 *
 * USAGE from the browser: {WORKER_URL}/v2/tokens/{mint},
 * {WORKER_URL}/v2/collections/{symbol}/stats, etc. — generic pass-through
 * proxy to Magic Eden (adds CORS, edge-caches GET responses), same as
 * ZurVault's Worker. wallet.html uses this to resolve a held mint's
 * collection symbol and that collection's current floor price.
 *
 * {WORKER_URL}/v2/wallet-assets?address={pubkey} looks up everything a
 * public Solana wallet owns via Helius, server-side. This IS the fix for
 * how ZurVault's old slideshow-legacy.html got itself flagged: that page
 * had a live Helius API key hardcoded in client-side JS, readable by
 * anyone via view-source — the entire reason this sandbox domain exists.
 * Here the key never leaves the Worker. Requires its own Helius
 * account/key; do not reuse ZurVault's old exposed key even here — treat
 * that one as permanently compromised and get a fresh one.
 */

const ME_ORIGIN = "https://api-mainnet.magiceden.dev";

// Swap in your real zurcovers.com origins once the GitHub Pages repo and
// custom domain are live. localhost:8000 kept for local dev, same as
// ZurVault's Worker.
const ALLOWED_ORIGINS = [
  "https://zurcovers.com",
  "https://phriar.github.io",
  "http://localhost:8000",
];

const EDGE_CACHE_SECONDS = 60;
const CLICK_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days, same retention as ZurVault's click log

// ---------------------------------------------------------------------
// WALLET ASSETS — GET /v2/wallet-assets?address={pubkey}, backs
// slideshow.html and wallet.html. Server-side Helius lookup so visitors
// only ever provide a public address, never an API key (see file header).
// ---------------------------------------------------------------------
const HELIUS_ORIGIN = "https://mainnet.helius-rpc.com/";
const SOL_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // base58, no 0/O/I/l
const WALLET_CACHE_TTL_SECONDS = 90; // repeat loads of the same wallet within this window skip Helius entirely
const WALLET_RATE_LIMIT_PER_HOUR = 30; // per IP, only counted on actual Helius calls (cache hits are free)
const WALLET_ASSET_MAX_PAGES = 10; // Helius getAssetsByOwner, 1000/page — same cap slideshow-legacy.html used

// Was an allow-list of "NFT-ish" interface values — any interface type
// Helius returned that wasn't on that specific list got silently
// excluded from results, a confirmed real cause of users reporting
// missing items. Flipped to a deny-list of the only types that are
// definitely NOT a collectible (fungible tokens, effectively SOL/USDC-
// like balances) — everything else Helius's DAS API returns for a
// wallet is kept by default instead of needing to match a fixed list.
const NON_COLLECTIBLE_INTERFACES = new Set(["FungibleAsset", "FungibleToken"]);

// Bounds how many off-chain-metadata fallback fetches one wallet scan
// can trigger (see backfillMissingMetadata below) — protects against a
// wallet full of unusual/malformed metadata blowing up scan latency.
// Confirmed live against a real 669-asset wallet that this gap is
// common, not an edge case: 219 of 669 assets (~33%) came back from
// Helius with empty image AND empty attributes.
//
// The real bottleneck turned out to be neither the cap nor a subrequest
// limit — it was candy.io's own metadata host (permaweb.candy.io)
// rate-limiting a burst of 15 concurrent requests: confirmed live, 194
// of 219 candidates came back HTTP 429. Same class of problem this file
// already learned to handle for Magic Eden (see the sibling project's
// throttleMagicEden() this pattern mirrors) — pacing actual request
// *rate*, not just bounding how many are conceptually "in flight" at
// once, is what avoids tripping it. CANDY_PERMAWEB_MAX_REQUESTS_PER_SEC
// below is a conservative starting point, unconfirmed against candy.io's
// real documented limit (they don't publish one) — tune based on how
// many fetch-http-429s show up in practice.
//
// At a throttled ~3 req/sec, backfilling this real wallet's full 219
// candidates would take over a minute — not viable inside one HTTP
// response. MAX_METADATA_FALLBACK_FETCHES is kept modest (60) so the
// fallback phase finishes in well under Workers' execution budget; a
// wallet with more gaps than that will need a couple of reloads to
// fully settle rather than backfilling 100% in one pass. That's a
// real, known limitation — not pretending otherwise.
const MAX_METADATA_FALLBACK_FETCHES = 60;
const CANDY_PERMAWEB_MAX_REQUESTS_PER_SEC = 3;
const CANDY_PERMAWEB_MAX_RETRIES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let candyPermawebRequestTimestamps = [];
async function throttleCandyPermaweb() {
  while (true) {
    const now = Date.now();
    candyPermawebRequestTimestamps = candyPermawebRequestTimestamps.filter((t) => now - t < 1000);
    if (candyPermawebRequestTimestamps.length < CANDY_PERMAWEB_MAX_REQUESTS_PER_SEC) {
      candyPermawebRequestTimestamps.push(now);
      return;
    }
    await sleep(1000 - (now - candyPermawebRequestTimestamps[0]) + 10);
  }
}

function extractImageFromAsset(a) {
  const links = (a.content && a.content.links) || {};
  const files = (a.content && a.content.files) || [];
  let image = links.image || links.animation_url || "";
  if (!image) {
    for (const f of files) {
      const uri = f.cdn_uri || f.uri || "";
      if (!uri) continue;
      if (f.mime && f.mime.startsWith("image/")) { image = uri; break; }
      if (!image) image = uri;
    }
  }
  return image;
}

// Same shape as slideshow-legacy.html's parse() — kept intentionally
// minimal (no full raw Helius payload forwarded to the client) so the
// response stays small for wallets holding hundreds of assets. jsonUri
// is the one exception — kept only long enough for backfillMissingMetadata
// to use it, stripped before the response goes out (see fetchWalletAssets).
function parseHeliusAsset(a) {
  const meta = (a.content && a.content.metadata) || {};
  const grouping = (a.grouping || []).find((g) => g.group_key === "collection");
  const collectionName =
    (grouping && grouping.collection_metadata && grouping.collection_metadata.name) ||
    (meta.collection && meta.collection.name) ||
    meta.symbol || "";
  return {
    mint: a.id,
    name: meta.name || (a.id ? a.id.slice(0, 8) : "Untitled"),
    collectionKey: (grouping && grouping.group_value) || null,
    collectionName,
    image: extractImageFromAsset(a),
    attributes: meta.attributes || [],
    jsonUri: (a.content && a.content.json_uri) || "",
  };
}

// A meaningful share of assets (confirmed live, not just a theoretical
// edge case) come back from Helius with a missing image, an empty
// attributes array, or both — Helius's own indexer didn't fully resolve
// their off-chain metadata JSON, even though the asset itself is real
// and owned. Previously a missing image meant the item was dropped from
// results entirely with no indication anything was missing; a missing
// attributes array meant the item silently lost its rarity (grouped
// under "No rarity data" even when the collection does use rarity
// tiers, or worse, undercounted collections/comics — see the
// "Showcase #4" investigation this fix came out of).
//
// Fetches each such item's own metadata JSON directly as a fallback,
// throttled through throttleCandyPermaweb() rather than fired in
// concurrent batches — confirmed live that candy.io's metadata host
// 429s hard under a burst of 15 concurrent requests (194 of 219 in one
// real test). Short bounded retry on 429 specifically, since a
// transient rate-limit hit shouldn't permanently leave an item without
// rarity data. Items still missing either field after this are kept
// anyway (image: "", attributes: []) rather than dropped — the frontend
// renders a placeholder for a missing image, and simply shows no rarity
// badge for missing attributes.
async function fetchCandyMetadataWithRetry(jsonUri) {
  for (let attempt = 0; attempt <= CANDY_PERMAWEB_MAX_RETRIES; attempt++) {
    await throttleCandyPermaweb();
    const res = await fetch(jsonUri, { headers: { Accept: "application/json" } });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < CANDY_PERMAWEB_MAX_RETRIES) {
      await sleep(500 * Math.pow(2, attempt));
      continue;
    }
    return null;
  }
  return null;
}

async function backfillMissingMetadata(assets) {
  const needsFetch = assets
    .filter((a) => (!a.image || (Array.isArray(a.attributes) && a.attributes.length === 0)) && a.jsonUri)
    .slice(0, MAX_METADATA_FALLBACK_FETCHES);
  await Promise.all(
    needsFetch.map(async (a) => {
      try {
        const meta = await fetchCandyMetadataWithRetry(a.jsonUri);
        if (!meta) return;
        if (!a.image) a.image = meta.image || "";
        if (!a.attributes || a.attributes.length === 0) a.attributes = Array.isArray(meta.attributes) ? meta.attributes : [];
      } catch {
        // leave as-is — frontend already handles missing image; missing attributes just means no rarity badge
      }
    })
  );
}

async function fetchWalletAssets(address, env) {
  const rpcUrl = `${HELIUS_ORIGIN}?api-key=${env.HELIUS_API_KEY}`;
  const assets = [];
  const seenMints = new Set(); // Helius's page-based pagination isn't guaranteed stable across requests if the wallet's asset set shifts mid-scan — dedupe by mint rather than trust page boundaries not to overlap.
  for (let page = 1; page <= WALLET_ASSET_MAX_PAGES; page++) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "zurcovers-wallet-assets",
        method: "getAssetsByOwner",
        params: {
          ownerAddress: address, page, limit: 1000,
          displayOptions: { showUnverifiedCollections: true, showCollectionMetadata: true, showNativeBalance: false },
        },
      }),
    });
    if (!res.ok) throw new Error(`Helius HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "Helius error");
    const items = (json.result && json.result.items) || [];
    for (const a of items) {
      if (seenMints.has(a.id)) continue;
      if (NON_COLLECTIBLE_INTERFACES.has(a.interface)) continue;
      seenMints.add(a.id);
      assets.push(parseHeliusAsset(a));
    }
    if (items.length < 1000) break;
  }
  await backfillMissingMetadata(assets);
  for (const a of assets) delete a.jsonUri; // internal-only, not part of the client-facing shape
  return assets;
}

// Only counted against actual Helius calls (see handleWalletAssets) — a
// cached response costs nothing, so it doesn't touch this. Same eventual-
// consistency tolerance as the click/gallery-view counters below: KV isn't
// a precise atomic counter, but that's fine for deterring casual abuse
// rather than enforcing an exact quota.
async function checkAndBumpRateLimit(ip, env) {
  const hourBucket = Math.floor(Date.now() / 3600000);
  const key = `ratelimit:wallet:${ip}:${hourBucket}`;
  const current = parseInt((await env.ZURCOVERS_CACHE.get(key)) || "0", 10);
  if (current >= WALLET_RATE_LIMIT_PER_HOUR) return false;
  await env.ZURCOVERS_CACHE.put(key, String(current + 1), { expirationTtl: 3600 });
  return true;
}

async function handleWalletAssets(request, env, corsHeaders) {
  const url = new URL(request.url);
  const address = (url.searchParams.get("address") || "").trim();
  if (!SOL_ADDRESS_RE.test(address)) {
    return new Response(JSON.stringify({ error: "invalid_address" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const cacheKey = `walletassets:${address}`;
  const cached = await env.ZURCOVERS_CACHE.get(cacheKey);
  if (cached) {
    return new Response(cached, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json", "X-Zurcovers-Wallet-Cache": "HIT" },
    });
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const allowed = await checkAndBumpRateLimit(ip, env);
  if (!allowed) {
    return new Response(JSON.stringify({ error: "rate_limited", retryAfterSeconds: 3600 }), {
      status: 429,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const assets = await fetchWalletAssets(address, env);
    const body = JSON.stringify({ wallet: address, count: assets.length, assets, fetchedAt: Date.now() });
    await env.ZURCOVERS_CACHE.put(cacheKey, body, { expirationTtl: WALLET_CACHE_TTL_SECONDS });
    return new Response(body, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json", "X-Zurcovers-Wallet-Cache": "MISS" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "wallet_lookup_failed", message: err.message }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// ---------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === "/v2/wallet-assets") {
      return handleWalletAssets(request, env, corsHeaders);
    }

    // Outbound-to-Magic-Eden click tracking — same shape as ZurVault's
    // /v2/click-log, own KV, own 90-day rolling window. Never mixed with
    // ZurVault's click data.
    if (url.pathname === "/v2/click-log" && request.method === "POST") {
      let payload;
      try {
        payload = JSON.parse(await request.text());
      } catch {
        return new Response(JSON.stringify({ error: "invalid_body" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const sanitize = (s, fallback) => String(s || "").slice(0, 80).replace(/[^a-zA-Z0-9_-]/g, "_") || fallback;
      const symbol = sanitize(payload?.symbol, "unknown");
      const mint = sanitize(payload?.mint, "_collection");
      const key = `click:${symbol}:${mint}:${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      ctx.waitUntil(env.ZURCOVERS_CACHE.put(key, "1", { expirationTtl: CLICK_TTL_SECONDS }));
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Gallery page-view counter — one KV entry per view (same "avoid lossy
    // shared-counter increments under concurrent writes" reasoning as click
    // tracking), 90-day rolling window. GET /v2/gallery-views returns the
    // total; nothing per-visitor is retained beyond a timestamp.
    if (url.pathname === "/v2/gallery-view" && request.method === "POST") {
      const key = `galleryview:${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      ctx.waitUntil(env.ZURCOVERS_CACHE.put(key, "1", { expirationTtl: CLICK_TTL_SECONDS }));
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/v2/gallery-views" && request.method === "GET") {
      let total = 0;
      let cursor;
      do {
        const page = await env.ZURCOVERS_CACHE.list({ prefix: "galleryview:", cursor, limit: 1000 });
        total += page.keys.length;
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return new Response(JSON.stringify({ total, retentionDays: CLICK_TTL_SECONDS / 86400 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // Generic pass-through proxy + edge cache, same as ZurVault's Worker.
    // wallet.html uses this for /v2/tokens/{mint} (resolve a held mint's
    // collection symbol) and /v2/collections/{symbol}/stats (that
    // collection's current floor price).
    const targetUrl = ME_ORIGIN + url.pathname + url.search;
    const cache = caches.default;
    const cacheKey = request.method === "GET" ? new Request(targetUrl, { method: "GET" }) : null;

    if (cacheKey) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const body = await cached.text();
        return new Response(body, {
          status: cached.status,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Cache-Control": cached.headers.get("Cache-Control") || `public, max-age=${EDGE_CACHE_SECONDS}`,
            "X-Zurcovers-Cache": "HIT",
          },
        });
      }
    }

    try {
      const meResponse = await fetch(targetUrl, { headers: { Accept: "application/json" } });
      const body = await meResponse.text();
      const cacheControl = meResponse.ok ? `public, max-age=${EDGE_CACHE_SECONDS}` : "no-store";

      const response = new Response(body, {
        status: meResponse.status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": cacheControl,
          "X-Zurcovers-Cache": cacheKey && meResponse.ok ? "MISS" : "BYPASS",
        },
      });

      if (cacheKey && meResponse.ok) {
        const toCache = new Response(body, {
          status: meResponse.status,
          headers: { "Content-Type": "application/json", "Cache-Control": cacheControl },
        });
        ctx.waitUntil(cache.put(cacheKey, toCache));
      }

      return response;
    } catch (err) {
      return new Response(JSON.stringify({ error: "proxy_fetch_failed", message: err.message }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },
};
