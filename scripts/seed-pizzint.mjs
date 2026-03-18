#!/usr/bin/env node

/**
 * Seeds the Pizza Index (PizzINT) data into Redis.
 *
 * When the Redis cache key `intel:pizzint:v1:gdelt` is cold, the Vercel
 * function fetches from pizzint.watch + GDELT batch API live, which can
 * take 3-5s — exceeding the health check's 3s PASS threshold.
 *
 * This seed script fetches the same upstream data from EC2 and writes
 * directly to Redis (direct-write mode), matching the data shape that
 * the Vercel cachedFetchJson handler expects.
 *
 * Runs in the "medium" seed group (every 2h). Cache TTL is 7800s (2h+10min)
 * to survive the full cron interval with buffer.
 */

import { loadEnvFile, CHROME_UA, getRedisCredentials, logSeedResult, extendExistingTtl, withRetry } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const PIZZINT_API = 'https://www.pizzint.watch/api/dashboard-data';
const GDELT_BATCH_API = 'https://www.pizzint.watch/api/gdelt/batch';
const DEFAULT_GDELT_PAIRS = 'usa_russia,russia_ukraine,usa_china,china_taiwan,usa_iran,usa_venezuela';

// Redis keys — must match server/worldmonitor/intelligence/v1/get-pizzint-status.ts
const CACHE_KEY_GDELT = 'intel:pizzint:v1:gdelt';
const CACHE_KEY_BASE = 'intel:pizzint:v1:base';
const CACHE_TTL = 7800; // 2h + 10min buffer — medium group runs every 2h

const FETCH_TIMEOUT_MS = 20_000;

async function fetchPizzintData() {
  console.log('  Fetching PizzINT dashboard data...');
  const resp = await fetch(PIZZINT_API, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!resp.ok) throw new Error(`PizzINT API returned ${resp.status}`);

  const raw = await resp.json();
  if (!raw.success || !raw.data) {
    throw new Error('PizzINT API returned no data');
  }

  const locations = raw.data.map((d) => ({
    placeId: d.place_id,
    name: d.name,
    address: d.address,
    currentPopularity: d.current_popularity,
    percentageOfUsual: d.percentage_of_usual ?? 0,
    isSpike: d.is_spike,
    spikeMagnitude: d.spike_magnitude ?? 0,
    dataSource: d.data_source,
    recordedAt: d.recorded_at,
    dataFreshness: d.data_freshness === 'fresh' ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
    isClosedNow: d.is_closed_now ?? false,
    lat: d.lat ?? 0,
    lng: d.lng ?? 0,
  }));

  const openLocations = locations.filter((l) => !l.isClosedNow);
  const activeSpikes = locations.filter((l) => l.isSpike).length;
  const avgPop = openLocations.length > 0
    ? openLocations.reduce((s, l) => s + l.currentPopularity, 0) / openLocations.length
    : 0;

  // DEFCON calculation — matches server-side logic exactly
  let adjusted = avgPop;
  if (activeSpikes > 0) adjusted += activeSpikes * 10;
  adjusted = Math.min(100, adjusted);
  let defconLevel = 5;
  let defconLabel = 'Normal Activity';
  if (adjusted >= 85) { defconLevel = 1; defconLabel = 'Maximum Activity'; }
  else if (adjusted >= 70) { defconLevel = 2; defconLabel = 'High Activity'; }
  else if (adjusted >= 50) { defconLevel = 3; defconLabel = 'Elevated Activity'; }
  else if (adjusted >= 25) { defconLevel = 4; defconLabel = 'Above Normal'; }

  const hasFresh = locations.some((l) => l.dataFreshness === 'DATA_FRESHNESS_FRESH');

  console.log(`  PizzINT: ${locations.length} locations, ${openLocations.length} open, ${activeSpikes} spikes, DEFCON ${defconLevel}`);

  return {
    defconLevel,
    defconLabel,
    aggregateActivity: Math.round(avgPop),
    activeSpikes,
    locationsMonitored: locations.length,
    locationsOpen: openLocations.length,
    updatedAt: Date.now(),
    dataFreshness: hasFresh ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
    locations,
  };
}

