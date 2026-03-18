/**
 * Fetch iHerb AI review tags via tw.iherb.com endpoint.
 *
 * Uses the ih-experiment cookie (A/B test flag) to access AI-generated
 * review highlight tags. This cookie is a static base64 JSON blob — it
 * doesn't expire, isn't IP-locked, and bypasses Cloudflare blocks.
 *
 * Endpoint: GET https://tw.iherb.com/ugc/api/tag/ai/{PRODUCT_ID}?lc=en-US&count=10
 *
 * Usage:
 *   node scripts/fetch-ai-tags.mjs                    # all from products.json
 *   node scripts/fetch-ai-tags.mjs --limit 100        # first 100
 *   node scripts/fetch-ai-tags.mjs --delay 500        # faster (default: 1000ms)
 *   node scripts/fetch-ai-tags.mjs --concurrency 3    # parallel requests
 *   node scripts/fetch-ai-tags.mjs --force             # re-fetch all
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SummariesDB } from "./lib/db.mjs";
import { exportProducts } from "./lib/export.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const PRODUCTS_FILE = join(DATA_DIR, "products.json");

const API_BASE = "https://tw.iherb.com/ugc/api";
const TAG_ENDPOINT = (id) => `${API_BASE}/tag/ai/${id}?lc=en-US&count=10`;

// Load the ih-experiment cookie from env var or .env file.
// This is an A/B test flag (base64 JSON) — not a session token.
// See SETUP.md for how to obtain it.
function loadExperimentCookie() {
  // 1. Check env var
  if (process.env.IH_EXPERIMENT) {
    return `ih-experiment=${process.env.IH_EXPERIMENT}`;
  }

  // 2. Check .env file
  const envPath = join(__dirname, "..", ".env");
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const match = line.match(/^IH_EXPERIMENT=(.+)$/);
      if (match) return `ih-experiment=${match[1].trim()}`;
    }
  }

  console.error("❌ Missing ih-experiment cookie.");
  console.error("   Set IH_EXPERIMENT env var or add it to .env file.");
  console.error("   See SETUP.md for instructions on how to obtain it.");
  process.exit(1);
}

const IH_EXPERIMENT_COOKIE = loadExperimentCookie();

// ── Parse args ──────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { limit: 0, batchSize: 0, batchOffset: 0, force: false, delay: 1000, concurrency: 2, maxAge: 0 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) opts.limit = parseInt(args[++i]);
    if (args[i] === "--batch-size" && args[i + 1]) opts.batchSize = parseInt(args[++i]);
    if (args[i] === "--batch-offset" && args[i + 1]) opts.batchOffset = parseInt(args[++i]);
    if (args[i] === "--delay" && args[i + 1]) opts.delay = parseInt(args[++i]);
    if (args[i] === "--concurrency" && args[i + 1]) opts.concurrency = parseInt(args[++i]);
    if (args[i] === "--max-age" && args[i + 1]) opts.maxAge = parseInt(args[++i]);
    if (args[i] === "--force") opts.force = true;
  }
  return opts;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadProducts() {
  if (!existsSync(PRODUCTS_FILE)) {
    console.error(`⚠ ${PRODUCTS_FILE} not found.`);
    console.error(`Run: node scripts/generate-from-distiller.mjs --db /path/to/distiller.db`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(PRODUCTS_FILE, "utf-8"));
}

// ── Fetch one product ───────────────────────────────────

async function fetchProduct(productId) {
  const resp = await fetch(TAG_ENDPOINT(productId), {
    headers: {
      Cookie: IH_EXPERIMENT_COOKIE,
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    if (text.includes("Just a moment") || resp.status === 403) {
      throw new Error("BLOCKED");
    }
    throw new Error(`HTTP ${resp.status}`);
  }

  const data = await resp.json();

  const tags = (data.tags || []).map((t, i) => ({
    name: t.name,
    count: t.count || 0,
    classification: t.classification, // 0=positive, 1=negative
    order: i,
  }));

  const positiveTags = tags.filter((t) => t.classification === 0).map((t) => t.name);
  const negativeTags = tags.filter((t) => t.classification === 1).map((t) => t.name);

  const summaryText = positiveTags.length > 0
    ? `Customers highlight: ${positiveTags.join(", ")}.` +
      (negativeTags.length > 0 ? ` Some note: ${negativeTags.join(", ")}.` : "")
    : null;

  return {
    productId,
    scrapedAt: new Date().toISOString(),
    summary: summaryText,
    tags,
    rating: null, // Not available from this endpoint
    topReviews: [],
    reviewCounts: {},
    error: null,
  };
}

// ── Main ────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  let products = loadProducts();

  if (opts.batchOffset > 0) products = products.slice(opts.batchOffset);
  if (opts.batchSize > 0) products = products.slice(0, opts.batchSize);
  if (opts.limit > 0) products = products.slice(0, opts.limit);

  const db = new SummariesDB();
  const stats = db.stats();

  console.log(`📦 Products: ${products.length}`);
  console.log(`📁 Already in DB: ${stats.total} (${stats.withTags} with tags)`);
  console.log(`⏱  Delay: ${opts.delay}ms | Concurrency: ${opts.concurrency}`);

  // Quick validation
  console.log("🔍 Testing endpoint...");
  try {
    const test = await fetchProduct(products[0].id);
    console.log(`✅ Works! Product ${products[0].id}: ${test.tags.length} tags (${test.tags.filter(t => t.classification === 0).length} positive, ${test.tags.filter(t => t.classification === 1).length} negative)\n`);
  } catch (e) {
    console.error(`❌ Test failed: ${e.message}`);
    process.exit(1);
  }

  let todo;
  if (opts.force) {
    todo = products;
  } else {
    const existing = db.getScrapedIds();
    todo = products.filter((p) => !existing.has(p.id));
    if (opts.maxAge > 0) {
      const staleIds = db.getStaleIds(opts.maxAge);
      const staleProducts = products.filter((p) => staleIds.has(p.id));
      todo = [...todo, ...staleProducts];
      console.log(`📅 Including ${staleProducts.length} stale products (older than ${opts.maxAge} days)`);
    }
  }

  console.log(`🔍 To fetch: ${todo.length}`);
  if (todo.length === 0) {
    console.log("Nothing to do.");
    db.close();
    return;
  }

  const etaMin = ((todo.length / opts.concurrency) * (opts.delay + 200) / 1000 / 60).toFixed(1);
  console.log(`⏳ Estimated: ~${etaMin} minutes\n`);

  const startTime = Date.now();
  let fetched = 0;
  let errors = 0;
  let blocked = 0;
  const fetchedIds = [];

  for (let i = 0; i < todo.length; i += opts.concurrency) {
    const batch = todo.slice(i, i + opts.concurrency);

    const results = await Promise.all(
      batch.map((p) =>
        fetchProduct(p.id).catch((e) => ({
          productId: p.id,
          scrapedAt: new Date().toISOString(),
          tags: [],
          error: e.message,
        }))
      )
    );

    for (const result of results) {
      if (result.error === "BLOCKED") {
        blocked++;
        if (blocked >= 5) {
          console.error(`\n❌ Rate limited. ${fetched} products saved. Re-run to continue.`);
          db.updateLastScrape();
          db.close();
          return;
        }
        // Back off
        console.log(`   ⏳ Rate limited, backing off 30s...`);
        await sleep(30000);
        continue;
      }
      db.saveResult(result);
      if (!result.error) {
        fetched++;
        fetchedIds.push(result.productId);
      } else {
        errors++;
      }
    }

    // Progress
    const idx = Math.min(i + opts.concurrency, todo.length);
    if (idx % 100 === 0 || idx === todo.length || idx <= opts.concurrency) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = fetched > 0 ? (fetched / (elapsed / 60)).toFixed(0) : "—";
      const last = results.find((r) => !r.error);
      const sample = last ? last.tags.slice(0, 3).map((t) => t.name).join(", ") : "";
      console.log(
        `[${idx}/${todo.length}] ${fetched} ok, ${errors} err (${elapsed}s, ${rate}/min) ${sample}`
      );
    }

    if (i + opts.concurrency < todo.length) {
      await sleep(opts.delay);
    }
  }

  db.updateLastScrape();
  const finalStats = db.stats();

  console.log(`\n🏁 Done! Fetched: ${fetched} | Errors: ${errors} | Blocked: ${blocked}`);
  console.log(`   DB: ${finalStats.total} total | ${finalStats.withTags} with tags`);

  // Auto-export fetched products to per-product JSON files
  if (fetchedIds.length > 0) {
    console.log(`\n📤 Exporting ${fetchedIds.length} products to data/scrape/...`);
    const { exported } = exportProducts(db, fetchedIds, "fetch-ai-tags");
    console.log(`   Exported ${exported} JSON files.`);
  }

  db.close();
}

main().catch(console.error);
