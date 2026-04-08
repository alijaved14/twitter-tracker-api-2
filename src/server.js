/**
 * twitter-tracker-api-2 — Meme coin trending & narrative tracker
 *
 * Endpoints
 * ─────────
 *  GET /health                         → liveness probe
 *  GET /api/memecoins/trending         → ranked trending meme coin tickers
 *  GET /api/memecoins/narratives       → narrative-level clusters (AI agents, dogs, frogs, etc.)
 *  GET /api/memecoins/new              → brand-new signals (first seen < 6h)
 *  GET /api/memecoins/cashtag/:ticker  → tweets for a single $TICKER
 *  GET /api/kols/feed?per=5            → merged KOL feed (enriched)
 *  GET /api/tweets/user/:username      → latest tweets for a user (enriched)
 *  GET /api/debug                      → health/status info
 *
 * Auth
 * ────
 *  If API_SECRET env var is set, /api/* requires `Authorization: Bearer <API_SECRET>`.
 *
 * Every tweet in every response uses the canonical shape:
 *   { profileImage, displayName, username, isVerified, followersCount,
 *     timeParsed, text, photos[].url, likes, retweets, views, permanentUrl }
 */

import express   from 'express';
import cors      from 'cors';
import rateLimit from 'express-rate-limit';

import { initScraper, isReady, getUserTweets, enrichTweets } from './scraper.js';
import {
  getTrendingMemeCoins,
  getTrendingNarratives,
  getNewSignals,
  getTweetsByCashtag,
  startTracker,
} from './memeCoinTracker.js';
import { ALL_KOLS } from './kols.js';

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.API_SECRET || '';

app.set('trust proxy', 1);
app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));

// Request logging — so we can see every incoming call in Render logs
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`→ ${req.method} ${req.originalUrl}`);
  res.on('finish', () => {
    console.log(`← ${req.method} ${req.originalUrl} ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// Hard request timeout — if any handler takes > 45s, kill it so the client
// doesn't hang forever. Returns 504 instead of waiting.
app.use((req, res, next) => {
  const t = setTimeout(() => {
    if (!res.headersSent) {
      console.error(`⏱  Request timeout: ${req.method} ${req.originalUrl}`);
      res.status(504).json({ error: 'Upstream timeout — scraper too slow. Try again.' });
    }
  }, 45_000);
  res.on('finish', () => clearTimeout(t));
  res.on('close',  () => clearTimeout(t));
  next();
});

const limiter = rateLimit({
  windowMs: 60_000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests — slow down' },
});
app.use('/api/', limiter);

// Global avatar walker — guarantees every tweet in every /api/* response
// has profileImage populated (falls back to unavatar.io/x/<username>).
app.use('/api/', avatarWalkerMiddleware);

function requireAuth(req, res, next) {
  if (!SECRET) return next();
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${SECRET}`) return next();
  return res.status(401).json({ error: 'Unauthorized — provide Bearer token' });
}

function scraperGuard(req, res, next) {
  if (!isReady()) {
    return res.status(503).json({ error: 'Twitter scraper not authenticated yet. Check logs.' });
  }
  next();
}

function parseCount(raw, max = 100, fallback = 25) {
  const n = parseInt(raw, 10);
  return isNaN(n) ? fallback : Math.min(Math.max(n, 1), max);
}

/**
 * Recursively walk any response payload and force every tweet-shaped
 * object to have a non-null profileImage. This is the single source of
 * truth for avatar population, regardless of caching or enrichment path.
 */
function forceProfileImage(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) { node.forEach(forceProfileImage); return node; }
  // Tweet-shaped: has username — ensure profileImage
  if (typeof node.username === 'string' && node.username) {
    if (!node.profileImage) {
      node.profileImage = `https://unavatar.io/x/${node.username}`;
    }
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') forceProfileImage(v);
  }
  return node;
}

/**
 * Express helper: wrap res.json so every payload gets walked through
 * forceProfileImage before being sent. Applied globally below.
 */
function avatarWalkerMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(forceProfileImage(body));
  next();
}

// ─── Health ──────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ready: isReady(), timestamp: new Date().toISOString() });
});

// ─── Meme coin endpoints ─────────────────────────────────────────────────────

/**
 * GET /api/memecoins/trending?limit=25
 * Ranked list of trending meme coin tickers with mentions, score, narratives,
 * and the top tweets driving the signal.
 */
