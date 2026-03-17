#!/usr/bin/env node

/**
 * Warms the Vercel edge function for YouTube video embeds.
 *
 * The /api/youtube/embed endpoint is a pure edge function (no Redis, no
 * external API calls) — it generates HTML on-the-fly. The slowness that
 * triggers health check WARNs is purely Vercel cold start latency.
 *
 * This seed script hits the endpoint periodically to keep the edge function
 * warm, so the health check (threshold: 3s PASS, 8s FAIL) sees fast responses.
 *
 * Runs in the "medium" seed group (every 2h).
 */

import { loadEnvFile, CHROME_UA, logSeedResult } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const VERCEL_URL = process.env.WM_VERCEL_URL || 'https://worldmonitor-six-ochre-42.vercel.app';
const EMBED_PATH = '/api/youtube/embed';
const TEST_VIDEO_ID = 'fIurYTprwzg'; // same video used by health check
const FETCH_TIMEOUT_MS = 15_000;

async function warmEmbed() {
  const url = `${VERCEL_URL}${EMBED_PATH}?videoId=${TEST_VIDEO_ID}`;
  console.log(`  Warming ${url}...`);

  const t0 = Date.now();
  const resp = await fetch(url, {
    headers: {
      'User-Agent': CHROME_UA,
      'Origin': VERCEL_URL,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const body = await resp.text();
  const elapsed = Date.now() - t0;
  const hasHtml = body.toLowerCase().includes('<html');

  if (!hasHtml) {
    throw new Error('Response does not contain HTML');
  }

  console.log(`  OK: ${body.length} bytes, ${elapsed}ms`);
  return { elapsed, bodyLength: body.length };
}

async function seedVideoEmbed() {
  const startMs = Date.now();
  console.log('=== youtube:video-embed Warm ===');
  console.log(`  Target: ${VERCEL_URL}`);

  try {
    const { elapsed, bodyLength } = await warmEmbed();
    const durationMs = Date.now() - startMs;
    logSeedResult('youtube', 1, durationMs, {
      mode: 'vercel-warm',
      responseMs: elapsed,
      bodyLength,
    });
    console.log(`\n=== Done (${Math.round(durationMs)}ms) ===`);
  } catch (err) {
    console.error(`  FAILED: ${err.message || err}`);
    console.log(`\n=== Failed (${Math.round(Date.now() - startMs)}ms) ===`);
    // Non-critical — don't exit with error code, the endpoint will just be slow on next cold start
    process.exit(0);
  }
}

seedVideoEmbed().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(`ERROR: ${err.message || err}`);
  process.exit(1);
});
