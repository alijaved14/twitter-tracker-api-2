/**
 * Meme coin trending / narrative detection logic.
 *
 * HOW IT FINDS TRENDING MEME COINS & KILLER NARRATIVES
 * ─────────────────────────────────────────────────────
 *  1. Pull tweets from a curated KOL watchlist (src/kols.js) + run targeted
 *     meme coin searches on X (cashtags, "pump.fun", "just aped", etc.).
 *  2. Extract candidate tokens from tweet text:
 *       • Cashtags:          $[A-Z]{2,10}
 *       • Solana addresses:  base58, 32–44 chars
 *       • EVM addresses:     0x[a-f0-9]{40}
 *  3. Score each candidate with a velocity formula:
 *       score = mentions
 *             * log10(sum_followers + 10)
 *             * kolTierBoost
 *             * verifiedBoost
 *             * engagementFactor (likes+retweets+views/1k)
 *             * freshnessFactor  (recent tweets weigh more)
 *  4. Cluster tickers into narratives via NARRATIVE_KEYWORDS + co-mention.
 *  5. Flag "new signals" — tickers first seen in the last 6 hours.
 *  6. Cache results for 60 s so the API is cheap to poll.
 */

import { searchTweets, getUserTweets, enrichTweets, isReady } from './scraper.js';
import { TIER_1, TIER_2, TIER_3, ALL_KOLS, kolTier, NARRATIVE_KEYWORDS } from './kols.js';
import { TTLCache } from './cache.js';

const resultCache = new TTLCache();
const CACHE_TTL   = 60_000; // 1 minute

// ─── Background worker state ────────────────────────────────────────────────
// Instead of scraping inline on every request (which exceeds 45s), a single
// background worker keeps this cache warm. API handlers serve from the cache
// instantly — first call on cold start returns whatever is there (maybe []).
let cachedRanked     = [];     // ranked ticker list
let cachedTweets     = [];     // raw enriched tweets last fetched
let lastRefreshedAt  = 0;
let refreshInFlight  = false;

// Track first-seen timestamps across runs for "new signals"
const firstSeen = new Map(); // ticker → unix seconds

// ─── Extraction ──────────────────────────────────────────────────────────────

const CASHTAG_RE    = /\$([A-Z][A-Z0-9]{1,9})\b/g;
const SOL_ADDR_RE   = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const EVM_ADDR_RE   = /\b0x[a-fA-F0-9]{40}\b/g;

// Common cashtags that are NOT meme coins — filter out to avoid noise
const BLACKLIST = new Set([
  'BTC', 'ETH', 'SOL', 'USD', 'USDT', 'USDC', 'BNB', 'XRP', 'ADA', 'DOT',
  'AVAX', 'MATIC', 'LINK', 'TRX', 'LTC', 'DAI', 'ATOM', 'NEAR', 'APT', 'OP',
  'ARB', 'SUI', 'TON', 'TIA', 'SEI', 'INJ', 'ICP', 'FTM', 'ALGO', 'XLM',
  'SPY', 'QQQ', 'NVDA', 'TSLA', 'AAPL', 'MSFT', 'GOOG', 'AMZN', 'META',
  'US', 'USA', 'CEO', 'IPO', 'ATH', 'ATL',
]);

export function extractCandidates(text = '') {
  const out = new Set();
  for (const m of text.matchAll(CASHTAG_RE)) {
    const tag = m[1].toUpperCase();
    if (!BLACKLIST.has(tag)) out.add(`$${tag}`);
  }
  for (const m of text.matchAll(EVM_ADDR_RE))  out.add(m[0].toLowerCase());
  for (const m of text.matchAll(SOL_ADDR_RE)) {
    // Avoid matching random base58-looking strings inside URLs
    if (m[0].length >= 32 && m[0].length <= 44 && !/^https?/i.test(m[0])) {
      out.add(m[0]);
    }
  }
  return [...out];
}

// ─── Narrative bucketing ─────────────────────────────────────────────────────

export function detectNarratives(text = '') {
  const lower = text.toLowerCase();
  const hits = [];
  for (const [name, kws] of Object.entries(NARRATIVE_KEYWORDS)) {
    if (kws.some(k => lower.includes(k))) hits.push(name);
  }
  return hits;
}

// ─── Data pulls ──────────────────────────────────────────────────────────────

