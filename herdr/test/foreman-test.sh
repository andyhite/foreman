#!/usr/bin/env bash
# Regression tests for `foreman`.
#
# No framework: the plugin is dependency-free shell and its tests should be
# too, so this runs anywhere foreman itself does. Every case here is a bug that
# was actually shipped, not a hypothetical.
#
#   herdr/test/foreman-test.sh
#
# Run it under the oldest bash you support as well — several of these only
# fail there:
#
#   /bin/bash herdr/test/foreman-test.sh    # macOS system bash 3.2

# Several sections replace a sourced function with a stub, so the tests can
# cover logic that would otherwise need a live herdr. shellcheck cannot see
# that those definitions shadow something and reports each as unused.
# shellcheck disable=SC1091,SC2329

# Deliberately not `set -e`: a failing assertion must record itself and let the
# rest of the suite run.
set -uo pipefail

FOREMAN_BIN=$(cd "$(dirname "$0")/.." && pwd)/bin/foreman
[ -f "$FOREMAN_BIN" ] || { printf 'cannot find foreman at %s\n' "$FOREMAN_BIN" >&2; exit 1; }

failures=0
ok()  { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — want [$3], got [$2]"; fi; }
assert()     { if "${@:2}"; then ok "$1"; else bad "$1"; fi; }
assert_not() { if "${@:2}"; then bad "$1"; else ok "$1"; fi; }

sandbox=$(mktemp -d) || exit 1
trap 'rm -rf "$sandbox"' EXIT

# Functions under test, without running a command.
# shellcheck source=../bin/foreman
source "$FOREMAN_BIN"
# foreman sets `-e` at its top, and sourcing applies that to this shell too — it
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
is 'renders the /skill: command invocation token' "$(command_instruction triage)" \
  '/skill:triage'

# `command:` prefixes a role's config value; a plain value stays type "skill"
# for back-compat with every config committed before this distinction existed.
is 'a plain value is type skill' "$(role_value_type code-review)" 'skill'
is 'a command: value is type command' "$(role_value_type command:triage)" 'command'
is 'a plain value is its own skill name' "$(role_value_skill code-review)" 'code-review'
is 'a command: value strips the prefix' "$(role_value_skill command:triage)" 'triage'

# An optional second, space-separated token pins a role to a model or omp
# modelRole selector, the same idea as --model for one spawn kept with the
# role's skill mapping. role_value_spec/role_value_model split it; the type/
# skill helpers above run on the spec half, never the raw two-token value.
is 'a value with no model has an empty model half' \
  "$(role_value_model code-review)" ''
is 'a value with no model keeps the whole thing as its spec' \
  "$(role_value_spec code-review)" 'code-review'
is 'a value with a model splits off the spec' \
  "$(role_value_spec 'code-review @review')" 'code-review'
is 'a value with a model splits off the model' \
  "$(role_value_model 'code-review @review')" '@review'
is 'a command: spec with a model still splits its spec half' \
  "$(role_value_spec 'command:triage @task')" 'command:triage'
is 'a command: spec with a model still splits its model half' \
  "$(role_value_model 'command:triage @task')" '@task'

# ── role config ──────────────────────────────────────────────────────────────
#
# `--role` resolves through foreman's own config instead of naming a skill at
# every dispatch site. Regression coverage for the parser (decoys, comments,
# malformed lines) and the lookup (found, missing key, missing config).

# HOME is sandboxed for this whole section: skill_description searches
# ~/.agents/skills et al, and this suite must pass identically whether or
# not the machine running it happens to have skills named "code-review" or
# "triage" installed globally.
role_home_orig=$HOME
HOME="$sandbox/role-home"
printf '\nrole config\n'
role_cfg="$sandbox/foreman-roles.yml"
cat >"$role_cfg" <<'YAML'
not-a-role: decoy
roles:
  review: code-review
  implement: my-house-implement  # trailing comment
  triage: command:triage
  broken
YAML
role_ent=$(role_entries "$role_cfg")
is 'reads three well-formed roles, not the decoy or the keyless line' \
  "$(printf '%s\n' "$role_ent" | wc -l | tr -d ' ')" '3'
assert 'reads the review mapping' [ "${role_ent#*review	code-review}" != "$role_ent" ]
assert 'strips a trailing comment' [ "${role_ent#*# trailing}" = "$role_ent" ]
assert 'ignores the top-level decoy key' [ "${role_ent#*not-a-role}" = "$role_ent" ]
assert 'reads a command: role value verbatim, prefix and all' \
  [ "${role_ent#*triage	command:triage}" != "$role_ent" ]

foreman_config() { printf '%s' "$role_cfg"; }
is 'role_skill resolves a configured role' "$(role_skill review)" 'code-review'
is 'role_skill resolves a command role with its prefix intact' \
  "$(role_skill triage)" 'command:triage'
is 'role_value_type reads a plain role as skill' \
  "$(role_value_type "$(role_skill review)")" 'skill'
is 'role_value_type reads a command role as command' \
  "$(role_value_type "$(role_skill triage)")" 'command'
is 'role_value_skill strips the command role prefix' \
  "$(role_value_skill "$(role_skill triage)")" 'triage'
assert_not 'role_skill fails an unconfigured role' role_skill missing
foreman_config() { return 1; }
assert_not 'role_skill fails with no config at all' role_skill review
foreman_config() { printf '%s' "$role_cfg"; }
is 'cmd_roles tags a command role in its listing' \
  "$(cmd_roles | sed -n '/triage/p')" '  triage               -> triage (command)'
is 'cmd_roles leaves a plain role untagged' \
  "$(cmd_roles | sed -n '/^  review/p')" '  review               -> code-review'

# The model token is a separate display concern from the command: tag above;
# a fresh one-entry config keeps it from disturbing the exact-string
# assertions on $role_cfg's untouched rows.
role_cfg_model="$sandbox/foreman-roles-model.yml"
cat >"$role_cfg_model" <<'YAML'
roles:
  review: code-review @review
YAML
foreman_config() { printf '%s' "$role_cfg_model"; }
is 'cmd_roles shows a role model in brackets' \
  "$(cmd_roles | sed -n '/^  review/p')" '  review               -> code-review [@review]'
foreman_config() { printf '%s' "$role_cfg"; }
unset -f foreman_config
HOME=$role_home_orig

# ── skill description lookup ────────────────────────────────────────────────
#
# `roles:` only ever stores a name; `cmd_roles` reads the mapped skill's own
# frontmatter `description:` back out to answer "what is this role for"
# without a second, driftable copy of that text in the config. Coverage: the
# frontmatter parser itself, project-before-global precedence, and the
# integrated `cmd_roles` listing.

printf '\nskill description lookup\n'
desc_home="$sandbox/desc-home"
mkdir -p "$sandbox/desc-project/skills/demo" \
  "$sandbox/desc-project/skills/noquote" \
  "$sandbox/desc-project/skills/empty" \
  "$desc_home/.agents/skills/global-demo"

cat >"$sandbox/desc-project/skills/demo/SKILL.md" <<'MD'
---
name: demo
description: "Quoted project demo skill."
---
Body.
MD
cat >"$sandbox/desc-project/skills/noquote/SKILL.md" <<'MD'
---
name: noquote
description: Unquoted description.
---
Body.
MD
cat >"$sandbox/desc-project/skills/empty/SKILL.md" <<'MD'
---
name: empty
---
Body, no description field at all.
MD
cat >"$desc_home/.agents/skills/global-demo/SKILL.md" <<'MD'
---
name: global-demo
description: Global-only demo skill.
---
Body.
MD

is 'reads a quoted frontmatter description' \
  "$(skill_frontmatter_description "$sandbox/desc-project/skills/demo/SKILL.md")" \
  'Quoted project demo skill.'
is 'reads an unquoted frontmatter description' \
  "$(skill_frontmatter_description "$sandbox/desc-project/skills/noquote/SKILL.md")" \
  'Unquoted description.'
assert_not 'no description field is a miss, not empty output' \
  skill_frontmatter_description "$sandbox/desc-project/skills/empty/SKILL.md"
assert_not 'a missing file is a miss' \
  skill_frontmatter_description "$sandbox/desc-project/skills/missing/SKILL.md"

project_root() { printf '%s' "$sandbox/desc-project"; }
HOME=$desc_home
is 'skill_description finds a project-local skill' \
  "$(skill_description demo)" 'Quoted project demo skill.'
is 'skill_description falls back to a global skill' \
  "$(skill_description global-demo)" 'Global-only demo skill.'
assert_not 'skill_description misses a skill nowhere on disk' \
  skill_description nowhere

desc_role_cfg="$sandbox/foreman-roles-desc.yml"
cat >"$desc_role_cfg" <<'YAML'
roles:
  mine: demo
  elsewhere: global-demo
  ghost: nowhere
YAML
foreman_config() { printf '%s' "$desc_role_cfg"; }
is 'cmd_roles shows a project skill description under its mapping' \
  "$(cmd_roles | sed -n '/^      Quoted/p')" '      Quoted project demo skill.'
is 'cmd_roles shows a global skill description under its mapping' \
  "$(cmd_roles | sed -n '/^      Global-only/p')" '      Global-only demo skill.'
is 'cmd_roles adds no description line for a skill found nowhere' \
  "$(cmd_roles | wc -l | tr -d ' ')" '6'
unset -f foreman_config project_root
HOME=$role_home_orig

# ── project-local config resolution ─────────────────────────────────────────
#
# foreman_config() used to check a machine-global herdr plugin config dir and
# a legacy ~/.herdr path — a `roles:` mapping is one repo's house convention,
# not something that should leak into every checkout on the machine. Now it
# only ever looks at $FOREMAN_CONFIG (an escape hatch) or .foreman/config.yml
# under the current repo's toplevel.

printf '\nproject-local config resolution\n'
cfg_repo="$sandbox/cfg-repo"
mkdir -p "$cfg_repo"
( cd "$cfg_repo" && git init -q . )

( cd "$cfg_repo" && unset FOREMAN_CONFIG
  source "$FOREMAN_BIN" 2>/dev/null
  assert_not 'foreman_config fails with no .foreman dir and no override' foreman_config
)

mkdir -p "$cfg_repo/.foreman"
printf 'roles:\n  review: code-review\n' >"$cfg_repo/.foreman/config.yml"
( cd "$cfg_repo" && unset FOREMAN_CONFIG
  source "$FOREMAN_BIN" 2>/dev/null
  is 'foreman_config resolves .foreman/config.yml at the repo toplevel' \
    "$(foreman_config)" "$(git rev-parse --show-toplevel)/.foreman/config.yml"
)

override_cfg="$sandbox/override.yml"
printf 'roles:\n  implement: house-implement\n' >"$override_cfg"
( cd "$cfg_repo" && FOREMAN_CONFIG=$override_cfg
  export FOREMAN_CONFIG
  source "$FOREMAN_BIN" 2>/dev/null
  is '$FOREMAN_CONFIG overrides the repo-local file' "$(foreman_config)" "$override_cfg"
)

# ── foreman init ─────────────────────────────────────────────────────────────

printf '\nforeman init\n'
init_repo="$sandbox/init-repo"
mkdir -p "$init_repo"
( cd "$init_repo" && git init -q . )

( cd "$init_repo" && unset FOREMAN_CONFIG && "$FOREMAN_BIN" init >/dev/null )
assert 'init creates .foreman/config.yml' [ -f "$init_repo/.foreman/config.yml" ]
assert 'the scaffold documents roles:' \
  bash -c 'grep -q "^# roles:" "$0"' "$init_repo/.foreman/config.yml"
assert 'the scaffold documents the command: prefix' \
  bash -c 'grep -q "command:" "$0"' "$init_repo/.foreman/config.yml"
assert 'the scaffold documents an optional model token' \
  bash -c 'grep -q "@review" "$0"' "$init_repo/.foreman/config.yml"

printf 'roles:\n  custom: my-skill\n' >"$init_repo/.foreman/config.yml"
( cd "$init_repo" && unset FOREMAN_CONFIG && "$FOREMAN_BIN" init >/dev/null )
is 'a second init leaves an existing config alone' \
  "$(cat "$init_repo/.foreman/config.yml")" "$(printf 'roles:\n  custom: my-skill\n')"

outside=$(mktemp -d)
assert_not 'init fails outside a git repo' \
  bash -c 'cd "$0" && "$1" init >/dev/null 2>&1' "$outside" "$FOREMAN_BIN"
rm -rf "$outside"

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
export FOREMAN_STATE="$sandbox/state"
h=worker1
mkdir -p "$(meta_dir "$h")"

bump() {  # what dispatch_to does to the counter
  local df n; df=$(dispatch_file "$1")
  n=$(cat "$df" 2>/dev/null || true)
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  printf '%s' "$((n + 1))" >"$df"
}
stamp() { cp "$(dispatch_file "$1")" "$(report_token_file "$1")"; }  # what `foreman report` does

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
# then the brief, then foreman's own protocol block. herdr is stubbed so the whole
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
    && FOREMAN_STATE="$sandbox/spawn-state" HERDR_ENV=1 HERDR_PANE_ID=p0 \
       cmd_spawn feat/x --tier deep --skill implement \
         --task 'Add exponential backoff to the dispatcher.' ) >/dev/null 2>&1

  assert 'a --skill spawn dispatches a prompt' [ -s "$prompt_file" ]
  prompt=$(cat "$prompt_file" 2>/dev/null || true)
  is 'the worker is told to load the skill first' "$(printf '%s' "$prompt" | sed -n 1p)" \
    'Before doing any other work, read `skill://implement` and follow it.'
  assert 'the brief follows the instruction' \
    [ "${prompt#*Add exponential backoff to the dispatcher.}" != "$prompt" ]
  assert "foreman's own protocol block is still appended" \
    [ "${prompt#*foreman report}" != "$prompt" ]
  started_cmd=$(cat "$start_args" 2>/dev/null || true)
  assert 'every worker starts as omp' \
    [ "${started_cmd#*--kind omp}" != "$started_cmd" ]
  is 'the skills are recorded for later inspection' \
    "$(FOREMAN_STATE="$sandbox/spawn-state" meta_get feat-x SKILLS)" 'implement'
  is 'the tier is recorded for later inspection' \
    "$(FOREMAN_STATE="$sandbox/spawn-state" meta_get feat-x TIER)" 'deep'
  is 'the mapped model is recorded for later inspection' \
    "$(FOREMAN_STATE="$sandbox/spawn-state" meta_get feat-x MODEL)" '@default'
  assert 'the mapped model reached agent start' \
    [ "${started_cmd#*--model @default}" != "$started_cmd" ]

  # `$FOREMAN_AGENT_TIER` must yield to an explicit `--model`, and the env-derived
  # tier must not be recorded beside it. Without that, exporting the documented
  # default makes the escape hatch unusable.
  rm -f "$prompt_file" "$started_file" "$start_args"
  ( cd "$spawn_repo" \
    && FOREMAN_STATE="$sandbox/spawn-state" FOREMAN_AGENT_TIER=deep \
       HERDR_ENV=1 HERDR_PANE_ID=p0 \
       cmd_spawn feat/y --model sonnet --skill implement \
         --task 'Prove --model wins over FOREMAN_AGENT_TIER.' ) >/dev/null 2>&1
  started_cmd=$(cat "$start_args" 2>/dev/null || true)
  is 'env-tier + --model records no tier' \
    "$(FOREMAN_STATE="$sandbox/spawn-state" meta_get feat-y TIER)" ''
  is 'env-tier + --model records the explicit model' \
    "$(FOREMAN_STATE="$sandbox/spawn-state" meta_get feat-y MODEL)" 'sonnet'
  assert 'the explicit --model reached agent start' \
    [ "${started_cmd#*--model sonnet}" != "$started_cmd" ]

  # A role contributes its mapped skill first, then every literal --skill in
  # argv order. The prompt must preserve all three procedures: losing either
  # one silently turns a combined dispatch into a different job.
  rm -f "$prompt_file" "$started_file" "$start_args"
  role_skill() { [ "$1" = review ] && { printf 'code-review'; return 0; }; return 1; }
  ( cd "$spawn_repo" \
    && FOREMAN_STATE="$sandbox/spawn-state" HERDR_ENV=1 HERDR_PANE_ID=p0 \
       cmd_spawn feat/z --tier deep --role review --skill implement --skill research \
         --task 'Review the retry policy change.' ) >/dev/null 2>&1
  prompt=$(cat "$prompt_file" 2>/dev/null || true)
  expected_instructions=$'Before doing any other work, read `skill://code-review` and follow it.\n\nBefore doing any other work, read `skill://implement` and follow it.\n\nBefore doing any other work, read `skill://research` and follow it.'
  is 'a role and repeated --skill flags all load their procedures first' \
    "${prompt%%$'\n\n'Review the retry policy change.*}" "$expected_instructions"
  is 'all resolved and literal skills are recorded in prompt order' \
    "$(FOREMAN_STATE="$sandbox/spawn-state" meta_get feat-z SKILLS)" 'code-review,implement,research'
  is 'the role itself is also recorded' \
    "$(FOREMAN_STATE="$sandbox/spawn-state" meta_get feat-z ROLE)" 'review'

  # A command role wraps the task as a /skill:<name> invocation instead of a
  # "read the skill" instruction, and its skill still lands in SKILLS meta
  # for introspection even though it never joins the instruction list.
  rm -f "$prompt_file" "$started_file" "$start_args"
  role_skill() { [ "$1" = triage ] && { printf 'command:triage'; return 0; }; return 1; }
  ( cd "$spawn_repo" \
    && FOREMAN_STATE="$sandbox/spawn-state" HERDR_ENV=1 HERDR_PANE_ID=p0 \
       cmd_spawn feat/triage --role triage --skill implement \
         --task 'Decide what to do about the flaky test.' ) >/dev/null 2>&1
  prompt=$(cat "$prompt_file" 2>/dev/null || true)
  expected_instructions=$'Before doing any other work, read `skill://implement` and follow it.\n\n/skill:triage'
  is 'a command role invokes /skill:<name> after any literal --skill instructions' \
    "${prompt%%$'\n\n'Decide what to do about the flaky test.*}" "$expected_instructions"
  is 'the command role skill is still recorded for introspection' \
    "$(FOREMAN_STATE="$sandbox/spawn-state" meta_get feat-triage SKILLS)" 'triage,implement'
  unset -f role_skill

  # A role's model token is a default like $FOREMAN_AGENT_TIER, not a flag:
  # it must fill in TIER/MODEL when neither --tier nor --model was given, the
  # same way FOREMAN_AGENT_TIER does.
  rm -f "$prompt_file" "$started_file" "$start_args"
  role_skill() { [ "$1" = review ] && { printf 'code-review @review'; return 0; }; return 1; }
  ( cd "$spawn_repo" \
    && FOREMAN_STATE="$sandbox/spawn-state" HERDR_ENV=1 HERDR_PANE_ID=p0 \
       cmd_spawn feat/role-model --role review \
         --task 'Prove a role model applies with no explicit --tier/--model.' ) >/dev/null 2>&1
  is 'a role model is recorded with no tier' \
    "$(FOREMAN_STATE="$sandbox/spawn-state" meta_get feat-role-model TIER)" ''
  is 'a role model is recorded as the model' \
    "$(FOREMAN_STATE="$sandbox/spawn-state" meta_get feat-role-model MODEL)" '@review'
  started_cmd=$(cat "$start_args" 2>/dev/null || true)
  assert 'the role model reached agent start' \
    [ "${started_cmd#*--model @review}" != "$started_cmd" ]

  # An explicit --tier/--model at the call site is a more specific signal
  # than a role default and must still win.
  rm -f "$prompt_file" "$started_file" "$start_args"
  ( cd "$spawn_repo" \
    && FOREMAN_STATE="$sandbox/spawn-state" HERDR_ENV=1 HERDR_PANE_ID=p0 \
       cmd_spawn feat/role-model-override --role review --model opus \
         --task 'Prove an explicit --model wins over a role model.' ) >/dev/null 2>&1
  is 'an explicit --model overrides the role model' \
    "$(FOREMAN_STATE="$sandbox/spawn-state" meta_get feat-role-model-override MODEL)" 'opus'

  rm -f "$prompt_file" "$started_file" "$start_args"
  ( cd "$spawn_repo" \
    && FOREMAN_STATE="$sandbox/spawn-state" HERDR_ENV=1 HERDR_PANE_ID=p0 \
       cmd_spawn feat/role-model-tier --role review --tier deep \
         --task 'Prove an explicit --tier wins over a role model.' ) >/dev/null 2>&1
  is 'an explicit --tier overrides the role model' \
    "$(FOREMAN_STATE="$sandbox/spawn-state" meta_get feat-role-model-tier TIER)" 'deep'
  is 'an explicit --tier leaves no role model behind' \
    "$(FOREMAN_STATE="$sandbox/spawn-state" meta_get feat-role-model-tier MODEL)" '@default'
  unset -f role_skill

  # A role model must not defeat the original --tier/--model conflict check
  # when both flags really are given explicitly alongside a role.
  role_skill() { [ "$1" = review ] && { printf 'code-review @review'; return 0; }; return 1; }
  out=$( (cd "$spawn_repo" && FOREMAN_STATE="$sandbox/spawn-state" HERDR_ENV=1 HERDR_PANE_ID=p0 \
      cmd_spawn feat/role-model-conflict --role review --tier deep --model opus --task x) 2>&1 )
  assert 'an explicit --tier and --model with a role model still conflict' \
    [ "${out#*--tier and --model are mutually exclusive}" != "$out" ]
  unset -f role_skill

  ( cd "$spawn_repo" && FOREMAN_STATE="$sandbox/spawn-state" HERDR_ENV=1 HERDR_PANE_ID=p0 \
      cmd_spawn feat/two-roles --role review --role review --task x ) >"$sandbox/foreman-two-roles" 2>&1
  assert 'a second --role is a die' \
    [ "$?" != 0 ]
  assert 'and explains the single-role limit' \
    grep -q 'only once' "$sandbox/foreman-two-roles"

  ( cd "$spawn_repo" && FOREMAN_STATE="$sandbox/spawn-state" HERDR_ENV=1 HERDR_PANE_ID=p0 \
      cmd_spawn feat/unmapped --role ghost --task x ) >"$sandbox/foreman-role-unmapped" 2>&1
  assert 'an unmapped --role is a die' \
    [ "$?" != 0 ]
  assert 'and names the role' \
    grep -q "role 'ghost'" "$sandbox/foreman-role-unmapped"
  rm -f "$sandbox/foreman-two-roles" "$sandbox/foreman-role-unmapped"
  unset -f role_skill

  unset -f herdr
