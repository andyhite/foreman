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

# Runs foreman-link out of checkout $1, with FOREMAN_LINK_DIR and FOREMAN_STATE
# scoped under scenario scratch dir $2 so scenarios never share a link target
# or a receipt file. Merges stderr into stdout: every assertion below only
# checks for a substring's presence, and the warnings are the point.
run_link() {
  dir=$1
  scratch=$2
  shift 2
  ( FOREMAN_LINK_DIR="$scratch/bin" FOREMAN_STATE="$scratch/state" sh "$dir/bin/foreman-link" "$@" 2>&1 )
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
( FOREMAN_LINK_DIR="$linkdir" FOREMAN_STATE="$s/state" sh "$s/ck/bin/foreman-link" 2>&1 )
assert 'symlink exists in space-containing dir' [ -L "$linkdir/foreman" ]
is     'resolves to the plugin checkout' "$(readlink "$linkdir/foreman")" "$s/ck/bin/foreman"

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
