#!/usr/bin/env node

/**
 * Warms the RSS feed digest cache by calling the Vercel RPC endpoint.
 *
 * When the digest cache in Redis (news:digest:v1:{variant}:{lang}) is cold,
 * the Vercel function fetches 50+ RSS feeds live, which can take 10-15s and
 * causes the health check "RSS Aggregation" to FAIL (threshold: 8s).
 *
 * This seed script calls each digest variant from EC2 with a generous timeout,
 * so the Vercel function populates the cache. Subsequent requests (including
 * the health check) get a cache hit and respond in <100ms.
 *
 * Runs in the "medium" seed group (every 2h). The digest cache TTL is 900s
 * (15 min), so the cache will expire between runs, but Vercel itself will
 * rebuild on the next user request — the seed just ensures a periodic warm-up
 * so the cache isn't cold for too long.
 */

import { loadEnvFile, CHROME_UA, logSeedResult, extendExistingTtl } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const VERCEL_URL = process.env.WM_VERCEL_URL || 'https://worldmonitor-six-ochre-42.vercel.app';
const RPC_PATH = '/api/news/v1/list-feed-digest';

// Variants to warm — 'full' is the main one, 'tech' is tested by health check
const VARIANTS = ['full', 'tech'];
const LANG = 'en';
const FETCH_TIMEOUT_MS = 30_000; // generous timeout for cold cache builds

// Redis keys that the Vercel function writes (for TTL extension on failure)
const CACHE_KEYS = VARIANTS.map(v => `news:digest:v1:${v}:${LANG}`);

async function warmVariant(variant) {
  const url = `${VERCEL_URL}${RPC_PATH}?variant=${variant}&lang=${LANG}`;
  console.log(`  Warming ${variant}...`);

  const t0 = Date.now();
  const resp = await fetch(url, {
    headers: {
      'User-Agent': CHROME_UA,
      'Origin': VERCEL_URL,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for variant=${variant}`);
  }

  const data = await resp.json();
  const elapsed = Date.now() - t0;
  const cats = data?.categories ? Object.keys(data.categories).length : 0;
  const items = data?.categories
    ? Object.values(data.categories).reduce((n, c) => n + (c?.items?.length || 0), 0)
    : 0;
  const statuses = data?.feedStatuses || {};
  const okCount = Object.values(statuses).filter(s => s === 'ok').length;
  const emptyCount = Object.values(statuses).filter(s => s === 'empty').length;
  const totalFeeds = Object.keys(statuses).length;

  console.log(`  ${variant}: ${cats} categories, ${items} items, ${okCount}/${totalFeeds} feeds ok (${emptyCount} empty), ${elapsed}ms`);

  return { variant, cats, items, elapsed };
}

async function seedRssDigest() {
  const startMs = Date.now();
  console.log('=== news:rss-digest Seed ===');
  console.log(`  Target:  ${VERCEL_URL}`);
  console.log(`  Variants: ${VARIANTS.join(', ')}`);

  const results = [];
  let anyFailed = false;

  for (const variant of VARIANTS) {
    try {
      const result = await warmVariant(variant);
      results.push(result);
    } catch (err) {
      console.error(`  ${variant} FAILED: ${err.message || err}`);
      anyFailed = true;
    }
  }

  if (results.length === 0) {
    console.error('  All variants failed');
    // Extend TTL on existing cache to prevent stale data expiry
    await extendExistingTtl(CACHE_KEYS, 1800);
    console.log(`\n=== Failed gracefully (${Math.round(Date.now() - startMs)}ms) ===`);
    process.exit(0);
  }

  const totalItems = results.reduce((n, r) => n + r.items, 0);
  const durationMs = Date.now() - startMs;
  logSeedResult('news', totalItems, durationMs, {
    variants: results.map(r => r.variant),
    mode: 'vercel-warm',
  });

  if (anyFailed) {
    console.warn('  Some variants failed — partial success');
  }

  console.log(`\n=== Done (${Math.round(durationMs)}ms) ===`);
}

seedRssDigest().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(`ERROR: ${err.message || err}`);
  process.exit(1);
});
