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

# ── portable skills and agent kinds ──────────────────────────────────────────

printf '\nskills\n'
skill_root="$sandbox/skills"
fallback_root="$sandbox/fallback-skills"
mkdir -p "$skill_root/implement" "$fallback_root/implement"
cat >"$skill_root/implement/SKILL.md" <<'EOF'
---
name: implement
description: Build an agreed change.
---

# Implement

Do the work.
EOF
printf 'wrong root\n' >"$fallback_root/implement/SKILL.md"
export FLEET_SKILL_PATH="$skill_root:$fallback_root"

is 'resolves the first configured skill root' "$(resolve_skill implement)" \
  "$skill_root/implement/SKILL.md"
# The base directory is normalized by cmd_skill, and $TMPDIR on macOS is itself a
# symlink, so the expectation has to be normalized the same way.
skill_base=$(cd -P "$skill_root/implement" && pwd)
expected=$(printf '## Skill: implement\n\nBase directory: `%s`\nFollow the instructions below. Resolve relative paths from the base directory.\n\n\n# Implement\n\nDo the work.' \
  "$skill_base")
is 'prints a portable prompt without YAML frontmatter' "$(cmd_skill implement)" "$expected"
is 'renders one universal worker instruction' "$(skill_instruction implement)" \
  'Before doing any other work, run `fleet skill implement` and follow the instructions it prints.'
assert 'resolves fleet-dispatch from its bundled plugin tree' \
  [ -f "$(resolve_skill fleet-dispatch)" ]
assert_not 'skill names reject traversal' valid_skill_name '../implement'
assert_not 'skill names reject uppercase' valid_skill_name 'Implement'

printf '\nagent kinds\n'
assert 'accepts a herdr agent kind' valid_agent_kind 'claude'
assert 'accepts a compound agent kind' valid_agent_kind 'cursor-agent'
assert_not 'rejects an agent-kind option injection' valid_agent_kind '--kind'
assert_not 'rejects an agent-kind path' valid_agent_kind '../omp'
assert_not 'rejects an uppercase agent kind' valid_agent_kind 'Claude'

printf '\nagent tiers and models\n'
assert 'accepts standard' valid_agent_tier 'standard'
assert 'accepts deep' valid_agent_tier 'deep'
assert_not 'rejects an unknown tier' valid_agent_tier 'cheap'
assert_not 'rejects an empty tier' valid_agent_tier ''
assert 'accepts a role selector' valid_agent_model '@task'
assert 'accepts a provider/model selector' valid_agent_model 'anthropic/claude-sonnet-5'
assert_not 'rejects a model option injection' valid_agent_model '--model'
assert_not 'rejects a model with spaces' valid_agent_model 'claude sonnet'
is 'omp standard maps to @task' "$(worker_agent_args omp standard '')" $'--model\n@task'
is 'omp deep maps to @default' "$(worker_agent_args omp deep '')" $'--model\n@default'
is 'claude standard maps to sonnet' "$(worker_agent_args claude standard '')" $'--model\nsonnet'
is 'explicit --model wins the plan' "$(worker_agent_args omp '' '@smol')" $'--model\n@smol'
is 'no tier and no model yields nothing' "$(worker_agent_args omp '' '')" ''

herdr_args="$sandbox/herdr-args"
herdr() { printf '%s\n' "$*" >"$herdr_args"; }
start_worker_agent worker ws pane claude
is 'threads the selected kind into herdr agent start' "$(cat "$herdr_args")" \
  'agent start worker --kind claude --pane pane --timeout 120000'