else
  printf '  skip  dispatched prompt cases (needs git and jq)\n'
fi

# ── plugin prose ─────────────────────────────────────────────────────────────
#
# The old `foreman spawn --skill` printer is gone; workers now read
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
    if [ -n "$(sed -n -E '/foreman[[:space:]]+skill/p' "$f")" ]; then
      offenders="$offenders $(basename "$(dirname "$f")")/$(basename "$f")"
    fi
  done
  is 'no removed foreman-skill reference survives in the plugin prose' "${offenders# }" ''

  # `orchestrate` arms omp's magic-keyword orchestration contract on a
  # worker's very first turn. This plugin dispatches generic briefs with no
  # skill catalogue of its own, so nothing in its prose should reach for that
  # keyword — a stray copy-paste would silently change a worker's behavior
  # with no review signal.
  offenders=""
  for f in "$plugin_dir"/command-prompts/*.md "$plugin_dir"/skills/*/SKILL.md; do
    [ -f "$f" ] || continue
    if [ -n "$(sed -n -E '/(^|[^[:alnum:]_-])orchestrate([^[:alnum:]_-]|$)/p' "$f")" ]; then
      offenders="$offenders $(basename "$f")"
    fi
  done
  is 'orchestrate does not appear in the plugin prose' "${offenders# }" ''
