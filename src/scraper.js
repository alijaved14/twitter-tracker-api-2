/**
 * Twitter scraper singleton — tailored for meme coin tracking.
 * Formats every tweet into the canonical shape expected by the frontend:
 *
 *   profileImage, displayName, username, isVerified, followersCount,
 *   timeParsed, text, photos[].url, likes, retweets, views, permanentUrl
 */

import { Scraper, SearchMode } from '@the-convocation/twitter-scraper';
import { Cookie } from 'tough-cookie';
import { TTLCache } from './cache.js';

const profileCache = new TTLCache();
const tweetCache   = new TTLCache();

const TWEET_CACHE_TTL   = 30_000;       // 30 s
const PROFILE_CACHE_TTL = 10 * 60_000;  // 10 min

let scraper     = null;
let ready       = false;
let initPromise = null;

function parseCookieString(raw) {
  return raw.split(';').map(s => Cookie.parse(s.trim())).filter(Boolean);
}

export async function initScraper() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    scraper = new Scraper();
    const cookieEnv = process.env.TWITTER_COOKIES;

    if (!cookieEnv || !cookieEnv.trim()) {
      console.error('❌ TWITTER_COOKIES env var is not set.');
      return;
    }

    try {
      let cookiesToSet;
      try {
        const decoded = Buffer.from(cookieEnv.trim(), 'base64').toString('utf8');
        const arr     = JSON.parse(decoded);
        if (Array.isArray(arr)) {
          cookiesToSet = arr.map(c => Cookie.parse(c)).filter(Boolean);
          console.log('🍪 Loaded cookies from base64 JSON format');
        } else {
          throw new Error('not an array');
        }
      } catch {
        cookiesToSet = parseCookieString(cookieEnv.trim());
        console.log('🍪 Loaded cookies from plain string format');
      }

      if (!cookiesToSet.length) throw new Error('No valid cookies parsed');

      await scraper.setCookies(cookiesToSet);
      ready = await scraper.isLoggedIn();
      console.log(ready ? '✅ Twitter session active' : '❌ Cookies loaded but session invalid');
    } catch (err) {
      console.error('❌ Failed to load cookies:', err.message);
    }
  })();

  return initPromise;
}

export const isReady = () => ready;
export const getScraper = () => scraper;

// ─── Profile ─────────────────────────────────────────────────────────────────

export async function getProfile(username) {
  const key    = `profile:${username.toLowerCase()}`;
  const cached = profileCache.get(key);
  if (cached) return cached;

  const p = await scraper.getProfile(username);
  const formatted = {
    username:       p.username   || username,
    name:           p.name       || username,
    avatar:         p.avatar     || null,
    followersCount: p.followersCount ?? 0,
    isVerified:     p.isBlueVerified || p.isVerified || false,
  };

  profileCache.set(key, formatted, PROFILE_CACHE_TTL);
  return formatted;
}

// ─── Canonical tweet formatter (matches the exact response schema) ───────────

export function formatTweet(tweet) {
  const likes    = tweet.likes    ?? tweet.likeCount    ?? tweet.favoriteCount ?? 0;
  const retweets = tweet.retweets ?? tweet.retweetCount ?? 0;
  const views    = tweet.views    ?? tweet.viewCount    ?? 0;

  const embeddedUser = tweet.user || tweet.author || {};
  const embeddedAvatar =
    embeddedUser.profile_image_url_https ||
    embeddedUser.profile_image_url ||
    embeddedUser.avatar ||
    tweet.profileImageUrl ||
    tweet.avatar ||
    null;

  // Normalize photos to [{ url }] — what the schema requires
  const photos = Array.isArray(tweet.photos)
    ? tweet.photos.map(p => (typeof p === 'string' ? { url: p } : { url: p.url || p.src || '' }))
    : [];

  return {
    id:             tweet.id || tweet.id_str || null,
    profileImage:   embeddedAvatar,
    displayName:    embeddedUser.name || tweet.name || tweet.displayName || tweet.username || '',
    username:       tweet.username || embeddedUser.screen_name || '',
    isVerified:     embeddedUser.verified || embeddedUser.is_blue_verified || tweet.isBlueVerified || tweet.isVerified || false,
    followersCount: embeddedUser.followers_count ?? tweet.followersCount ?? 0,
    timeParsed:     tweet.timeParsed || (tweet.timestamp ? new Date(tweet.timestamp * 1000).toISOString() : null),
    timestamp:      tweet.timestamp || (tweet.timeParsed ? Math.floor(new Date(tweet.timeParsed).getTime() / 1000) : null),
    text:           tweet.text || tweet.full_text || '',
    photos,
    likes,
    retweets,
    views,
    permanentUrl:   tweet.permanentUrl || (tweet.id && tweet.username ? `https://x.com/${tweet.username}/status/${tweet.id}` : null),
  };
}