// Queries that catch meme coin mentions globally (not just from KOL watchlist)
const MEME_QUERIES = [
  '(pump.fun OR pumpfun OR "just aped" OR "new meme") min_faves:20 -filter:replies',
  '(memecoin OR "meme coin" OR "meta is") (solana OR base OR sol) min_faves:15 -filter:replies',
  '"$" (10x OR 100x OR ath OR moonshot OR breakout) min_faves:25 -filter:replies',
  '(new narrative OR "killer narrative" OR "next meta") min_faves:10 -filter:replies',
];

// SMALL batch — the scraper lib serializes internally, so 30 parallel
// iterators stall. Keep KOL pulls lean; the targeted searches do most of
// the work for finding trending coins anyway.
async function fetchKolTweets(perAccount = 4) {
  const picks = ALL_KOLS.slice(0, 6);
  console.log(`[tracker] KOL fetch: ${picks.length} accounts × ${perAccount}`);
  const results = await Promise.allSettled(
    picks.map(u => getUserTweets(u, perAccount, 6_000))
  );
  const ok = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
  console.log(`[tracker] KOL fetch done: ${ok.length} tweets`);
  return ok;
}

async function fetchMemeSearches() {
  console.log(`[tracker] meme searches: ${MEME_QUERIES.length} queries`);
  // Sequentially — parallel stalls the scraper lib. Each is capped at 10s.
  const out = [];
  for (const q of MEME_QUERIES) {
    try {
      const tweets = await searchTweets(q, 15, 'latest', 10_000);
      out.push(...tweets);
    } catch (err) {
      console.warn(`[tracker] search failed: ${err.message}`);
    }
  }
  console.log(`[tracker] meme searches done: ${out.length} tweets`);
  return out;
}

// ─── Main aggregation ────────────────────────────────────────────────────────

function scoreTweet(tweet) {
  const tier         = kolTier(tweet.username);
  const tierBoost    = tier === 1 ? 5 : tier === 2 ? 3 : tier === 3 ? 2 : tier === 4 ? 1.5 : 1;
  const verifyBoost  = tweet.isVerified ? 1.3 : 1;
  const follow       = Math.max(tweet.followersCount || 0, 1);
  const followBoost  = Math.log10(follow + 10);
  const engagement   = (tweet.likes || 0) + (tweet.retweets || 0) * 2 + (tweet.views || 0) / 1000;
  const engBoost     = 1 + Math.log10(engagement + 10);
  const ageSec       = Math.max(Date.now() / 1000 - (tweet.timestamp || 0), 1);
  const freshness    = 1 + Math.max(0, (6 * 3600 - ageSec) / (6 * 3600)); // up to 2x for <6h old
  return tierBoost * verifyBoost * followBoost * engBoost * freshness;
}

/**
 * Runs ONCE — does the expensive scraping and updates the in-memory cache.
 * Call repeatedly from a background interval, NOT from request handlers.
 */
async function refreshCache() {
  if (refreshInFlight) {
    console.log('[tracker] refresh skipped — previous run still in flight');
    return;
  }
  if (!isReady()) {
    console.log('[tracker] refresh skipped — scraper not ready');
    return;
  }
  refreshInFlight = true;
  const t0 = Date.now();

  try {
    console.log('[tracker] 🔄 refreshCache START');

    // Searches first (higher-value tweets), then KOLs.
    const searchResults = await fetchMemeSearches();
    const kolTweets     = await fetchKolTweets(4);

    // Merge + dedupe by tweet id
    const merged = [...kolTweets, ...searchResults];
    const unique = Array.from(new Map(merged.filter(t => t && t.id).map(t => [t.id, t])).values());

    // Enrich (best-effort — tight timeout)
    let tweets = unique;
    try {
      tweets = await Promise.race([
        enrichTweets(unique),
        new Promise((_, rej) => setTimeout(() => rej(new Error('enrich timeout')), 12_000)),
      ]);
    } catch (e) {
      console.warn(`[tracker] enrichment failed: ${e.message} — using raw tweets`);
    }

    const ranked = computeRanking(tweets, 100);
    cachedRanked    = ranked;
    cachedTweets    = tweets;
    lastRefreshedAt = Date.now();

    console.log(`[tracker] ✅ refreshCache DONE in ${Date.now() - t0}ms — ${tweets.length} tweets, ${ranked.length} tickers`);
  } catch (err) {
    console.error(`[tracker] ❌ refreshCache FAILED after ${Date.now() - t0}ms:`, err.message);
  } finally {
    refreshInFlight = false;
  }
}

/**
 * Start the background refresher. Called once at server startup.
 * Kicks off an immediate refresh, then runs every `intervalMs`.
 */
