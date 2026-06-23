# WorldMonitor

## Overview
Real-time global intelligence dashboard — AI-synthesized news aggregation, geopolitical/
infrastructure monitoring on a 3D globe + flat map. Stack: vanilla TypeScript + Vite frontend,
Vercel Edge Functions (`api/`), Upstash Redis cache, with seed scripts (run on a server) feeding
Redis. Also ships a Tauri 2 desktop app. Fork of upstream `koala73/worldmonitor` (AGPL-3.0).

## Develop / Test
- Node 22 (`.nvmrc`). `npm install` (husky pre-commit auto-installs node_modules in worktrees).
- `npm run dev` — Vite frontend ONLY (port 5173); `api/` edge functions do NOT run, so news/
  market/AI panels stay empty. For full local stack use `vercel dev` (port 3000, emulates edge runtime).
- Variants: `npm run dev:tech|dev:finance|dev:commodity|dev:happy` (or `VITE_VARIANT=...`).
- `npm run typecheck` / `typecheck:api` / `typecheck:all` — `tsc --noEmit`.
- `npm run build` (blog + tsc + vite) ; `build:full` ; `build:desktop` (Tauri).
- Lint/format = **Biome** (not eslint/prettier): `npm run lint`, `lint:fix`, `lint:md`.
- Tests: `test:data` (tsx node:test in `tests/`), `test:e2e` (Playwright, per-variant),
  `test:sidecar`, `test:feeds` (RSS validation). `test:e2e:visual` for golden screenshots.

## Architecture
Data flow: **seed scripts → Upstash Redis → Vercel edge functions → frontend**. The frontend reads
pre-seeded Redis data for instant loads; it does not call external APIs directly.
- `src/` — frontend: `components/`, `services/`, `workers/`, `config/`, `locales/` (21 langs). Uses
  preact, globe.gl + Three.js (3D), deck.gl + MapLibre GL (flat map), Transformers.js (browser ML).
- `api/` — 60+ Vercel Edge Functions, grouped by domain (news, market, conflict, cyber, maritime,
  seismology, ...). Shared helpers: `api/_cors.js`, `api/_api-key.js`.
- `server/` — shared server logic: `cors.ts`, `_shared/redis.ts`, `llm.ts`, `rate-limit.ts`, plus
  `server/worldmonitor/` domain handlers (also reused by the desktop sidecar).
- `scripts/` — `seed-*.mjs` seeders + `seed-all.sh` (groups: `fast`/`medium`/`slow`/`heavy`),
  `demo-health-check.sh`, `ais-relay.cjs` (optional Railway relay: AIS/OpenSky/Telegram/OREF).
- `proto/` — Protocol Buffer API contracts (sebuf HTTP annotations). `src-tauri/` — desktop (Rust +
  Node sidecar). `convex/` — Convex backend (contact form / interest). `blog-site/` — separate build.
- `middleware.ts` — edge auth/CORS + anti-bot (rejects `curl/` UA or UA length < 10).

## Key Facts / Gotchas
- This is a FORK: `origin` = our remote, `upstream` = koala73. Rebase local commits onto upstream;
  keep a backup branch before syncing.
- CORS/auth allowlist must match a generic Vercel preview pattern — when editing keep `api/_cors.js`,
  `api/_api-key.js`, and `server/cors.ts` in sync (regex must not hardcode an author-specific slug).
- No env vars needed for the static frontend; API keys (Upstash, Groq, Finnhub, FRED, EIA, NASA
  FIRMS, etc.) are server-side only, set in the Vercel dashboard. See `.env.example` for the full list.
- LLM summary chain (AI World Brief): Groq (primary) → OpenRouter → Ollama fallback. Local-only mode
  runs fully on Ollama with no API keys.
- `vercel.json` ignoreCommand skips builds when only `*.md`/`docs/`/`e2e/`/`scripts/`/`.github/` change;
  env-var changes require a manual Redeploy.
- Redis keys are versioned (e.g. `news:digest:v1:...`, `market:crypto:v1`); a seed group must include
  every key its consumers read or panels go blank.
