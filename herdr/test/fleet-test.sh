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

# Several sections replace a sourced function with a stub, so the tests can
# cover logic that would otherwise need a live herdr. shellcheck cannot see
# that those definitions shadow something and reports each as unused.
# shellcheck disable=SC1091,SC2329

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

# ── skills and worker args ──────────────────────────────────────────────────

printf '\nskills\n'
is 'renders the omp-native skill instruction' "$(skill_instruction implement)" \
  'Before doing any other work, read `skill://implement` and follow it.'
assert_not 'skill names reject traversal' valid_skill_name '../implement'
assert_not 'skill names reject uppercase' valid_skill_name 'Implement'

printf '\nagent tiers and models\n'
assert 'accepts standard' valid_agent_tier 'standard'
assert 'accepts deep' valid_agent_tier 'deep'
assert_not 'rejects an unknown tier' valid_agent_tier 'cheap'
assert_not 'rejects an empty tier' valid_agent_tier ''
assert 'accepts a role selector' valid_agent_model '@task'
assert 'accepts a provider/model selector' valid_agent_model 'anthropic/claude-sonnet-5'
assert_not 'rejects a model option injection' valid_agent_model '--model'
assert_not 'rejects a model with spaces' valid_agent_model 'claude sonnet'
is 'standard maps to @task' "$(worker_agent_args standard '')" $'--model\n@task'
is 'deep maps to @default' "$(worker_agent_args deep '')" $'--model\n@default'
is 'explicit --model wins the plan' "$(worker_agent_args '' '@smol')" $'--model\n@smol'
is 'no tier and no model yields nothing' "$(worker_agent_args '' '')" ''

herdr_args="$sandbox/herdr-args"
herdr() { printf '%s\n' "$*" >"$herdr_args"; }
start_worker_agent worker ws pane
is 'always starts an omp agent' "$(cat "$herdr_args")" \
  'agent start worker --kind omp --pane pane --timeout 120000'
start_worker_agent worker ws pane --model '@task'
is 'threads model args after --' "$(cat "$herdr_args")" \
  'agent start worker --kind omp --pane pane --timeout 120000 -- --model @task'
unset -f herdr

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

# ── dispatched prompt composition ────────────────────────────────────────────
#
# The contract a worker actually receives: the portable skill instruction first,
# then the brief, then fleet's own protocol block. herdr is stubbed so the whole
# composition is asserted without creating a worktree or starting an agent.

printf '\ndispatched prompt\n'
if command -v git >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  spawn_repo="$sandbox/repo"
  mkdir -p "$spawn_repo"
  ( cd "$spawn_repo" && git init -q . \
    && git -c user.email=t@example.com -c user.name=t \
         commit -q --allow-empty -m init ) >/dev/null 2>&1

  prompt_file="$sandbox/prompt.txt"
  started_file="$sandbox/started"
  start_args="$sandbox/start-args"
  rm -f "$prompt_file" "$started_file" "$start_args"

  # `agent start` flips the roster: before it the handle must be free, after it
  # the worker has to look live and busy or dispatch_to would never settle.
  herdr() {
    case "$1 $2" in
      'agent list')
        if [ -f "$started_file" ]; then
          printf '{"result":{"agents":[{"name":"foreman","pane_id":"p0"},{"name":"feat-x","pane_id":"p1","agent_status":"working","interactive_ready":true,"workspace_id":"w1"}]}}'
        else
          printf '{"result":{"agents":[{"name":"foreman","pane_id":"p0"}]}}'
        fi ;;
      'plugin list') printf '' ;;
      'worktree create')
        printf '{"result":{"workspace":{"workspace_id":"w1"},"tab":{"tab_id":"t1"},"root_pane":{"pane_id":"p1"}}}' ;;
      'agent start') printf '%s\n' "$*" >"$start_args"; : >"$started_file" ;;
      'agent prompt') printf '%s' "$4" >"$prompt_file"; printf '{}' ;;
      *) printf '{}' ;;
    esac
  }

  # A subshell, because `die` exits: a regression here must fail one assertion
  # rather than abort the whole run.
  ( cd "$spawn_repo" \
    && FLEET_STATE="$sandbox/spawn-state" HERDR_ENV=1 HERDR_PANE_ID=p0 \
       cmd_spawn feat/x --tier deep --skill implement \
         --task 'Add exponential backoff to the dispatcher.' ) >/dev/null 2>&1

  assert 'a --skill spawn dispatches a prompt' [ -s "$prompt_file" ]
  prompt=$(cat "$prompt_file" 2>/dev/null || true)
  is 'the worker is told to load the skill first' "$(printf '%s' "$prompt" | sed -n 1p)" \
    'Before doing any other work, read `skill://implement` and follow it.'
  assert 'the brief follows the instruction' \
    [ "${prompt#*Add exponential backoff to the dispatcher.}" != "$prompt" ]
  assert 'fleets own protocol block is still appended' \
    [ "${prompt#*fleet report}" != "$prompt" ]
  started_cmd=$(cat "$start_args" 2>/dev/null || true)
  assert 'every worker starts as omp' \
    [ "${started_cmd#*--kind omp}" != "$started_cmd" ]
  is 'the skill is recorded for later inspection' \
    "$(FLEET_STATE="$sandbox/spawn-state" meta_get feat-x SKILL)" 'implement'
  is 'the tier is recorded for later inspection' \
    "$(FLEET_STATE="$sandbox/spawn-state" meta_get feat-x TIER)" 'deep'
  is 'the mapped model is recorded for later inspection' \
    "$(FLEET_STATE="$sandbox/spawn-state" meta_get feat-x MODEL)" '@default'
  assert 'the mapped model reached agent start' \
    [ "${started_cmd#*--model @default}" != "$started_cmd" ]

  # `$FLEET_AGENT_TIER` must yield to an explicit `--model`, and the env-derived
  # tier must not be recorded beside it. Without that, exporting the documented
  # default makes the escape hatch unusable.
  rm -f "$prompt_file" "$started_file" "$start_args"
  ( cd "$spawn_repo" \
    && FLEET_STATE="$sandbox/spawn-state" FLEET_AGENT_TIER=deep \
       HERDR_ENV=1 HERDR_PANE_ID=p0 \
       cmd_spawn feat/y --model sonnet --skill implement \
         --task 'Prove --model wins over FLEET_AGENT_TIER.' ) >/dev/null 2>&1
  started_cmd=$(cat "$start_args" 2>/dev/null || true)
  is 'env-tier + --model records no tier' \
    "$(FLEET_STATE="$sandbox/spawn-state" meta_get feat-y TIER)" ''
  is 'env-tier + --model records the explicit model' \
    "$(FLEET_STATE="$sandbox/spawn-state" meta_get feat-y MODEL)" 'sonnet'
  assert 'the explicit --model reached agent start' \
    [ "${started_cmd#*--model sonnet}" != "$started_cmd" ]

  unset -f herdr
