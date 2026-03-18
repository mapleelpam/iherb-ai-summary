/**
 * Fast API-based fetcher for iHerb review data.
 * No browser automation needed — hits open API endpoints directly.
 *
 * Endpoints used (no auth required):
 *   /ugc/api/product/{id}/tags          → review highlight tags with counts + sentiment
 *   /ugc/api/product/{id}/review/summary/v2 → rating breakdown, top reviews, language counts
 *
 * Usage:
 *   node scripts/fetch-reviews.mjs                         # fetch all from products.json
 *   node scripts/fetch-reviews.mjs --limit 100             # first 100
 *   node scripts/fetch-reviews.mjs --batch-offset 1000 --batch-size 5000
 *   node scripts/fetch-reviews.mjs --force                 # re-fetch already-scraped
 *   node scripts/fetch-reviews.mjs --delay 500             # ms between requests (default: 200)
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
const DEFAULT_DELAY = 1000; // ms between requests — conservative to avoid Cloudflare rate limits

// ── Parse args ──────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { limit: 0, batchSize: 0, batchOffset: 0, force: false, delay: DEFAULT_DELAY, maxAge: 0 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) opts.limit = parseInt(args[++i]);
    if (args[i] === "--batch-size" && args[i + 1]) opts.batchSize = parseInt(args[++i]);
    if (args[i] === "--batch-offset" && args[i + 1]) opts.batchOffset = parseInt(args[++i]);
    if (args[i] === "--delay" && args[i + 1]) opts.delay = parseInt(args[++i]);
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

const MAX_RETRIES = 3;
const BACKOFF_BASE = 10_000; // 10s base backoff for rate limits

async function fetchJson(url, attempt = 1) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  });

  if (resp.status === 403) {
    // Cloudflare rate limit — back off and retry
    if (attempt <= MAX_RETRIES) {
      const backoff = BACKOFF_BASE * attempt + Math.random() * 5000;
      console.log(`   ⏳ Rate limited (403). Backing off ${(backoff / 1000).toFixed(0)}s (attempt ${attempt}/${MAX_RETRIES})...`);
      await sleep(backoff);
      return fetchJson(url, attempt + 1);
    }
    throw new Error(`Rate limited after ${MAX_RETRIES} retries: ${url}`);
  }

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }

  const text = await resp.text();
  if (text.includes("<!DOCTYPE") || text.includes("Just a moment")) {
    if (attempt <= MAX_RETRIES) {
      const backoff = BACKOFF_BASE * attempt + Math.random() * 5000;
      console.log(`   ⏳ Cloudflare challenge. Backing off ${(backoff / 1000).toFixed(0)}s...`);
      await sleep(backoff);
      return fetchJson(url, attempt + 1);
    }
    throw new Error(`Cloudflare challenge after ${MAX_RETRIES} retries`);
  }

  return JSON.parse(text);
}

async function fetchProduct(productId) {
  const [tagsData, summaryData] = await Promise.all([
    fetchJson(`${BASE_API}/product/${productId}/tags`).catch((e) => ({
      error: e.message,
    })),
    fetchJson(`${BASE_API}/product/${productId}/review/summary/v2`).catch(
      (e) => ({ error: e.message })
    ),
  ]);

  // Extract tags
  const tags =
    tagsData.tags?.map((t, i) => ({
      name: t.name,
      count: t.count,
      classification: t.classification, // 1=positive, 0=neutral/negative
      order: i,
    })) || [];

  // Extract rating
  const rating = summaryData.rating || null;

  // Extract top reviews (positive + critical)
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

  // Extract per-product review counts (from tags response)
  const reviewCounts = tagsData.perProductReviewCount || {};

  // Build summary text from tags (structured alternative to AI paragraph)
  const positiveTags = tags
    .filter((t) => t.classification === 1)
    .map((t) => t.name);
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
    error:
      tagsData.error && summaryData.error
        ? `tags: ${tagsData.error}; summary: ${summaryData.error}`
        : null,
  };
}

// ── Main ────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  let products = loadProducts();

  // Apply batch slicing
  if (opts.batchOffset > 0) products = products.slice(opts.batchOffset);
  if (opts.batchSize > 0) products = products.slice(0, opts.batchSize);
  if (opts.limit > 0) products = products.slice(0, opts.limit);

  const db = new SummariesDB();
  const stats = db.stats();

  console.log(`📦 Products in batch: ${products.length}`);
  console.log(`📁 Existing in DB: ${stats.total} (${stats.withSummary} with data, ${stats.errors} errors)`);
  console.log(`⏱  Delay: ${opts.delay}ms between requests`);

  // Filter already-fetched
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

  const startTime = Date.now();
  const eta = ((todo.length * (opts.delay + 300)) / 1000 / 60).toFixed(1);
  console.log(`⏳ Estimated time: ~${eta} minutes\n`);

  let fetched = 0;
  let errors = 0;
  const fetchedIds = [];

  for (let i = 0; i < todo.length; i++) {
    const product = todo[i];
    try {
      const result = await fetchProduct(product.id);
      db.saveResult(result);
      fetched++;
      fetchedIds.push(product.id);

      if (i % 100 === 0 || i === todo.length - 1) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate = (fetched / (elapsed / 60)).toFixed(0);
        console.log(
          `[${i + 1}/${todo.length}] ${product.id} — ` +
            `${result.tags.length} tags, ` +
            `${result.rating ? "rating " + result.rating.averageRating : "no rating"} ` +
            `(${elapsed}s, ${rate}/min)`
        );
      }
    } catch (e) {
      errors++;
      db.saveResult({
        productId: product.id,
        scrapedAt: new Date().toISOString(),
        error: e.message,
      });
      if (errors > 50 && errors > fetched) {
        console.error(`\n❌ Too many errors (${errors}). Stopping.`);
        break;
      }
    }

    if (i < todo.length - 1) {
      await sleep(opts.delay);
    }
  }

  db.updateLastScrape();
  const finalStats = db.stats();
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log(`\n🏁 Done in ${elapsed} minutes.`);
  console.log(`   Fetched: ${fetched} | Errors: ${errors}`);
  console.log(`   DB total: ${finalStats.total} | with data: ${finalStats.withSummary} | with tags: ${finalStats.withTags}`);

  // Auto-export fetched products to per-product JSON files
  if (fetchedIds.length > 0) {
    console.log(`\n📤 Exporting ${fetchedIds.length} products to data/scrape/...`);
    const { exported } = exportProducts(db, fetchedIds, "fetch-reviews");
    console.log(`   Exported ${exported} JSON files.`);
  }

  db.close();
}

main().catch(console.error);
