/**
 * Export iherb_summaries.db → per-product JSON files in data/scrape/.
 *
 * Each product gets its own file: data/scrape/{iherb_id}.json
 * with timestamps, current data, and scrape history.
 *
 * Usage:
 *   node scripts/export-scrape.mjs                # export all successful products
 *   node scripts/export-scrape.mjs --ids 1,2,3    # export specific products
 *   node scripts/export-scrape.mjs --source scrape # label the source
 */
import { SummariesDB } from "./lib/db.mjs";
import { exportProducts } from "./lib/export.mjs";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { ids: [], source: "export" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ids" && args[i + 1]) {
      opts.ids = args[++i].split(",").map(Number).filter(Boolean);
    }
    if (args[i] === "--source" && args[i + 1]) {
      opts.source = args[++i];
    }
  }
  return opts;
}

const opts = parseArgs();
const db = new SummariesDB();

const stats = db.stats();
console.log(`📁 DB: ${stats.total} total | ${stats.withSummary} with summary | ${stats.withTags} with tags`);

const { exported, skipped } = exportProducts(db, opts.ids, opts.source);
console.log(`✅ Exported ${exported} products to data/scrape/{id}.json (${skipped} skipped)`);

db.close();