else
  printf '  skip  dispatched prompt cases (needs git and jq)\n'
fi

# ── plugin prose ─────────────────────────────────────────────────────────────
#
# The old `fleet spawn --skill` printer is gone; workers now read
# `skill://<name>` directly, which only omp can resolve. A stray reference to
# that removed printer left in the plugin prose after the cutover would
# silently tell a worker to run something that no longer exists.

printf '\nplugin prose\n'
plugin_dir=$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)
if [ -n "$plugin_dir" ]; then
  offenders=""
  for f in "$plugin_dir"/command-prompts/*.md "$plugin_dir"/skills/*/SKILL.md \
           "$plugin_dir"/README.md; do
    [ -f "$f" ] || continue
    if [ -n "$(sed -n -E '/fleet[[:space:]]+skill/p' "$f")" ]; then
      offenders="$offenders $(basename "$(dirname "$f")")/$(basename "$f")"
    fi
  done
  is 'no removed fleet-skill reference survives in the plugin prose' "${offenders# }" ''

  # `orchestrate` arms omp's magic-keyword orchestration contract on the
  # worker's very first turn. It belongs only in the three commands whose
  # dispatched work is genuinely multi-phase; leaking it into a fifth file
  # (a copy-paste from one of these three, say) would silently change a
  # worker's behavior with no review signal.
  offenders=""
  for f in "$plugin_dir"/command-prompts/*.md "$plugin_dir"/skills/*/SKILL.md; do
    [ -f "$f" ] || continue
    if [ -n "$(sed -n -E '/(^|[^[:alnum:]_-])orchestrate([^[:alnum:]_-]|$)/p' "$f")" ]; then
      offenders="$offenders $(basename "$f")"
    fi
  done
  is 'orchestrate appears only in the commands that dispatch multi-phase work' \
    "${offenders# }" 'backlog.md implement.md prototype.md'


  # Each dispatch command must name the skill it dispatches, or the worker gets
  # the brief with no procedure attached.
  missing=""
  for c in implement diagnosing-bugs research prototype code-review; do
    f="$plugin_dir/command-prompts/$c.md"
    [ -f "$f" ] || continue
    [ -n "$(sed -n "/skill: \"$c\"/p" "$f")" ] || missing="$missing $c"
  done
  is 'every dispatch command passes its own skill:' "${missing# }" ''

  missing=""
  for c in implement diagnosing-bugs research prototype code-review; do
    f="$plugin_dir/command-prompts/$c.md"
    [ -f "$f" ] || continue
    [ -n "$(sed -n '/tier: "/p' "$f")" ] || missing="$missing $c"
  done
  is 'every dispatch command names a tier:' "${missing# }" ''
else
  printf '  skip  plugin prose cases (plugin tree not beside this checkout)\n'
fi

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

# ── meta round-trip ──────────────────────────────────────────────────────────
#
# `meta` is sourced, so every value goes through printf %q. meta_update rewrites
# one key and must not drop the rest — restating all of them was the bug that
# made it exist.

printf '\nmeta\n'
export FLEET_STATE="$sandbox/meta"
meta_set m1 "FOREMAN=my foreman" "BRANCH=feat/x'y\"z" "DIR=/tmp/a b" "WORKSPACE=w8" \
  "REPO=/r" "REPO_KEY=/r/.git"
is 'a value with a space round-trips'  "$(meta_get m1 FOREMAN)"   'my foreman'
is 'quotes and slashes round-trip'     "$(meta_get m1 BRANCH)" "feat/x'y\"z"

meta_update m1 "FOREMAN=other"
is 'meta_update rewrites its key'      "$(meta_get m1 FOREMAN)"   'other'
is 'and preserves its siblings'        "$(meta_get m1 BRANCH)" "feat/x'y\"z"
is 'and preserves the ones after it'   "$(meta_get m1 DIR)"    '/tmp/a b'

is 'an absent key reads empty'         "$(meta_get m1 NOPE)"   ''
is 'an absent worker reads empty'      "$(meta_get nosuch FOREMAN)" ''

# meta_get used to expand ${!key} *after* sourcing without unsetting first, so
# a key the file did not carry fell through to the environment. A stale meta
# file plus an exported REPO_KEY silently mis-scoped every repo-scoped command.
export REPO_KEY=leaked-from-the-environment
is 'an absent key does not leak the environment' "$(meta_get m1 XREPO_KEY)" ''
meta_set m2 "FOREMAN=b"
is 'a missing REPO_KEY ignores the exported value' "$(meta_get m2 REPO_KEY)" ''
unset REPO_KEY

# ── counters ─────────────────────────────────────────────────────────────────

printf '\ncounters\n'
cf="$sandbox/counters/c"
is 'an absent counter is empty, not zero' "$(counter_read "$cf")" ''
counter_bump "$cf"; is 'first bump is 1'  "$(counter_read "$cf")" '1'
counter_bump "$cf"; is 'second bump is 2' "$(counter_read "$cf")" '2'
printf 'garbage' >"$cf"; counter_bump "$cf"
is 'a non-numeric counter restarts at 1'  "$(counter_read "$cf")" '1'

# ── timing ───────────────────────────────────────────────────────────────────
#
# Budgets are absolute deadlines, not accumulated sleep. Accumulating counted
# only the time spent asleep, so `start_worker_agent`'s 120s bound actually
# bounded 240 iterations of a call that could itself take 120s.

printf '\ntiming\n'
past=$(deadline_ms 0)
sleep 1
assert     'a zero-ms deadline expires'      expired "$past"
is         'and has no time left'            "$(remaining_ms "$past")" '0'
future=$(deadline_ms 60000)
assert_not 'a 60s deadline has not expired'  expired "$future"
left=$(remaining_ms "$future")
assert 'and reports roughly a minute left' [ "$left" -gt 50000 ] 
assert 'never more than it was given'      [ "$left" -le 60000 ]
# sleep_ms must produce an argument `sleep` accepts on both platforms.
assert 'sleep_ms accepts sub-second values' sleep_ms 10

# ── slug collisions ──────────────────────────────────────────────────────────
#
# Three distinct branches reduce to one handle. That is tolerable while the
# first worker is live — spawn refuses a handle in use — but its *record*
# outliving its agent used to let the second spawn overwrite the first's
# BRANCH/DIR/WORKSPACE and strand a worktree nothing could find.

printf '\nslug collisions\n'
is 'feat/x and feat_x collapse' "$(slugify feat/x)" "$(slugify feat_x)"
is 'and so does feat-x'         "$(slugify feat-x)" "$(slugify feat/x)"

# ── join bookkeeping ─────────────────────────────────────────────────────────
#
# What makes a re-join terminate, and what makes a question preempt one.

printf '\njoin bookkeeping\n'
export FLEET_STATE="$sandbox/join"
for w in alive quiet asker; do mkdir -p "$(meta_dir "$w")"; : >"$(meta_file "$w")"; done
# live_workers asks herdr; the bookkeeping under test does not.
agent_exists() { case "$1" in alive|quiet|asker) return 0 ;; *) return 1 ;; esac; }