else
  printf '  skip  plugin prose cases (plugin tree not beside this checkout)\n'
fi

# ── reap argument handling ───────────────────────────────────────────────────
#
# `cmd_reap` joins a handle onto $FOREMAN_STATE and `rm -rf`s it, and its handles
# come straight off the command line. Needs a real herdr on PATH.

printf '\nreap\n'
if [ "${HERDR_ENV:-}" = 1 ] && command -v herdr >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  reap_state="$sandbox/reap"
  reap() (
    cd /tmp || exit 1
    FOREMAN_STATE="$reap_state" HERDR_ENV=1 HERDR_PANE_ID=x "$FOREMAN_BIN" reap "$@" 2>&1
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
export FOREMAN_STATE="$sandbox/meta"
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
export FOREMAN_STATE="$sandbox/join"
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

# The spin: a worker that ends its turn without ever running `foreman report` is
# simply idle, which settles instantly. Collecting it must be recorded even
# though no report exists, or "join again until everyone reports" never ends.
assert_not 'collected without a report is still collected' report_is_fresh alive

counter_bump "$(dispatch_file alive)"
assert 'a new dispatch makes it joinable again' \
  [ "$(joinable_workers | tr -d '[:space:]')" = alive ]

# `foreman spawn` makes a worker's first dispatch, and a freshly started omp can
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
# dispatch 1 would read dispatch 2's now-current counter when it reports. Foreman
# must refuse, without bumping that counter or prompting the agent. Raw answers
# remain allowed below.
out=$(
  ( agent_field() { printf 'working'; }
    herdr() { printf '{"id":"t","result":{}}'; }
    dispatch_to quiet 'a second tracked task' ) 2>&1
)
is 'a working worker refuses a REdispatch' "$?" '1'
assert 'and explains the raw steering path' [ "${out#*foreman send --raw}" != "$out" ]
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
assert 'foreman reply files a pending question' question_pending asker
joinable=$(joinable_workers | tr -d '[:space:]')
assert 'a question makes an already-collected worker joinable again' \
  [ "${joinable#*asker}" != "$joinable" ]
print_question asker >/dev/null
assert_not 'and showing it clears the pending flag' question_pending asker
unset -f agent_exists

# ── workspace-manager coexistence ────────────────────────────────────────────
#
# The gate used to grep `- repo:` across the whole file and ignore `path:`
# entirely, so a repo configured by checkout path read as uncovered and foreman
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
# actually contend for. Without it such a repo could not use foreman at all.
FOREMAN_IGNORE_WORKSPACE_MANAGER=1 \
  assert_not 'and the override really disables the check' \
    workspace_manager_covers /some/repo /srv/checkouts/web-app-feat-x
unset -f workspace_manager_enabled workspace_manager_config

# ── reap --forget ────────────────────────────────────────────────────────────
#
# A worktree removed by hand leaves a record `worktree remove` can never
# satisfy, so the worker used to sit in `foreman ls` as `gone` permanently with
# no way to clear it.

printf '\nreap --forget\n'
export FOREMAN_STATE="$sandbox/forget"
herdr() { return 1; }   # every `worktree remove` fails, as it would for a gone worktree
meta_set stuck "BRANCH=feat/gone" "DIR=/tmp/gone" "WORKSPACE=w9"
assert_not 'reap refuses when the workspace will not remove' reap_one stuck 0 0
assert     'and leaves the record behind to try again' [ -d "$(meta_dir stuck)" ]
assert     '--forget clears the record anyway'          reap_one stuck 0 1
assert_not 'and the record is gone'                     [ -d "$(meta_dir stuck)" ]
unset -f herdr

# ── join validates explicit handles ─────────────────────────────────────────────

printf '\njoin validates explicit handles\n'
export FOREMAN_STATE="$sandbox/state-join-validate"
require_herdr() { :; }

out=$( (cmd_join 'no-such-worker') 2>&1 )
rc=$?
assert     'join fails for nonexistent worker' [ "$rc" != 0 ]
assert     'output contains no foreman record for' [ "${out#*no foreman record for}" != "$out" ]
assert_not 'output contains no === result' [ "${out#*===}" != "$out" ]

out=$( (cmd_join '../evil') 2>&1 )
rc=$?
assert     'join fails for invalid handle' [ "$rc" != 0 ]
assert     'output contains invalid handle' [ "${out#*invalid handle}" != "$out" ]
unset -f require_herdr

# ── tracked send refuses unregistered agents ────────────────────────────────────

printf '\ntracked send refuses unregistered agents\n'
export FOREMAN_STATE="$sandbox/state-send-unregistered"
agent_exists() { return 0; }
require_herdr() { :; }

out=$( (cmd_send intruder 'hi') 2>&1 )
rc=$?
assert     'send fails for unregistered agent' [ "$rc" != 0 ]
assert     'output contains not registered' [ "${out#*not a registered foreman worker}" != "$out" ]
assert     'output suggests foreman send --raw' [ "${out#*foreman send --raw}" != "$out" ]
assert_not 'no state dir created for handle' [ -d "$FOREMAN_STATE/intruder" ]
unset -f agent_exists require_herdr

# ── ask rejects --raw ────────────────────────────────────────────────────────────

printf '\nask rejects --raw\n'
export FOREMAN_STATE="$sandbox/state-ask-raw"
require_herdr() { :; }

out=$( (cmd_ask --raw intruder 'hi') 2>&1 )
rc=$?
assert 'ask --raw dies' [ "$rc" != 0 ]
assert 'output mentions foreman send --raw' [ "${out#*foreman send --raw}" != "$out" ]

# cmd_send also honors --raw in the position right after the handle, so ask
# must refuse it there too — not just in the leading position.
out=$( (cmd_ask intruder --raw 'hi') 2>&1 )
rc=$?
assert 'ask <handle> --raw dies too' [ "$rc" != 0 ]
assert 'trailing form also points at foreman send --raw' [ "${out#*foreman send --raw}" != "$out" ]
unset -f require_herdr

# ── spawn flag conflicts ─────────────────────────────────────────────────────────

printf '\nspawn flag conflicts\n'
export FOREMAN_STATE="$sandbox/state-spawn-flags"
require_herdr() { :; }
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
assert     'output contains tier/model mutually exclusive' \
  [ "${out#*--tier and --model are mutually exclusive}" != "$out" ]
assert_not 'herdr was not called for tier/model' [ "${out#*herdr was called}" != "$out" ]

# `$FOREMAN_AGENT_TIER` is a default, not a flag. An explicit `--model` must
# override it; otherwise exporting the documented env default makes the escape
# hatch unusable. This used to die "--tier and --model are mutually exclusive".
out=$( (FOREMAN_AGENT_TIER=deep cmd_spawn br --model opus --task x) 2>&1 )
assert_not 'env FOREMAN_AGENT_TIER does not block --model' \
  [ "${out#*--tier and --model are mutually exclusive}" != "$out" ]

unset -f herdr
unset -f require_herdr

# ── join --timeout validation ───────────────────────────────────────────────────

printf '\njoin --timeout validation\n'
export FOREMAN_STATE="$sandbox/state-join-timeout"
require_herdr() { :; }

out=$( (cmd_join --timeout abc h) 2>&1 )
rc=$?
assert 'join --timeout dies on non-numeric value' [ "$rc" != 0 ]
assert 'output contains usage: foreman join' [ "${out#*usage: foreman join}" != "$out" ]
unset -f require_herdr

# ── join --once ──────────────────────────────────────────────────────────────
#
# The single-tick mode the omp foreman extension polls on a timer to deliver
# worker reports as a non-interrupting aside, instead of the boss
# blocking a tool call. It must never enter the deadline/sleep loop — a
# poller calling this every few seconds must never itself block.

printf '\njoin --once\n'
export FOREMAN_STATE="$sandbox/state-join-once"
mkdir -p "$(meta_dir w1)"
meta_set w1 "BOSS=me" "BRANCH=b" "DIR=/tmp/w1" "REPO_KEY=k"
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
export FOREMAN_STATE="$sandbox/state-join-once-working"
mkdir -p "$(meta_dir w2)"
meta_set w2 "BOSS=me" "BRANCH=b" "DIR=/tmp/w2" "REPO_KEY=k"
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
export FOREMAN_STATE="$sandbox/state-join-once-empty"
out3=$( (cmd_join --once) 2>&1 )
rc3=$?
is 'join --once with nothing joinable exits 0' "$rc3" '0'
is 'join --once with nothing joinable prints nothing' "$out3" ''
unset -f require_herdr scoped_key

# ── join settle-confirm race ─────────────────────────────────────────────────
#
# Bug caught live: a poller ticking every few seconds right after spawn can
# observe agent_status flip to idle a beat before a *different* process sees
# the report `foreman_report` just wrote in that same turn — herdr's status
# tracking and the filesystem view have no ordering guarantee between them.
# `mark_joined` used to fire unconditionally on the first idle/done sighting,
# so that race silently lost a real report forever: the joined counter was
# already bumped past it by the time the report became visible.

printf '\njoin settle-confirm race\n'
export FOREMAN_STATE="$sandbox/state-join-settle-race"
mkdir -p "$(meta_dir w1)"
meta_set w1 "BOSS=me" "BRANCH=b" "DIR=/tmp/w1" "REPO_KEY=k"
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

# A worker that is genuinely done with nothing to report (no `foreman_report`
# call at all) must still settle — just one tick later, never permanently
# stuck — once the SAME unfresh idle sighting repeats.
export FOREMAN_STATE="$sandbox/state-join-settle-noreport"
mkdir -p "$(meta_dir w2)"
meta_set w2 "BOSS=me" "BRANCH=b" "DIR=/tmp/w2" "REPO_KEY=k"
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
export FOREMAN_STATE="$sandbox/state-reply-append"
mkdir -p "$FOREMAN_STATE/w1"
meta_set w1 "BOSS=me" "BRANCH=b" "DIR=/tmp/x"
self_handle() { printf 'w1'; }
boss_handle() { printf 'me'; }
agent_exists() { return 1; }
require_herdr() { :; }

cmd_reply 'first question' >/dev/null 2>&1
cmd_reply 'second question' >/dev/null 2>&1

qf="$FOREMAN_STATE/w1/question.md"
assert     'question.md exists' [ -f "$qf" ]
assert     'question.md contains first question' [ -n "$(grep -F 'first question' "$qf")" ]
assert     'question.md contains second question' [ -n "$(grep -F 'second question' "$qf")" ]
assert     'question.md contains separator' [ -n "$(grep -F -- '---' "$qf")" ]
is         'question.seq reads 2' "$(counter_read "$FOREMAN_STATE/w1/question.seq")" '2'
unset -f self_handle boss_handle agent_exists require_herdr

# ── foreman version ───────────────────────────────────────────────────────────────

printf '\nforeman version\n'
is 'version comes from the plugin manifest' "$(cmd_version)" 'foreman 0.5.0'

# ── ls shows a pending question ──────────────────────────────────────────────────

printf '\nls shows a pending question\n'
export FOREMAN_STATE="$sandbox/state-ls-q"
mkdir -p "$FOREMAN_STATE/w2"
meta_set w2 "BOSS=boss" "BRANCH=feat/q" "DIR=/tmp/q" "REPO_KEY=k"
: >"$FOREMAN_STATE/w2/question.md"
counter_bump "$(cat "$FOREMAN_STATE/w2/question.seq" 2>/dev/null || echo "$FOREMAN_STATE/w2/question.seq")"

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
# bumping it would make a worker's eventual `foreman report` for its real task
# look like it answers the broadcast instead.

printf '\nbroadcast\n'
export FOREMAN_STATE="$sandbox/state-broadcast"
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

out2=$( (FOREMAN_STATE="$sandbox/state-broadcast-empty" cmd_broadcast 'hi') 2>&1 )
rc2=$?
assert 'broadcast fails with no live workers in scope' [ "$rc2" != 0 ]
assert 'and explains why' [ "${out2#*no live workers in this repo}" != "$out2" ]
unset -f herdr self_handle require_herdr scoped_key

# ── dm ────────────────────────────────────────────────────────────────────────
#
# Raw steering to one foreman member. Same untracked-dispatch contract as
# broadcast; the target gate (registered worker or the boss handle) is the one
# thing that differs from `foreman send --raw`, which only checks liveness.

printf '\ndm\n'
export FOREMAN_STATE="$sandbox/state-dm"
mkdir -p "$(meta_dir w1)"; meta_set w1 "BOSS=me"
self_handle() { printf 'me'; }
require_herdr() { :; }
agent_exists() { case "$1" in w1|intruder) return 0 ;; *) return 1 ;; esac; }
sent_text=""
prompt_raw() { sent_text="$2"; }

