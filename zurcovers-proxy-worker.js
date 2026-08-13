/**
 * zurcovers → Magic Eden proxy
 * ----------------------------
 * Sibling of ZurVault's me-proxy-worker.js, same architecture, fully
 * separate deployment — own Worker (zurcovers-proxy), own KV namespace
 * (ZURCOVERS_CACHE), own Cron Trigger. Does not read or write anything in
 * zurvault-proxy's KV (ZURVAULT_DC_CACHE) and is never called by any
 * ZurVault page. See ZurVault's CLAUDE.md/README.md for the full story on
 * *why* this architecture looks the way it does (rate limiting, per-
 * collection KV resilience, edge caching) — this file mirrors those
 * decisions rather than re-explaining them inline everywhere.
 *
 * Tracks Spawn/OddKey (McFarlane) comic NFT collections on Solana instead
 * of DC ones. SPAWN_COLLECTIONS below starts EMPTY on purpose — populate it
 * by hand from scripts/spawn-discovery-results.json after manually
 * reviewing which symbols are actually Spawn *comics* (not toys, not
 * unrelated art drops, not name collisions). Nothing auto-populates this.
 *
 * DEPLOY:
 * 1. https://dash.cloudflare.com → Workers & Pages → Create → Worker,
 *    name it zurcovers-proxy (or similar), paste this whole file in, Deploy.
 * 2. Create a KV namespace (Workers & Pages → KV → Create) named
 *    ZURCOVERS_CACHE, bind it to this Worker under that same name
 *    (Worker Settings → Variables → KV Namespace Bindings).
 * 3. Add a Cron Trigger (Worker Settings → Triggers): */20 * * * * (every
 *    20 min, same cadence as zurvault-proxy).
 * 4. Note the URL Cloudflare gives you and point zurcovers.com's pages at
 *    it (ME_PROXY_BASE constant in each HTML file).
 *
 * USAGE from the browser: {WORKER_URL}/v2/spawn-summary (served entirely
 * from KV, mirrors ZurVault's /v2/dc-summary response shape) and
 * {WORKER_URL}/v2/tokens/{mint} etc. (pass-through proxy to Magic Eden,
 * same as ZurVault's Worker).
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

// ---------------------------------------------------------------------
// SPAWN_COLLECTIONS — starts empty. Populate by hand from
// scripts/spawn-discovery-results.json after manual review (see that
// script's header). Same {sub, symbol} shape as ZurVault's DC_COLLECTIONS
// — "sub" is the human-readable sub-collection label shown in filter UIs,
// "symbol" is the exact Magic Eden collection symbol.
// ---------------------------------------------------------------------
const SPAWN_COLLECTIONS = [
  // { sub: "Spawn (1992) #1", symbol: "TODO_confirm_after_manual_review" },
];

// ---------------------------------------------------------------------
// SCHEDULED AGGREGATION (cron) — populates KV, read by GET /v2/spawn-summary
// ---------------------------------------------------------------------

const collectionKey = (symbol) => `collection:${symbol}`;
const KV_TTL_SECONDS = 2400; // 40 min — see me-proxy-worker.js for the "generous relative to cron cadence" reasoning
const CLICK_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days, same retention as ZurVault's click log
const BATCH_SIZE = 5;
const SALES_WINDOW_SECS = 7 * 24 * 60 * 60;
const ACTIVITIES_MAX_PAGES = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same real, confirmed Magic Eden per-minute rate limit ZurVault's Worker
// documented — pacing every fetch() call globally, not just bounding
// concurrency, is what actually avoids tripping it.
const MAGIC_EDEN_MAX_REQUESTS_PER_SEC = 3;
let meRequestTimestamps = [];
async function throttleMagicEden() {
  while (true) {
    const now = Date.now();
    meRequestTimestamps = meRequestTimestamps.filter((t) => now - t < 1000);
    if (meRequestTimestamps.length < MAGIC_EDEN_MAX_REQUESTS_PER_SEC) {
      meRequestTimestamps.push(now);
      return;
    }
    await sleep(1000 - (now - meRequestTimestamps[0]) + 10);
  }
}

async function fetchJSONDirect(url, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    await throttleMagicEden();
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < retries) {
      await sleep(400 * Math.pow(2, attempt));
      continue;
    }
    const bodySnippet = await res.text().catch(() => "");
    throw new Error(`${url}: HTTP ${res.status}${bodySnippet ? " — " + bodySnippet.slice(0, 150) : ""}`);
  }
}

