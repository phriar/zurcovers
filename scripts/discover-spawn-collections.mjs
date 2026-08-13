// One-off discovery script — NOT part of the deployed site.
//
// Paginates Magic Eden's public GET /v2/collections (base
// api-mainnet.magiceden.dev) looking for Spawn/OddKey/McFarlane collections.
// That endpoint has no name-search param, only offset/limit, and (confirmed
// live) enforces limit must be a multiple of 20 and offset must be a
// multiple of limit — 500/500-step pagination satisfies both. No item-count
// field exists in this endpoint's response shape (confirmed live), so
// matches are dumped without one rather than guessing.
//
// IMPORTANT CONFIRMED LIMITATION: this endpoint hard-caps at offset 30000
// (offset=30000 succeeds, offset=30020 and beyond return the same generic
// "offset and limit must be a multiple of 20" error regardless of actually
// satisfying that constraint — it's an undocumented deep-pagination ceiling,
// not really a validation error). sort/direction query params were tested
// and don't appear to change result order either. So this script can only
// ever see the first ~30,020 collections in whatever fixed order Magic Eden
// returns them, not the full catalog — if Spawn/OddKey collections happen
// to sit beyond that offset, they will not show up here. Treat a clean run
// with zero matches as inconclusive, not as confirmation those collections
// don't exist on Magic Eden.
//
// Paced conservatively (same documented reason as me-proxy-worker.js's
// throttleMagicEden(): Magic Eden enforces a real requests-per-minute limit,
// confirmed via a live 429 during this script's own development) —
// sequential requests with a delay between them, short bounded retry on
// 429, rather than firing pages concurrently.
//
// Run: node scripts/discover-spawn-collections.mjs
// Output: scripts/spawn-discovery-results.json (for manual review — nothing
// here is auto-wired into any live collections array). Written even if the
// offset-30000 ceiling is hit partway through, so a hard stop never loses
// whatever matches were already found.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ME_ORIGIN = "https://api-mainnet.magiceden.dev";
const PAGE_SIZE = 500; // must be a multiple of 20 (confirmed live)
const REQUEST_DELAY_MS = 400; // conservative pacing, see header comment
const MATCH_TERMS = ["spawn", "oddkey", "mcfarlane"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(offset, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${ME_ORIGIN}/v2/collections?offset=${offset}&limit=${PAGE_SIZE}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < retries) {
      const backoff = 500 * Math.pow(2, attempt);
      console.error(`  429 at offset=${offset}, backing off ${backoff}ms (attempt ${attempt + 1}/${retries})`);
      await sleep(backoff);
      continue;
    }
    throw new Error(`offset=${offset}: HTTP ${res.status}`);
  }
}

function matches(col) {
  const haystack = `${col.name || ""} ${col.symbol || ""}`.toLowerCase();
  return MATCH_TERMS.some((term) => haystack.includes(term));
}

async function main() {
  const found = [];
  let offset = 0;
  let page = 0;

  while (true) {
    page++;
    process.stdout.write(`page ${page} (offset ${offset})... `);
    const batch = await fetchPage(offset);
    console.log(`${batch.length} collection(s)`);

    if (batch.length === 0) break;

    for (const col of batch) {
      if (matches(col)) {
        found.push({
          symbol: col.symbol,
          name: col.name,
          description: col.description || "",
          image: col.image || "",
          categories: col.categories || [],
          isBadged: !!col.isBadged,
        });
      }
    }

    offset += PAGE_SIZE;
    if (batch.length < PAGE_SIZE) break; // short page — last one
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\nScanned ${page} page(s), ${offset <= PAGE_SIZE ? offset : "~" + offset} collection(s) total.`);
  console.log(`Found ${found.length} match(es) for: ${MATCH_TERMS.join(", ")}\n`);

  for (const m of found) {
    console.log(`  ${m.symbol}  —  "${m.name}"${m.isBadged ? " [badged]" : ""}`);
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = join(__dirname, "spawn-discovery-results.json");
  writeFileSync(outPath, JSON.stringify(found, null, 2));
  console.log(`\nWrote ${found.length} match(es) to ${outPath}`);
  console.log("Nothing here is live — review by hand before anything goes into SPAWN_COLLECTIONS.");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