assert_not 'an undispatched worker is not joinable' \
  [ -n "$(joinable_workers | tr -d '[:space:]')" ]

counter_bump "$(dispatch_file alive)"
assert 'a dispatched worker is joinable' \
  [ "$(joinable_workers | tr -d '[:space:]')" = alive ]

mark_joined alive
assert_not 'and stops being joinable once collected' \
  [ -n "$(joinable_workers | tr -d '[:space:]')" ]

# The spin: a worker that ends its turn without ever running `fleet report` is
# simply idle, which settles instantly. Collecting it must be recorded even
# though no report exists, or "join again until everyone reports" never ends.
assert_not 'collected without a report is still collected' report_is_fresh alive

counter_bump "$(dispatch_file alive)"
assert 'a new dispatch makes it joinable again' \
  [ "$(joinable_workers | tr -d '[:space:]')" = alive ]

# `fleet spawn` makes a worker's first dispatch, and a freshly started omp can
# still be initializing or sitting on a first-run trust prompt. Refusing there
# would fail a spawn whose worktree, agent and layout already exist — and with
# no prior dispatch there is no earlier report to mislabel, so it is submitted
# with the settle check skipped rather than failed.
out=$(
  ( agent_field() { printf 'blocked'; }
    herdr() { printf '{"id":"t","result":{}}'; }
    dispatch_to quiet 'the first task' ) 2>&1
)
is 'a blocked worker accepts its FIRST dispatch'  "$?" '0'
assert 'and says pickup was not confirmed' [ "${out#*without confirming pickup}" != "$out" ]
is 'and records that dispatch' "$(counter_read "$(dispatch_file quiet)")" '1'

