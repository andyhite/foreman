#!/usr/bin/env bash
# Regression tests for `fleet dashboard`.
#
# Same shape as fleet-test.sh: no framework, no dependencies beyond what the
# dashboard itself needs. Everything here is a pure function or a function over
# files on disk, so the whole suite runs without a terminal, a herdr session or
# a worker.
#
#   herdr/test/fleet-dashboard-test.sh
#   /bin/bash herdr/test/fleet-dashboard-test.sh    # macOS system bash 3.2
#
# The interactive layer — raw mode, escape-sequence decoding, the draw loop —
# is deliberately not covered here; it needs a pty. What it dispatches to is,
# via dash_action_for_key, which exists as a separate function precisely so the
# keymap can be asserted without one.

# Sourcing the dashboard is invisible to shellcheck, so it reports the state
# variables the tests set for it as unused (SC2034) and its stubs as unreachable
# (SC2329). Expected output carrying a literal tilde is SC2088.
# shellcheck disable=SC1091,SC2329,SC2034,SC2088

# Deliberately not `set -e`: a failing assertion must record itself and let the
# rest of the suite run.
set -uo pipefail

BIN=$(cd "$(dirname "$0")/.." && pwd)/bin
DASHBOARD="$BIN/fleet-dashboard"
[ -f "$DASHBOARD" ] || { printf 'cannot find fleet-dashboard at %s\n' "$DASHBOARD" >&2; exit 1; }

