#!/usr/bin/env bash
# Regression tests for `fleet`.
#
# No framework: the plugin is dependency-free shell and its tests should be
# too, so this runs anywhere fleet itself does. Every case here is a bug that
# was actually shipped, not a hypothetical.
#
#   herdr/test/fleet-test.sh
#
# Run it under the oldest bash you support as well — several of these only
# fail there:
#
#   /bin/bash herdr/test/fleet-test.sh    # macOS system bash 3.2

# Deliberately not `set -e`: a failing assertion must record itself and let the
# rest of the suite run.
set -uo pipefail

FLEET=$(cd "$(dirname "$0")/.." && pwd)/bin/fleet
[ -f "$FLEET" ] || { printf 'cannot find fleet at %s\n' "$FLEET" >&2; exit 1; }

failures=0
ok()  { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — want [$3], got [$2]"; fi; }
assert()     { if "${@:2}"; then ok "$1"; else bad "$1"; fi; }
assert_not() { if "${@:2}"; then bad "$1"; else ok "$1"; fi; }

sandbox=$(mktemp -d) || exit 1
trap 'rm -rf "$sandbox"' EXIT

# Functions under test, without running a command.
# shellcheck source=../bin/fleet
source "$FLEET"
# fleet sets `-e` at its top, and sourcing applies that to this shell too — it
# would abort the run on the first assertion that is *supposed* to fail.
set +e

# ── slugify ──────────────────────────────────────────────────────────────────
#
# A branch reduces to a herdr agent name: [a-z][a-z0-9_-]{0,31}.

printf '\nslugify\n'
is 'lowercases and separates' "$(slugify 'FEAT/1234-Add_Widget_v2')" 'feat-1234-add-widget-v2'
is 'prefixes a leading digit'  "$(slugify '42')" 'w-42'

long=$(slugify 'a-very-long-branch-name-that-keeps-going-and-going')
is 'truncates to 32'           "${#long}" '32'
assert_not 'no trailing hyphen after truncation' [ "${long%-}" != "$long" ]

# Every branch that reduces to nothing used to collapse onto the same handle,
# so two such worktrees could not coexist.
a=$(slugify '---'); b=$(slugify '///'); c=$(slugify '-.-')
assert_not 'degenerate slugs do not collide' [ "$a" = "$b" ]
assert_not 'degenerate slugs do not collide (2)' [ "$b" = "$c" ]
assert 'degenerate slug is still a legal handle' valid_handle "$a"
is 'degenerate slug is stable' "$(slugify '---')" "$a"

# ── valid_handle ─────────────────────────────────────────────────────────────
#
# This is what stands between a command-line argument and `rm -rf`.

printf '\nvalid_handle\n'
assert     'accepts a plain handle'     valid_handle 'webapp'
assert     'accepts digits and dashes'  valid_handle 'feat-412-retry'
assert     'accepts underscores'        valid_handle 'a_b'
assert_not 'rejects empty'              valid_handle ''
assert_not 'rejects a leading digit'    valid_handle '1abc'
assert_not 'rejects uppercase'          valid_handle 'Webapp'
assert_not 'rejects relative traversal' valid_handle '../victim'
assert_not 'rejects absolute paths'     valid_handle '/etc'
assert_not 'rejects an embedded slash'  valid_handle 'a/b'
assert_not 'rejects 33 characters'      valid_handle 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

# ── report freshness ─────────────────────────────────────────────────────────
#
# Whether a report answers the most recent dispatch. This was an mtime
# comparison, and `test -nt` resolves to whole seconds under bash 3.2, so a
# worker that reported inside the same second as its dispatch read as stale —
# which made a fast task look like a dispatch that never landed.

printf '\nreport freshness\n'
export FLEET_STATE="$sandbox/state"
h=worker1
mkdir -p "$(meta_dir "$h")"

bump() {  # what dispatch_to does to the counter
  local df n; df=$(dispatch_file "$1")
  n=$(cat "$df" 2>/dev/null || true)
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  printf '%s' "$((n + 1))" >"$df"
}
stamp() { cp "$(dispatch_file "$1")" "$(report_token_file "$1")"; }  # what `fleet report` does

assert_not 'no report at all is not fresh' report_is_fresh "$h"

printf 'findings\n' >"$(report_file "$h")"
assert 'an undispatched report is fresh' report_is_fresh "$h"

bump "$h"
assert_not 'a report predating the dispatch is stale' report_is_fresh "$h"

printf 'answer\n' >"$(report_file "$h")"; stamp "$h"
assert 'a report in the same second as its dispatch is FRESH' report_is_fresh "$h"

bump "$h"
assert_not 'redispatch makes the old report stale' report_is_fresh "$h"
assert 'and does not destroy it' [ -s "$(report_file "$h")" ]

printf 'answer2\n' >"$(report_file "$h")"; stamp "$h"
assert 'the answer to the second dispatch is fresh' report_is_fresh "$h"

# ── reap argument handling ───────────────────────────────────────────────────
#
# `cmd_reap` joins a handle onto $FLEET_STATE and `rm -rf`s it, and its handles
# come straight off the command line. Needs a real herdr on PATH.

printf '\nreap\n'
if [ "${HERDR_ENV:-}" = 1 ] && command -v herdr >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  reap_state="$sandbox/reap"
  reap() (
    cd /tmp || exit 1
    FLEET_STATE="$reap_state" HERDR_ENV=1 HERDR_PANE_ID=x "$FLEET" reap "$@" 2>&1
  )
  mk() { mkdir -p "$reap_state/$1"; : >"$reap_state/$1/meta"; }

  mk good1; reap good1 >/dev/null
  assert_not 'a valid handle is reaped' [ -d "$reap_state/good1" ]

  mk good2
  out=$(reap good2 '../../etc'); rc=$?
  is  'a traversal argument fails'     "$rc" '1'
  assert 'and says which handle'       [ "${out#*invalid handle}" != "$out" ]
  assert 'and reaps nothing before it' [ -d "$reap_state/good2" ]

  out=$(reap '/tmp/anything'); is 'an absolute path fails' "$?" '1'

  # `--all` used to resolve its scope the moment it was parsed, so this died
  # telling the user to pass the flag they had already passed.
  out=$(reap --all --all-repos)
  assert_not 'reap --all --all-repos does not contradict itself' \
    [ "${out#*pass --all-repos}" != "$out" ]
else
  printf '  skip  reap CLI cases (needs herdr, jq, and HERDR_ENV=1)\n'
fi

printf '\n'
if [ "$failures" = 0 ]; then
  printf 'all tests passed\n'; exit 0
fi
printf '%s test(s) failed\n' "$failures"; exit 1