# A second tracked task cannot be associated with its eventual report, though:
# dispatch 1 would read dispatch 2's now-current counter when it reports. Fleet
# must refuse, without bumping that counter or prompting the agent. Raw answers
# remain allowed below.
out=$(
  ( agent_field() { printf 'working'; }
    herdr() { printf '{"id":"t","result":{}}'; }
    dispatch_to quiet 'a second tracked task' ) 2>&1
)
is 'a working worker refuses a REdispatch' "$?" '1'
assert 'and explains the raw steering path' [ "${out#*fleet send --raw}" != "$out" ]
is 'and leaves the counter alone' "$(counter_read "$(dispatch_file quiet)")" '1'

# Raw answers are steering: no protocol block, no new dispatch counter.
raw_before=$(counter_read "$(dispatch_file asker)")
raw_after=$(
  agent_field() { printf 'working'; }
  herdr() { printf '{"id":"test","result":{}}'; }
  prompt_raw asker 'use the existing RetryPolicy' 2>/dev/null
  counter_read "$(dispatch_file asker)"
)
is 'a raw answer does not bump the dispatch counter' "$raw_after" "$raw_before"

assert_not 'no question filed yet' question_pending asker
printf 'which retry policy?\n' >"$(question_file asker)"
counter_bump "$(question_seq_file asker)"
assert 'fleet reply files a pending question' question_pending asker
joinable=$(joinable_workers | tr -d '[:space:]')
assert 'a question makes an already-collected worker joinable again' \
  [ "${joinable#*asker}" != "$joinable" ]
print_question asker >/dev/null
assert_not 'and showing it clears the pending flag' question_pending asker
unset -f agent_exists

# ── workspace-manager coexistence ────────────────────────────────────────────
#
# The gate used to grep `- repo:` across the whole file and ignore `path:`
# entirely, so a repo configured by checkout path read as uncovered and fleet
# raced the plugin it exists to avoid racing.

printf '\nworkspace-manager gate\n'
wsm="$sandbox/wsm.yml"
cat >"$wsm" <<'YAML'
layouts:
  - id: web-app
    tabs:
      - title: code
        panes:
          - title: agent
            # a decoy: `repo:` outside the workspaces block
            command: echo repo: /not/a/workspace
workspaces:
  - repo: ~/code/web-app        # trailing comment
    defaultLayout: web-app
  - repo: "quoted-name"
  - path: /srv/checkouts
YAML
entries=$(workspace_manager_entries "$wsm")
is 'reads three entries, not the decoy' "$(printf '%s\n' "$entries" | wc -l | tr -d ' ')" '3'
assert 'expands nothing itself, just extracts' \
  [ "${entries#*repo	~/code/web-app}" != "$entries" ]
assert 'strips a trailing comment' \
  [ "${entries#*# trailing}" = "$entries" ]
assert 'reads a path: entry' [ "${entries#*path	/srv/checkouts}" != "$entries" ]

# Cover the matcher without a real plugin installed.
workspace_manager_enabled() { return 0; }
workspace_manager_config() { printf '%s' "$wsm"; }
assert     'a path: prefix covers a planned worktree' \
  workspace_manager_covers /some/repo /srv/checkouts/web-app-feat-x
assert_not 'an unrelated worktree is not covered' \
  workspace_manager_covers /some/repo /home/me/code/other-feat-x
assert     'a bare repo name still matches by basename' \
  workspace_manager_covers /anywhere/quoted-name /tmp/quoted-name-feat-x