failures=0
ok()  { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — want [$3], got [$2]"; fi; }
assert()     { if "${@:2}"; then ok "$1"; else bad "$1"; fi; }
assert_not() { if "${@:2}"; then bad "$1"; else ok "$1"; fi; }

sandbox=$(mktemp -d) || exit 1

# Escape codes would have to be stripped out of every expectation below, and
# the dashboard decides its palette once, at source time.
export NO_COLOR=1
export FLEET_STATE="$sandbox/state"

# Functions under test, without taking over the terminal. This also sources
# `fleet`, which the dashboard depends on for its state helpers.
# shellcheck source=../bin/fleet-dashboard
source "$DASHBOARD"
# Both files set `-e` at their top, and sourcing applies that here too — it
# would abort the run on the first assertion that is *supposed* to fail.
set +e
# After sourcing: the dashboard installs its own EXIT trap to restore the
# terminal, and registering the cleanup first would just lose it.
trap 'dash_leave_screen; rm -rf "$sandbox"' EXIT

# ── scope ────────────────────────────────────────────────────────────────────
#
# Which repository the dashboard reports on. A popup starts in the plugin root,
# so getting this wrong does not fail loudly — it quietly shows this plugin's
# own checkout instead of the workspace the user is looking at, which is the
# bug `fleet-ls` already had to be fixed for.

printf '\nscope\n'
ctx='{"workspace_id":"w1","workspace_cwd":"'"$sandbox"'"}'

is 'an explicit --cwd wins outright' \
  "$(dash_scope_dir "$sandbox" dashboard "$ctx" /fallback)" "$sandbox"
is 'a plugin pane prefers the workspace herdr handed it' \
  "$(dash_scope_dir '' dashboard "$ctx" /fallback)" "$sandbox"
is 'outside a plugin pane the context is ignored' \
  "$(dash_scope_dir '' '' "$ctx" /fallback)" '/fallback'
is 'a workspace that is not a directory falls back' \
  "$(dash_scope_dir '' dashboard '{"workspace_cwd":"/nope/nowhere"}' /fallback)" '/fallback'
is 'a context with no workspace falls back' \
  "$(dash_scope_dir '' dashboard '{}' /fallback)" '/fallback'
is 'unparseable context JSON falls back rather than aborting' \
  "$(dash_scope_dir '' dashboard 'not json at all' /fallback)" '/fallback'

# ── keymap ───────────────────────────────────────────────────────────────────
#
# Every binding the help screen advertises has to reach an arm of the loop's
# case. A key that maps to nothing is a documented feature that does nothing.

printf '\nkeymap\n'
for pair in \
  'j next' 'down next' 'k prev' 'up prev' 'g first' 'G last' \
  'enter focus' 'right focus' 'r report' 't terminal' 'l log' \
  's send' 'S steer' 'a answer' 'n spawn' 'x reap' 'X reap-force' \
  'A scope' 'R refresh' '? help' 'q quit' 'esc quit' 'tick tick'
do
  set -- $pair
  is "$1 -> $2" "$(dash_action_for_key "$1")" "$2"
done
is 'an unbound key does nothing' "$(dash_action_for_key 'Z')" 'none'
is 'an unrecognised escape sequence does nothing' "$(dash_action_for_key 'unknown')" 'none'

# Case matters: the destructive pair is one shift away from the safe one, and a
# case-insensitive match would make `x` discard uncommitted work.
assert_not 'reap and reap --force are distinct keys' \
  [ "$(dash_action_for_key x)" = "$(dash_action_for_key X)" ]
assert_not 'send and steer are distinct keys' \
  [ "$(dash_action_for_key s)" = "$(dash_action_for_key S)" ]

# Every documented key is bound. The help text is the contract with the user,
# so it is parsed rather than trusted.
missing=""
while IFS= read -r key; do
  [ -n "$key" ] || continue
  [ "$(dash_action_for_key "$key")" = none ] || continue
  missing="$missing $key"
done <<EOF
$(printf '%s\n' "$DASH_HELP" | awk '/^  Row flags/ { exit } /^    [a-zA-Z?]/ { print $1 }')
EOF
is 'every key the help advertises is bound' "${missing# }" ''

# ── key decoding ─────────────────────────────────────────────────────────────
#
# This was read with bash's `read -n 1`, which reprograms the terminal to
# VMIN=1/VTIME=0 for the duration of the call and so overrode the `stty time`
# the whole loop is built on. A lone Escape blocked until the next keystroke
# arrived and then swallowed it — Escape never closed the dashboard, and the
# key after it was misread — and the poll read never timed out, so the list
# stopped refreshing on its own. Reading through `dd` restores the driver's
# behaviour; these assertions pin the decoding that sits on top of it.

printf '\nkey decoding\n'
dash_tty_saved=$DASH_TTY
DASH_TTY=/dev/null
stty() { :; }

# The byte source, scripted: dash_key is the thing under test, not the tty.
# The queue is a file rather than a variable because dash_key consumes bytes
# through command substitution — a subshell, where an assignment would be lost
# and every call would hand back the same first byte.
byteq="$sandbox/bytes"
dash_byte() {
  local first
  first=$(sed -n '1p' "$byteq")
  sed '1d' "$byteq" >"$byteq.tmp" && mv "$byteq.tmp" "$byteq"
  printf '%s' "$first"
}
# shellcheck disable=SC2086  # the argument is a byte list and must word-split
press() { printf '%s\n' $1 >"$byteq"; dash_key; }

is 'a bare Escape is Escape, not the start of a sequence' "$(press '1b')" 'esc'
is 'and Escape closes the dashboard' "$(dash_action_for_key "$(press '1b')")" 'quit'
is 'the down arrow survives the same decoder' "$(press '1b 5b 42')" 'down'
is 'so does the up arrow'                     "$(press '1b 5b 41')" 'up'
is 'and right, which focuses'                 "$(press '1b 5b 43')" 'right'
is 'an unrecognised sequence is not a key'    "$(press '1b 5b 5a')" 'unknown'
is 'a plain key is itself'                    "$(press '71')" 'q'
is 'a shifted key keeps its case'             "$(press '58')" 'X'
is 'carriage return is enter'                 "$(press '0d')" 'enter'
is 'so is newline'                            "$(press '0a')" 'enter'

# The tick is what makes the list live: with no key pressed the read has to come
# back empty so the loop can redraw, rather than blocking until the user types.
is 'no byte within the timeout is a poll tick' "$(press '')" 'tick'
is 'and a tick redraws instead of acting' "$(dash_action_for_key "$(press '')")" 'tick'

is 'a sequence decodes from its bytes alone' "$(dash_decode_escape 5b44)" 'left'
is 'and an empty tail is a bare Escape'      "$(dash_decode_escape '')" 'esc'

unset -f stty dash_byte
DASH_TTY=$dash_tty_saved

# ── truncation ───────────────────────────────────────────────────────────────

printf '\ntruncation\n'
is 'leaves a string that fits alone' "$(dash_fit abcdef 6)" 'abcdef'
is 'ellipsizes to exactly the budget' "$(dash_fit abcdef 4)" 'abc…'
is 'a one-column budget has no room for an ellipsis' "$(dash_fit abcdef 1)" 'a'
is 'a zero-column budget is empty' "$(dash_fit abcdef 0)" ''
fitted=$(dash_fit 'aaaaaaaaaa' 5)
is 'a truncated field never exceeds its column' "${#fitted}" '5'

printf '\npath display\n'
is 'home is a bare tilde' "$(dash_tilde "$HOME")" '~'
is 'a path under home is shortened' "$(dash_tilde "$HOME/Code/x")" '~/Code/x'
is 'an unrelated path is untouched' "$(dash_tilde /var/tmp)" '/var/tmp'
# `$HOME-backup` starts with $HOME as a *string* but is not under it, and
# prefix-stripping without the slash would render it as `~-backup`.
is 'a sibling of home is not mistaken for a child' \
  "$(dash_tilde "$HOME-backup")" "$HOME-backup"

# ── glyphs ───────────────────────────────────────────────────────────────────

printf '\nglyphs\n'
is 'working'  "$(dash_glyph working 0)" '>'
is 'blocked'  "$(dash_glyph blocked 0)" '!'
is 'done'     "$(dash_glyph 'done' 0)"  '*'
is 'idle'     "$(dash_glyph idle 0)"    'o'
is 'gone'     "$(dash_glyph gone 0)"    'x'
is 'a status herdr has not taught us yet' "$(dash_glyph starting 0)" '.'
# A worker waiting on an answer is the one thing in a wave that stops
# everything else from mattering, so it outranks whatever herdr reports.
is 'a pending question outranks the agent status' "$(dash_glyph working 1)" '?'
is 'even for an agent that is gone' "$(dash_glyph gone 1)" '?'

# ── status lookup ────────────────────────────────────────────────────────────
#
# One `agent list` per refresh is turned into a table and read N times. bash 3.2
# has no associative arrays, so this is a scan — and a scan is exactly where a
# prefix match creeps in.

printf '\nstatus lookup\n'
DASH_STATUSES=$(printf 'boss\tidle\nfeat-x\tworking\nfeat-x-2\tblocked\n')
is 'finds a status'                 "$(dash_status_of feat-x)"   'working'
is 'does not stop at a prefix'      "$(dash_status_of feat-x-2)" 'blocked'
is 'an unregistered agent is gone'  "$(dash_status_of nobody)"   'gone'
DASH_STATUSES=""
is 'an empty roster is all gone'    "$(dash_status_of feat-x)"   'gone'

# ── selection ────────────────────────────────────────────────────────────────

printf '\nselection\n'
DASH_HANDLES=$(printf 'alpha\nbeta\ngamma\n')
is 'indexes from zero'       "$(dash_handle_at 0)" 'alpha'
is 'indexes the last row'    "$(dash_handle_at 2)" 'gamma'
is 'past the end is empty'   "$(dash_handle_at 3)" ''
DASH_SEL=1
is 'the selection reads through' "$(dash_selected)" 'beta'
DASH_HANDLES=""
is 'an empty list has no selection' "$(dash_handle_at 0)" ''

# ── row flags ────────────────────────────────────────────────────────────────
#
# `<dispatches><report><join>`: the send/report/collect state, which is the
# part `fleet ls` cannot show at all. Each character is written by a different
# command, so the encoding is asserted against the files those commands write
# rather than against a fixture.

printf '\nrow flags\n'
h=flagworker
mkdir -p "$(meta_dir "$h")"

bump()  { counter_bump "$(dispatch_file "$1")"; }                        # dispatch_to
stamp() { cp "$(dispatch_file "$1")" "$(report_token_file "$1")"; }      # fleet report
join()  { cp "$(dispatch_file "$1")" "$(joined_token_file "$1")"; }      # fleet join

is 'a worker that has never been dispatched to' "$(dash_flags "$h")" '0-.'

bump "$h"
is 'dispatched, nothing back yet' "$(dash_flags "$h")" '1-^'

printf 'findings\n' >"$(report_file "$h")"; stamp "$h"
is 'reported, not collected' "$(dash_flags "$h")" '1+^'

join "$h"
is 'reported and collected' "$(dash_flags "$h")" '1+.'

bump "$h"
is 'redispatched makes the old report stale again' "$(dash_flags "$h")" '2-^'
assert 'and does not destroy it' [ -s "$(report_file "$h")" ]

# ── detail strip ─────────────────────────────────────────────────────────────
#
# What the selected worker is currently saying. The ordering is the whole
# point: a question the orchestrator has not answered has to win over a report,
# or a blocked wave looks finished.

printf '\ndetail strip\n'
d=detailworker
mkdir -p "$(meta_dir "$d")"

first_line() { printf '%s\n' "$1" | sed -n '1p'; }

is 'nothing selected explains the empty list' \
  "$(first_line "$(dash_detail_lines '' 5)")" \
  'no workers here — n spawns one, A widens the scope to every repo'

is 'a silent worker says so' \
  "$(first_line "$(dash_detail_lines "$d" 5)")" \
  "$d has filed no report — t reads its terminal"

printf 'the findings\n' >"$(report_file "$d")"
counter_bump "$(dispatch_file "$d")"
cp "$(dispatch_file "$d")" "$(report_token_file "$d")"
is 'a fresh report is shown with its dispatch number' \
  "$(first_line "$(dash_detail_lines "$d" 5)")" \
  'report for dispatch 1 — r opens all of it'
is 'and its text follows' \
  "$(printf '%s\n' "$(dash_detail_lines "$d" 5)" | sed -n '2p')" 'the findings'

counter_bump "$(dispatch_file "$d")"
is 'a stale report is kept, and labelled stale' \
  "$(first_line "$(dash_detail_lines "$d" 5)")" \
  'no report for the current dispatch; the previous one begins:'

printf 'which branch should I use?\n' >"$(question_file "$d")"
counter_bump "$(question_seq_file "$d")"
is 'an unanswered question outranks the report' \
  "$(first_line "$(dash_detail_lines "$d" 5)")" \
  "QUESTION from $d — a answers it"
is 'and the question itself follows' \
  "$(printf '%s\n' "$(dash_detail_lines "$d" 5)" | sed -n '2p')" \
  'which branch should I use?'

# What `a` does after the send: without this half the question stays pending
# forever, and the next `fleet join` returns early on an answered question.
cp "$(question_seq_file "$d")" "$(question_seen_file "$d")"
assert_not 'acknowledging clears the pending question' question_pending "$d"

# ── row rendering ────────────────────────────────────────────────────────────
#
# A row that overruns the frame wraps, and one wrapped row pushes every line
# below it down — which in a fixed frame means the whole screen tears.

printf '\nrow rendering\n'
r=renderworker
meta_set "$r" BRANCH=feat/a-branch-name-of-some-considerable-length \
  DIR="$HOME/Code/somewhere/deep/and/long/renderworker" KIND=codex
DASH_STATUSES=$(printf '%s\tworking\n' "$r")

for cols in 40 80 193; do
  DASH_COLS=$cols
  dash_columns
  row=$(dash_row "$r" 0)
  is "a $cols-column row fits its frame" "$([ ${#row} -le $cols ] && echo fits)" 'fits'
done

DASH_COLS=120; dash_columns
row=$(dash_row "$r" 0)
case "$row" in
  *"$r"*)  ok 'the row carries its handle' ;;
  *)       bad 'the row carries its handle' ;;
