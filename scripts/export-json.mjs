/**
 * Export iherb_summaries.db → JSON for ad-hoc use.
 *
 * Usage:
 *   node scripts/export-json.mjs                  # → data/summaries.json
 *   node scripts/export-json.mjs --output out.json # → custom path
 *   node scripts/export-json.mjs --only-success    # exclude errors
 */
import Database from "better-sqlite3";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "data", "iherb_summaries.db");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { output: join(__dirname, "..", "data", "summaries.json"), onlySuccess: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) opts.output = args[++i];
    if (args[i] === "--only-success") opts.onlySuccess = true;
  }
  return opts;
}

const opts = parseArgs();
const db = new Database(DB_PATH, { readonly: true });

let query = "SELECT * FROM review_summaries";
if (opts.onlySuccess) {
  query += " WHERE error IS NULL AND summary_text IS NOT NULL";
}
query += " ORDER BY iherb_id";

const rows = db.prepare(query).all();
const tags = db.prepare("SELECT * FROM review_tags ORDER BY iherb_id, tag_order").all();

// Group tags by iherb_id
const tagMap = {};
for (const t of tags) {
  if (!tagMap[t.iherb_id]) tagMap[t.iherb_id] = [];
  tagMap[t.iherb_id].push(t.tag_name);
}

const result = {};
for (const row of rows) {
  result[String(row.iherb_id)] = {
    productId: row.iherb_id,
    scrapedAt: row.scraped_at,
    url: row.final_url,
    summary: row.summary_text,
    tags: tagMap[row.iherb_id] || [],
    rating: row.rating_avg != null ? { averageRating: row.rating_avg, count: row.rating_count } : null,
    error: row.error || undefined,
  };
}

db.close();

writeFileSync(opts.output, JSON.stringify(result, null, 2), "utf-8");
console.log(`✅ Exported ${Object.keys(result).length} entries → ${opts.output}`);
