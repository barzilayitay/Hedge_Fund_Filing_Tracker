#!/usr/bin/env bash
# Docker-gated security check (real Supabase) — PostgREST over-the-wire smoke.
#
# Verifies REACHABILITY with the anon key, which the psql state-checks cannot:
#   * the six intended RPCs are callable (HTTP 200 with valid args);
#   * refresh_derived and the five formerly-granted views are denied (401/404).
#
# Needs a running local stack (supabase start + db reset). Reads ANON_KEY and
# API_URL from `supabase status`. Exits non-zero, naming the offending endpoint,
# on any deviation. Origin: Phase 4 gate review #1 — see ARCHITECTURE.md "CI".
set -uo pipefail

STATUS=$(npx supabase status -o env 2>/dev/null)
ANON_KEY=$(printf '%s\n' "$STATUS" | sed -n 's/^ANON_KEY="\(.*\)"$/\1/p')
API_URL=$(printf '%s\n' "$STATUS" | sed -n 's/^API_URL="\(.*\)"$/\1/p')
if [ -z "$ANON_KEY" ] || [ -z "$API_URL" ]; then
  echo "postgrest-smoke: could not read ANON_KEY/API_URL from 'supabase status'." >&2
  exit 1
fi
REST="$API_URL/rest/v1"
FAILED=0

# --- helpers ---------------------------------------------------------------
# code_for METHOD PATH [JSON_BODY]
code_for() {
  local method=$1 path=$2 body=${3:-}
  if [ "$method" = "POST" ]; then
    curl -s -o /dev/null -w '%{http_code}' -X POST "$REST/$path" \
      -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
      -H "Content-Type: application/json" -d "$body"
  else
    curl -s -o /dev/null -w '%{http_code}' "$REST/$path" \
      -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
  fi
}

expect_200() { # label PATH BODY
  local label=$1 path=$2 body=$3 code
  code=$(code_for POST "$path" "$body")
  if [ "$code" != "200" ]; then
    echo "FAIL: intended RPC '$label' not reachable for anon (got HTTP $code, want 200)" >&2
    FAILED=1
  else
    echo "ok: $label reachable (200)"
  fi
}

expect_denied() { # label METHOD PATH [BODY]
  local label=$1 method=$2 path=$3 body=${4:-} code
  code=$(code_for "$method" "$path" "$body")
  if [ "$code" != "401" ] && [ "$code" != "403" ] && [ "$code" != "404" ]; then
    echo "FAIL: '$label' should be denied to anon (got HTTP $code, want 401/403/404)" >&2
    FAILED=1
  else
    echo "ok: $label denied ($code)"
  fi
}

# --- wait for PostgREST to have (re)loaded the schema cache -----------------
for i in $(seq 1 30); do
  c=$(code_for POST "rpc/get_fund_holdings" '{"fund_slug":"x","quarter":"2026-03-31"}')
  [ "$c" = "200" ] && break
  echo "waiting for PostgREST schema cache ($i)... last=$c"
  sleep 2
done

# --- the six RPCs are reachable (valid args -> 200) ------------------------
expect_200 get_fund_holdings       "rpc/get_fund_holdings"       '{"fund_slug":"x","quarter":"2026-03-31"}'
expect_200 get_fund_summary        "rpc/get_fund_summary"        '{"fund_slug":"x"}'
expect_200 get_fund_realtime       "rpc/get_fund_realtime"       '{"fund_slug":"x"}'
expect_200 get_stock_institutional "rpc/get_stock_institutional" '{"ticker":"X","quarter":"2026-03-31"}'
expect_200 get_stock_insiders      "rpc/get_stock_insiders"      '{"ticker":"X"}'
expect_200 get_confluence          "rpc/get_confluence"          '{"ticker":"X","from_quarter":"2026-03-31"}'

# --- the DoS helper and the five formerly-granted views are denied ---------
expect_denied refresh_derived          POST "rpc/refresh_derived" '{}'
expect_denied fund_holdings_enriched   GET  "fund_holdings_enriched?select=*&limit=1"
expect_denied fund_quarter_summary     GET  "fund_quarter_summary?select=*&limit=1"
expect_denied fund_realtime_activity   GET  "fund_realtime_activity?select=*&limit=1"
expect_denied insider_cluster_buys     GET  "insider_cluster_buys?select=*&limit=1"
expect_denied insider_sentiment        GET  "insider_sentiment?select=*&limit=1"

if [ "$FAILED" -ne 0 ]; then
  echo "postgrest-smoke: FAILED" >&2
  exit 1
fi
echo "postgrest-smoke: all reachability checks passed."