esac
case "$row" in
  *'~/Code/'*) ok 'the row shortens home in the worktree path' ;;
  *)           bad 'the row shortens home in the worktree path' ;;
esac
case "$row" in
  ' > '*) ok 'the row leads with its status glyph' ;;
  *)      bad "the row leads with its status glyph — got [${row%%"$r"*}]" ;;
esac
# A field wide enough to be ellipsized used to shorten its own column by two,
# because printf pads to a byte count and the ellipsis is three bytes.
DASH_COLS=120; dash_columns
ellipsized=$(dash_cell 'a-branch-far-too-long-for-its-column' "$DASH_W_BRANCH")
is 'an ellipsized column still occupies its full width' \
  "${#ellipsized}" "$DASH_W_BRANCH"

selected=$(dash_row "$r" 1)
is 'a selected row is padded to the full width so the highlight is a bar' \
  "${#selected}" "$DASH_COLS"

# ── frame geometry ───────────────────────────────────────────────────────────

printf '\nframe geometry\n'
# dash_measure redirects from $DASH_TTY, and a test run has no controlling
# terminal — pointing it at /dev/null keeps the redirect succeeding so the
# stubbed `stty` is the thing under test.
dash_tty_real=$DASH_TTY
DASH_TTY=/dev/null
stty() { printf '%s\n' "$STTY_SIZE"; }