export function startTracker(intervalMs = 90_000) {
  console.log(`[tracker] starting background refresher (every ${intervalMs / 1000}s)`);
  // Fire-and-forget the first run; don't block server startup
  refreshCache().catch(e => console.error('[tracker] initial refresh error:', e.message));
  setInterval(() => {
    refreshCache().catch(e => console.error('[tracker] interval refresh error:', e.message));
  }, intervalMs);
}

/**
 * Pure ranking function — no I/O. Scores the given tweets and returns
 * a sorted list of trending tickers.
 */
function computeRanking(tweets, limit) {

  // 4. Build ticker → stats map
  const tickerMap = new Map(); // ticker → { mentions, score, tweets[], narratives Set, firstSeen }

  for (const tweet of tweets) {
    const candidates = extractCandidates(tweet.text);
    if (candidates.length === 0) continue;

    const weight     = scoreTweet(tweet);
    const narratives = detectNarratives(tweet.text);

    for (const ticker of candidates) {
      if (!tickerMap.has(ticker)) {
        tickerMap.set(ticker, {
          ticker,
          mentions:   0,
          score:      0,
          tweets:     [],
          narratives: new Set(),
          firstSeenAt: firstSeen.get(ticker) || tweet.timestamp || Math.floor(Date.now() / 1000),
        });
      }
      const entry = tickerMap.get(ticker);
      entry.mentions += 1;
      entry.score    += weight;
      entry.tweets.push(tweet);
      narratives.forEach(n => entry.narratives.add(n));

      if (!firstSeen.has(ticker)) {
        firstSeen.set(ticker, tweet.timestamp || Math.floor(Date.now() / 1000));
      }
    }
  }

  // 5. Rank
  const nowSec = Math.floor(Date.now() / 1000);
  const ranked = [...tickerMap.values()]
    .map(e => ({
      ticker:       e.ticker,
      mentions:     e.mentions,
      score:        Math.round(e.score * 100) / 100,
      narratives:   [...e.narratives],
      isNewSignal:  (nowSec - e.firstSeenAt) < 6 * 3600,
      firstSeenAt:  new Date(e.firstSeenAt * 1000).toISOString(),
      topTweets:    e.tweets
        .sort((a, b) => (b.likes + b.retweets * 2) - (a.likes + a.retweets * 2))
        .slice(0, 5),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return ranked;
}

// ─── Public API (all instant — serve from cache) ────────────────────────────

export function getTrendingMemeCoins({ limit = 25 } = {}) {
  return {
    lastRefreshedAt: lastRefreshedAt ? new Date(lastRefreshedAt).toISOString() : null,
    refreshing:      refreshInFlight,
    tickers:         cachedRanked.slice(0, limit),
  };
}

// Narrative-level view: clusters tickers by narrative bucket
export function getTrendingNarratives({ limit = 10 } = {}) {
  const tickers = cachedRanked;
  const buckets = new Map();

  for (const t of tickers) {
    const names = t.narratives.length ? t.narratives : ['Uncategorized'];
    for (const name of names) {
      if (!buckets.has(name)) {
        buckets.set(name, { narrative: name, score: 0, tickers: [], sampleTweets: [] });
      }
      const b = buckets.get(name);
      b.score += t.score;
      b.tickers.push({ ticker: t.ticker, mentions: t.mentions, score: t.score });
      if (b.sampleTweets.length < 3 && t.topTweets[0]) b.sampleTweets.push(t.topTweets[0]);
    }
  }

  return [...buckets.values()]
    .map(b => ({ ...b, score: Math.round(b.score * 100) / 100 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Early signals — tickers first seen in the last 6h, sorted by velocity
export function getNewSignals({ limit = 20 } = {}) {
  return cachedRanked.filter(t => t.isNewSignal).slice(0, limit);
}

// Cashtag drill-down — live but tightly timeout-bounded
export async function getTweetsByCashtag(ticker, count = 30) {
  const clean = ticker.replace(/^\$/, '').toUpperCase();
  const query = `$${clean} -filter:retweets`;
  const raw   = await searchTweets(query, count, 'latest', 10_000);
  try {
    return await Promise.race([
      enrichTweets(raw),
      new Promise((_, rej) => setTimeout(() => rej(new Error('enrich timeout')), 8_000)),
    ]);
  } catch {
    return raw;
  }
}

// Expose raw cached tweets (useful for debug / /api/live-style endpoint)
export function getCachedTweets(limit = 50) {
  return cachedTweets.slice(0, limit);
}
