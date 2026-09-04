#!/usr/bin/env bash
#
# Foreman one-step installer.
#
#   curl -fsSL https://raw.githubusercontent.com/andyhite/foreman/main/scripts/install.sh | bash
#
# Clones (or updates) the foreman checkout, builds it, drops a `foreman`
# wrapper on PATH, then launches `foreman setup`. Setup writes exactly one
# global symlink, `~/.foreman/plugin -> <checkout>/packages/omp-plugin`; it
# does not touch any repo. Per-repo activation is `foreman init`, run inside
# each repo you want Foreman in. Safe to re-run — it just pulls the latest
# checkout, rebuilds, and re-runs setup on top of your existing
# ~/.foreman/config.json.
#
# Extra arguments are forwarded to `foreman setup`, e.g.:
#
#   curl -fsSL .../install.sh | bash -s -- --yes
#
# Env overrides: FOREMAN_REPO_URL, FOREMAN_INSTALL_DIR, FOREMAN_BIN_DIR, FOREMAN_REF.

set -euo pipefail

FOREMAN_REPO_URL="${FOREMAN_REPO_URL:-https://github.com/andyhite/foreman.git}"
FOREMAN_INSTALL_DIR="${FOREMAN_INSTALL_DIR:-$HOME/.foreman/src}"
FOREMAN_BIN_DIR="${FOREMAN_BIN_DIR:-$HOME/.local/bin}"
FOREMAN_REF="${FOREMAN_REF:-}"

