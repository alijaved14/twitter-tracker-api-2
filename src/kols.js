/**
 * Curated list of crypto / meme coin KOLs on X.
 * These are the accounts whose mentions drive meme coin narratives.
 *
 * Tiers are used for scoring — Tier 1 callers move markets harder than Tier 3.
 */

// Tier 1 — heavyweight callers / market movers
export const TIER_1 = [
  'Ansem',           // blknoiz06 → Ansem
  'blknoiz06',
  'CryptoKaleo',
  'Cobratate',
  'notthreadguy',
  'hsakatrades',
  'gainzy222',
  'MustStopMurad',
  'CryptoHayes',
  'inversebrah',
];

// Tier 2 — well-known meme coin traders / alpha callers
export const TIER_2 = [
  'himgajria',
  'traderpow',
  'CryptoCred',
  'ThinkingUSD',
  'AltcoinGordon',
  'CL207',
  'icebergy_',
  'trader1sz',
  'FlowsTrades',
  'RookieXBT',
  'CryptoGodJohn',
  'SmallCapScience',
  'crypto_linn',
  'zachxbt',
  'DeeZe',
  'frankdegods',
  'beaniemaxi',
];

// Tier 3 — high-volume meme traders / Solana degens
export const TIER_3 = [
  'solanalegend',
  'aeyakovenko',   // Anatoly — Solana founder
  'rajgokal',
  'mononautical',
  'lookonchain',
  'arkhamintel',
  'nansen_ai',
  'gmoneyNFT',
  '0xRamonos',
  '0xSisyphus',
  'TylerDurden',
  'Overdose_AI',
  'thuggies_sol',
  'fityeth',
  'Tezzo100x',
  'pandajackson42',
  'cryptowizardd',
  'notcrypto_kk',
];

// Launchpad / scanner accounts that often break new coins
export const SCANNERS = [
  'pumpdotfun',
  'dexscreener',
  'birdeye_so',
  'photon_sol',
  'bullx_io',
  'GMGN_AI',
];

export const ALL_KOLS = [...new Set([...TIER_1, ...TIER_2, ...TIER_3, ...SCANNERS])];

export function kolTier(username) {
  if (!username) return 0;
  const u = username.toLowerCase();
  if (TIER_1.some(x => x.toLowerCase() === u)) return 1;
  if (TIER_2.some(x => x.toLowerCase() === u)) return 2;
  if (TIER_3.some(x => x.toLowerCase() === u)) return 3;
  if (SCANNERS.some(x => x.toLowerCase() === u)) return 4;
  return 0;
}

// Narrative keywords — used to bucket tickers into meta-narratives
export const NARRATIVE_KEYWORDS = {
  'AI Agents':    ['ai agent', 'ai16z', 'autonomous agent', 'agentic', 'virtuals', 'aixbt'],
  'Dogs':         ['doge', 'shib', 'wif', 'bonk', 'dog', 'puppy', 'shiba'],
  'Cats':         ['cat', 'popcat', 'mew', 'neiro', 'michi'],
  'Frogs/Pepe':   ['pepe', 'frog', 'pepecoin', 'brett'],
  'Politics':     ['trump', 'maga', 'biden', 'election', 'potus'],
  'Celebrity':    ['elon', 'musk', 'kanye', 'ye'],
  'Gaming':       ['gamefi', 'game coin', 'p2e', 'play to earn'],
  'RWA':          ['rwa', 'real world asset', 'tokenized'],
  'DeSci':        ['desci', 'decentralized science'],
  'Base Memes':   ['base chain', '$degen', 'higher', 'based'],
  'Solana Memes': ['sol memecoin', 'pump.fun', 'pumpfun', 'solana meme'],
  'Fart / Toilet':['fart', 'poop', 'toilet', 'chillguy'],
};
