import { chromium } from "playwright";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SummariesDB } from "./lib/db.mjs";
import { exportProducts } from "./lib/export.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const PRODUCTS_FILE = join(DATA_DIR, "products.json");

const DEBUG = !!process.env.DEBUG;
const FORCE = process.argv.includes("--force");
const HEADLESS = !DEBUG;

// ── Parse args ──────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { batchSize: 0, batchOffset: 0, maxAge: 0 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--batch-size" && args[i + 1]) opts.batchSize = parseInt(args[++i]);
    if (args[i] === "--batch-offset" && args[i + 1]) opts.batchOffset = parseInt(args[++i]);
    if (args[i] === "--max-age" && args[i + 1]) opts.maxAge = parseInt(args[++i]);
  }
  return opts;
}

// ── Config ──────────────────────────────────────────────
const BASE_URL = "https://www.iherb.com";
const DELAY_BETWEEN_PAGES = [3000, 6000]; // random delay range (ms)
const PAGE_TIMEOUT = 30_000;

// ── Helpers ─────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay() {
  const [min, max] = DELAY_BETWEEN_PAGES;
  return Math.floor(Math.random() * (max - min) + min);
}

// ── Cloudflare Turnstile solver ─────────────────────────
// Detects the "Verify you are human" challenge and performs
// a click-and-hold (~6s) on the checkbox to pass it.
const CF_CHALLENGE_HOLD_MS = 6000;
const CF_MAX_RETRIES = 3;

async function solveTurnstileIfPresent(page) {
  // Look for the Cloudflare Turnstile iframe
  const cfFrame = page.frameLocator(
    'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]'
  );

  // Check if the challenge checkbox/button exists inside the iframe
  const checkbox = cfFrame.locator(
    'input[type="checkbox"], .cb-i, #challenge-stage, .ctp-checkbox-container, label'
  ).first();

  let visible;
  try {
    visible = await checkbox.isVisible({ timeout: 3000 });
  } catch {
    // No Turnstile iframe found — no challenge present
    return false;
  }

  if (!visible) return false;

  console.log("🤖 Cloudflare Turnstile challenge detected — solving...");

  for (let attempt = 1; attempt <= CF_MAX_RETRIES; attempt++) {
    try {
      // Get the bounding box of the checkbox element within its iframe
      const box = await checkbox.boundingBox({ timeout: 5000 });
      if (!box) {
        console.log(`   Attempt ${attempt}: Could not locate checkbox bounds, retrying...`);
        await sleep(2000);
        continue;
      }

      // Click-and-hold at the center of the checkbox
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;

      console.log(`   Attempt ${attempt}: Pressing and holding for ${CF_CHALLENGE_HOLD_MS / 1000}s...`);
      await page.mouse.move(x, y);
      await sleep(200);
      await page.mouse.down();
      await sleep(CF_CHALLENGE_HOLD_MS);
      await page.mouse.up();

      // Wait for the challenge to resolve
      await sleep(2000);

      // Check if challenge is gone
      let stillVisible;
      try {
        stillVisible = await checkbox.isVisible({ timeout: 2000 });
      } catch {
        stillVisible = false;
      }

      if (!stillVisible) {
        console.log("   ✅ Turnstile challenge solved!");
        return true;
      }

      console.log(`   Challenge still visible after attempt ${attempt}...`);
    } catch (e) {
      console.log(`   Attempt ${attempt} error: ${e.message}`);
    }

    await sleep(2000);
  }

  console.log("   ⚠️  Could not auto-solve Turnstile after retries. May need manual intervention.");
  return false;
}

