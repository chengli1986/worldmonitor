#!/usr/bin/env node

/**
 * Fetches service statuses via the Vercel RPC endpoint and writes
 * directly to Redis from EC2.
 *
 * Previous warm-ping approach relied on Vercel's cachedFetchJson writing
 * to Redis, but serverless runtime truncates background promises after
 * the response is sent, so the Redis write never completed.
 */

import { loadEnvFile, CHROME_UA, getRedisCredentials, logSeedResult, extendExistingTtl } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const RPC_URL = 'https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses';
const CANONICAL_KEY = 'infra:service-statuses:v1';
const CACHE_TTL = 1800; // 30 minutes, matches server-side TTL

async function seedServiceStatuses() {
  const startMs = Date.now();
  console.log('=== infra:service-statuses Seed ===');
  console.log(`  Key:     ${CANONICAL_KEY}`);
  console.log(`  Target:  ${RPC_URL}`);

  let data;
  try {
    const resp = await fetch(RPC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': CHROME_UA,
        Origin: 'https://worldmonitor.app',
      },
      body: '{}',
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) throw new Error(`RPC failed: HTTP ${resp.status}`);
    data = await resp.json();
  } catch (err) {
    console.error(`  FETCH FAILED: ${err.message || err}`);
    await extendExistingTtl([CANONICAL_KEY], 7200);
    console.log(`\n=== Failed gracefully (${Math.round(Date.now() - startMs)}ms) ===`);
    process.exit(0);
  }

  const statuses = data?.statuses;
  const count = statuses?.length || 0;
  console.log(`  Statuses: ${count}`);

  if (!count) {
    console.warn('  SKIPPED: no statuses returned');
    await extendExistingTtl([CANONICAL_KEY], 7200);
    console.log(`\n=== Done (${Math.round(Date.now() - startMs)}ms, no write) ===`);
    process.exit(0);
  }

  // Write directly to Redis from EC2
  const { url, token } = getRedisCredentials();
  const payload = JSON.stringify(statuses);
  const setResp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', CANONICAL_KEY, payload, 'EX', CACHE_TTL]),
    signal: AbortSignal.timeout(15_000),
  });

  if (!setResp.ok) {
    const text = await setResp.text().catch(() => '');
    throw new Error(`Redis SET failed: HTTP ${setResp.status} — ${text.slice(0, 200)}`);
  }

  // Verify
  const verifyResp = await fetch(`${url}/get/${encodeURIComponent(CANONICAL_KEY)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  const verifyData = await verifyResp.json();
  if (verifyData.result) {
    console.log('  Verified: data present in Redis');
  } else {
    throw new Error('Verification failed: Redis key empty after write');
  }

  const durationMs = Date.now() - startMs;
  logSeedResult('infra', count, durationMs, { mode: 'direct-write' });
  console.log(`\n=== Done (${Math.round(durationMs)}ms) ===`);
}

seedServiceStatuses().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(`ERROR: ${err.message || err}`);
  process.exit(1);
});
