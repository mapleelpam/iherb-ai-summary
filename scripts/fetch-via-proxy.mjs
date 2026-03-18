/**
 * Fetch iHerb review data via rotating proxy to avoid Cloudflare IP blocks.
 *
 * Supports multiple proxy strategies:
 *   1. PROXY_URL env var — any HTTP/HTTPS/SOCKS5 proxy (e.g. rotating residential)
 *   2. SCRAPING_API=scrapingbee — ScrapingBee API (1000 free credits, no CC needed)
 *   3. SCRAPING_API=scraperapi — ScraperAPI (5000 free credits)
 *   4. No proxy — direct fetch with longer delays (fallback)
 *
 * Usage:
 *   # Via ScrapingBee (free tier: 1000 credits, 1 credit per request with js_render=false)
 *   SCRAPING_API=scrapingbee SCRAPING_API_KEY=YOUR_KEY node scripts/fetch-via-proxy.mjs
 *
 *   # Via ScraperAPI (free tier: 5000 credits)
 *   SCRAPING_API=scraperapi SCRAPING_API_KEY=YOUR_KEY node scripts/fetch-via-proxy.mjs
 *
 *   # Via any HTTP proxy (e.g. rotating residential proxy)
 *   PROXY_URL=http://user:pass@proxy.example.com:8080 node scripts/fetch-via-proxy.mjs
 *
 *   # Direct (no proxy, conservative delay)
 *   node scripts/fetch-via-proxy.mjs --delay 3000
 *
 * Options:
 *   --limit N          Only fetch first N products
 *   --delay N          Ms between requests (default: 500 with proxy, 3000 without)
 *   --force            Re-fetch already-scraped products
 *   --batch-size N     Process N products in this batch
 *   --batch-offset N   Skip first N products
 *   --concurrency N    Parallel requests (default: 1, up to 5 with proxy)
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SummariesDB } from "./lib/db.mjs";
import { exportProducts } from "./lib/export.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const PRODUCTS_FILE = join(DATA_DIR, "products.json");

const BASE_API = "https://www.iherb.com/ugc/api";
const SCRAPING_API = process.env.SCRAPING_API || "";
const SCRAPING_API_KEY = process.env.SCRAPING_API_KEY || "";
const PROXY_URL = process.env.PROXY_URL || "";

// ── Parse args ──────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const hasProxy = !!(SCRAPING_API || PROXY_URL);
  const opts = {
    limit: 0,
    batchSize: 0,
    batchOffset: 0,
    force: false,
    delay: hasProxy ? 500 : 3000,
    concurrency: 1,
    maxAge: 0,
  };
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

// ── Proxy-aware fetch ───────────────────────────────────

async function proxyFetch(targetUrl) {
  let fetchUrl;
  let fetchOpts = {
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  };

  if (SCRAPING_API === "scrapingbee") {
    // ScrapingBee: 1 credit per request with render_js=false
    fetchUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPING_API_KEY}&url=${encodeURIComponent(targetUrl)}&render_js=false`;
  } else if (SCRAPING_API === "scraperapi") {
    // ScraperAPI: 1 credit per request without JS render
    fetchUrl = `https://api.scraperapi.com?api_key=${SCRAPING_API_KEY}&url=${encodeURIComponent(targetUrl)}&render=false`;
  } else if (PROXY_URL) {
    // Direct proxy — use node's native proxy support via env
    // Node 18+ respects HTTPS_PROXY for fetch
    fetchUrl = targetUrl;
    // For HTTP proxies, we need to use the proxy-agent approach
    // For simplicity, set env var and let Node handle it
    process.env.HTTPS_PROXY = PROXY_URL;
    process.env.HTTP_PROXY = PROXY_URL;
  } else {
    // Direct — no proxy
    fetchUrl = targetUrl;
  }

  const resp = await fetch(fetchUrl, fetchOpts);

  if (!resp.ok) {
    const text = await resp.text();
    if (text.includes("Just a moment") || resp.status === 403) {
      throw new Error(`CLOUDFLARE_BLOCK`);
    }
    throw new Error(`HTTP ${resp.status}`);
  }

  const text = await resp.text();
  if (text.includes("Just a moment") || text.includes("<!DOCTYPE")) {
    throw new Error(`CLOUDFLARE_BLOCK`);
  }

  return JSON.parse(text);
}

// ── Fetch one product ───────────────────────────────────

async function fetchProduct(productId) {
  const [tagsData, summaryData] = await Promise.all([
    proxyFetch(`${BASE_API}/product/${productId}/tags`).catch((e) => ({ _error: e.message })),
    proxyFetch(`${BASE_API}/product/${productId}/review/summary/v2`).catch((e) => ({ _error: e.message })),
  ]);

  // Check for Cloudflare blocks
  if (tagsData._error === "CLOUDFLARE_BLOCK" || summaryData._error === "CLOUDFLARE_BLOCK") {
    return { productId, cloudflareBlock: true };
  }

  const tags =
    tagsData.tags?.map((t, i) => ({
      name: t.name,
      count: t.count,
      classification: t.classification,
      order: i,
    })) || [];

  const rating = summaryData.rating || null;

  const topReviews = [];
  if (summaryData.languages) {
    for (const lang of summaryData.languages) {
      if (lang.topPositiveReview) {
        topReviews.push({
          type: "positive",
          language: lang.languageCode,
          title: lang.topPositiveReview.reviewTitle,
          text: lang.topPositiveReview.reviewText,
          rating: lang.topPositiveReview.ratingValue,
          helpfulYes: lang.topPositiveReview.helpfulYes,
          postedDate: lang.topPositiveReview.postedDate,
        });
      }
      if (lang.topCriticalReview) {
        topReviews.push({
          type: "critical",
          language: lang.languageCode,
          title: lang.topCriticalReview.reviewTitle,
          text: lang.topCriticalReview.reviewText,
          rating: lang.topCriticalReview.ratingValue,
          helpfulYes: lang.topCriticalReview.helpfulYes,
          postedDate: lang.topCriticalReview.postedDate,
        });
      }
    }
  }

  const reviewCounts = tagsData.perProductReviewCount || {};

  const positiveTags = tags.filter((t) => t.classification === 1).map((t) => t.name);
  const summaryText = positiveTags.length > 0
    ? `Customers highlight: ${positiveTags.join(", ")}.`
    : null;

  return {
    productId,
    scrapedAt: new Date().toISOString(),
    summary: summaryText,
    tags,
    rating: rating
      ? {
          averageRating: rating.averageRating,
          count: rating.count,
          distribution: {
            oneStar: rating.oneStar?.count,
            twoStar: rating.twoStar?.count,
            threeStar: rating.threeStar?.count,
            fourStar: rating.fourStar?.count,
            fiveStar: rating.fiveStar?.count,
          },
        }
      : null,
    topReviews: topReviews.filter((r) => r.language === "en-US"),
    reviewCounts,
    error: tagsData._error && summaryData._error
      ? `tags: ${tagsData._error}; summary: ${summaryData._error}`
      : null,
  };
}

// ── Process batch with concurrency ──────────────────────

async function processBatch(products, db, opts) {
  const startTime = Date.now();
  let fetched = 0;
  let errors = 0;
  let cfBlocks = 0;
  const fetchedIds = [];

  for (let i = 0; i < products.length; i += opts.concurrency) {
    const batch = products.slice(i, i + opts.concurrency);

    const results = await Promise.all(
      batch.map((p) => fetchProduct(p.id).catch((e) => ({
        productId: p.id,
        scrapedAt: new Date().toISOString(),
        error: e.message,
      })))
    );

    for (const result of results) {
      if (result.cloudflareBlock) {
        cfBlocks++;
        if (cfBlocks >= 5) {
          console.error(`\n❌ Cloudflare blocking detected (${cfBlocks} blocks). Your proxy may not be working.`);
          if (!SCRAPING_API && !PROXY_URL) {
            console.error("   Set SCRAPING_API=scrapingbee or PROXY_URL to use a proxy.");
          }
          return { fetched, errors, cfBlocks, stopped: true };
        }
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

    // Progress logging
    const idx = Math.min(i + opts.concurrency, products.length);
    if (idx % 50 === 0 || idx === products.length || cfBlocks > 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = fetched > 0 ? (fetched / (elapsed / 60)).toFixed(0) : "—";
      const lastResult = results[results.length - 1];
      const tagCount = lastResult?.tags?.length || 0;
      console.log(
        `[${idx}/${products.length}] ` +
        `${fetched} ok, ${errors} err, ${cfBlocks} blocked ` +
        `(${elapsed}s, ${rate}/min) ` +
        `last: ${tagCount} tags`
      );
    }

    // Delay between batches
    if (i + opts.concurrency < products.length) {
      await sleep(opts.delay);
    }
  }

  return { fetched, errors, cfBlocks, stopped: false, fetchedIds };
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

  // Determine proxy mode
  let mode = "direct (no proxy)";
  if (SCRAPING_API === "scrapingbee") mode = "ScrapingBee API";
  else if (SCRAPING_API === "scraperapi") mode = "ScraperAPI";
  else if (PROXY_URL) mode = `proxy: ${PROXY_URL.replace(/:[^:@]+@/, ":***@")}`;

  console.log(`🔧 Mode: ${mode}`);
  console.log(`📦 Products in batch: ${products.length}`);
  console.log(`📁 Existing in DB: ${stats.total} (${stats.withSummary} with data)`);
  console.log(`⏱  Delay: ${opts.delay}ms | Concurrency: ${opts.concurrency}`);

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

  console.log(`🔍 To fetch: ${todo.length}${opts.force ? " (--force)" : ""}`);

  if (todo.length === 0) {
    console.log("Nothing to do.");
    db.close();
    return;
  }

  const etaMin = ((todo.length / opts.concurrency * (opts.delay + 300)) / 1000 / 60).toFixed(1);
  console.log(`⏳ Estimated: ~${etaMin} minutes\n`);

  const result = await processBatch(todo, db, opts);

  db.updateLastScrape();
  const finalStats = db.stats();

  console.log(`\n🏁 Done!`);
  console.log(`   Fetched: ${result.fetched} | Errors: ${result.errors} | CF blocks: ${result.cfBlocks}`);
  console.log(`   DB total: ${finalStats.total} | with data: ${finalStats.withSummary} | with tags: ${finalStats.withTags}`);
  if (result.stopped) {
    console.log(`\n⚠  Stopped early due to Cloudflare blocks. Try with a proxy.`);
  }

  // Auto-export fetched products to per-product JSON files
  if (result.fetchedIds?.length > 0) {
    console.log(`\n📤 Exporting ${result.fetchedIds.length} products to data/scrape/...`);
    const { exported } = exportProducts(db, result.fetchedIds, "fetch-via-proxy");
    console.log(`   Exported ${exported} JSON files.`);
  }

  db.close();
}

main().catch(console.error);