function loadProducts() {
  if (!existsSync(PRODUCTS_FILE)) {
    console.error(`\n⚠ ${PRODUCTS_FILE} not found.`);
    console.error(`Run: node scripts/generate-from-distiller.mjs --db /path/to/distiller.db`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(PRODUCTS_FILE, "utf-8"));
}

// ── Extract AI summary from the rendered DOM ────────────
async function extractFromDOM(page) {
  return page.evaluate(async () => {
    const out = { summary: null, tags: [], productId: null };

    const ugcEl = document.querySelector("ugc-pdp-review");
    out.productId = ugcEl?.getAttribute("product-id") || null;

    // Wait up to 10s for shadow root to appear (Stencil lazy hydration)
    if (ugcEl) {
      for (let i = 0; i < 20; i++) {
        if (ugcEl.shadowRoot) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // ── Strategy 1: Read from shadow DOM ──
    const shadow = ugcEl?.shadowRoot;
    if (shadow) {
      const fullText = shadow.textContent?.trim() || "";
      const match = fullText.match(
        /Customers?\s+(generally|often|frequently|commonly|love|praise|appreciate)[\s\S]*?(?=Review highlights|$)/i
      );
      if (match) {
        out.summary = match[0].trim();
      }

      const tagEls = shadow.querySelectorAll(
        "[class*='tag'], [class*='highlight'], [class*='chip']"
      );
      out.tags = Array.from(tagEls)
        .map((el) => el.textContent?.trim())
        .filter((t) => t && t.length > 2 && t.length < 100);
    }

    // ── Strategy 2: Search the full visible page ──
    if (!out.summary) {
      const allElements = document.querySelectorAll("p, div, span, section");
      for (const el of allElements) {
        const text = el.textContent?.trim() || "";
        if (
          text.length > 80 &&
          text.length < 2000 &&
          /customers?\s+(generally|often|frequently|commonly|love|praise|appreciate)/i.test(text)
        ) {
          const cleaned = text.replace(/^What customers say/i, "").trim();
          const reviewHighlightsIdx = cleaned.indexOf("Review highlights");
          out.summary = reviewHighlightsIdx > 0
            ? cleaned.substring(0, reviewHighlightsIdx).trim()
            : cleaned;
          break;
        }
      }
    }

    return out;
  });
}

// ── Intercept API responses for tags ────────────────────
function setupApiInterceptor(page) {
  const captured = { reviewMeta: null, tags: null };

  page.on("response", async (response) => {
    const url = response.url();
    try {
      if (url.includes("/review/summary")) {
        const data = await response.json();
        captured.reviewMeta = {
          rating: data.rating,
          productId: data.productId,
        };
      }
      if (url.includes("/tag/ai/")) {
        captured.tags = await response.json();
      }
    } catch {
      // ignore parse errors
    }
  });

  return captured;
}

// ── Main ────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  let products = loadProducts();

  // Apply batch slicing
  if (opts.batchOffset > 0) {
    products = products.slice(opts.batchOffset);
  }
  if (opts.batchSize > 0) {
    products = products.slice(0, opts.batchSize);
  }

  const summariesDb = new SummariesDB();

  console.log(`📦 Products in this batch: ${products.length}`);
  if (opts.batchOffset || opts.batchSize) {
    console.log(`   Batch: offset=${opts.batchOffset}, size=${opts.batchSize || "all"}`);
  }

  const existingStats = summariesDb.stats();
  console.log(`📁 Existing in DB: ${existingStats.total} (${existingStats.withSummary} with summary, ${existingStats.errors} errors)`);

  // Filter out already-scraped products (unless --force or --max-age)
  let todo;
  if (FORCE) {
    todo = products;
  } else {
    const scrapedIds = summariesDb.getScrapedIds();
    todo = products.filter((p) => !scrapedIds.has(p.id));
    // Also re-scrape stale products if --max-age is set
    if (opts.maxAge > 0) {
      const staleIds = summariesDb.getStaleIds(opts.maxAge);
      const staleProducts = products.filter((p) => staleIds.has(p.id));
      todo = [...todo, ...staleProducts];
      console.log(`📅 Including ${staleProducts.length} stale products (older than ${opts.maxAge} days)`);
    }
  }

  console.log(`🔍 To scrape: ${todo.length}${FORCE ? " (--force)" : ""}\n`);

  if (todo.length === 0) {
    console.log("Nothing to do. All products in this batch already scraped.");
    console.log("Use --force to re-scrape: node scripts/scrape.mjs --force");
    summariesDb.close();
    return;
  }

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();

  // First visit: go to homepage to get cookies / pass Cloudflare
  console.log("🌐 Visiting iHerb homepage to establish session...");
  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
    await sleep(3000);

    const title = await page.title();
    if (title.includes("moment") || title.includes("Just a")) {
      console.log("⏳ Cloudflare challenge detected. Waiting for it to resolve...");
      console.log("   (If headless, try running with: npm run scrape:debug)\n");

      // Try auto-solving the Turnstile hold-button challenge
      await solveTurnstileIfPresent(page);

      await page.waitForURL("**/iherb.com/**", { timeout: 60_000 });
      await sleep(2000);
    }
    console.log(`✅ Session established: ${await page.title()}\n`);
  } catch (e) {
    console.error("❌ Failed to establish session:", e.message);
    console.log("   Try running with: npm run scrape:debug (opens visible browser)");
    await browser.close();
    summariesDb.close();
    return;
  }

  // Scrape each product
  let scraped = 0;
  const scrapedThisSession = [];
  for (let idx = 0; idx < todo.length; idx++) {
    const product = todo[idx];
    const productId = product.id;
    const productUrl = product.url.startsWith("http")
      ? product.url
      : `${BASE_URL}${product.url}`;

    console.log(`── [${idx + 1}/${todo.length}] Scraping product ${productId} ──`);

    const captured = setupApiInterceptor(page);

    try {
      await page.goto(productUrl, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT,
      });

      await sleep(2000);

      // Check for Turnstile challenge on product page
      const pageTitle = await page.title();
      if (pageTitle.includes("moment") || pageTitle.includes("Just a")) {
        await solveTurnstileIfPresent(page);
        await page.waitForURL("**/*.iherb.com/**", { timeout: 60_000 }).catch(() => {});
        await sleep(2000);
      }

      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

      // Scroll to trigger lazy-loaded components
      await page.evaluate(() => {
        const ugc = document.querySelector("ugc-pdp-review");
        if (ugc) {
          ugc.scrollIntoView({ behavior: "instant", block: "center" });
        } else {
          window.scrollTo(0, document.body.scrollHeight * 0.6);
        }
      });

      await sleep(5000);

      const domResult = await extractFromDOM(page);

      const entry = {
        productId: product.id,
        scrapedAt: new Date().toISOString(),
        url: await page.url(),
        summary: domResult.summary || null,
        tags: [],
        rating: captured.reviewMeta?.rating || null,
      };

      // Tags: prefer intercepted API data, fallback to DOM
      if (captured.tags?.tags && Array.isArray(captured.tags.tags)) {
        entry.tags = captured.tags.tags.map((t) => t.name);
      } else if (domResult.tags.length > 0) {
        entry.tags = domResult.tags;
      }

      summariesDb.saveResult(entry);
      scraped++;
      scrapedThisSession.push(product.id);

      const status = entry.summary ? "✅" : "⚠️  no summary found";
      console.log(`   ${status}`);
      if (entry.summary) {
        console.log(`   Summary: ${entry.summary.substring(0, 120)}...`);
      }
      if (entry.tags.length > 0) {
        console.log(`   Tags: [${entry.tags.join(", ")}]`);
      }
    } catch (e) {
      console.error(`   ❌ Error: ${e.message}`);
      summariesDb.saveResult({
        productId: product.id,
        scrapedAt: new Date().toISOString(),
        error: e.message,
      });
    }

    // Random delay between pages
    if (idx < todo.length - 1) {
      const delay = randomDelay();
      console.log(`   ⏳ Waiting ${delay}ms...\n`);
      await sleep(delay);
    }
  }

  summariesDb.updateLastScrape();
  const finalStats = summariesDb.stats();
  console.log(`\n🏁 Done! Scraped ${scraped} products this session.`);
  console.log(`   DB total: ${finalStats.total} | with summary: ${finalStats.withSummary} | errors: ${finalStats.errors}`);

  // Auto-export scraped products to per-product JSON files
  if (scrapedThisSession.length > 0) {
    console.log(`\n📤 Exporting ${scrapedThisSession.length} products to data/scrape/...`);
    const { exported } = exportProducts(summariesDb, scrapedThisSession, "scrape");
    console.log(`   Exported ${exported} JSON files.`);
  }

  summariesDb.close();
  await browser.close();
}

main().catch(console.error);
