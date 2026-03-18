/**
 * SQLite helper for iherb_summaries.db — the scraper's output database.
 */
import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = join(__dirname, "..", "..", "data", "iherb_summaries.db");

const SCHEMA_VERSION = "2.0";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS review_summaries (
    iherb_id        INTEGER PRIMARY KEY,
    summary_text    TEXT,
    scraped_at      TEXT NOT NULL,
    final_url       TEXT,
    rating_avg      REAL,
    rating_count    INTEGER,
    rating_1star    INTEGER,
    rating_2star    INTEGER,
    rating_3star    INTEGER,
    rating_4star    INTEGER,
    rating_5star    INTEGER,
    top_positive    TEXT,
    top_critical    TEXT,
    error           TEXT
);

CREATE TABLE IF NOT EXISTS review_tags (
    iherb_id       INTEGER NOT NULL,
    tag_name       TEXT NOT NULL,
    tag_count      INTEGER NOT NULL DEFAULT 0,
    tag_class      INTEGER NOT NULL DEFAULT 0,
    tag_order      INTEGER NOT NULL,
    PRIMARY KEY (iherb_id, tag_name),
    FOREIGN KEY (iherb_id) REFERENCES review_summaries(iherb_id)
);

CREATE TABLE IF NOT EXISTS _metadata (
    key   TEXT PRIMARY KEY,
    value TEXT
);
`;

// Migration: add columns if upgrading from v1.0
const MIGRATIONS = [
  "ALTER TABLE review_summaries ADD COLUMN rating_1star INTEGER",
  "ALTER TABLE review_summaries ADD COLUMN rating_2star INTEGER",
  "ALTER TABLE review_summaries ADD COLUMN rating_3star INTEGER",
  "ALTER TABLE review_summaries ADD COLUMN rating_4star INTEGER",
  "ALTER TABLE review_summaries ADD COLUMN rating_5star INTEGER",
  "ALTER TABLE review_summaries ADD COLUMN top_positive TEXT",
  "ALTER TABLE review_summaries ADD COLUMN top_critical TEXT",
  "ALTER TABLE review_tags ADD COLUMN tag_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE review_tags ADD COLUMN tag_class INTEGER NOT NULL DEFAULT 0",
];

export class SummariesDB {
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);

    // Run migrations (ignore if columns already exist)
    for (const sql of MIGRATIONS) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists — fine
      }
    }

    // Set/update schema version
    this.db
      .prepare("INSERT OR REPLACE INTO _metadata (key, value) VALUES (?, ?)")
      .run("schema_version", SCHEMA_VERSION);

    // Prepare statements
    this._upsertSummary = this.db.prepare(`
      INSERT OR REPLACE INTO review_summaries
        (iherb_id, summary_text, scraped_at, final_url,
         rating_avg, rating_count, rating_1star, rating_2star, rating_3star, rating_4star, rating_5star,
         top_positive, top_critical, error)
      VALUES
        (@iherb_id, @summary_text, @scraped_at, @final_url,
         @rating_avg, @rating_count, @rating_1star, @rating_2star, @rating_3star, @rating_4star, @rating_5star,
         @top_positive, @top_critical, @error)
    `);

    this._deleteTags = this.db.prepare(
      "DELETE FROM review_tags WHERE iherb_id = ?"
    );

    this._insertTag = this.db.prepare(`
      INSERT OR IGNORE INTO review_tags (iherb_id, tag_name, tag_count, tag_class, tag_order)
      VALUES (?, ?, ?, ?, ?)
    `);

    this._getScraped = this.db.prepare(
      "SELECT iherb_id FROM review_summaries WHERE error IS NULL"
    );
  }

  /** Save a single product result (summary + tags). */
  saveResult(entry) {
    const txn = this.db.transaction(() => {
      // Extract top English reviews as JSON strings
      const topPositive = entry.topReviews?.find((r) => r.type === "positive");
      const topCritical = entry.topReviews?.find((r) => r.type === "critical");

      this._upsertSummary.run({
        iherb_id: entry.productId,
        summary_text: entry.summary || null,
        scraped_at: entry.scrapedAt,
        final_url: entry.url || null,
        rating_avg: entry.rating?.averageRating ?? null,
        rating_count: entry.rating?.count ?? null,
        rating_1star: entry.rating?.distribution?.oneStar ?? null,
        rating_2star: entry.rating?.distribution?.twoStar ?? null,
        rating_3star: entry.rating?.distribution?.threeStar ?? null,
        rating_4star: entry.rating?.distribution?.fourStar ?? null,
        rating_5star: entry.rating?.distribution?.fiveStar ?? null,
        top_positive: topPositive ? JSON.stringify(topPositive) : null,
        top_critical: topCritical ? JSON.stringify(topCritical) : null,
        error: entry.error || null,
      });

      // Replace tags
      this._deleteTags.run(entry.productId);
      if (entry.tags && entry.tags.length > 0) {
        for (const tag of entry.tags) {
          const name = typeof tag === "string" ? tag : tag.name;
          const count = tag.count ?? 0;
          const cls = tag.classification ?? 0;
          const order = tag.order ?? 0;
          this._insertTag.run(entry.productId, name, count, cls, order);
        }
      }
    });
    txn();
  }

  /** Return Set of iherb_ids already successfully scraped. */
  getScrapedIds() {
    const rows = this._getScraped.all();
    return new Set(rows.map((r) => r.iherb_id));
  }

  /** Update last_scrape_at metadata. */
  updateLastScrape() {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO _metadata (key, value) VALUES ('last_scrape_at', ?)"
      )
      .run(new Date().toISOString());
  }

  /** Return basic stats. */
  stats() {
    const total = this.db
      .prepare("SELECT COUNT(*) as n FROM review_summaries")
      .get().n;
    const withSummary = this.db
      .prepare(
        "SELECT COUNT(*) as n FROM review_summaries WHERE summary_text IS NOT NULL AND error IS NULL"
      )
      .get().n;
    const withTags = this.db
      .prepare("SELECT COUNT(DISTINCT iherb_id) as n FROM review_tags")
      .get().n;
    const errors = this.db
      .prepare(
        "SELECT COUNT(*) as n FROM review_summaries WHERE error IS NOT NULL"
      )
      .get().n;
    return { total, withSummary, withTags, errors };
  }

  /** Return Set of iherb_ids where scraped_at is older than maxAgeDays. */
  getStaleIds(maxAgeDays) {
    const cutoff = new Date(Date.now() - maxAgeDays * 86400_000).toISOString();
    const rows = this.db
      .prepare(
        "SELECT iherb_id FROM review_summaries WHERE error IS NULL AND scraped_at < ?"
      )
      .all(cutoff);
    return new Set(rows.map((r) => r.iherb_id));
  }

  /** Return full product data for given iherb_ids (for JSON export). */
  getProducts(ids) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM review_summaries WHERE iherb_id IN (${placeholders}) AND error IS NULL`
      )
      .all(...ids);

    const tagRows = this.db
      .prepare(
        `SELECT * FROM review_tags WHERE iherb_id IN (${placeholders}) ORDER BY iherb_id, tag_order`
      )
      .all(...ids);

    const tagMap = {};
    for (const t of tagRows) {
      if (!tagMap[t.iherb_id]) tagMap[t.iherb_id] = [];
      tagMap[t.iherb_id].push({
        name: t.tag_name,
        classification: t.tag_class,
        count: t.tag_count,
      });
    }

    return rows.map((row) => ({
      iherb_id: row.iherb_id,
      scraped_at: row.scraped_at,
      summary: row.summary_text,
      tags: tagMap[row.iherb_id] || [],
      rating: row.rating_avg != null
        ? {
            average: row.rating_avg,
            count: row.rating_count,
            distribution: {
              "1": row.rating_1star,
              "2": row.rating_2star,
              "3": row.rating_3star,
              "4": row.rating_4star,
              "5": row.rating_5star,
            },
          }
        : null,
    }));
  }

  /** Return all product IDs that have tags (meaningful data). */
  getAllSuccessIds() {
    const rows = this.db
      .prepare("SELECT DISTINCT iherb_id FROM review_tags")
      .all();
    return rows.map((r) => r.iherb_id);
  }

  close() {
    this.db.close();
  }
}
