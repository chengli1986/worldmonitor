#!/usr/bin/env bash
set -eo pipefail

# World Monitor seed runner — groups seeds by refresh frequency
# Usage: seed-all.sh [fast|medium|slow|heavy]
#
# fast   (every 30min): earthquakes, market, crypto, commodities, predictions, stablecoins
# medium (every 2h):    climate, natural, unrest, etf, gulf, outages, service, airport, bis, rss-digest, video-embed, pizzint
# slow   (every 6h):    cyber threats, wildfires
# heavy  (daily):       world bank, displacement

CD="$(cd "$(dirname "$0")" && pwd)"
LOG_PREFIX="[seed-all]"

run_seed() {
  local script="$1"
  local start=$SECONDS
  echo "$LOG_PREFIX Running $script..."
  if timeout 600 node "$CD/$script" 2>&1 | tail -3; then
    echo "$LOG_PREFIX $script done ($((SECONDS - start))s)"
  else
    echo "$LOG_PREFIX $script FAILED ($((SECONDS - start))s)" >&2
  fi
}

GROUP="${1:-fast}"

case "$GROUP" in
  fast)
    run_seed seed-earthquakes.mjs
    run_seed seed-market-quotes.mjs
    run_seed seed-crypto-quotes.mjs
    run_seed seed-commodity-quotes.mjs
    run_seed seed-prediction-markets.mjs
    run_seed seed-stablecoin-markets.mjs
    run_seed seed-insights.mjs
    ;;
  medium)
    run_seed seed-climate-anomalies.mjs
    run_seed seed-natural-events.mjs
    run_seed seed-unrest-events.mjs
    run_seed seed-etf-flows.mjs
    run_seed seed-gulf-quotes.mjs
    run_seed seed-internet-outages.mjs
    run_seed seed-service-statuses.mjs
    run_seed seed-airport-delays.mjs
    run_seed seed-bis-data.mjs
    run_seed seed-rss-digest.mjs
    run_seed seed-video-embed.mjs
    run_seed seed-pizzint.mjs
    ;;
  slow)
    run_seed seed-cyber-threats.mjs
    run_seed seed-fire-detections.mjs
    ;;
  heavy)
    run_seed seed-wb-indicators.mjs
    run_seed seed-displacement-summary.mjs
    ;;
  all)
    "$0" fast
    "$0" medium
    "$0" slow
    "$0" heavy
    ;;
  *)
    echo "Usage: $0 [fast|medium|slow|heavy|all]"
    exit 1
    ;;
esac

echo "$LOG_PREFIX Group '$GROUP' complete."
