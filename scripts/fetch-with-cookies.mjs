/**
 * Fetch iHerb review data using cookies from your real browser session.
 *
 * How to get cookies:
 *   1. Open https://www.iherb.com in Chrome/Firefox
 *   2. Open DevTools (F12) → Network tab
 *   3. Click any request to iherb.com
 *   4. In the Headers panel, find the "cookie:" request header
 *   5. Copy the entire cookie string
 *   6. Save it to a file: echo 'YOUR_COOKIE_STRING' > cookies.txt
 *
 * Usage:
 *   node scripts/fetch-with-cookies.mjs --cookies cookies.txt
 *   node scripts/fetch-with-cookies.mjs --cookies cookies.txt --limit 1000
 *   node scripts/fetch-with-cookies.mjs --cookies cookies.txt --concurrency 3 --delay 300
 *
 * The key cookie is `cf_clearance` — it lasts several hours after passing
 * Cloudflare's challenge in a real browser. With it, API requests go through
 * without any blocks.
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

// ── Parse args ──────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    cookies: null,
    limit: 0,
    batchSize: 0,
    batchOffset: 0,
    force: false,
    delay: 300,
    concurrency: 2,
    maxAge: 0,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cookies" && args[i + 1]) opts.cookies = args[++i];
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

function loadCookies(cookiePath) {
  if (!existsSync(cookiePath)) {
    console.error(`⚠ Cookie file not found: ${cookiePath}`);
    console.error(`\nHow to get cookies:`);
    console.error(`  1. Open https://www.iherb.com in your browser`);
    console.error(`  2. F12 → Network tab → click any request`);
    console.error(`  3. Copy the "cookie:" header value`);
    console.error(`  4. echo 'PASTE_HERE' > ${cookiePath}`);
    process.exit(1);
  }
  const raw = readFileSync(cookiePath, "utf-8").trim();
  // Validate it has cf_clearance
  if (!raw.includes("cf_clearance")) {
    console.warn("⚠ Warning: cookie string doesn't contain cf_clearance — Cloudflare may still block requests.");
  }
  return raw;
}

// ── Fetch with cookie auth ──────────────────────────────

async function fetchJson(url, cookieStr) {
  const resp = await fetch(url, {
    headers: {
      Cookie: cookieStr,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.iherb.com/",
    },
  });

  if (resp.status === 403) {
    const text = await resp.text();
    if (text.includes("Just a moment") || text.includes("cf_chl")) {
      throw new Error("COOKIE_EXPIRED");
    }
    throw new Error(`HTTP 403`);
  }

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const text = await resp.text();
  if (text.includes("<!DOCTYPE") || text.includes("Just a moment")) {
    throw new Error("COOKIE_EXPIRED");
  }

  return JSON.parse(text);
}

async function fetchProduct(productId, cookieStr) {
  const [tagsData, summaryData] = await Promise.all([
    fetchJson(`${BASE_API}/product/${productId}/tags`, cookieStr).catch((e) => ({ _error: e.message })),
    fetchJson(`${BASE_API}/product/${productId}/review/summary/v2`, cookieStr).catch((e) => ({ _error: e.message })),
  ]);

  if (tagsData._error === "COOKIE_EXPIRED" || summaryData._error === "COOKIE_EXPIRED") {
    return { productId, cookieExpired: true };
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
    reviewCounts: tagsData.perProductReviewCount || {},
    error:
      tagsData._error && summaryData._error
        ? `tags: ${tagsData._error}; summary: ${summaryData._error}`
        : null,
  };
}

// ── Main ────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();

  if (!opts.cookies) {
    console.error("Error: --cookies path/to/cookies.txt is required\n");
    console.error("Quick start:");
    console.error("  1. Open https://www.iherb.com in your browser");
    console.error("  2. F12 → Network → click any request → copy cookie header");
    console.error("  3. echo 'PASTE_COOKIE_HERE' > cookies.txt");
    console.error("  4. node scripts/fetch-with-cookies.mjs --cookies cookies.txt");
    process.exit(1);
  }

  const cookieStr = loadCookies(opts.cookies);
  console.log(`🍪 Loaded cookies (${cookieStr.length} chars, cf_clearance: ${cookieStr.includes("cf_clearance") ? "✅" : "❌"})`);

  // Quick validation — test one request
  console.log("🔍 Testing cookie validity...");
  try {
    const test = await fetchJson(`${BASE_API}/product/62118/tags`, cookieStr);
    if (test.tags) {
      console.log(`✅ Cookies work! Test product has ${test.tags.length} tags.\n`);
    } else {
      console.log(`✅ Cookies work! (no tags for test product, but API responded)\n`);
    }
  } catch (e) {
    if (e.message === "COOKIE_EXPIRED") {
      console.error("❌ Cookies expired or invalid. Please refresh:");
      console.error("   Open iherb.com in browser → F12 → copy fresh cookies");
      process.exit(1);
    }
    throw e;
  }

  let products = loadProducts();
  if (opts.batchOffset > 0) products = products.slice(opts.batchOffset);
  if (opts.batchSize > 0) products = products.slice(0, opts.batchSize);
  if (opts.limit > 0) products = products.slice(0, opts.limit);

  const db = new SummariesDB();
  const stats = db.stats();

  console.log(`📦 Products: ${products.length}`);
  console.log(`📁 Already in DB: ${stats.total} (${stats.withSummary} with data)`);
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

  console.log(`🔍 To fetch: ${todo.length}\n`);

  if (todo.length === 0) {
    console.log("Nothing to do.");
    db.close();
    return;
  }

  const startTime = Date.now();
  let fetched = 0;
  let errors = 0;
  let expired = false;
  const fetchedIds = [];

  for (let i = 0; i < todo.length; i += opts.concurrency) {
    const batch = todo.slice(i, i + opts.concurrency);

    const results = await Promise.all(
      batch.map((p) =>
        fetchProduct(p.id, cookieStr).catch((e) => ({
          productId: p.id,
          scrapedAt: new Date().toISOString(),
          error: e.message,
        }))
      )
    );

    for (const result of results) {
      if (result.cookieExpired) {
        console.error("\n❌ Cookies expired mid-run. Refresh and restart.");
        console.error(`   Progress saved — ${fetched} products fetched. Will resume from here.`);
        expired = true;
        break;
      }
      db.saveResult(result);
      if (!result.error) {
        fetched++;
        fetchedIds.push(result.productId);
      } else {
        errors++;
      }
    }

    if (expired) break;

    const idx = Math.min(i + opts.concurrency, todo.length);
    if (idx % 100 === 0 || idx === todo.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = fetched > 0 ? (fetched / (elapsed / 60)).toFixed(0) : "—";
      const lastOk = results.find((r) => !r.error && !r.cookieExpired);
      const tagInfo = lastOk?.tags?.length ? `${lastOk.tags.length} tags` : "";
      console.log(
        `[${idx}/${todo.length}] ${fetched} ok, ${errors} err (${elapsed}s, ${rate}/min) ${tagInfo}`
      );
    }

    if (i + opts.concurrency < todo.length) {
      await sleep(opts.delay);
    }
  }

  db.updateLastScrape();
  const finalStats = db.stats();

  console.log(`\n🏁 Done! Fetched: ${fetched} | Errors: ${errors}`);
  console.log(`   DB: ${finalStats.total} total | ${finalStats.withSummary} with data | ${finalStats.withTags} with tags`);

  // Auto-export fetched products to per-product JSON files
  if (fetchedIds.length > 0) {
    console.log(`\n📤 Exporting ${fetchedIds.length} products to data/scrape/...`);
    const { exported } = exportProducts(db, fetchedIds, "fetch-with-cookies");
    console.log(`   Exported ${exported} JSON files.`);
  }

  db.close();
}

main().catch(console.error);