# The override is the escape hatch for a repo the plugin covers but does not
# actually contend for. Without it such a repo could not use fleet at all.
FLEET_IGNORE_WORKSPACE_MANAGER=1 \
  assert_not 'and the override really disables the check' \
    workspace_manager_covers /some/repo /srv/checkouts/web-app-feat-x
unset -f workspace_manager_enabled workspace_manager_config

# ── reap --forget ────────────────────────────────────────────────────────────
#
# A worktree removed by hand leaves a record `worktree remove` can never
# satisfy, so the worker used to sit in `fleet ls` as `gone` permanently with
# no way to clear it.

printf '\nreap --forget\n'
export FLEET_STATE="$sandbox/forget"
herdr() { return 1; }   # every `worktree remove` fails, as it would for a gone worktree
meta_set stuck "BRANCH=feat/gone" "DIR=/tmp/gone" "WORKSPACE=w9"
assert_not 'reap refuses when the workspace will not remove' reap_one stuck 0 0
assert     'and leaves the record behind to try again' [ -d "$(meta_dir stuck)" ]
assert     '--forget clears the record anyway'          reap_one stuck 0 1
assert_not 'and the record is gone'                     [ -d "$(meta_dir stuck)" ]
unset -f herdr

# ── join validates explicit handles ─────────────────────────────────────────────

printf '\njoin validates explicit handles\n'
export FLEET_STATE="$sandbox/state-join-validate"
require_herdr() { :; }

out=$( (cmd_join 'no-such-worker') 2>&1 )
rc=$?
assert     'join fails for nonexistent worker' [ "$rc" != 0 ]
assert     'output contains no fleet record for' [ "${out#*no fleet record for}" != "$out" ]
assert_not 'output contains no === result' [ "${out#*===}" != "$out" ]

out=$( (cmd_join '../evil') 2>&1 )
rc=$?
assert     'join fails for invalid handle' [ "$rc" != 0 ]
assert     'output contains invalid handle' [ "${out#*invalid handle}" != "$out" ]
unset -f require_herdr

# ── tracked send refuses unregistered agents ────────────────────────────────────

printf '\ntracked send refuses unregistered agents\n'
export FLEET_STATE="$sandbox/state-send-unregistered"
agent_exists() { return 0; }
require_herdr() { :; }

out=$( (cmd_send intruder 'hi') 2>&1 )
rc=$?
assert     'send fails for unregistered agent' [ "$rc" != 0 ]
assert     'output contains not registered' [ "${out#*not a registered fleet worker}" != "$out" ]
assert     'output suggests fleet send --raw' [ "${out#*fleet send --raw}" != "$out" ]
assert_not 'no state dir created for handle' [ -d "$FLEET_STATE/intruder" ]
unset -f agent_exists require_herdr

# ── ask rejects --raw ────────────────────────────────────────────────────────────

printf '\nask rejects --raw\n'
export FLEET_STATE="$sandbox/state-ask-raw"
require_herdr() { :; }

out=$( (cmd_ask --raw intruder 'hi') 2>&1 )
rc=$?
assert 'ask --raw dies' [ "$rc" != 0 ]
assert 'output mentions fleet send --raw' [ "${out#*fleet send --raw}" != "$out" ]

# cmd_send also honors --raw in the position right after the handle, so ask
# must refuse it there too — not just in the leading position.
out=$( (cmd_ask intruder --raw 'hi') 2>&1 )
rc=$?
assert 'ask <handle> --raw dies too' [ "$rc" != 0 ]
assert 'trailing form also points at fleet send --raw' [ "${out#*fleet send --raw}" != "$out" ]
unset -f require_herdr

# ── spawn flag conflicts ─────────────────────────────────────────────────────────

printf '\nspawn flag conflicts\n'
export FLEET_STATE="$sandbox/state-spawn-flags"
herdr() { printf 'herdr was called\n' >&2; return 1; }

out=$( (cmd_spawn br --task x --task-file y) 2>&1 )
rc=$?
assert     'spawn dies on task/task-file conflict' [ "$rc" != 0 ]
assert     'output contains mutually exclusive' [ "${out#*mutually exclusive}" != "$out" ]
assert_not 'herdr was not called' [ "${out#*herdr was called}" != "$out" ]

out=$( (cmd_spawn br --no-dispatch --task x) 2>&1 )
rc=$?
assert     'spawn dies on --no-dispatch --task conflict' [ "$rc" != 0 ]
assert     'output contains --no-dispatch cannot be combined' [ "${out#*--no-dispatch cannot be combined}" != "$out" ]
assert_not 'herdr was not called' [ "${out#*herdr was called}" != "$out" ]

out=$( (cmd_spawn br --tier deep --model opus --task x) 2>&1 )
rc=$?
assert     'spawn dies on --tier/--model conflict' [ "$rc" != 0 ]
assert     'output contains tier/model mutually exclusive' [ "${out#*--tier and --model are mutually exclusive}" != "$out" ]
assert_not 'herdr was not called for tier/model' [ "${out#*herdr was called}" != "$out" ]