cmd_dm w1 'ping' >/dev/null 2>&1
is 'dm carries the [foreman dm from <sender>] prefix' "$sent_text" '[foreman dm from me] ping'

out=$( (cmd_dm intruder 'hi') 2>&1 )
rc=$?
assert 'dm rejects an unregistered, non-boss target' [ "$rc" != 0 ]
assert 'and points at foreman ls' [ "${out#*foreman ls}" != "$out" ]

before=$(counter_read "$(dispatch_file w1)")
cmd_dm w1 'ping again' >/dev/null 2>&1
after=$(counter_read "$(dispatch_file w1)")
is 'dm leaves the dispatch counter untouched' "$after" "$before"
unset -f self_handle require_herdr agent_exists prompt_raw

# ── keys ──────────────────────────────────────────────────────────────────────
#
# Unblocking an approval UI needs real terminal keys, not text `agent prompt`
# can deliver. foreman does not validate key names — herdr does — so the argv
# must reach `herdr agent send-keys` unmodified.

printf '\nkeys\n'
export FOREMAN_STATE="$sandbox/state-keys"
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
assert 'and explains usage' [ "${out#*usage: foreman keys}" != "$out" ]

out=$( (cmd_keys unknown-handle down) 2>&1 )
rc=$?
assert 'keys rejects a non-live handle' [ "$rc" != 0 ]
unset -f require_herdr agent_exists herdr

