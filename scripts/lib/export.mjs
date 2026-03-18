/**
 * Shared export logic: DB rows → data/scrape/{iherb_id}.json
 *
 * Each JSON file contains current data plus a history of scrape timestamps,
 * so git diffs show exactly when and what changed.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRAPE_DIR = join(__dirname, "..", "..", "data", "scrape");
const MAX_HISTORY = 20;

/**
 * Export products to individual JSON files.
 *
 * @param {import('./db.mjs').SummariesDB} db - open DB instance
 * @param {number[]} ids - product IDs to export (if empty, exports all successful)
 * @param {string} source - scrape source label (e.g. "scrape", "fetch-ai-tags")
 * @returns {{ exported: number, skipped: number }}
 */
export function exportProducts(db, ids, source = "unknown") {
  if (!existsSync(SCRAPE_DIR)) {
    mkdirSync(SCRAPE_DIR, { recursive: true });
  }

  const idsToExport = ids.length > 0 ? ids : db.getAllSuccessIds();
  const products = db.getProducts(idsToExport);

  let exported = 0;
  let skipped = 0;

  for (const product of products) {
    const filePath = join(SCRAPE_DIR, `${product.iherb_id}.json`);

    // Load existing file to preserve history
    let existing = null;
    if (existsSync(filePath)) {
      try {
        existing = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {
        existing = null;
      }
    }

    const now = product.scraped_at;
    const firstScraped = existing?.first_scraped || now;

    // Build history: prepend new entry, cap at MAX_HISTORY
    const prevHistory = existing?.history || [];
    const newEntry = { scraped_at: now, source };

    // Don't duplicate if same timestamp already in history
    const isDuplicate = prevHistory.some((h) => h.scraped_at === now);
    const history = isDuplicate
      ? prevHistory
      : [newEntry, ...prevHistory].slice(0, MAX_HISTORY);

    const output = {
      iherb_id: product.iherb_id,
      last_updated: now,
      first_scraped: firstScraped,
      source,
      data: {
        summary: product.summary || null,
        tags: product.tags,
        rating: product.rating,
      },
      history,
    };

    writeFileSync(filePath, JSON.stringify(output, null, 2) + "\n", "utf-8");
    exported++;
  }

  skipped = idsToExport.length - exported;
  return { exported, skipped };
}
