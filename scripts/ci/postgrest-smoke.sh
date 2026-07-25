#!/usr/bin/env bash
# Docker-gated security check (real Supabase) — PostgREST over-the-wire smoke.
#
# Verifies REACHABILITY with the anon key, which the psql state-checks cannot:
#   * the six intended RPCs are callable (HTTP 200 with valid args);
#   * refresh_derived and the derived views are denied — and denied FOR THE
#     RIGHT REASON.
#
# WHY THE REASON MATTERS (gate review #2 found this as a false negative):
# PostgREST maps every SQLSTATE 42501 to HTTP 401. If EXECUTE on
# refresh_derived() were re-granted to anon, the call would run and then fail
# one layer deeper on the matview ("permission denied for materialized view
# fund_holdings_enriched") — still a 401. A status-only assertion therefore
# reported "denied" while BLOCKER-1 was fully reintroduced; it only caught the
# regression in combination with BLOCKER-2. So each denial assertion now also
# requires the error to name the object under test. A 404 is likewise NOT
# accepted as proof of denial: a renamed or dropped object would otherwise make
# this check pass vacuously.
#
# scripts/ci/assert-anon-surface.sql remains the authoritative control; this is
# the over-the-wire corroboration of it.
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
# fetch METHOD PATH [JSON_BODY] -> response body, then a newline, then the code.
fetch() {
  local method=$1 path=$2 body=${3:-}
  if [ "$method" = "POST" ]; then
    curl -s -w '\n%{http_code}' -X POST "$REST/$path" \
      -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
      -H "Content-Type: application/json" -d "$body"
  else
    curl -s -w '\n%{http_code}' "$REST/$path" \
      -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
  fi
}

http_code() { printf '%s' "$1" | tail -n1; }
payload()   { printf '%s' "$1" | sed '$d'; }

expect_200() { # label PATH BODY
  local label=$1 path=$2 body=$3 out code
  out=$(fetch POST "$path" "$body")
  code=$(http_code "$out")
  if [ "$code" != "200" ]; then
    echo "FAIL: intended RPC '$label' not reachable for anon (got HTTP $code, want 200)" >&2
    echo "      body: $(payload "$out")" >&2
    FAILED=1
  else
    echo "ok: $label reachable (200)"
  fi
}

# expect_denied LABEL METHOD PATH EXPECTED_MESSAGE [BODY]
# Requires 401/403 AND SQLSTATE 42501 AND an error message naming this object.
expect_denied() {
  local label=$1 method=$2 path=$3 want=$4 body=${5:-} out code data
  out=$(fetch "$method" "$path" "$body")
  code=$(http_code "$out")
  data=$(payload "$out")

  if [ "$code" = "404" ]; then
    echo "FAIL: '$label' returned HTTP 404 — a missing endpoint is NOT proof of denial." >&2
    echo "      Was the object renamed or dropped? Update this check. body: $data" >&2
    FAILED=1
    return
  fi
  if [ "$code" != "401" ] && [ "$code" != "403" ]; then
    echo "FAIL: '$label' should be denied to anon (got HTTP $code, want 401/403)" >&2
    echo "      body: $data" >&2
    FAILED=1
    return
  fi
  case "$data" in
    *'"code":"42501"'*) : ;;
    *)
      echo "FAIL: '$label' was refused, but not by a privilege check (want SQLSTATE 42501)." >&2
      echo "      body: $data" >&2
      FAILED=1
      return
      ;;
  esac
  case "$data" in
    *"$want"*)
      echo "ok: $label denied ($code, $want)"
      ;;
    *)
      # This is the BLOCKER-1-independent-of-BLOCKER-2 assertion: the call got
      # far enough to fail on something else, so anon holds more than it should.
      echo "FAIL: '$label' was denied for the WRONG reason — anon may reach it." >&2
      echo "      want the error to name this object: \"$want\"" >&2
      echo "      got: $data" >&2
      FAILED=1
      ;;
  esac
}

# --- wait for PostgREST to have (re)loaded the schema cache -----------------
for i in $(seq 1 30); do
  c=$(http_code "$(fetch POST "rpc/get_fund_holdings" '{"fund_slug":"x","quarter":"2026-03-31"}')")
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

# --- the DoS helper is denied, and denied ON ITSELF ------------------------
# If EXECUTE were re-granted to anon this message becomes "permission denied for
# materialized view fund_holdings_enriched" and the check fails, independently
# of whether the MAINTAIN leak (BLOCKER-2) is also present.
expect_denied refresh_derived POST "rpc/refresh_derived" \
  "permission denied for function refresh_derived" '{}'

# --- every derived view is denied, each named in its own error -------------
expect_denied fund_holdings_enriched GET "fund_holdings_enriched?select=*&limit=1" \
  "permission denied for materialized view fund_holdings_enriched"
expect_denied fund_quarter_summary   GET "fund_quarter_summary?select=*&limit=1" \
  "permission denied for view fund_quarter_summary"
expect_denied fund_realtime_activity GET "fund_realtime_activity?select=*&limit=1" \
  "permission denied for view fund_realtime_activity"
expect_denied insider_cluster_buys   GET "insider_cluster_buys?select=*&limit=1" \
  "permission denied for view insider_cluster_buys"
expect_denied insider_sentiment      GET "insider_sentiment?select=*&limit=1" \
  "permission denied for view insider_sentiment"
# The two internal views were never granted, but are swept so the wire check
# covers the same set as the PGlite denial test.
expect_denied filings_effective      GET "filings_effective?select=*&limit=1" \
  "permission denied for view filings_effective"
expect_denied holdings_13f_agg       GET "holdings_13f_agg?select=*&limit=1" \
  "permission denied for view holdings_13f_agg"

# --- a base table, for good measure ----------------------------------------
expect_denied holdings_13f GET "holdings_13f?select=*&limit=1" \
  "permission denied for table holdings_13f"

if [ "$FAILED" -ne 0 ]; then
  echo "postgrest-smoke: FAILED" >&2
  exit 1
fi
echo "postgrest-smoke: all reachability checks passed."