app.get('/api/memecoins/trending', requireAuth, scraperGuard, (req, res) => {
  try {
    const limit  = parseCount(req.query.limit, 100, 25);
    const result = getTrendingMemeCoins({ limit });
    res.json({
      success:         true,
      lastRefreshedAt: result.lastRefreshedAt,
      refreshing:      result.refreshing,
      count:           result.tickers.length,
      tickers:         result.tickers,
    });
  } catch (err) {
    console.error('[/api/memecoins/trending]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/memecoins/narratives?limit=10
 * Groups trending tickers into narrative buckets (AI agents, dogs, etc.)
 */
app.get('/api/memecoins/narratives', requireAuth, scraperGuard, (req, res) => {
  try {
    const limit  = parseCount(req.query.limit, 50, 10);
    const result = getTrendingNarratives({ limit });
    res.json({ success: true, count: result.length, narratives: result });
  } catch (err) {
    console.error('[/api/memecoins/narratives]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/memecoins/new?limit=20
 * Brand-new signals — tickers first seen in the last 6 hours.
 */
app.get('/api/memecoins/new', requireAuth, scraperGuard, (req, res) => {
  try {
    const limit  = parseCount(req.query.limit, 50, 20);
    const result = getNewSignals({ limit });
    res.json({ success: true, count: result.length, signals: result });
  } catch (err) {
    console.error('[/api/memecoins/new]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/memecoins/cashtag/:ticker?count=30
 * Drill-down: recent tweets mentioning $TICKER.
 */
app.get('/api/memecoins/cashtag/:ticker', requireAuth, scraperGuard, async (req, res) => {
  try {
    const count  = parseCount(req.query.count, 100, 30);
    const tweets = await getTweetsByCashtag(req.params.ticker, count);
    res.json({ success: true, ticker: req.params.ticker.toUpperCase(), count: tweets.length, tweets });
  } catch (err) {
    console.error('[/api/memecoins/cashtag]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/kols/feed?per=5
 * Merged newest-first feed of the curated KOL watchlist, enriched.
 */
app.get('/api/kols/feed', requireAuth, scraperGuard, async (req, res) => {
  try {
    const per = parseCount(req.query.per, 20, 5);
    const picks = ALL_KOLS.slice(0, 20);
    const results = await Promise.allSettled(picks.map(u => getUserTweets(u, per)));
    const all = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const enriched = await enrichTweets(all);
    res.json({ success: true, count: enriched.length, accounts: picks, tweets: enriched });
  } catch (err) {
    console.error('[/api/kols/feed]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tweets/user/:username?count=20
 * Latest tweets from one account in the canonical schema.
 */
app.get('/api/tweets/user/:username', requireAuth, scraperGuard, async (req, res) => {
  try {
    const count    = parseCount(req.query.count, 50, 20);
    const raw      = await getUserTweets(req.params.username, count);
    const enriched = await enrichTweets(raw);
    res.json({ success: true, count: enriched.length, tweets: enriched });
  } catch (err) {
    console.error('[/api/tweets/user]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/kols/list — just returns the watchlist
 */
app.get('/api/kols/list', requireAuth, (_req, res) => {
  res.json({ success: true, count: ALL_KOLS.length, kols: ALL_KOLS });
});

/**
 * GET /api/debug
 */
app.get('/api/debug', (_req, res) => {
  res.json({
    ready: isReady(),
    env: {
      hasCookies: !!process.env.TWITTER_COOKIES,
      hasSecret:  !!process.env.API_SECRET,
    },
    timestamp: new Date().toISOString(),
  });
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, async () => {
  console.log(`🚀  twitter-tracker-api-2 listening on port ${PORT}`);
  console.log(`🔐  Auth: ${SECRET ? 'enabled' : 'disabled'}`);
  console.log('🐦  Initialising Twitter scraper...');
  await initScraper();
  console.log(`📡  Ready: ${isReady()}`);
  if (isReady()) {
    // Warm the meme coin tracker cache in the background — requests to
    // /api/memecoins/* are served instantly from this cache.
    startTracker(90_000);
  }
});

process.on('SIGTERM', () => { console.log('SIGTERM — shutting down'); process.exit(0); });
process.on('SIGINT',  () => { console.log('SIGINT  — shutting down'); process.exit(0); });
