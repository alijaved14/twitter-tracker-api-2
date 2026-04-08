# twitter-tracker-api-2

Meme coin trending & narrative tracker. Finds the **killer narratives** and **early meme coins** bubbling up on X by scraping a curated KOL watchlist + targeted meme-coin searches, extracting cashtags/contract addresses, and scoring them with a velocity formula.

Companion service to [`twitter-tracker-api`](https://github.com/alijaved14/twitter-tracker-api) — this one focuses purely on meme coin discovery logic.

## Response shape (every tweet)

```json
{
  "profileImage":   "https://pbs.twimg.com/profile_images/.../abc.jpg",
  "displayName":    "Ansem",
  "username":       "blknoiz06",
  "isVerified":     true,
  "followersCount": 892341,
  "timeParsed":     "2026-04-09T14:32:11.000Z",
  "text":           "$WIF about to send. this narrative isn't done.",
  "photos":         [{ "url": "https://pbs.twimg.com/media/xyz.jpg" }],
  "likes":          4821,
  "retweets":       612,
  "views":          238910,
  "permanentUrl":   "https://x.com/blknoiz06/status/1234567890"
}
```

Every field is a **real value** pulled from X — no placeholder zeros. `profileImage`, `displayName`, `followersCount`, and `isVerified` are enriched via a per-user profile lookup (cached 10 min) so they are always populated even when the raw tweet payload omits them.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness probe |
| GET | `/api/memecoins/trending?limit=25` | Ranked trending meme coin tickers |
| GET | `/api/memecoins/narratives?limit=10` | Narrative-level clusters (AI agents, dogs, frogs, …) |
| GET | `/api/memecoins/new?limit=20` | Brand-new signals — tickers first seen in the last 6 h |
| GET | `/api/memecoins/cashtag/:ticker?count=30` | All recent tweets mentioning `$TICKER` |
| GET | `/api/kols/feed?per=5` | Merged newest-first feed of the curated KOL watchlist |
| GET | `/api/kols/list` | The KOL watchlist itself |
| GET | `/api/tweets/user/:username?count=20` | Latest tweets from one account |
| GET | `/api/debug` | Internal state |

Auth: if `API_SECRET` is set, every `/api/*` request must send `Authorization: Bearer <API_SECRET>`.

## How it finds trending meme coins

1. **KOL watchlist** — `src/kols.js` ships a tiered list of ~50 crypto KOLs (Ansem, Murad, Hsaka, frankdegods, Cobratate, …), Solana degens, and scanner accounts (pumpdotfun, dexscreener, GMGN_AI).
2. **Targeted searches** — in parallel with the KOL pulls, it runs meme-coin-focused X searches (`pump.fun`, `"just aped"`, `memecoin solana`, `"next meta"`, etc.) so it catches tokens KOLs haven't tweeted about *yet*.
3. **Candidate extraction** — from every tweet:
   - Cashtags: `$[A-Z]{2,10}` (major tickers like `$BTC/$ETH/$SOL` are blacklisted so they don't dominate the ranking)
   - Solana contracts: base58, 32–44 chars
   - EVM contracts: `0x[a-f0-9]{40}`
4. **Velocity scoring** — each mention contributes:

   ```
   score = Σ (tierBoost × verifyBoost × log10(followers) × log10(engagement) × freshness)
   ```

   - `tierBoost`: Tier-1 KOLs (Ansem/Murad) = 5×, Tier-2 = 3×, Tier-3 = 2×, unknown = 1×
   - `verifyBoost`: 1.3× for verified
   - `freshness`: up to 2× for tweets <6 h old
5. **Narrative clustering** — `NARRATIVE_KEYWORDS` buckets tweets into narratives (AI Agents, Dogs, Cats, Frogs/Pepe, Politics, Solana Memes, Fart/Toilet, …). `/api/memecoins/narratives` surfaces the winners at the narrative level.
6. **New-signal detection** — the service tracks `firstSeen` per ticker in-memory; anything first observed in the last 6 h is flagged `isNewSignal: true` and exposed via `/api/memecoins/new`.
7. **Caching** — results cached 60 s so the frontend can poll cheaply.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `TWITTER_COOKIES` | yes | Base64 JSON or raw cookie string for scraper session |
| `API_SECRET` | recommended | Bearer token for `/api/*` |
| `PORT` | no | Default 3000 |

## Local dev

```bash
npm install
TWITTER_COOKIES="<base64-cookie-json>" npm start
```

## Deploy

Push to GitHub and point Render at the repo — `render.yaml` is included for one-click Blueprint deploy.