# `$FLEET_AGENT_TIER` is a default, not a flag. An explicit `--model` must
# override it; otherwise exporting the documented env default makes the escape
# hatch unusable. This used to die "--tier and --model are mutually exclusive".
out=$( (FLEET_AGENT_TIER=deep cmd_spawn br --model opus --task x) 2>&1 )
assert_not 'env FLEET_AGENT_TIER does not block --model' \
  [ "${out#*--tier and --model are mutually exclusive}" != "$out" ]

unset -f herdr

# ── join --timeout validation ───────────────────────────────────────────────────

printf '\njoin --timeout validation\n'
export FLEET_STATE="$sandbox/state-join-timeout"
require_herdr() { :; }

out=$( (cmd_join --timeout abc h) 2>&1 )
rc=$?
assert 'join --timeout dies on non-numeric value' [ "$rc" != 0 ]
assert 'output contains usage: fleet join' [ "${out#*usage: fleet join}" != "$out" ]
unset -f require_herdr

# ── join --once ──────────────────────────────────────────────────────────────
#
# The single-tick mode the omp fleet extension polls on a timer to deliver
# worker reports as a non-interrupting aside, instead of the orchestrator
# blocking a tool call. It must never enter the deadline/sleep loop — a
# poller calling this every few seconds must never itself block.

printf '\njoin --once\n'
export FLEET_STATE="$sandbox/state-join-once"
mkdir -p "$(meta_dir w1)"
meta_set w1 "FOREMAN=me" "BRANCH=b" "DIR=/tmp/w1" "REPO_KEY=k"
counter_bump "$(dispatch_file w1)"
printf 'settled ok' >"$(report_file w1)"
cp "$(dispatch_file w1)" "$(report_token_file w1)"
require_herdr() { :; }
scoped_key() { printf 'k'; }
herdr() {
  case "$*" in
    "agent list") printf '{"result":{"agents":[{"name":"w1","agent_status":"idle"}]}}' ;;
    *) printf '{"result":{}}' ;;
  esac
}

out=$(cmd_join --once 2>&1)
rc=$?
is     'join --once exits 0 on a settled worker' "$rc" '0'
assert 'join --once prints the settled worker' [ "${out#*w1 (idle)}" != "$out" ]
is     'join --once marks the worker joined' \
  "$(counter_read "$(joined_token_file w1)")" "$(counter_read "$(dispatch_file w1)")"
unset -f herdr

# A still-working worker must return after exactly one tick, not fall through
# to the normal deadline/`sleep_ms` loop — `sleep_ms` here would hang the
# test (and, for real, block the poller) for a full `JOIN_POLL_MS`.
export FLEET_STATE="$sandbox/state-join-once-working"
mkdir -p "$(meta_dir w2)"
meta_set w2 "FOREMAN=me" "BRANCH=b" "DIR=/tmp/w2" "REPO_KEY=k"
counter_bump "$(dispatch_file w2)"
sleep_ms() { bad 'join --once must not call sleep_ms'; }
herdr() {
  case "$*" in
    "agent list") printf '{"result":{"agents":[{"name":"w2","agent_status":"working"}]}}' ;;
    *) printf '{"result":{}}' ;;
  esac
}

out2=$(cmd_join --once 2>&1)
rc2=$?
is     'join --once returns 0 while a worker is still working' "$rc2" '0'
is     'join --once leaves a still-working worker unjoined' \
  "$(counter_read "$(joined_token_file w2)")" ''
unset -f herdr sleep_ms

# A poller ticks every few seconds; with nothing joinable it must stay silent
# rather than repeat "nothing to join" on every tick.
export FLEET_STATE="$sandbox/state-join-once-empty"
out3=$( (cmd_join --once) 2>&1 )
rc3=$?
is 'join --once with nothing joinable exits 0' "$rc3" '0'
is 'join --once with nothing joinable prints nothing' "$out3" ''
unset -f require_herdr scoped_key

# ── join settle-confirm race ─────────────────────────────────────────────────
#
# Bug caught live: a poller ticking every few seconds right after spawn can
# observe agent_status flip to idle a beat before a *different* process sees
# the report `fleet_report` just wrote in that same turn — herdr's status
# tracking and the filesystem view have no ordering guarantee between them.
# `mark_joined` used to fire unconditionally on the first idle/done sighting,
# so that race silently lost a real report forever: the joined counter was
# already bumped past it by the time the report became visible.

printf '\njoin settle-confirm race\n'
export FLEET_STATE="$sandbox/state-join-settle-race"
mkdir -p "$(meta_dir w1)"
meta_set w1 "FOREMAN=me" "BRANCH=b" "DIR=/tmp/w1" "REPO_KEY=k"
counter_bump "$(dispatch_file w1)"
require_herdr() { :; }
scoped_key() { printf 'k'; }
herdr() {
  case "$*" in
    "agent list") printf '{"result":{"agents":[{"name":"w1","agent_status":"idle"}]}}' ;;
    *) printf '{"result":{}}' ;;
  esac
}