STTY_SIZE='54 193'
dash_measure
is 'a real popup size is taken as given (rows)' "$DASH_ROWS" '54'
is 'a real popup size is taken as given (cols)' "$DASH_COLS" '193'

STTY_SIZE='2 8'
dash_measure
assert 'a frame too short to draw is clamped' [ "$DASH_ROWS" -ge 10 ]
assert 'a frame too narrow to draw is clamped' [ "$DASH_COLS" -ge 40 ]

# A terminal that cannot answer must not leave the frame at zero.
STTY_SIZE=''
dash_measure
assert 'an unanswerable terminal keeps the last usable size' [ "$DASH_ROWS" -ge 10 ]

unset -f stty
DASH_TTY=$dash_tty_real

# Column budgets have to survive the narrowest frame the clamp allows.
DASH_COLS=40; dash_columns
total=$((3 + DASH_W_HANDLE + DASH_W_STATUS + DASH_W_KIND + DASH_W_FLAGS + DASH_W_BRANCH + DASH_W_DIR + 5))
assert 'the branch column is positive at 40 columns' [ "$DASH_W_BRANCH" -gt 0 ]
assert 'the dir column is positive at 40 columns'    [ "$DASH_W_DIR" -gt 0 ]
assert 'and the row is truncated to the frame rather than the budget' \
  [ "$total" -ge "$DASH_COLS" ]

