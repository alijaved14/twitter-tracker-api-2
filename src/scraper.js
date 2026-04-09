/**
 * Twitter scraper singleton — tailored for meme coin tracking.
 * Formats every tweet into the canonical shape expected by the frontend:
 *
 * profileImage, displayName, username, isVerified, followersCount,
 * timeParsed, text, photos[].url, likes, retweets, views, permanentUrl
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

// ─── Syndication API Helpers (No Auth / High Limits) ─────────────────────────

// 1. Get Avatars from Official Embed CDN
function getSyndicationToken(tweetId) {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

async function fetchSyndicationProfile(tweetId) {
  try {
    const token = getSyndicationToken(tweetId);
    const url = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${token}`;
    
    const res = await fetch(url);
    if (!res.ok) return null;
    
    const data = await res.json();
    const user = data.user;
    if (!user) return null;

    return {
      username: user.screen_name,
      name: user.name,
      avatar: user.profile_image_url_https?.replace('_normal', ''),
      followersCount: user.followers_count, 
      isVerified: user.is_blue_verified || user.verified || false,
    };
  } catch (err) {
    return null;
  }
}

// 2. Get Follower Counts from FixTweet/vxTwitter Public API
async function fetchSyndicationFollowers(usernames) {
  if (!usernames || usernames.length === 0) return {};
  try {
    const counts = {};
    
    // Process in batches of 5 to respect the free API limits
    for (let i = 0; i < usernames.length; i += 5) {
      const chunk = usernames.slice(i, i + 5);
      
      await Promise.all(chunk.map(async (uname) => {
        try {
          const res = await fetch(`https://api.fxtwitter.com/${uname}`, { 
            signal: AbortSignal.timeout(5000),
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
          });
          
          if (!res.ok) return;
          const data = await res.json();
          
          if (data && data.user && typeof data.user.followers === 'number') {
            counts[uname.toLowerCase()] = data.user.followers;
          }
        } catch (e) {
          // ignore individual timeouts
        }
      }));
    }
    return counts;
  } catch (err) {
    console.warn('[SyndicationFollowers] Error fetching batch follower counts', err.message);
    return {};
  }
}

// ─── Init / Auth ─────────────────────────────────────────────────────────────

export async function initScraper() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    scraper = new Scraper();
    const cookieEnv = process.env.TWITTER_COOKIES;

    try {
      if (!cookieEnv || !cookieEnv.trim()) {
        console.warn('⚠️ TWITTER_COOKIES env var is not set. Attempting fresh login...');
        
        if (!process.env.TWITTER_USERNAME || !process.env.TWITTER_PASSWORD) {
          throw new Error('TWITTER_USERNAME and TWITTER_PASSWORD must be set if cookies are empty.');
        }

        await scraper.login(
          process.env.TWITTER_USERNAME,
          process.env.TWITTER_PASSWORD,
          process.env.TWITTER_EMAIL
        );
        
        const cookies = await scraper.getCookies();
        const cookieStrings = cookies.map(c => c.toString());
        const base64Cookies = Buffer.from(JSON.stringify(cookieStrings)).toString('base64');
        
        console.log('\n========================================================================');
        console.log('✅ FRESH LOGIN SUCCESSFUL!');
        console.log('🚨 Copy the string below and paste it into TWITTER_COOKIES in Render:');
        console.log('\n' + base64Cookies + '\n');
        console.log('========================================================================\n');
        
        ready = await scraper.isLoggedIn();
      } else {
        // Load existing cookies
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

        if (!cookiesToSet.length) {
          throw new Error('No valid cookies could be parsed from TWITTER_COOKIES');
        }

        await scraper.setCookies(cookiesToSet);
        ready = await scraper.isLoggedIn();
      }

      console.log(ready ? '✅ Twitter session active' : '❌ Cookies loaded but session invalid');
    } catch (err) {
      console.error('❌ Init Error:', err.message);
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

  try {
    // 1. Try standard scraper first
    const res = await scraper.getProfile(username);
    const p = res?.value || res; 
    
    if (p && p.username) {
      const formatted = {
        username:       p.username,
        name:           p.name,
        avatar:         p.avatar,
        followersCount: p.followersCount || 0,
        isVerified:     p.isBlueVerified || p.isVerified || false,
      };
      profileCache.set(key, formatted, PROFILE_CACHE_TTL);
      return formatted;
    }
  } catch (err) {
    console.warn(`[getProfile] Scraper failed for ${username}, trying syndication fallback...`);
  }

  // 2. Fallback: Grab their latest tweet and extract profile via Syndication
  try {
    const tweetsIter = scraper.getTweets(username, 1);
    for await (const tweet of tweetsIter) {
      if (tweet.id) {
        const profile = await fetchSyndicationProfile(tweet.id);
        const followerData = await fetchSyndicationFollowers([username]);
        
        if (profile) {
           profile.followersCount = followerData[username.toLowerCase()] ?? profile.followersCount ?? 0;
           profileCache.set(key, profile, PROFILE_CACHE_TTL);
           return profile;
        }
      }
    }
  } catch (e) {
     // Ignore
  }

  throw new Error(`Profile fetch failed for ${username}`);
}

// ─── Canonical tweet formatter (matches the exact response schema) ───────────

export function formatTweet(tweet) {
  const likes    = tweet.likes    ?? tweet.likeCount    ?? tweet.favoriteCount ?? 0;
  const retweets = tweet.retweets ?? tweet.retweetCount ?? 0;
  const views    = tweet.views    ?? tweet.viewCount    ?? 0;

  const embeddedUser = tweet.user || tweet.author || {};
  const username = tweet.username || embeddedUser.screen_name || '';
  const embeddedAvatar =
    embeddedUser.profile_image_url_https ||
    embeddedUser.profile_image_url ||
    embeddedUser.avatar ||
    tweet.profileImageUrl ||
    tweet.avatar ||
    (username ? `https://unavatar.io/x/${username}` : null);

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

export async function enrichTweets(tweets, batchSize = 5) { // Keeps signature for safety, but we don't need batchSize anymore
  const uniqueUsernames = [...new Set(tweets.map(t => t.username).filter(Boolean))];
  
  // Only query FixTweet for users missing from the cache OR stuck with 0 followers
  const missingFollowers = uniqueUsernames.filter(uname => {
    const cached = profileCache.get(`profile:${uname.toLowerCase()}`);
    return !cached || !cached.followersCount; 
  });

  const followerData = await fetchSyndicationFollowers(missingFollowers);

  return Promise.all(tweets.map(async (tweet) => {
    const unameLower = tweet.username?.toLowerCase();
    const cacheKey = `profile:${unameLower}`;
    let profile = profileCache.get(cacheKey);

    // If completely uncached, fetch avatar via official CDN using the Tweet ID
    if (!profile && tweet.id) {
      profile = await fetchSyndicationProfile(tweet.id);
    }

    // Resolve the highest-priority follower count available
    const fetchedCount = followerData[unameLower];
    const realFollowers = (fetchedCount !== undefined && fetchedCount !== null) 
                          ? fetchedCount 
                          : (profile?.followersCount || tweet.followersCount || 0);

    // Save/Update the cache so we don't keep pinging the APIs
    if (profile) {
      profile.followersCount = realFollowers;
      profileCache.set(cacheKey, profile, PROFILE_CACHE_TTL);
    }

    const fallbackAvatar = tweet.username ? `https://unavatar.io/x/${tweet.username}` : null;

    return {
      ...tweet,
      profileImage:   profile?.avatar         || tweet.profileImage || fallbackAvatar,
      displayName:    profile?.name           || tweet.displayName  || tweet.username,
      followersCount: realFollowers,
      isVerified:     profile?.isVerified     || tweet.isVerified   || false,
    };
  }));
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
