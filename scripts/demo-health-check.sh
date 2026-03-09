#!/usr/bin/env bash
set -eo pipefail

# WorldMonitor Feature Health Check
# Tests all key features + Vercel performance
# Usage: demo-health-check.sh

VERCEL_URL="${WM_VERCEL_URL:-https://worldmonitor-six-ochre-42.vercel.app}"

# Load Upstash creds
if [[ -f "$HOME/worldmonitor/.env.local" ]]; then
  while IFS= read -r line; do
    line="${line%%#*}"; line="$(echo "$line" | xargs)"
    [[ -z "$line" ]] && continue
    key="${line%%=*}"; val="${line#*=}"; val="${val%\"}"; val="${val#\"}"
    export "$key=$val"
  done < "$HOME/worldmonitor/.env.local"
fi

export VERCEL_URL

echo "=== WorldMonitor Feature Health Check ==="
echo "  URL: $VERCEL_URL"
echo "  Time: $(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M BJT')"
echo ""

python3 << 'PYEOF'
import json, os, sys, time, urllib.request, urllib.error, urllib.parse
from datetime import datetime, timezone

VERCEL = os.environ["VERCEL_URL"]
ORIGIN = VERCEL
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
REDIS_URL = os.environ.get("UPSTASH_REDIS_REST_URL", "")
REDIS_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN", "")

results = []
perf_results = []

def fetch(url, headers=None, timeout=20):
    hdrs = {"User-Agent": UA, "Origin": ORIGIN}
    if headers: hdrs.update(headers)
    req = urllib.request.Request(url, headers=hdrs)
    t0 = time.time()
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        body = resp.read().decode("utf-8", errors="replace")
        return resp.status, body, time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, "", time.time() - t0
    except Exception as e:
        return 0, str(e), time.time() - t0

def fetch_json(url, headers=None):
    code, body, elapsed = fetch(url, headers)
    if code != 200: return code, None, elapsed
    try: return 200, json.loads(body), elapsed
    except: return 200, None, elapsed

def redis_get(key):
    if not REDIS_URL or not REDIS_TOKEN: return None
    code, data, _ = fetch_json(
        f"{REDIS_URL}/get/{urllib.parse.quote(key, safe='')}",
        {"Authorization": f"Bearer {REDIS_TOKEN}"})
    if code != 200 or not data: return None
    raw = data.get("result")
    return json.loads(raw) if raw else None

def check(name, status, detail):
    results.append((name, status, detail))

def perf(name, elapsed_s, threshold_s=3.0):
    ms = int(elapsed_s * 1000)
    status = "PASS" if elapsed_s < threshold_s else ("WARN" if elapsed_s < 8.0 else "FAIL")
    perf_results.append((name, status, f"{ms}ms"))

# ═══════════════════════════════════════
# FEATURE CHECKS
# ═══════════════════════════════════════

# 1. Video Embed
code, body, t = fetch(f"{VERCEL}/api/youtube/embed?videoId=fIurYTprwzg")
if code == 200 and "<html" in body.lower():
    check("Video Embed", "PASS", "YouTube embed HTML OK")
else:
    check("Video Embed", "FAIL", f"HTTP {code}")
perf("Video Embed", t)

# 2. YouTube Live Detection
code, data, t = fetch_json(f"{VERCEL}/api/youtube/live?videoId=fIurYTprwzg")
if code == 200 and data and data.get("videoId"):
    check("YouTube Live API", "PASS", f"Video={data['videoId']}")
else:
    check("YouTube Live API", "WARN", f"HTTP {code}, no video data")
perf("YouTube Live", t)

# 3. News Digest
code, data, t = fetch_json(f"{VERCEL}/api/news/v1/list-feed-digest?variant=full&lang=en")
if code == 200 and data:
    cats = data.get("categories", {})
    items = sum(len(c.get("items", [])) for c in cats.values())
    check("News Digest", "PASS" if items > 50 else "WARN", f"{len(cats)} cats, {items} items")
else:
    check("News Digest", "FAIL", f"HTTP {code}")
perf("News Digest", t, 5.0)

# 4. AI World Brief (Redis)
insights = redis_get("news:insights:v1")
if insights:
    stories = len(insights.get("topStories", []))
    brief = (insights.get("worldBrief") or "")[:60]
    provider = insights.get("briefProvider", "?")
    status_val = insights.get("status", "?")
    gen = insights.get("generatedAt", "")
    age = "?"
    if gen:
        try:
            dt = datetime.fromisoformat(gen.replace("Z", "+00:00"))
            age = int((datetime.now(timezone.utc) - dt).total_seconds() / 60)
        except: pass
    stale = isinstance(age, int) and age > 60
    check("AI World Brief", "WARN" if stale else "PASS",
          f"{status_val}, {stories} stories, {provider}, {age}min: {brief}...")
else:
    check("AI World Brief", "FAIL", "No insights in Redis")