async function fetchGdeltPairs() {
  console.log('  Fetching GDELT tension pairs...');
  const url = `${GDELT_BATCH_API}?pairs=${encodeURIComponent(DEFAULT_GDELT_PAIRS)}&method=gpr`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!resp.ok) throw new Error(`GDELT batch API returned ${resp.status}`);

  const raw = await resp.json();
  const tensionPairs = Object.entries(raw).map(([pairKey, dataPoints]) => {
    const countries = pairKey.split('_');
    const latest = dataPoints[dataPoints.length - 1];
    const prev = dataPoints.length > 1 ? dataPoints[dataPoints.length - 2] : latest;
    const change = prev.v > 0 ? ((latest.v - prev.v) / prev.v) * 100 : 0;
    const trend = change > 5
      ? 'TREND_DIRECTION_RISING'
      : change < -5
        ? 'TREND_DIRECTION_FALLING'
        : 'TREND_DIRECTION_STABLE';

    return {
      id: pairKey,
      countries,
      label: countries.map((c) => c.toUpperCase()).join(' - '),
      score: latest?.v ?? 0,
      trend,
      changePercent: Math.round(change * 10) / 10,
      region: 'global',
    };
  });

  console.log(`  GDELT: ${tensionPairs.length} tension pairs`);
  return tensionPairs;
}

async function writeToRedis(key, data) {
  const { url, token } = getRedisCredentials();
  const payload = JSON.stringify(data);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', key, payload, 'EX', CACHE_TTL]),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis SET ${key} failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  console.log(`  Written: ${key} (${(payload.length / 1024).toFixed(1)}KB, TTL ${CACHE_TTL}s)`);
}

async function seedPizzint() {
  const startMs = Date.now();
  console.log('=== intel:pizzint Seed ===');

  // Fetch PizzINT data (required)
  let pizzint;
  try {
    pizzint = await withRetry(fetchPizzintData, 2, 3000);
  } catch (err) {
    console.error(`  PizzINT FETCH FAILED: ${err.message || err}`);
    await extendExistingTtl([CACHE_KEY_GDELT, CACHE_KEY_BASE], CACHE_TTL);
    console.log(`\n=== Failed gracefully (${Math.round(Date.now() - startMs)}ms) ===`);
    process.exit(0);
  }

  // Fetch GDELT tension pairs (optional — continue if it fails)
  let tensionPairs = [];
  try {
    tensionPairs = await fetchGdeltPairs();
  } catch (err) {
    console.warn(`  GDELT FAILED (non-critical): ${err.message || err}`);
  }

  // Build response objects matching the Vercel handler's cachedFetchJson shape
  const responseWithGdelt = { pizzint, tensionPairs };
  const responseBase = { pizzint, tensionPairs: [] };

  // Write both cache variants to Redis
  await writeToRedis(CACHE_KEY_GDELT, responseWithGdelt);
  await writeToRedis(CACHE_KEY_BASE, responseBase);

  // Verify
  const { url, token } = getRedisCredentials();
  const verifyResp = await fetch(`${url}/get/${encodeURIComponent(CACHE_KEY_GDELT)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  const verifyData = await verifyResp.json();
  if (verifyData.result) {
    console.log('  Verified: data present in Redis');
  } else {
    console.warn('  WARNING: verification read returned null');
  }

  const durationMs = Date.now() - startMs;
  logSeedResult('intelligence', pizzint.locationsMonitored, durationMs, {
    mode: 'direct-write',
    defconLevel: pizzint.defconLevel,
    gdeltPairs: tensionPairs.length,
  });
  console.log(`\n=== Done (${Math.round(durationMs)}ms) ===`);
}

seedPizzint().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(`ERROR: ${err.message || err}`);
  process.exit(1);
});