# ── boss identity ────────────────────────────────────────────────────────────
#
# `foreman boss` is the mandatory first step of every session, and
# `rebind_boss` repoints the BOSS field of every worker that reported to a
# renamed handle — a bug in either misroutes every `foreman reply` in the wave,
# and neither had a single assertion.

printf '\nboss identity\n'
export FOREMAN_STATE="$sandbox/state-boss"
require_herdr() { :; }
export HERDR_PANE_ID=p1

# A pane that already has a handle keeps it: `boss` with no argument has to
# stay a read, or running it a second time would silently rename the caller.
self_handle() { printf 'already-named'; }
h() { printf 'h was called: %s\n' "$*" >>"$h_calls"; }
h_calls="$sandbox/boss-h-calls"; : >"$h_calls"
is 'a bare boss on a named pane reports the existing handle' \
  "$(cmd_boss)" 'already-named'
is 'and never calls into herdr to rename anything' "$(cat "$h_calls")" ''
unset -f self_handle

# Two repos each wanting a foreman is the ordinary case: claiming a handle
# already held elsewhere must fail and name the holder, not overwrite it.
self_handle() { printf ''; }
agent_field() { case "$1" in taken) printf 'other-pane' ;; *) printf '' ;; esac; }
out=$( (cmd_boss taken) 2>&1 )
rc=$?
is 'claiming a held handle fails' "$rc" '1'
assert 'and names the pane holding it' [ "${out#*held by pane other-pane}" != "$out" ]
assert 'and offers a different handle' [ "${out#*foreman boss <name>}" != "$out" ]
assert 'and offers --steal as the alternative' [ "${out#*--steal}" != "$out" ]
unset -f agent_field self_handle

