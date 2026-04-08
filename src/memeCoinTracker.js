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

import { searchTweets, getUserTweets, enrichTweets } from './scraper.js';
import { TIER_1, TIER_2, TIER_3, ALL_KOLS, kolTier, NARRATIVE_KEYWORDS } from './kols.js';
import { TTLCache } from './cache.js';

const resultCache = new TTLCache();
const CACHE_TTL   = 60_000; // 1 minute

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

async function fetchKolTweets(perAccount = 8) {
  // Sample from ALL_KOLS — too many accounts at once will rate-limit
  const picks = ALL_KOLS.slice(0, 30);
  const results = await Promise.allSettled(
    picks.map(u => getUserTweets(u, perAccount))
  );
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);
}

async function fetchMemeSearches() {
  const results = await Promise.allSettled(
    MEME_QUERIES.map(q => searchTweets(q, 25, 'latest'))
  );
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);
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

export async function getTrendingMemeCoins({ limit = 25, enrich = true } = {}) {
  const cacheKey = `memetrend:${limit}:${enrich}`;
  const cached   = resultCache.get(cacheKey);
  if (cached) return cached;

  // 1. Pull from KOLs and targeted searches in parallel
  const [kolTweets, searchResults] = await Promise.all([
    fetchKolTweets(6),
    fetchMemeSearches(),
  ]);

  // 2. Merge + dedupe by tweet id
  const merged = [...kolTweets, ...searchResults];
  const unique = Array.from(new Map(merged.filter(t => t && t.id).map(t => [t.id, t])).values());

  // 3. Enrich so profileImage / displayName / followersCount are real values
  const tweets = enrich ? await enrichTweets(unique) : unique;

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

  resultCache.set(cacheKey, ranked, CACHE_TTL);
  return ranked;
}

// Narrative-level view: clusters tickers by narrative bucket
export async function getTrendingNarratives({ limit = 10 } = {}) {
  const tickers = await getTrendingMemeCoins({ limit: 100 });
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
export async function getNewSignals({ limit = 20 } = {}) {
  const tickers = await getTrendingMemeCoins({ limit: 100 });
  return tickers.filter(t => t.isNewSignal).slice(0, limit);
}

// Cashtag drill-down — all tweets for one ticker
export async function getTweetsByCashtag(ticker, count = 30) {
  const clean = ticker.replace(/^\$/, '').toUpperCase();
  const query = `$${clean} -filter:retweets`;
  const raw   = await searchTweets(query, count, 'latest');
  return enrichTweets(raw);
}