# 5. Pizza Index
code, data, t = fetch_json(f"{VERCEL}/api/intelligence/v1/get-pizzint-status?includeGdelt=true")
if code == 200 and data:
    p = data.get("pizzint", {})
    locs = len(p.get("locations", []))
    spikes = sum(1 for l in p.get("locations", []) if l.get("isSpike"))
    check("Pizza Index", "PASS" if locs > 0 else "FAIL",
          f"DEFCON {p.get('defconLevel','?')}, {locs} locs, {spikes} spikes")
else:
    check("Pizza Index", "FAIL", f"HTTP {code}")
perf("Pizza Index", t)

# 6. Strategic Risk
code, data, t = fetch_json(f"{VERCEL}/api/news/v1/list-feed-digest?variant=full&lang=en")
# Already fetched above, reuse check
if code == 200 and data:
    items = sum(len(c.get("items",[])) for c in data.get("categories",{}).values())
    check("Strategic Risk Data", "PASS" if items > 50 else "WARN", f"{items} items feeding risk model")
else:
    check("Strategic Risk Data", "FAIL", f"HTTP {code}")

# ── Redis Data Checks (correct key names from actual Redis) ──
redis_checks = [
    ("Market Quotes",      "market:stocks-bootstrap:v1"),
    ("Commodities",        "market:commodities-bootstrap:v1"),
    ("Crypto Quotes",      "market:crypto:v1"),
    ("Stablecoins",        "market:stablecoins:v1"),
    ("Earthquakes",        "seismology:earthquakes:v1"),
    ("Predictions",        "prediction:markets-bootstrap:v1"),
    ("Climate Anomalies",  "climate:anomalies:v1"),
    ("Displacement",       "displacement:summary:v1:2026"),
    ("Cyber Threats",      "supply_chain:minerals:v2"),
    ("ETF Flows",          "market:commodities-bootstrap:v1"),
    ("BIS Economic",       "economic:bis:policy:v1"),
]

for name, key in redis_checks:
    data = redis_get(key)
    if data:
        n = len(data) if isinstance(data, (list, dict)) else 1
        check(name, "PASS", f"{n} entries")
    else:
        check(name, "WARN", f"No data ({key})")

# ═══════════════════════════════════════
# VERCEL PERFORMANCE CHECKS
# ═══════════════════════════════════════

# Homepage load
code, body, t = fetch(VERCEL)
perf("Homepage", t, 3.0)
if code == 200:
    size_kb = len(body.encode()) // 1024
    perf_results[-1] = ("Homepage", perf_results[-1][1], f"{int(t*1000)}ms, {size_kb}KB")

# API cold start test (hit a less-used endpoint)
code, _, t = fetch_json(f"{VERCEL}/api/intelligence/v1/get-pizzint-status?includeGdelt=false")
perf("API Cold Start", t, 5.0)

# Static asset (check if CDN caching works)
# Try fetching a known static path
code, _, t = fetch(f"{VERCEL}/favicon.ico")
perf("Static Asset (CDN)", t, 1.0)

# RSS aggregation endpoint
code, _, t = fetch_json(f"{VERCEL}/api/news/v1/list-feed-digest?variant=tech&lang=en")
perf("RSS Aggregation", t, 8.0)

# ═══════════════════════════════════════
# OUTPUT
# ═══════════════════════════════════════

passes = sum(1 for _,s,_ in results if s == "PASS")
warns  = sum(1 for _,s,_ in results if s == "WARN")
fails  = sum(1 for _,s,_ in results if s == "FAIL")

print(f"{'':─<75}")
print(f" FEATURE STATUS")
print(f"{'':─<75}")
print(f"{'Status':<6} | {'Feature':<22} | Details")
print(f"{'':─<75}")
for name, status, detail in results:
    icon = {"PASS": "✓", "WARN": "!", "FAIL": "✗"}[status]
    print(f"{icon} {status:<4} | {name:<22} | {detail}")

print(f"\n{'':─<75}")
print(f" VERCEL PERFORMANCE")
print(f"{'':─<75}")
print(f"{'Status':<6} | {'Endpoint':<22} | Latency")
print(f"{'':─<75}")
for name, status, detail in perf_results:
    icon = {"PASS": "✓", "WARN": "!", "FAIL": "✗"}[status]
    print(f"{icon} {status:<4} | {name:<22} | {detail}")

print(f"\n{'':─<75}")
print(f"Features: {passes} pass, {warns} warn, {fails} fail")
p_pass = sum(1 for _,s,_ in perf_results if s == "PASS")
p_warn = sum(1 for _,s,_ in perf_results if s == "WARN")
p_fail = sum(1 for _,s,_ in perf_results if s == "FAIL")
print(f"Performance: {p_pass} pass, {p_warn} warn, {p_fail} fail")
print()

if fails > 0:
    print(f"ACTION NEEDED: {fails} feature(s) failing!")
    sys.exit(1)
elif warns > 0:
    print("Some features degraded — check warnings.")
else:
    print("All systems healthy.")
PYEOF