// Batched profile enrichment so displayName / profileImage / followersCount
// are never the default zero/empty values.
export async function enrichTweets(tweets, batchSize = 5) {
  const usernames = [...new Set(tweets.map(t => t.username).filter(Boolean))];
  const profileMap = {};

  const fetchOne = (u) =>
    Promise.race([
      getProfile(u),
      new Promise((_, reject) => setTimeout(() => reject(new Error('profile timeout')), 4_000)),
    ]);

  for (let i = 0; i < usernames.length; i += batchSize) {
    const batch = usernames.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(fetchOne));
    batch.forEach((u, idx) => {
      if (results[idx].status === 'fulfilled') {
        profileMap[u.toLowerCase()] = results[idx].value;
      }
    });
  }

  return tweets.map(tweet => {
    const p = profileMap[tweet.username?.toLowerCase()] || {};
    return {
      ...tweet,
      profileImage:   p.avatar         || tweet.profileImage || null,
      displayName:    p.name           || tweet.displayName || tweet.username,
      followersCount: p.followersCount ?? tweet.followersCount ?? 0,
      isVerified:     p.isVerified     || tweet.isVerified || false,
    };
  });
}

// ─── Raw search / user fetch helpers ─────────────────────────────────────────

/**
 * Drain an async iterator with a hard overall timeout. The underlying
 * scraper iterators can hang indefinitely on network stalls, so we race
 * each iteration against a timeout. Whatever was collected so far is returned.
 */
async function drainWithTimeout(iterable, count, timeoutMs, label) {
  const out = [];
  const iter = iterable[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;

  try {
    while (out.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        console.warn(`[${label}] overall timeout after ${timeoutMs}ms — got ${out.length}`);
        break;
      }
      const next = await Promise.race([
        iter.next(),
        new Promise(resolve => setTimeout(() => resolve({ __timeout: true }), remaining)),
      ]);
      if (next.__timeout) {
        console.warn(`[${label}] step timeout — got ${out.length}`);
        break;
      }
      if (next.done) break;
      out.push(next.value);
    }
  } catch (err) {
    console.error(`[${label}] error:`, err.message);
  } finally {
    try { if (typeof iter.return === 'function') await iter.return(); } catch {}
  }
  return out;
}

export async function searchTweets(query, count = 30, mode = 'latest', timeoutMs = 12_000) {
  const cacheKey = `search:${query}:${count}:${mode}`;
  const cached   = tweetCache.get(cacheKey);
  if (cached) return cached;

  const searchMode = mode === 'top' ? SearchMode.Top : SearchMode.Latest;
  const raw = await drainWithTimeout(
    scraper.searchTweets(query, count, searchMode),
    count,
    timeoutMs,
    `searchTweets:${query.slice(0, 30)}`
  );
  const tweets = raw.map(formatTweet);

  tweetCache.set(cacheKey, tweets, TWEET_CACHE_TTL);
  return tweets;
}

export async function getUserTweets(username, count = 20, timeoutMs = 8_000) {
  const cacheKey = `user:${username.toLowerCase()}:${count}`;
  const cached   = tweetCache.get(cacheKey);
  if (cached) return cached;

  const raw = await drainWithTimeout(
    scraper.getTweets(username, count),
    count,
    timeoutMs,
    `getUserTweets:${username}`
  );
  const tweets = raw.map(formatTweet);

  tweetCache.set(cacheKey, tweets, TWEET_CACHE_TTL);
  return tweets;
}

// ─── Cache maintenance ───────────────────────────────────────────────────────
setInterval(() => {
  profileCache.cleanup();
  tweetCache.cleanup();
}, 5 * 60_000);