# --steal takes the handle over. The previous holder must be moved to a FREE
# name, not unnamed — an unnamed agent cannot be addressed by `foreman send`,
# `foreman read` or even its own `foreman whoami`.
self_handle() { printf ''; }
agent_field() { case "$1" in taken) printf 'other-pane' ;; *) printf '' ;; esac; }
agent_exists() { return 1; }  # every candidate name free_handle tries is open
: >"$h_calls"
out=$(cmd_boss taken --steal)
is 'stealing still returns the claimed handle' "$out" 'taken'
h_calls_content=$(cat "$h_calls")
assert 'the previous holder is renamed to a free variant, not cleared' \
  [ "${h_calls_content#*agent rename other-pane taken-1}" != "$h_calls_content" ]
assert 'and the caller'"'"'s pane is renamed to the claimed handle' \
  [ "${h_calls_content#*agent rename p1 taken}" != "$h_calls_content" ]
unset -f agent_field agent_exists self_handle
unset h_calls_content

# rebind_boss repoints only the workers that pointed at the old handle —
# leaving any worker that reports elsewhere untouched.
mkdir -p "$(meta_dir mine)" "$(meta_dir also-mine)" "$(meta_dir elsewhere)"
meta_set mine       "BOSS=old-handle" "BRANCH=b" "DIR=/tmp/mine"
meta_set also-mine  "BOSS=old-handle" "BRANCH=b" "DIR=/tmp/also-mine"
meta_set elsewhere  "BOSS=someone-else" "BRANCH=b" "DIR=/tmp/elsewhere"
rebind_note=$(rebind_boss old-handle new-handle 2>&1)
is 'a worker pointed at the old handle now points at the new one' \
  "$(meta_get mine BOSS)" 'new-handle'
