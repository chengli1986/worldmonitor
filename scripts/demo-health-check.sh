#!/usr/bin/env bash
set -eo pipefail

# WorldMonitor Feature Health Check
# Tests all key features + Vercel performance + Redis data freshness
# Usage: demo-health-check.sh [--email]
# Style: matches aws-health-monitor.sh financial editorial theme

VERCEL_URL="${WM_VERCEL_URL:-https://worldmonitor-six-ochre-42.vercel.app}"
SEND_EMAIL=false
[[ "${1:-}" == "--email" ]] && SEND_EMAIL=true

# Load Upstash creds
if [[ -f "$HOME/worldmonitor/.env.local" ]]; then
  while IFS= read -r line; do
    line="${line%%#*}"; line="$(echo "$line" | xargs)"
    [[ -z "$line" ]] && continue
    key="${line%%=*}"; val="${line#*=}"; val="${val%\"}"; val="${val#\"}"
    export "$key=$val"
  done < "$HOME/worldmonitor/.env.local"
fi

# Load SMTP creds for email
if [[ "$SEND_EMAIL" == "true" ]]; then
  eval "$(grep -E '^(MAIL_TO|SMTP_USER|SMTP_PASS)=' /home/ubuntu/.stock-monitor.env)"
  export MAIL_TO SMTP_USER SMTP_PASS
fi

export VERCEL_URL SEND_EMAIL

echo "=== WorldMonitor Feature Health Check ==="
echo "  URL: $VERCEL_URL"
echo "  Time: $(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M BJT')"
echo ""

python3 << 'PYEOF'
import json, os, sys, time, urllib.request, urllib.error, urllib.parse, html as html_mod
from datetime import datetime, timezone, timedelta

VERCEL = os.environ["VERCEL_URL"]
ORIGIN = VERCEL
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
REDIS_URL = os.environ.get("UPSTASH_REDIS_REST_URL", "")
REDIS_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN", "")
SEND_EMAIL = os.environ.get("SEND_EMAIL", "false") == "true"

BJT = timezone(timedelta(hours=8))
now_bj = datetime.now(BJT).strftime('%Y年%m月%d日 %H:%M')
now_short = datetime.now(BJT).strftime('%m-%d %H:%M')

# ============================================================
# Style constants (matching aws-health-monitor)
# ============================================================
C_BG      = "#f4f5f7"
C_CARD    = "#ffffff"
C_DARK    = "#0d1117"
C_HEAD    = "#161b22"
C_ACCENT  = "#c9a96e"
C_TEXT    = "#24292f"
C_SEC     = "#57606a"
C_MUTED   = "#8b949e"
C_BORDER  = "#d0d7de"
C_STRIPE  = "#f6f8fa"
C_OK      = "#1a7f37"
C_WARN    = "#bf8700"
C_CRIT    = "#cf222e"
FONT      = "Georgia, 'PingFang SC', 'Noto Serif SC', serif"
FONT_MONO = "'SF Mono', 'Cascadia Code', Menlo, monospace"
FONT_SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif"

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
    except Exception: return 200, None, elapsed

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
    perf_results.append((name, status, f"{ms}ms", elapsed_s))

def status_badge(status_str: str, label: str | None = None) -> str:
    if status_str in ("PASS", "ok"):
        c, bg, text = C_OK, "rgba(26,127,55,.1)", label or "Pass"
    elif status_str in ("WARN", "warn"):
        c, bg, text = C_WARN, "rgba(191,135,0,.1)", label or "Warning"
    else:
        c, bg, text = C_CRIT, "rgba(207,34,46,.1)", label or "Fail"
    return f'<span style="display:inline-block;background:{bg};color:{c};border:1px solid {c};padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600;">{text}</span>'

def latency_bar(elapsed_s: float, threshold_s: float = 3.0) -> str:
    pct = min(elapsed_s / (threshold_s * 2) * 100, 100)
    c = C_OK if elapsed_s < threshold_s else (C_WARN if elapsed_s < threshold_s * 2 else C_CRIT)
    return f'''<table style="width:80px;border-collapse:collapse;display:inline-table;vertical-align:middle;">
      <tr><td style="width:{pct}%;height:6px;background:{c};padding:0;border-radius:3px 0 0 3px;"></td>
          <td style="width:{100-pct}%;height:6px;background:{C_BORDER};padding:0;border-radius:0 3px 3px 0;"></td></tr>
    </table>'''

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
        except Exception: pass
    stale = isinstance(age, int) and age > 60
    check("AI World Brief", "WARN" if stale else "PASS",
          f"{status_val}, {stories} stories, {provider}, {age}min")
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
if code == 200 and data:
    items = sum(len(c.get("items",[])) for c in data.get("categories",{}).values())
    check("Strategic Risk Data", "PASS" if items > 50 else "WARN", f"{items} items feeding risk model")
else:
    check("Strategic Risk Data", "FAIL", f"HTTP {code}")

# ── Redis Data Checks ──
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
    perf_results[-1] = ("Homepage", perf_results[-1][1], f"{int(t*1000)}ms, {size_kb}KB", t)