# Tick 1: idle, but no report visible yet — must defer, not finalize.
out1=$(cmd_join --once 2>&1)
is     'settle race: first unfresh idle tick exits 0' "$?" '0'
is     'settle race: first unfresh idle tick prints nothing' "$out1" ''
is     'settle race: first unfresh idle tick leaves worker unjoined' \
  "$(counter_read "$(joined_token_file w1)")" ''

# Tick 2, same dispatch generation, report now written (the race resolving
# itself): report_is_fresh short-circuits the debounce — must finalize
# immediately rather than waiting for a third tick.
printf 'the real report' >"$(report_file w1)"
cp "$(dispatch_file w1)" "$(report_token_file w1)"
out2=$(cmd_join --once 2>&1)
is     'settle race: second tick with a fresh report exits 0' "$?" '0'
assert 'settle race: second tick delivers the real report' \
  [ "${out2#*the real report}" != "$out2" ]
is     'settle race: second tick marks the worker joined' \
  "$(counter_read "$(joined_token_file w1)")" "$(counter_read "$(dispatch_file w1)")"
unset -f herdr

# A worker that is genuinely done with nothing to report (no `fleet_report`
# call at all) must still settle — just one tick later, never permanently
# stuck — once the SAME unfresh idle sighting repeats.
export FLEET_STATE="$sandbox/state-join-settle-noreport"
mkdir -p "$(meta_dir w2)"
meta_set w2 "FOREMAN=me" "BRANCH=b" "DIR=/tmp/w2" "REPO_KEY=k"
counter_bump "$(dispatch_file w2)"
herdr() {
  case "$*" in
    "agent list") printf '{"result":{"agents":[{"name":"w2","agent_status":"idle"}]}}' ;;
    *) printf '{"result":{}}' ;;
  esac
}
out3=$(cmd_join --once 2>&1)
is 'settle race: no-report worker first tick leaves it unjoined' \
  "$(counter_read "$(joined_token_file w2)")" ''
out4=$(cmd_join --once 2>&1)
is     'settle race: no-report worker second identical tick exits 0' "$?" '0'
assert 'settle race: no-report worker eventually reports no report written' \
  [ "${out4#*no report written}" != "$out4" ]
is     'settle race: no-report worker second identical tick marks joined' \
  "$(counter_read "$(joined_token_file w2)")" "$(counter_read "$(dispatch_file w2)")"
unset -f herdr require_herdr scoped_key

# ── reply appends an uncollected question ────────────────────────────────────────

printf '\nreply appends an uncollected question\n'
export FLEET_STATE="$sandbox/state-reply-append"
mkdir -p "$FLEET_STATE/w1"
meta_set w1 "FOREMAN=me" "BRANCH=b" "DIR=/tmp/x"
self_handle() { printf 'w1'; }
foreman_handle() { printf 'me'; }
agent_exists() { return 1; }
require_herdr() { :; }

cmd_reply 'first question' >/dev/null 2>&1
cmd_reply 'second question' >/dev/null 2>&1

qf="$FLEET_STATE/w1/question.md"
assert     'question.md exists' [ -f "$qf" ]
assert     'question.md contains first question' [ -n "$(grep -F 'first question' "$qf")" ]
assert     'question.md contains second question' [ -n "$(grep -F 'second question' "$qf")" ]
assert     'question.md contains separator' [ -n "$(grep -F -- '---' "$qf")" ]
is         'question.seq reads 2' "$(counter_read "$FLEET_STATE/w1/question.seq")" '2'
unset -f self_handle foreman_handle agent_exists require_herdr

# ── fleet version ───────────────────────────────────────────────────────────────

printf '\nfleet version\n'
is 'version comes from the plugin manifest' "$(cmd_version)" 'fleet 0.5.0'

# ── ls shows a pending question ──────────────────────────────────────────────────

printf '\nls shows a pending question\n'
export FLEET_STATE="$sandbox/state-ls-q"
mkdir -p "$FLEET_STATE/w2"
meta_set w2 "FOREMAN=foreman" "BRANCH=feat/q" "DIR=/tmp/q" "REPO_KEY=k"
: >"$FLEET_STATE/w2/question.md"
counter_bump "$(cat "$FLEET_STATE/w2/question.seq" 2>/dev/null || echo "$FLEET_STATE/w2/question.seq")"

agent_field() { printf ''; }
require_herdr() { :; }
scoped_key() { printf 'k'; }

