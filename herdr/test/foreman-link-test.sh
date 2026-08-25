#!/bin/sh
# Regression tests for `foreman-link`.
#
# No framework, same reasoning as foreman-test.sh: the plugin is dependency-free
# shell, so its tests should run anywhere foreman-link itself does — and unlike
# foreman-test.sh, foreman-link is POSIX sh (it runs under dash on Linux), so this
# file avoids bashisms too and is run under both:
#
#   /bin/sh herdr/test/foreman-link-test.sh
#   /opt/homebrew/bin/bash herdr/test/foreman-link-test.sh
#
# Each case runs the real foreman-link as a subprocess against a throwaway
# plugin checkout, the way herdr's `[[startup]]` hook actually invokes it —
# nothing here sources it or calls its functions directly.

set -u

FOREMAN_LINK=$(cd "$(dirname "$0")/.." && pwd)/bin/foreman-link
[ -f "$FOREMAN_LINK" ] || { printf 'cannot find foreman-link at %s\n' "$FOREMAN_LINK" >&2; exit 1; }

failures=0
ok()  { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — want [$3], got [$2]"; fi; }
assert()     { d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
assert_not() { d=$1; shift; if "$@"; then bad "$d"; else ok "$d"; fi; }

# mktemp -d hands back a path that on macOS resolves through a /var -> private
# symlink. foreman-link's own resolve_path canonicalizes with `cd -P`, so any
# expected-path string built by simple concatenation must start from an
# already-canonical root or the two will disagree despite naming the same file.
sandbox=$(mktemp -d) || exit 1
sandbox=$(cd -P "$sandbox" && pwd) || exit 1
trap 'rm -rf "$sandbox"' EXIT

# Builds a throwaway plugin checkout at $1 declaring plugin id $2: a real copy
# of foreman-link under test (so $0 inside it resolves within the checkout, same
# as an installed or `herdr plugin link`ed plugin), a herdr-plugin.toml naming
# the id, and a stand-in `bin/foreman` that just echoes which checkout ran it.
make_checkout() {
  dir=$1
  id=$2
  mkdir -p "$dir/bin"
  cp "$FOREMAN_LINK" "$dir/bin/foreman-link"
  chmod +x "$dir/bin/foreman-link"
  { printf '#!/bin/sh\n'; printf 'printf "%%s\\n" "%s"\n' "$id"; } >"$dir/bin/foreman"
  chmod +x "$dir/bin/foreman"
  printf 'id = "%s"\n' "$id" >"$dir/herdr-plugin.toml"
}

# Runs foreman-link out of checkout $1, with FOREMAN_LINK_DIR, FOREMAN_STATE
# and HOME scoped under scenario scratch dir $2 so scenarios never share a
# link target, a receipt file, or an omp MCP config. Merges stderr into
# stdout: every assertion below only checks for a substring's presence, and
# the warnings are the point.
run_link() {
  dir=$1
  scratch=$2
  shift 2
  ( FOREMAN_LINK_DIR="$scratch/bin" FOREMAN_STATE="$scratch/state" HOME="$scratch/home" sh "$dir/bin/foreman-link" "$@" 2>&1 )
}

# ── fresh install ────────────────────────────────────────────────────────────

printf '\nfresh install\n'
s="$sandbox/s1"; mkdir -p "$s"
make_checkout "$s/ck" foreman.test.s1
out=$(run_link "$s/ck" "$s"); rc=$?
is     'exits 0'                 "$rc" '0'
assert 'reports linked'          [ "${out#*linked }" != "$out" ]
assert 'target is now a symlink' [ -L "$s/bin/foreman" ]
is     'resolves into the checkout' "$(readlink "$s/bin/foreman")" "$s/ck/bin/foreman"

# ── idempotent re-run ────────────────────────────────────────────────────────

printf '\nidempotent re-run\n'
out=$(run_link "$s/ck" "$s"); rc=$?
is     'exits 0'                    "$rc" '0'
assert 'reports already linked'     [ "${out#*already linked}" != "$out" ]
is     'link target unchanged'      "$(readlink "$s/bin/foreman")" "$s/ck/bin/foreman"

# ── repoint between two checkouts sharing a plugin id ───────────────────────

printf '\nrepoint, same plugin id\n'
s="$sandbox/s3"; mkdir -p "$s"
make_checkout "$s/ckA" foreman.test.s3
make_checkout "$s/ckB" foreman.test.s3
run_link "$s/ckA" "$s" >/dev/null
out=$(run_link "$s/ckB" "$s"); rc=$?
is     'exits 0'                  "$rc" '0'
assert 'reports repointed'        [ "${out#*repointed}" != "$out" ]
is     'now resolves into ckB'    "$(readlink "$s/bin/foreman")" "$s/ckB/bin/foreman"

# ── refusals: nothing not owned by this plugin is ever touched ─────────────

printf '\nrefusal: regular file at target\n'
s="$sandbox/s4"; mkdir -p "$s/bin"
make_checkout "$s/ck" foreman.test.s4
printf 'not a link\n' >"$s/bin/foreman"
out=$(run_link "$s/ck" "$s"); rc=$?
is         'exits 0'               "$rc" '0'
assert     'warns it already exists' [ "${out#*already exists}" != "$out" ]
assert_not 'target did not become a symlink' [ -L "$s/bin/foreman" ]
is         'file contents untouched' "$(cat "$s/bin/foreman")" 'not a link'

printf '\nrefusal: symlink to an unrelated executable\n'
s="$sandbox/s5"; mkdir -p "$s/bin" "$s/other"
make_checkout "$s/ck" foreman.test.s5
printf '#!/bin/sh\necho other\n' >"$s/other/tool"
chmod +x "$s/other/tool"
ln -s "$s/other/tool" "$s/bin/foreman"
out=$(run_link "$s/ck" "$s"); rc=$?
is     'exits 0'                        "$rc" '0'
assert 'warns it already points elsewhere' [ "${out#*already points at}" != "$out" ]
is     'still points at the unrelated tool' "$(readlink "$s/bin/foreman")" "$s/other/tool"

printf '\nrefusal: live symlink into a DIFFERENT plugin id checkout\n'
s="$sandbox/s6"; mkdir -p "$s"
make_checkout "$s/ckA" foreman.test.s6.a
make_checkout "$s/ckB" foreman.test.s6.b
run_link "$s/ckB" "$s" >/dev/null
out=$(run_link "$s/ckA" "$s"); rc=$?
is     'exits 0'                          "$rc" '0'
assert 'warns it already points elsewhere' [ "${out#*already points at}" != "$out" ]
is     'still points at ckB'              "$(readlink "$s/bin/foreman")" "$s/ckB/bin/foreman"

printf '\nrefusal: dangling symlink not matching the receipt\n'
s="$sandbox/s8"; mkdir -p "$s/bin"
make_checkout "$s/ck" foreman.test.s8
ln -s "$s/nowhere/foreman" "$s/bin/foreman"
out=$(run_link "$s/ck" "$s"); rc=$?
is     'exits 0'                                 "$rc" '0'
assert 'warns foreman will not be on PATH'         [ "${out#*will not be on PATH}" != "$out" ]
is     'dangling link left exactly as it was'    "$(readlink "$s/bin/foreman")" "$s/nowhere/foreman"

# ── the regression: uninstall the linked checkout, rerun the other hook ────
#
# This is the bug foreman-link-test.sh exists to pin down. Before the receipt,
# step 3 below left the link dangling forever: nothing could prove the broken
# link was foreman-link's own, so it was never adopted, and `foreman` silently
# fell off PATH.

printf '\nregression: repoint away from a since-removed checkout\n'
s="$sandbox/s7"; mkdir -p "$s"
make_checkout "$s/installed" foreman.test.s7
make_checkout "$s/linked" foreman.test.s7
run_link "$s/installed" "$s" >/dev/null                # 1. fresh install
run_link "$s/linked" "$s" >/dev/null                    # 2. `herdr plugin link` repoints it
rm -rf "$s/linked"                                      # 3. the linked checkout is removed
out=$(run_link "$s/installed" "$s"); rc=$?              #    re-run the installed copy's hook
is     'exits 0'                            "$rc" '0'
assert 'reports repointed, not a warning'   [ "${out#*repointed}" != "$out" ]
assert 'link resolves again'                [ -e "$s/bin/foreman" ]
is     'points back at the installed checkout' "$(readlink "$s/bin/foreman")" "$s/installed/bin/foreman"
is     'and the command actually runs'      "$("$s/bin/foreman")" 'foreman.test.s7'
assert_not 'repoint left no temp debris' [ -n "$(ls "$s/bin"/*.tmp.* 2>/dev/null)" ]

# ── target dir path contains a space ──────────────────────────────────────────

printf '\ntarget dir path contains a space\n'
s="$sandbox/s9"; mkdir -p "$s"
make_checkout "$s/ck" foreman.test.s9
linkdir="$s/with space/bin"
mkdir -p "$linkdir"
( FOREMAN_LINK_DIR="$linkdir" FOREMAN_STATE="$s/state" HOME="$s/home" sh "$s/ck/bin/foreman-link" 2>&1 )
assert 'symlink exists in space-containing dir' [ -L "$linkdir/foreman" ]
is     'resolves to the plugin checkout' "$(readlink "$linkdir/foreman")" "$s/ck/bin/foreman"

# ── omp MCP: the installer registers nothing ─────────────────────────────────
#
# The bus is declared by the agent plugin's own `.omp-plugin/plugin.json`, so a
# sidecar exists exactly where a listener does. This installer used to write
# `~/.omp/agent/mcp.json` instead, which started a sidecar in *every* omp
# session on the machine — including sessions that never loaded the plugin and
# so could never turn a wake into an aside. A boss then read that sidecar's
# marker as proof of delivery, skipped the herdr prompt, and the task reached
# nobody at all.

printf '\nomp MCP: the installer registers nothing\n'
s="$sandbox/s11"; mkdir -p "$s"
make_checkout "$s/ck" foreman.test.s11
run_link "$s/ck" "$s" >/dev/null
assert_not 'no user-level mcp.json is written' [ -e "$s/home/.omp/agent/mcp.json" ]
assert_not 'and no .omp tree is created to hold one' [ -e "$s/home/.omp" ]

printf '\nomp MCP: an existing user config is left alone\n'
s="$sandbox/s12"; mkdir -p "$s/home/.omp/agent"
make_checkout "$s/ck" foreman.test.s12
printf '{"mcpServers":{"other":{"command":"other-tool","args":[]}}}\n' >"$s/home/.omp/agent/mcp.json"
run_link "$s/ck" "$s" >/dev/null
is 'unrelated config left byte-for-byte' \
  "$(cat "$s/home/.omp/agent/mcp.json")" \
  '{"mcpServers":{"other":{"command":"other-tool","args":[]}}}'

# ── omp MCP: the installer removes its own old entry ─────────────────────────
#
# Upgrade path. Stopping the write is not enough: an install that already ran
# the old version still has the entry, so the session would start one sidecar
# from it and a second from the plugin manifest.

printf '\nomp MCP: the installer removes its own old entry\n'
s="$sandbox/s13"; mkdir -p "$s/home/.omp/agent"
make_checkout "$s/ck" foreman.test.s13
printf '{"mcpServers":{"other":{"command":"other-tool","args":[]},"foreman":{"command":"foreman","args":["bus"]}}}\n' \
  >"$s/home/.omp/agent/mcp.json"
out=$(run_link "$s/ck" "$s")
is 'the stale foreman entry is gone' \
  "$(jq -c '.mcpServers.foreman // "absent"' "$s/home/.omp/agent/mcp.json")" '"absent"'
is 'and every other server survives untouched' \
  "$(jq -Sc '.mcpServers.other' "$s/home/.omp/agent/mcp.json")" \
  '{"args":[],"command":"other-tool"}'
assert 'and it says so, naming the file' [ "${out#*removed the old user-level foreman entry}" != "$out" ]

# A foreman entry pointing at something else was hand-written, so deleting it
# would silently break a setup the installer never created.
printf '\nomp MCP: a customised foreman entry is left alone\n'
s="$sandbox/s14"; mkdir -p "$s/home/.omp/agent"
make_checkout "$s/ck" foreman.test.s14
custom='{"mcpServers":{"foreman":{"command":"/opt/mine/foreman","args":["bus","--verbose"]}}}'
printf '%s\n' "$custom" >"$s/home/.omp/agent/mcp.json"
out=$(run_link "$s/ck" "$s")
is 'the customised entry is preserved byte-for-byte' \
  "$(cat "$s/home/.omp/agent/mcp.json")" "$custom"
assert 'and the installer says it left it alone' \
  [ "${out#*leaving customised foreman entry}" != "$out" ]

# A config that does not parse is not ours to rewrite, and must not abort the
# link that is this script's actual job.
printf '\nomp MCP: an unparseable config is left for the user\n'
s="$sandbox/s15"; mkdir -p "$s/home/.omp/agent"
make_checkout "$s/ck" foreman.test.s15
printf 'not json at all\n' >"$s/home/.omp/agent/mcp.json"
run_link "$s/ck" "$s" >/dev/null 2>&1
is 'the broken config is untouched' \
  "$(cat "$s/home/.omp/agent/mcp.json")" 'not json at all'
assert 'and the symlink was still created' [ -L "$s/bin/foreman" ]
assert 'leaving no temp file behind' \
  [ -z "$(find "$s/home/.omp/agent" -name 'mcp.json.tmp.*' 2>/dev/null)" ]

# Every warning branch in the link block exits 0, so a migration placed after
# it never ran for the one user who most needs it: the entry is stale whether
# or not the symlink could be created.
printf '\nomp MCP: the old entry goes even when the link target is occupied\n'
s="$sandbox/s16"; mkdir -p "$s/home/.omp/agent" "$s/bin"
make_checkout "$s/ck" foreman.test.s16
printf '#!/bin/sh\necho not ours\n' >"$s/bin/foreman"
chmod +x "$s/bin/foreman"
printf '{"mcpServers":{"foreman":{"command":"foreman","args":["bus"]}}}\n' \
  >"$s/home/.omp/agent/mcp.json"
out=$(run_link "$s/ck" "$s")
assert 'the link is still refused' [ "${out#*already exists}" != "$out" ]
is 'but the stale entry is gone anyway' \
  "$(jq -c '.mcpServers.foreman // "absent"' "$s/home/.omp/agent/mcp.json")" '"absent"'


# ── foreman-ls: parse guard against malformed JSON ───────────────────────────────

printf '\nforeman-ls: parse guard against malformed JSON\n'
s="$sandbox/s10"; mkdir -p "$s"
FOREMAN_LS=$(cd "$(dirname "$FOREMAN_LINK")/.." && pwd)/bin/foreman-ls
[ -f "$FOREMAN_LS" ] || { printf 'cannot find foreman-ls at %s\n' "$FOREMAN_LS" >&2; exit 1; }
out=$(HERDR_PLUGIN_CONTEXT_JSON='not json' sh "$FOREMAN_LS" 2>&1); rc=$?
is     'exits nonzero'                 "$rc" '1'
assert 'stderr mentions parse failure' [ "${out#*could not parse}" != "$out" ]

printf '\n'
if [ "$failures" = 0 ]; then
  printf 'all tests passed\n'; exit 0
fi
printf '%s test(s) failed\n' "$failures"; exit 1