async function fetchCollectionListingsDirect(symbol) {
  return fetchJSONDirect(`${ME_ORIGIN}/v2/collections/${symbol}/listings?offset=0&limit=100`);
}

async function fetchCollectionActivitiesDirect(symbol) {
  let all = [];
  for (let page = 0; page < ACTIVITIES_MAX_PAGES; page++) {
    const batch = await fetchJSONDirect(`${ME_ORIGIN}/v2/collections/${symbol}/activities?offset=${page * 100}&limit=100`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all = all.concat(batch);
    const oldest = batch[batch.length - 1];
    const oldestAge = Date.now() / 1000 - (oldest?.blockTime || 0);
    if (batch.length < 100 || oldestAge > SALES_WINDOW_SECS) break;
  }
  return all;
}

function deriveListedTimes(activities) {
  const map = new Map();
  for (const a of activities) {
    if (a?.type === "list" && a?.tokenMint && !map.has(a.tokenMint)) {
      map.set(a.tokenMint, a.blockTime || null);
    }
  }
  return map;
}

// Same rarity-string normalization as ZurVault's me-proxy-worker.js — see
// that file for the full "why" (candy.io drops format the raw Rarity trait
// inconsistently). Kept in sync by hand; if you change one, change both.
const RARITY_ALIASES = {
  common: "common", core: "common", base: "common", standard: "common",
  uncommon: "uncommon",
  rare: "rare",
  epic: "epic",
  legendary: "legendary",
};
const RARITY_LABELS = { common: "Common", uncommon: "Uncommon", rare: "Rare", epic: "Epic", legendary: "Legendary" };

function normalizeRarity(attributes) {
  const attr = (attributes || []).find((a) => /^rarity$/i.test(a?.trait_type || ""));
  if (!attr) return { tier: null, pct: null };
  const raw = String(attr.value || "").trim();
  const match = /^(.*?)\s*\(([\d.]+)\)\s*$/.exec(raw);
  const cleaned = (match ? match[1] : raw).trim().toLowerCase();
  const key = RARITY_ALIASES[cleaned];
  return key ? { tier: RARITY_LABELS[key], pct: match ? parseFloat(match[2]) : null } : { tier: null, pct: null };
}

// Same multi-artist-credit splitting as ZurVault's extractCoverArtists() —
// kept for parity in case Spawn/OddKey drops carry a Cover Artist trait
// too. Harmless no-op (returns []) if they don't.
const ARTIST_NAME_EXCLUDE = new Set(["na", "n/a", "various", ""]);
function extractCoverArtists(attributes) {
  const attr = (attributes || []).find((a) => /^cover artist$/i.test(a?.trait_type || ""));
  if (!attr) return [];
  const raw = String(attr.value || "").replace(/\s+/g, " ").trim();
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const names = [];
  for (const part of parts) {
    if (/^(Jr\.?|Sr\.?|II|III|IV)$/i.test(part) && names.length > 0) {
      names[names.length - 1] += ", " + part;
    } else {
      names.push(part);
    }
  }
  return names.map((n) => n.trim()).filter((n) => !ARTIST_NAME_EXCLUDE.has(n.toLowerCase()));
}

function deriveSales(activities, col) {
  const cutoff = Date.now() / 1000 - SALES_WINDOW_SECS;
  const sales = [];
  for (const a of activities) {
    if ((a?.type === "buyNow" || a?.type === "acceptBid") && a?.tokenMint && (a.blockTime || 0) >= cutoff) {
      sales.push({
        sub: col.sub,
        symbol: col.symbol,
        image: a.image || "",
        price: a.price ?? null,
        mint: a.tokenMint,
        soldAt: a.blockTime || null,
        pdpUrl: `https://magiceden.io/item-details/${a.tokenMint}`,
      });
    }
  }
  return sales;
}

async function refreshOneCollection(col, env) {
  try {
    const [data, activities] = await Promise.all([
      fetchCollectionListingsDirect(col.symbol),
      fetchCollectionActivitiesDirect(col.symbol).catch(() => []),
    ]);
    const listedTimes = deriveListedTimes(Array.isArray(activities) ? activities : []);
    const listings = (Array.isArray(data) ? data : []).map((item) => {
      const mint = item?.tokenMint || item?.token?.mintAddress || "";
      const rarityInfo = normalizeRarity(item?.token?.attributes);
      return {
        sub: col.sub,
        symbol: col.symbol,
        name: item?.token?.name || "Untitled",
        image: item?.token?.image || item?.extra?.img || "",
        price: item?.price ?? null,
        mintAddress: mint,
        listedAt: listedTimes.get(mint) || null,
        pdpUrl: `https://magiceden.io/item-details/${mint}`,
        rarity: rarityInfo.tier,
        rarityPct: rarityInfo.pct,
        coverArtists: extractCoverArtists(item?.token?.attributes),
      };
    });
    const sales = deriveSales(Array.isArray(activities) ? activities : [], col);
    const entry = { symbol: col.symbol, sub: col.sub, listings, sales, updatedAt: Date.now() };
    await env.ZURCOVERS_CACHE.put(collectionKey(col.symbol), JSON.stringify(entry), { expirationTtl: KV_TTL_SECONDS });
    return { ok: true, symbol: col.symbol, listingCount: listings.length, saleCount: sales.length };
  } catch (err) {
    console.error(`refreshOneCollection: ${col.symbol} failed:`, err.message);
    return { ok: false, symbol: col.symbol, error: err.message };
  }
}

async function refreshAllCollections(env) {
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < SPAWN_COLLECTIONS.length; i += BATCH_SIZE) {
    const batch = SPAWN_COLLECTIONS.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((col) => refreshOneCollection(col, env)));
    for (const r of results) {
      if (r.ok) ok++;
      else failed++;
    }
  }
  console.log(`refreshAllCollections: ${ok} succeeded, ${failed} failed (of ${SPAWN_COLLECTIONS.length})`);
}