ls_out=$(cmd_ls 2>&1)
assert 'ls header contains Q column' [ "${ls_out#* Q }" != "$ls_out" ]
assert 'ls row shows ? for pending question' [ "${ls_out#*w2*\?}" != "$ls_out" ]
unset -f agent_field require_herdr scoped_key

# ── broadcast ─────────────────────────────────────────────────────────────────
#
# Raw steering to every live worker in the repo. It must never bump the
# dispatch counter dispatch_to guards — a broadcast is not a tracked task, and
# bumping it would make a worker's eventual `fleet report` for its real task
# look like it answers the broadcast instead.

printf '\nbroadcast\n'
export FLEET_STATE="$sandbox/state-broadcast"
for w in w1 w2 me; do mkdir -p "$(meta_dir "$w")"; meta_set "$w" "REPO_KEY=repo1"; done
herdr() {
  case "$*" in
    "agent list") printf '{"result":{"agents":[{"name":"w1","agent_status":"idle"},{"name":"me","agent_status":"idle"}]}}' ;;
    *) printf '{"result":{}}' ;;
  esac
}
self_handle() { printf 'me'; }
require_herdr() { :; }
scoped_key() { printf 'repo1'; }

before=$(counter_read "$(dispatch_file w1)")
out=$(cmd_broadcast 'checkpoint' 2>&1)
after=$(counter_read "$(dispatch_file w1)")
is 'broadcast leaves the dispatch counter untouched' "$after" "$before"
assert 'broadcast sends to the live worker' [ "${out#*sent: w1}" != "$out" ]
assert_not 'broadcast skips its own sender handle' [ "${out#*sent: me}" != "$out" ]
assert 'broadcast skips the dead worker' [ "${out#*skipped*w2}" != "$out" ]

out2=$( (FLEET_STATE="$sandbox/state-broadcast-empty" cmd_broadcast 'hi') 2>&1 )
rc2=$?
assert 'broadcast fails with no live workers in scope' [ "$rc2" != 0 ]
assert 'and explains why' [ "${out2#*no live workers in this repo}" != "$out2" ]
unset -f herdr self_handle require_herdr scoped_key

# ── dm ────────────────────────────────────────────────────────────────────────
#
# Raw steering to one fleet member. Same untracked-dispatch contract as
# broadcast; the target gate (registered worker or the foreman handle) is the one
# thing that differs from `fleet send --raw`, which only checks liveness.

printf '\ndm\n'
export FLEET_STATE="$sandbox/state-dm"
mkdir -p "$(meta_dir w1)"; meta_set w1 "FOREMAN=me"
self_handle() { printf 'me'; }
require_herdr() { :; }
agent_exists() { case "$1" in w1|intruder) return 0 ;; *) return 1 ;; esac; }
sent_text=""
prompt_raw() { sent_text="$2"; }

cmd_dm w1 'ping' >/dev/null 2>&1
is 'dm carries the [fleet dm from <sender>] prefix' "$sent_text" '[fleet dm from me] ping'

out=$( (cmd_dm intruder 'hi') 2>&1 )
rc=$?
assert 'dm rejects an unregistered, non-foreman target' [ "$rc" != 0 ]
assert 'and points at fleet ls' [ "${out#*fleet ls}" != "$out" ]

before=$(counter_read "$(dispatch_file w1)")
cmd_dm w1 'ping again' >/dev/null 2>&1
after=$(counter_read "$(dispatch_file w1)")
is 'dm leaves the dispatch counter untouched' "$after" "$before"
unset -f self_handle require_herdr agent_exists prompt_raw

# ── keys ──────────────────────────────────────────────────────────────────────
#
# Unblocking an approval UI needs real terminal keys, not text `agent prompt`
# can deliver. fleet does not validate key names — herdr does — so the argv
# must reach `herdr agent send-keys` unmodified.

printf '\nkeys\n'
export FLEET_STATE="$sandbox/state-keys"
require_herdr() { :; }
agent_exists() { case "$1" in feat-x) return 0 ;; *) return 1 ;; esac; }
herdr_args="$sandbox/herdr-keys-args"
herdr() { printf '%s\n' "$*" >"$herdr_args"; }

cmd_keys feat-x down down enter
is 'keys threads argv into herdr agent send-keys verbatim' "$(cat "$herdr_args")" \
  'agent send-keys feat-x down down enter'

out=$( (cmd_keys feat-x) 2>&1 )
rc=$?
assert 'keys requires at least one key' [ "$rc" != 0 ]
assert 'and explains usage' [ "${out#*usage: fleet keys}" != "$out" ]

out=$( (cmd_keys unknown-handle down) 2>&1 )
rc=$?
assert 'keys rejects a non-live handle' [ "$rc" != 0 ]
unset -f require_herdr agent_exists herdr

printf '\n'
if [ "$failures" = 0 ]; then
  printf 'all tests passed\n'; exit 0
fi
printf '%s test(s) failed\n' "$failures"; exit 1