start_worker_agent worker ws pane omp --model '@task'
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
          printf '{"result":{"agents":[{"name":"boss","pane_id":"p0"},{"name":"feat-x","pane_id":"p1","agent_status":"working","interactive_ready":true,"workspace_id":"w1"}]}}'
        else
          printf '{"result":{"agents":[{"name":"boss","pane_id":"p0"}]}}'
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
       cmd_spawn feat/x --kind claude --tier deep --skill implement \
         --task 'Add exponential backoff to the dispatcher.' ) >/dev/null 2>&1

  assert 'a --skill spawn dispatches a prompt' [ -s "$prompt_file" ]
  prompt=$(cat "$prompt_file" 2>/dev/null || true)
  is 'the worker is told to load the skill first' "$(printf '%s' "$prompt" | sed -n 1p)" \
    'Before doing any other work, run `fleet skill implement` and follow the instructions it prints.'
  assert 'the brief follows the instruction' \
    [ "${prompt#*Add exponential backoff to the dispatcher.}" != "$prompt" ]
  assert 'fleets own protocol block is still appended' \
    [ "${prompt#*fleet report}" != "$prompt" ]
  assert_not 'no skill:// URI reaches the worker' \
    [ "${prompt#*skill://}" != "$prompt" ]
  started_cmd=$(cat "$start_args" 2>/dev/null || true)
  assert 'the requested kind reached agent start' \
    [ "${started_cmd#*--kind claude}" != "$started_cmd" ]
  is 'the kind is recorded for later inspection' \
    "$(FLEET_STATE="$sandbox/spawn-state" meta_get feat-x KIND)" 'claude'
  is 'the skill is recorded for later inspection' \
    "$(FLEET_STATE="$sandbox/spawn-state" meta_get feat-x SKILL)" 'implement'
  is 'the tier is recorded for later inspection' \
    "$(FLEET_STATE="$sandbox/spawn-state" meta_get feat-x TIER)" 'deep'
  is 'the mapped model is recorded for later inspection' \
    "$(FLEET_STATE="$sandbox/spawn-state" meta_get feat-x MODEL)" 'opus'
  assert 'the mapped model reached agent start' \
    [ "${started_cmd#*--model opus}" != "$started_cmd" ]

  # `$FLEET_AGENT_TIER` must yield to an explicit `--model`, and the env-derived
  # tier must not be recorded beside it. Without that, exporting the documented
  # default makes the escape hatch unusable.
  rm -f "$prompt_file" "$started_file" "$start_args"
  ( cd "$spawn_repo" \
    && FLEET_STATE="$sandbox/spawn-state" FLEET_AGENT_TIER=deep \
       HERDR_ENV=1 HERDR_PANE_ID=p0 \
       cmd_spawn feat/y --kind claude --model sonnet --skill implement \
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

# ── portable plugin prose ────────────────────────────────────────────────────
#
# `skill://` is an omp-only URI. A worker on any other harness cannot resolve
# one, and the failure is silent — it just does generic work. This caught a real
# regression: a rebase reintroduced four of them in hunks git never flagged,
# because the merge conflicted elsewhere in the same files.

printf '\nportable plugin prose\n'
plugin_dir=$(cd "$(dirname "$0")/../../plugins/fleet" 2>/dev/null && pwd)
if [ -n "$plugin_dir" ]; then
  offenders=""
  for f in "$plugin_dir"/commands/*.md "$plugin_dir"/skills/*/SKILL.md \
           "$plugin_dir"/README.md "$plugin_dir/../../README.md"; do
    [ -f "$f" ] || continue
    if [ -n "$(sed -n '/skill:\/\//p' "$f")" ]; then
      offenders="$offenders $(basename "$(dirname "$f")")/$(basename "$f")"
    fi
  done
  is 'no skill:// URI survives in the plugin prose' "${offenders# }" ''

  offenders=""
  for f in "$plugin_dir"/commands/*.md "$plugin_dir"/skills/*/SKILL.md \
           "$plugin_dir"/README.md "$plugin_dir/../../README.md"; do
    [ -f "$f" ] || continue
    # Harness-specific model selectors and omp-only verbs belong in
    # herdr/bin/fleet, not in the portable plugin. A bare `orchestrate` in a
    # brief would also silently arm omp's orchestration contract.
    if [ -n "$(sed -n -E '/(^|[^[:alnum:]_-])(orchestrate|@smol|@task|@slow|@default|--smol)([^[:alnum:]_-]|$)/p' "$f")" ]; then
      offenders="$offenders $(basename "$(dirname "$f")")/$(basename "$f")"
    fi
  done
  is 'no harness-specific model vocab survives in the plugin prose' "${offenders# }" ''


  # Each dispatch command must name the skill it dispatches, or the worker gets
  # the brief with no procedure attached.
  missing=""
  for c in implement diagnosing-bugs research prototype code-review; do
    f="$plugin_dir/commands/$c.md"
    [ -f "$f" ] || continue
    [ -n "$(sed -n "/--skill $c/p" "$f")" ] || missing="$missing $c"
  done
  is 'every dispatch command passes its own --skill' "${missing# }" ''

  missing=""
  for c in implement diagnosing-bugs research prototype code-review; do
    f="$plugin_dir/commands/$c.md"
    [ -f "$f" ] || continue
    [ -n "$(sed -n '/--tier /p' "$f")" ] || missing="$missing $c"
  done
  is 'every dispatch command names a --tier' "${missing# }" ''
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
meta_set m1 "BOSS=my boss" "BRANCH=feat/x'y\"z" "DIR=/tmp/a b" "WORKSPACE=w8" \
  "REPO=/r" "REPO_KEY=/r/.git"
is 'a value with a space round-trips'  "$(meta_get m1 BOSS)"   'my boss'
is 'quotes and slashes round-trip'     "$(meta_get m1 BRANCH)" "feat/x'y\"z"

meta_update m1 "BOSS=other"
is 'meta_update rewrites its key'      "$(meta_get m1 BOSS)"   'other'
is 'and preserves its siblings'        "$(meta_get m1 BRANCH)" "feat/x'y\"z"
is 'and preserves the ones after it'   "$(meta_get m1 DIR)"    '/tmp/a b'

is 'an absent key reads empty'         "$(meta_get m1 NOPE)"   ''
is 'an absent worker reads empty'      "$(meta_get nosuch BOSS)" ''

# meta_get used to expand ${!key} *after* sourcing without unsetting first, so
# a key the file did not carry fell through to the environment. A stale meta
# file plus an exported REPO_KEY silently mis-scoped every repo-scoped command.
export REPO_KEY=leaked-from-the-environment
is 'an absent key does not leak the environment' "$(meta_get m1 XREPO_KEY)" ''
meta_set m2 "BOSS=b"
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

out=$( (cmd_spawn br --kind codex --tier deep --task x) 2>&1 )
rc=$?
assert     'spawn dies when kind has no --tier mapping' [ "$rc" != 0 ]
assert     'output contains no --tier mapping' [ "${out#*no --tier mapping}" != "$out" ]
assert_not 'herdr was not called for unmapped kind+tier' [ "${out#*herdr was called}" != "$out" ]
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

# ── reply appends an uncollected question ────────────────────────────────────────

printf '\nreply appends an uncollected question\n'
export FLEET_STATE="$sandbox/state-reply-append"
mkdir -p "$FLEET_STATE/w1"
meta_set w1 "BOSS=me" "BRANCH=b" "DIR=/tmp/x"
self_handle() { printf 'w1'; }
boss_handle() { printf 'me'; }
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
unset -f self_handle boss_handle agent_exists require_herdr

# ── fleet version ───────────────────────────────────────────────────────────────

printf '\nfleet version\n'
is 'version comes from the plugin manifest' "$(cmd_version)" 'fleet 0.4.0'

# ── ls shows a pending question ──────────────────────────────────────────────────

printf '\nls shows a pending question\n'
export FLEET_STATE="$sandbox/state-ls-q"
mkdir -p "$FLEET_STATE/w2"
meta_set w2 "BOSS=boss" "BRANCH=feat/q" "DIR=/tmp/q" "KIND=omp" "REPO_KEY=k"
: >"$FLEET_STATE/w2/question.md"
counter_bump "$(cat "$FLEET_STATE/w2/question.seq" 2>/dev/null || echo "$FLEET_STATE/w2/question.seq")"

agent_field() { printf ''; }
require_herdr() { :; }
scoped_key() { printf 'k'; }

ls_out=$(cmd_ls 2>&1)
assert 'ls header contains Q column' [ "${ls_out#* Q }" != "$ls_out" ]
assert 'ls row shows ? for pending question' [ "${ls_out#*w2*\?}" != "$ls_out" ]
unset -f agent_field require_herdr scoped_key

# ── widen the skill:// sweep ────────────────────────────────────────────────────

# Modify existing sweep test to add repo root README.md
# The sweep test was around lines 241-264, so update the for loop to include repo root README

printf '\n'
if [ "$failures" = 0 ]; then
  printf 'all tests passed\n'; exit 0
fi
printf '%s test(s) failed\n' "$failures"; exit 1