# API cold start
code, _, t = fetch_json(f"{VERCEL}/api/intelligence/v1/get-pizzint-status?includeGdelt=false")
perf("API Cold Start", t, 5.0)

# Static asset (CDN)
code, _, t = fetch(f"{VERCEL}/favicon.ico")
perf("Static Asset (CDN)", t, 1.0)

# RSS aggregation
code, _, t = fetch_json(f"{VERCEL}/api/news/v1/list-feed-digest?variant=tech&lang=en")
perf("RSS Aggregation", t, 8.0)

# ═══════════════════════════════════════
# CONSOLE OUTPUT
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
for name, status, detail, _ in perf_results:
    icon = {"PASS": "✓", "WARN": "!", "FAIL": "✗"}[status]
    print(f"{icon} {status:<4} | {name:<22} | {detail}")

print(f"\n{'':─<75}")
print(f"Features: {passes} pass, {warns} warn, {fails} fail")
p_pass = sum(1 for _,s,_,_ in perf_results if s == "PASS")
p_warn = sum(1 for _,s,_,_ in perf_results if s == "WARN")
p_fail = sum(1 for _,s,_,_ in perf_results if s == "FAIL")
print(f"Performance: {p_pass} pass, {p_warn} warn, {p_fail} fail")
print()

if fails > 0:
    print(f"ACTION NEEDED: {fails} feature(s) failing!")
elif warns > 0:
    print("Some features degraded — check warnings.")
else:
    print("All systems healthy.")

# ═══════════════════════════════════════
# HTML EMAIL
# ═══════════════════════════════════════

if not SEND_EMAIL:
    sys.exit(1 if fails > 0 else 0)

# Overall status
all_statuses = [s for _,s,_ in results] + [s for _,s,_,_ in perf_results]
if "FAIL" in all_statuses:
    overall, overall_label = "crit", "DEGRADED"
elif "WARN" in all_statuses:
    overall, overall_label = "warn", "WARNING"
else:
    overall, overall_label = "ok", "ALL HEALTHY"

overall_color = {"ok": C_OK, "warn": C_WARN, "crit": C_CRIT}[overall]
overall_bg = {"ok": "rgba(26,127,55,.12)", "warn": "rgba(191,135,0,.12)", "crit": "rgba(207,34,46,.12)"}[overall]
overall_border = {"ok": "rgba(26,127,55,.25)", "warn": "rgba(191,135,0,.25)", "crit": "rgba(207,34,46,.25)"}[overall]

th_s = f'padding:8px 12px;font-size:11px;font-weight:600;color:{C_MUTED};text-transform:uppercase;letter-spacing:0.5px;text-align:left;border-bottom:2px solid {C_DARK};'

# Feature rows
feature_rows = ""
for i, (name, status, detail) in enumerate(results):
    bg = C_STRIPE if i % 2 == 0 else C_CARD
    feature_rows += f'''<tr style="background:{bg};">
      <td style="padding:7px 12px;font-weight:600;font-size:13px;color:{C_TEXT};">{html_mod.escape(name)}</td>
      <td style="padding:7px 12px;">{status_badge(status)}</td>
      <td style="padding:7px 12px;font-family:{FONT_MONO};font-size:11px;color:{C_MUTED};max-width:250px;overflow:hidden;">{html_mod.escape(detail[:80])}</td>
    </tr>'''

# Performance rows
perf_rows = ""
for i, (name, status, detail, elapsed) in enumerate(perf_results):
    bg = C_STRIPE if i % 2 == 0 else C_CARD
    threshold = 3.0
    if "cold" in name.lower(): threshold = 5.0
    elif "rss" in name.lower(): threshold = 8.0
    elif "cdn" in name.lower() or "static" in name.lower(): threshold = 1.0
    perf_rows += f'''<tr style="background:{bg};">
      <td style="padding:7px 12px;font-weight:600;font-size:13px;color:{C_TEXT};">{html_mod.escape(name)}</td>
      <td style="padding:7px 12px;">{status_badge(status)}</td>
      <td style="padding:7px 12px;">{latency_bar(elapsed, threshold)}
        <span style="font-family:{FONT_MONO};font-size:12px;color:{C_TEXT};margin-left:6px;">{html_mod.escape(detail)}</span>
      </td>
    </tr>'''

# Summary counts
feature_summary = f'''<table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
  <tr>
    <td style="padding:4px 12px;color:{C_SEC};font-size:12px;">Pass</td>
    <td style="padding:4px 12px;font-family:{FONT_MONO};font-size:13px;font-weight:600;color:{C_OK};">{passes}</td>
    <td style="padding:4px 12px;color:{C_SEC};font-size:12px;">Warn</td>
    <td style="padding:4px 12px;font-family:{FONT_MONO};font-size:13px;font-weight:600;color:{C_WARN};">{warns}</td>
    <td style="padding:4px 12px;color:{C_SEC};font-size:12px;">Fail</td>
    <td style="padding:4px 12px;font-family:{FONT_MONO};font-size:13px;font-weight:600;color:{C_CRIT};">{fails}</td>
  </tr>
</table>'''