async function buildSpawnSummary(env) {
  const list = await env.ZURCOVERS_CACHE.list({ prefix: "collection:" });
  if (list.keys.length === 0) {
    return JSON.stringify({ listings: [], sales: [], updatedAt: null, failed: [], notReady: true });
  }
  const entries = await Promise.all(list.keys.map((k) => env.ZURCOVERS_CACHE.get(k.name)));
  const listings = [];
  const sales = [];
  let oldestUpdatedAt = null;
  for (const raw of entries) {
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (Array.isArray(parsed.listings)) listings.push(...parsed.listings);
    if (Array.isArray(parsed.sales)) sales.push(...parsed.sales);
    if (parsed.updatedAt && (oldestUpdatedAt === null || parsed.updatedAt < oldestUpdatedAt)) {
      oldestUpdatedAt = parsed.updatedAt;
    }
  }
  return JSON.stringify({ listings, sales, updatedAt: oldestUpdatedAt, failed: [] });
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

    if (url.pathname === "/v2/spawn-summary") {
      const cache = caches.default;
      const summaryCacheKey = new Request(url.origin + "/__spawn-summary-merged", { method: "GET" });
      const cachedSummary = await cache.match(summaryCacheKey);
      const body = cachedSummary ? await cachedSummary.text() : await buildSpawnSummary(env);
      if (!cachedSummary) {
        const toCache = new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" },
        });
        ctx.waitUntil(cache.put(summaryCacheKey, toCache));
      }
      return new Response(body, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // Debug endpoint, same as ZurVault's /v2/__trigger-refresh — refresh one
    // collection's KV entry on demand instead of waiting for the cron cycle.
    if (url.pathname === "/v2/__trigger-refresh") {
      const symbol = url.searchParams.get("key");
      if (!symbol) {
        return new Response(JSON.stringify({ error: "missing ?key=<symbol>" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const col = SPAWN_COLLECTIONS.find((c) => c.symbol === symbol);
      if (!col) {
        return new Response(JSON.stringify({ error: `no SPAWN_COLLECTIONS entry with symbol "${symbol}"` }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const result = await refreshOneCollection(col, env);
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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

  // Cron Trigger expression set in the dashboard: */20 * * * *
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAllCollections(env));
  },
};
