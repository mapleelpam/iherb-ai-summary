# Setup Guide

## Prerequisites

- Node.js >= 18
- Access to `distiller.db` (TheJournalism's main database)

## 1. Install Dependencies

```bash
npm install
npx playwright install chromium
```

## 2. Generate Product List

### Option A: From distiller.db (recommended)

```bash
# Top 100 products by review count
node scripts/generate-from-distiller.mjs --db /path/to/distiller.db --limit 100

# All 24K+ iHerb products
node scripts/generate-from-distiller.mjs --db /path/to/distiller.db

# Only products with 1000+ reviews
node scripts/generate-from-distiller.mjs --db /path/to/distiller.db --min-reviews 1000

# Specific product IDs
node scripts/generate-from-distiller.mjs --db /path/to/distiller.db --ids 62118,103274
```

### Option B: From iherb.db (legacy, requires NAS access)

```bash
mkdir -p input
curl -o input/iherb.db http://leana.local/forge/20260122/iherb.db
node scripts/generate-products.mjs --limit 100
```

Output: `data/products.json`

## 3. Run Scraper

```bash
# Headless mode (default — incremental, skips already-scraped products)
node scripts/scrape.mjs

# Debug mode (opens visible browser)
npm run scrape:debug

# Force re-scrape all products
node scripts/scrape.mjs --force

# Batch mode (for parallel scraping sessions)
node scripts/scrape.mjs --batch-offset 0 --batch-size 5000    # session 1
node scripts/scrape.mjs --batch-offset 5000 --batch-size 5000  # session 2
```

Results stored in `data/iherb_summaries.db` (SQLite).

## 4. Export (optional)

```bash
# Export SQLite → JSON
node scripts/export-json.mjs

# Only successful scrapes
node scripts/export-json.mjs --only-success
```

## Project Structure

```
iherb-ai-summary/
├── input/
│   └── iherb.db                    # Legacy: iHerb product DB (not in git)
├── data/
│   ├── products.json               # Product list to scrape (generated)
│   ├── iherb_summaries.db          # Scrape results — SQLite (not in git)
│   └── summaries.json              # Optional JSON export (not in git)
├── scripts/
│   ├── generate-from-distiller.mjs # Generate product list from distiller.db
│   ├── generate-products.mjs       # Legacy: generate from iherb.db
│   ├── scrape.mjs                  # Playwright scraper → SQLite
│   ├── export-json.mjs             # SQLite → JSON export
│   └── lib/
│       └── db.mjs                  # SQLite helper (SummariesDB class)
├── package.json
└── .gitignore
```

## Integration with TheJournalism

The scraper produces `data/iherb_summaries.db`. Copy or symlink this file to TheJournalism's `data/` directory:

```bash
ln -s /path/to/iherb-ai-summary/data/iherb_summaries.db /path/to/TheJournalism/data/iherb_summaries.db
```

TheJournalism's `SentimentDB` wrapper reads this file to enrich L0 extractors and L2 reports with consumer sentiment data.