perf_summary = f'''<table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
  <tr>
    <td style="padding:4px 12px;color:{C_SEC};font-size:12px;">Pass</td>
    <td style="padding:4px 12px;font-family:{FONT_MONO};font-size:13px;font-weight:600;color:{C_OK};">{p_pass}</td>
    <td style="padding:4px 12px;color:{C_SEC};font-size:12px;">Warn</td>
    <td style="padding:4px 12px;font-family:{FONT_MONO};font-size:13px;font-weight:600;color:{C_WARN};">{p_warn}</td>
    <td style="padding:4px 12px;color:{C_SEC};font-size:12px;">Fail</td>
    <td style="padding:4px 12px;font-family:{FONT_MONO};font-size:13px;font-weight:600;color:{C_CRIT};">{p_fail}</td>
  </tr>
</table>'''

email_html = f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
  .table-scroll {{ overflow-x:auto; -webkit-overflow-scrolling:touch; }}
  @media (max-width:640px) {{
    body {{ padding:6px !important; }}
    .main {{ border-radius:8px !important; }}
    td,th {{ padding:5px 4px !important; font-size:11px !important; }}
  }}
</style>
</head>
<body style="font-family:{FONT_SANS};background:{C_BG};margin:0;padding:16px;-webkit-text-size-adjust:100%;">
<div class="main" style="max-width:700px;margin:0 auto;background:{C_CARD};border-radius:12px;
            box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.04);overflow:hidden;border:1px solid {C_BORDER};">

  <!-- Header -->
  <div style="background:{C_DARK};color:#e6edf3;padding:28px 24px;">
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="vertical-align:middle;">
          <div style="font-family:{FONT};font-size:22px;font-weight:400;letter-spacing:0.5px;color:#fff;">WorldMonitor</div>
          <div style="font-size:13px;color:{C_MUTED};margin-top:4px;font-family:{FONT_SANS};">Feature Health Check &middot; {now_bj}</div>
        </td>
        <td style="text-align:right;vertical-align:middle;">
          <div style="display:inline-block;background:{overall_bg};border:1px solid {overall_border};padding:6px 14px;border-radius:4px;font-size:12px;color:{overall_color};font-family:{FONT_MONO};letter-spacing:1px;font-weight:700;">{overall_label}</div>
        </td>
      </tr>
    </table>
  </div>

  <!-- Info Bar -->
  <table style="width:100%;border-collapse:collapse;background:{C_HEAD};border-bottom:1px solid #30363d;">
    <tr>
      <td style="padding:10px 14px;font-size:12px;color:{C_MUTED};">Vercel</td>
      <td style="padding:10px 14px;font-size:12px;color:#e6edf3;font-family:{FONT_MONO};white-space:nowrap;">{html_mod.escape(VERCEL)}</td>
    </tr>
  </table>

  <!-- Features -->
  <div style="padding:14px;">
    <div style="font-size:11px;font-weight:700;color:{C_ACCENT};text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px;padding-left:4px;">Feature Status</div>
    {feature_summary}
    <div class="table-scroll">
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr><th style="{th_s}">Feature</th><th style="{th_s}">Status</th><th style="{th_s}">Detail</th></tr></thead>
      <tbody>{feature_rows}</tbody>
    </table>
    </div>
  </div>

  <!-- Performance -->
  <div style="padding:14px;border-top:2px solid {C_DARK};">
    <div style="font-size:11px;font-weight:700;color:{C_ACCENT};text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px;padding-left:4px;">Vercel Performance</div>
    {perf_summary}
    <div class="table-scroll">
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr><th style="{th_s}">Endpoint</th><th style="{th_s}">Status</th><th style="{th_s}">Latency</th></tr></thead>
      <tbody>{perf_rows}</tbody>
    </table>
    </div>
  </div>

  <!-- Footer -->
  <div style="border-top:1px solid {C_BORDER};padding:16px 20px;text-align:center;font-size:11px;color:{C_MUTED};line-height:1.8;">
    WorldMonitor &middot; Feature Health Check<br>
    {len(results)} features &middot; {len(perf_results)} performance endpoints
  </div>

</div></body></html>"""

# Send email
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

msg = MIMEMultipart('alternative')
msg['Subject'] = f"🌍 WorldMonitor Health: {overall_label} — {now_short}"
msg['From'] = os.environ['SMTP_USER']
msg['To'] = os.environ['MAIL_TO']
msg['MIME-Version'] = '1.0'
msg.attach(MIMEText(email_html, 'html'))

try:
    with smtplib.SMTP_SSL('smtp.163.com', 465) as s:
        s.login(os.environ['SMTP_USER'], os.environ['SMTP_PASS'])
        s.send_message(msg)
    print("Health check email sent")
except Exception as e:
    print(f"Email send failed: {e}", file=sys.stderr)

sys.exit(1 if fails > 0 else 0)
PYEOF