info() { printf '  %s\n' "$1"; }
die() { printf 'foreman-install: error: %s\n' "$1" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required — https://git-scm.com"
command -v bun >/dev/null 2>&1 || die "bun is required — https://bun.sh"

printf '\n\033[1mForeman installer\033[0m\n\n'

if [ -e "$FOREMAN_INSTALL_DIR" ]; then
  [ -d "$FOREMAN_INSTALL_DIR" ] || die "$FOREMAN_INSTALL_DIR exists but is not a directory; choose an empty install path with FOREMAN_INSTALL_DIR."
  # `rev-parse --is-inside-work-tree` succeeds for any directory *nested*
  # inside a work tree — if $HOME is itself a repo (a dotfiles checkout),
  # an install dir under it would pass this guard while every later
  # `git -C "$FOREMAN_INSTALL_DIR"` command actually operates on that
  # ancestor repo. Compare the work tree's actual root to the install dir.
  toplevel="$(git -C "$FOREMAN_INSTALL_DIR" rev-parse --show-toplevel 2>/dev/null)" ||
    die "$FOREMAN_INSTALL_DIR exists but is not a git checkout; move it aside or choose another FOREMAN_INSTALL_DIR."
  [ "$toplevel" = "$(cd "$FOREMAN_INSTALL_DIR" && pwd -P)" ] ||
    die "$FOREMAN_INSTALL_DIR is nested inside another git checkout ($toplevel); choose another FOREMAN_INSTALL_DIR."

  if [ -n "$(git -C "$FOREMAN_INSTALL_DIR" status --porcelain)" ]; then
    die "$FOREMAN_INSTALL_DIR has uncommitted changes; commit, stash, or discard them before updating."
  fi

  if git -C "$FOREMAN_INSTALL_DIR" symbolic-ref -q HEAD >/dev/null; then
    if ! git -C "$FOREMAN_INSTALL_DIR" fetch --quiet origin; then
      die "could not fetch origin for $FOREMAN_INSTALL_DIR; check network access and the origin remote."
    fi
    if ! git -C "$FOREMAN_INSTALL_DIR" rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
      die "$FOREMAN_INSTALL_DIR has no upstream branch; configure one or choose a fresh FOREMAN_INSTALL_DIR."
    fi
    if ! git -C "$FOREMAN_INSTALL_DIR" merge-base --is-ancestor HEAD '@{u}'; then
      die "$FOREMAN_INSTALL_DIR has local commits that cannot be fast-forwarded; push them or reset it before updating."
    fi

    info "updating existing checkout at $FOREMAN_INSTALL_DIR"
    if ! git -C "$FOREMAN_INSTALL_DIR" pull --quiet --ff-only; then
      die "could not fast-forward $FOREMAN_INSTALL_DIR; update or reset the checkout, then re-run the installer."
    fi
  elif [ -n "$FOREMAN_REF" ]; then
    # A detached HEAD is expected here: a previous run pinned it via
    # FOREMAN_REF below. Re-fetch so that pin's `git checkout` further down
    # can move to a newer commit if the ref is a branch or moved tag.
    info "$FOREMAN_INSTALL_DIR is pinned to FOREMAN_REF=$FOREMAN_REF (detached HEAD) — re-fetching"
    git -C "$FOREMAN_INSTALL_DIR" fetch --quiet --tags origin ||
      die "could not fetch origin for $FOREMAN_INSTALL_DIR; check network access and the origin remote."
  else
    die "$FOREMAN_INSTALL_DIR is on a detached HEAD, most likely left over from a previous FOREMAN_REF pin. Unset FOREMAN_REF and run \`git -C $FOREMAN_INSTALL_DIR checkout main\` to reattach it to a branch, then re-run this installer, or set FOREMAN_REF again to keep the pin."
  fi
else
  info "cloning $FOREMAN_REPO_URL to $FOREMAN_INSTALL_DIR"
  mkdir -p "$(dirname "$FOREMAN_INSTALL_DIR")"
  if ! git clone --quiet "$FOREMAN_REPO_URL" "$FOREMAN_INSTALL_DIR"; then
    die "could not clone $FOREMAN_REPO_URL; check the repository URL, credentials, and network connection."
  fi
fi

if [ -n "$FOREMAN_REF" ]; then
  info "checking out $FOREMAN_REF"
  git -C "$FOREMAN_INSTALL_DIR" fetch --quiet --tags origin
  git -C "$FOREMAN_INSTALL_DIR" checkout --quiet "$FOREMAN_REF" ||
    die "could not check out $FOREMAN_REF in $FOREMAN_INSTALL_DIR."
fi

info "bun install --frozen-lockfile && bun run build"
(cd "$FOREMAN_INSTALL_DIR" && bun install --frozen-lockfile && bun run build)

mkdir -p "$FOREMAN_BIN_DIR"
cat > "$FOREMAN_BIN_DIR/foreman" <<WRAPPER
#!/usr/bin/env bash
exec bun "$FOREMAN_INSTALL_DIR/packages/cli/dist/main.js" "\$@"
WRAPPER
chmod +x "$FOREMAN_BIN_DIR/foreman"
info "installed $FOREMAN_BIN_DIR/foreman"

case ":$PATH:" in
  *":$FOREMAN_BIN_DIR:"*) ;;
  *)
    echo
    echo "  $FOREMAN_BIN_DIR isn't on your PATH yet. Add it, e.g.:"
    echo "    export PATH=\"$FOREMAN_BIN_DIR:\$PATH\""
    ;;
esac

printf '\n\033[1mRunning foreman setup...\033[0m\n\n'

# Piped through `curl | bash`, this script's own stdin is the pipe, not a
# terminal — reconnect the wizard to /dev/tty so it can still prompt
# interactively. Reopening /dev/tty as a fresh fd breaks Bun's raw-mode
# keypress reading (used by the checkbox prompts), so only do this when
# stdin isn't already a real terminal — running the script directly
# (`./scripts/install.sh`, not piped) needs no reconnection at all. No
# /dev/tty (CI, a non-interactive shell) falls back to --yes so the
# installer never hangs on a read from a closed stream.
if [ -t 0 ]; then
  "$FOREMAN_BIN_DIR/foreman" setup "$@"
elif [ -t 1 ] && [ -r /dev/tty ]; then
  "$FOREMAN_BIN_DIR/foreman" setup "$@" < /dev/tty
else
  "$FOREMAN_BIN_DIR/foreman" setup --yes "$@"
fi

printf '\n\033[1mNext steps\033[0m\n\n'
echo "  cd <repo> && foreman init   # activate Foreman in a repo"
echo "  foreman doctor              # verify the install is healthy"