# ── operation log ────────────────────────────────────────────────────────────
#
# The log lives under $FLEET_STATE, which is also the directory `known_workers`
# globs for worker records. A visible name in there would list as a worker, on
# every fleet command, in every repository.

printf '\noperation log\n'
dash_log_init
is 'the log is kept inside the fleet state directory' \
  "${DASH_LOG%/*}" "$FLEET_STATE/.dashboard"
dash_log_head 'a test operation'
assert 'and writing to it works' [ -s "$DASH_LOG" ]

listed=""
for handle in $(known_workers ''); do
  case "$handle" in .*) listed="$listed $handle" ;; esac
done
is 'and it is not mistaken for a worker' "${listed# }" ''

# ── frame height ─────────────────────────────────────────────────────────────
#
# The frame is a fixed grid: exactly one screenful, with the last line carrying
# no newline. One line too many scrolls the terminal and the whole thing
# flickers on every poll tick; one too few and the keymap floats off the bottom
# edge, taking the separator and the detail band with it.

printf '\nframe height\n'
dash_tty_real=$DASH_TTY
DASH_TTY=/dev/null
stty() { printf '%s\n' "$STTY_SIZE"; }
dash_out() { :; }   # the frame is asserted, not drawn

frame_lines() {
  STTY_SIZE="$1 100"
  DASH_SEL=0
  dash_draw
  # The frame opens with a cursor-home escape and closes with a clear-to-end;
  # every line but the last is newline-terminated.
  printf '%s' "$DASH_FRAME" | sed -n '$=' | tr -d '\n'
}

meta_set alpha BRANCH=feat/a DIR=/tmp/a KIND=omp
meta_set beta  BRANCH=feat/b DIR=/tmp/b KIND=omp

DASH_HANDLES=$(printf 'alpha\nbeta\n'); DASH_COUNT=2; DASH_STATUSES=""
is 'a 30-row terminal draws 30 rows'  "$(frame_lines 30)" '30'
is 'a 54-row popup draws 54 rows'     "$(frame_lines 54)" '54'
is 'the clamped minimum draws 10 rows' "$(frame_lines 4)" '10'

DASH_HANDLES=""; DASH_COUNT=0
is 'an empty fleet still fills the frame' "$(frame_lines 30)" '30'

# More workers than the band can hold: the window scrolls, the frame does not.
many=""
i=0
while [ "$i" -lt 40 ]; do many="$many$(printf 'w%s\n' "$i")"$'\n'; i=$((i + 1)); done
DASH_HANDLES=$many; DASH_COUNT=40
is 'a fleet larger than the frame still draws one screenful' "$(frame_lines 30)" '30'
DASH_SEL=39
dash_draw
is 'and the last worker is reachable' "$(dash_selected)" 'w39'

unset -f stty dash_out
DASH_TTY=$dash_tty_real

# ── opening the popup ────────────────────────────────────────────────────────
#
# A popup is a singleton session resource and the command palette is itself a
# popup, so the palette — the advertised way to reach this action — is still
# holding the slot at the moment it dispatches the action. Opening once and
# giving up returned "popup already open" for every palette invocation, which
# is every invocation a new user makes.