is 'so does a second worker pointed at the same old handle' \
  "$(meta_get also-mine BOSS)" 'new-handle'
is 'a worker reporting elsewhere is left alone' \
  "$(meta_get elsewhere BOSS)" 'someone-else'
assert 'the rebind is noted with the count moved' \
  [ "${rebind_note#*repointed 2 worker(s)}" != "$rebind_note" ]

# The default handle tracks the repo, not a constant — a constant would let
# only one repo on the machine ever hold `boss`.
if command -v git >/dev/null 2>&1; then
  boss_repo="$sandbox/boss-repo"
  mkdir -p "$boss_repo"
  ( cd "$boss_repo" && git init -q . )
  is 'the default handle is slugified from the repo root name' \
    "$(cd "$boss_repo" && unset FOREMAN_BOSS_HANDLE; default_boss)" \
    "$(basename "$boss_repo")"
  is 'FOREMAN_BOSS_HANDLE overrides the repo-derived default' \
    "$(cd "$boss_repo" && FOREMAN_BOSS_HANDLE=explicit default_boss)" 'explicit'
else
  printf '  skip  default handle derivation (needs git)\n'
fi

unset -f require_herdr h
unset HERDR_PANE_ID

printf '\n'
if [ "$failures" = 0 ]; then
  printf 'all tests passed\n'; exit 0
fi
printf '%s test(s) failed\n' "$failures"; exit 1
