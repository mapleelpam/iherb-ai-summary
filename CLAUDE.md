# CLAUDE.md

## Project Overview

iherb-ai-summary — 從 iHerb 產品頁面批量爬取 AI 生成的評論摘要（"What Customers Say" 區塊），建立 `productId → AI summary` 的字典。

## Background

iHerb 產品頁面上有一個 "What Customers Say" 區塊，包含：
1. **AI 生成摘要** — 一段由 AI 根據所有評論生成的總結段落（如 "Customers generally praise..."）
2. **Review Highlights 標籤** — AI 生成的關鍵詞標籤（如 "No fishy taste", "Easy swallow"）

這些資料由 `api-comms.iherb.com` 提供，透過 `ugc-pdp-review` Web Component（Stencil.js）在前端渲染。

### API Endpoints (Reference)

| 端點 | 用途 |
|------|------|
| `/api/product/{id}/review/summary/v2` | 評論統計（評分、語言分布、精選評論），**不是** AI 摘要文字 |
| `/api/tag/ai/{id}` | AI 生成的 Review Highlights 標籤 |

> 注意：API 端點有 CORS 限制且受 Cloudflare 保護，無法直接用 curl/fetch 存取。必須透過真實瀏覽器。

### Data Source

產品清單來自 `input/iherb.db`（SQLite），約 25,276 筆產品資料，包含 `iherb_id`、`url_name`、`total_rating_count` 等欄位。DB 檔從內網 NAS 下載（見 SETUP.md）。

## Tech Stack

- **Node.js** (ESM, .mjs)
- **Playwright** — 瀏覽器自動化，繞過 Cloudflare 保護
- **better-sqlite3** — 讀取 iherb.db 產品資料

## Key Commands

```bash
npm run generate                        # 從 DB 生成 products.json
npm run scrape                          # Headless 爬取
npm run scrape:debug                    # 開瀏覽器視窗爬取
node scripts/scrape.mjs --force         # 強制重爬
node scripts/scrape.mjs --max-age 7    # 重爬超過 7 天的資料
npm run export:scrape                   # 手動匯出全部到 data/scrape/{id}.json
node scripts/generate-products.mjs --min-reviews 5000 --limit 50
```

## Data Storage

爬取結果以 per-product JSON 檔案儲存在 `data/scrape/{iherb_id}.json`，每個檔案包含：

```json
{
  "iherb_id": 62118,
  "last_updated": "2026-03-23T10:00:00.000Z",
  "first_scraped": "2026-03-20T09:20:31.941Z",
  "source": "fetch-ai-tags",
  "data": { "summary": "...", "tags": [...], "rating": {...} },
  "history": [
    { "scraped_at": "2026-03-23T...", "source": "fetch-ai-tags" }
  ]
}
```

- `history` 記錄每次爬取的時間戳和來源，上限 20 筆
- 每次爬取完成後自動匯出（不需手動 export）
- SQLite DB (`data/iherb_summaries.db`) 作為爬取時的工作資料庫，不進 git

## Continuous Updates

所有 scraper 都支援 `--max-age N`（天）旗標：
- 重新爬取 `scraped_at` 超過 N 天的產品
- 搭配 cron job 可持續更新：`node scripts/fetch-ai-tags.mjs --max-age 7`
- `--force` 強制重爬全部，`--max-age` 只重爬過期的

## Architecture Notes

- Scraper 的 AI 摘要文字提取**優先從 DOM 讀取**（web component 渲染後的文字），而非 API 回應
- `/review/summary/v2` 回傳的是評論統計資料（rating, top reviews），腳本只取其中的 rating
- `/tag/ai/{id}` 回傳的 tag 陣列才是 Review Highlights
- 爬蟲支援增量模式：已爬取的產品會跳過，除非使用 `--force` 或 `--max-age`
- `data/summaries.json` 不進 git，`input/` 不進 git
- `data/scrape/*.json` 進 git（per-product 爬取結果）