printf '\nopening the popup\n'
openbin="$sandbox/openbin"
mkdir -p "$openbin"
cat >"$openbin/herdr" <<'STUB'
#!/bin/sh
case "$1 $2" in
  "plugin pane")
    n=$(cat "$OPEN_COUNTER" 2>/dev/null || printf 0)
    n=$((n + 1)); printf '%s' "$n" >"$OPEN_COUNTER"
    case "$OPEN_SCENARIO" in
      ok) printf '{"result":{"type":"ok"}}\n'; exit 0 ;;
      busy-then-ok)
        [ "$n" -ge 3 ] && { printf '{"result":{"type":"ok"}}\n'; exit 0; }
        printf '{"error":{"code":"plugin_pane_open_failed","message":"popup already open"}}\n'
        exit 1 ;;
      always-busy)
        printf '{"error":{"code":"plugin_pane_open_failed","message":"popup already open"}}\n'
        exit 1 ;;
      fatal)
        printf '{"error":{"code":"entrypoint_not_found","message":"no such entrypoint"}}\n'
        exit 1 ;;
    esac ;;
  "notification show") printf 'toast\n' >>"$OPEN_NOTIFY"; exit 0 ;;
esac
exit 0
STUB
chmod +x "$openbin/herdr"

export HERDR_BIN_PATH="$openbin/herdr"
export OPEN_COUNTER="$sandbox/open-count"
export OPEN_NOTIFY="$sandbox/open-notify"
export FLEET_DASHBOARD_OPEN_TIMEOUT_S=1

run_open() {
  export OPEN_SCENARIO=$1
  : >"$OPEN_COUNTER"; : >"$OPEN_NOTIFY"
  "$BIN/fleet-dashboard-open" >/dev/null 2>&1
}

run_open ok
is 'a free popup slot opens on the first attempt' "$?$(cat "$OPEN_COUNTER")" '01'

run_open busy-then-ok
rc=$?
is 'the palette holding the slot is waited out, not reported' "$rc" '0'
assert 'and it took more than one attempt' [ "$(cat "$OPEN_COUNTER")" -gt 1 ]
is 'with no toast, because nothing failed' "$(cat "$OPEN_NOTIFY")" ''

run_open always-busy
rc=$?
is 'a slot that never frees is reported' "$rc" '1'
assert 'after retrying rather than after one attempt' [ "$(cat "$OPEN_COUNTER")" -gt 1 ]
is 'and it says so' "$(cat "$OPEN_NOTIFY")" 'toast'

# Retrying a real misconfiguration for the whole budget delays the only useful
# signal by the whole budget.
run_open fatal
rc=$?
is 'an error that is not a modal fails immediately' "$rc" '1'
is 'on the first attempt' "$(cat "$OPEN_COUNTER")" '1'

unset HERDR_BIN_PATH OPEN_COUNTER OPEN_NOTIFY OPEN_SCENARIO FLEET_DASHBOARD_OPEN_TIMEOUT_S

# ── plugin wiring ────────────────────────────────────────────────────────────
#
# The manifest names commands by path, and herdr only resolves them when the
# user opens the popup. A rename here is otherwise silent until then.

printf '\nplugin wiring\n'
manifest=$(cd "$(dirname "$0")/.." && pwd)/herdr-plugin.toml
assert 'the manifest declares a dashboard pane' \
  grep -q '^id = "dashboard"' "$manifest"
assert 'as a popup' grep -q '^placement = "popup"' "$manifest"
assert 'the dashboard the manifest launches is executable' [ -x "$BIN/fleet-dashboard" ]
assert 'so is the action that opens it'                    [ -x "$BIN/fleet-dashboard-open" ]

while IFS= read -r cmd; do
  [ -n "$cmd" ] || continue
  assert "the manifest command '$cmd' exists" [ -e "$BIN/../$cmd" ]
done <<EOF
$(sed -n 's|.*"[./]*\(bin/[a-z-]*\)".*|\1|p' "$manifest")
EOF

# `fleet dashboard` has to reach the dashboard's own argument parsing, which
# happens before it needs herdr — so this runs without a session.
out=$("$BIN/fleet" dashboard --help 2>&1); rc=$?
is 'fleet dashboard --help exits like every other usage' "$rc" '2'
case "$out" in
  *'usage: fleet dashboard'*) ok 'and prints the dashboard usage' ;;
  *) bad "and prints the dashboard usage — got [$out]" ;;
esac
out=$("$BIN/fleet" dash --help 2>&1)
case "$out" in
  *'usage: fleet dashboard'*) ok 'the dash alias reaches the same program' ;;
  *) bad "the dash alias reaches the same program — got [$out]" ;;
esac

printf '\n'
if [ "$failures" = 0 ]; then
  printf 'all tests passed\n'; exit 0
fi
printf '%s test(s) failed\n' "$failures"; exit 1
