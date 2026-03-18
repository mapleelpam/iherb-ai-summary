/**
 * Generate products.json from distiller.db (TheJournalism's main database).
 * Eliminates the dependency on iherb.db from NAS.
 *
 * Usage:
 *   node scripts/generate-from-distiller.mjs --db ../LuminNexus-AlchemyMind-TheJournalism/data/distiller.db
 *   node scripts/generate-from-distiller.mjs --db /path/to/distiller.db --limit 100
 *   node scripts/generate-from-distiller.mjs --db /path/to/distiller.db --min-reviews 1000
 *   node scripts/generate-from-distiller.mjs --db /path/to/distiller.db --ids 62118,103274
 */
import Database from "better-sqlite3";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(__dirname, "..", "data", "products.json");

// ── Parse CLI args ──
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { db: null, limit: 0, minReviews: 0, ids: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db" && args[i + 1]) opts.db = args[++i];
    if (args[i] === "--limit" && args[i + 1]) opts.limit = parseInt(args[++i]);
    if (args[i] === "--min-reviews" && args[i + 1]) opts.minReviews = parseInt(args[++i]);
    if (args[i] === "--ids" && args[i + 1]) opts.ids = args[++i].split(",").map(Number);
  }
  return opts;
}

const opts = parseArgs();

if (!opts.db) {
  console.error("Error: --db path/to/distiller.db is required");
  console.error("Example: node scripts/generate-from-distiller.mjs --db ../LuminNexus-AlchemyMind-TheJournalism/data/distiller.db");
  process.exit(1);
}

const db = new Database(opts.db, { readonly: true });

let query = `
  SELECT
    CAST(source_id AS INTEGER) AS id,
    COALESCE(iherb_rating_count, 0) AS rating_count
  FROM Products
  WHERE source_type = 'iherb'
    AND source_id IS NOT NULL
`;
const params = [];

if (opts.ids) {
  query += ` AND CAST(source_id AS INTEGER) IN (${opts.ids.map(() => "?").join(",")})`;
  params.push(...opts.ids);
}

if (opts.minReviews > 0) {
  query += " AND COALESCE(iherb_rating_count, 0) >= ?";
  params.push(opts.minReviews);
}

// High-voice products first (scrape priority)
query += " ORDER BY COALESCE(iherb_rating_count, 0) DESC";

if (opts.limit > 0) {
  query += " LIMIT ?";
  params.push(opts.limit);
}

const rows = db.prepare(query).all(...params);
db.close();

// iHerb redirects /pr/{id} to the canonical slug URL
const products = rows.map((r) => ({
  id: r.id,
  url: `/pr/${r.id}`,
}));

writeFileSync(OUTPUT, JSON.stringify(products, null, 2), "utf-8");
console.log(`✅ Generated ${products.length} products → ${OUTPUT}`);
if (products.length > 0) {
  console.log(`   First: ${products[0].id} (${rows[0].rating_count} reviews)`);
  console.log(`   Last:  ${products[products.length - 1].id} (${rows[rows.length - 1].rating_count} reviews)`);
}
