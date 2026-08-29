#!/usr/bin/env bash
#
# Foreman one-step installer.
#
#   curl -fsSL https://raw.githubusercontent.com/andyhite/foreman/main/scripts/install.sh | bash
#
# Clones (or updates) the foreman checkout, builds it, drops a `foreman`
# wrapper on PATH, then launches `foreman setup`. Safe to re-run — it just
# pulls the latest checkout and re-runs setup on top of your existing
# ~/.foreman/config.json.
#
# Extra arguments are forwarded to `foreman setup`, e.g.:
#
#   curl -fsSL .../install.sh | bash -s -- --yes --omp install --scope user
#
# Env overrides: FOREMAN_REPO_URL, FOREMAN_INSTALL_DIR, FOREMAN_BIN_DIR.

set -euo pipefail

FOREMAN_REPO_URL="${FOREMAN_REPO_URL:-https://github.com/andyhite/foreman.git}"
FOREMAN_INSTALL_DIR="${FOREMAN_INSTALL_DIR:-$HOME/.foreman/src}"
FOREMAN_BIN_DIR="${FOREMAN_BIN_DIR:-$HOME/.local/bin}"

info() { printf '  %s\n' "$1"; }
die() { printf 'foreman-install: error: %s\n' "$1" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required — https://git-scm.com"
command -v bun >/dev/null 2>&1 || die "bun is required — https://bun.sh"

printf '\n\033[1mForeman installer\033[0m\n\n'

if [ -e "$FOREMAN_INSTALL_DIR" ]; then
  [ -d "$FOREMAN_INSTALL_DIR" ] || die "$FOREMAN_INSTALL_DIR exists but is not a directory; choose an empty install path with FOREMAN_INSTALL_DIR."
  git -C "$FOREMAN_INSTALL_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
    die "$FOREMAN_INSTALL_DIR exists but is not a git checkout; move it aside or choose another FOREMAN_INSTALL_DIR."

  if [ -n "$(git -C "$FOREMAN_INSTALL_DIR" status --porcelain)" ]; then
    die "$FOREMAN_INSTALL_DIR has uncommitted changes; commit, stash, or discard them before updating."
  fi
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
else
  info "cloning $FOREMAN_REPO_URL to $FOREMAN_INSTALL_DIR"
  mkdir -p "$(dirname "$FOREMAN_INSTALL_DIR")"
  if ! git clone --quiet "$FOREMAN_REPO_URL" "$FOREMAN_INSTALL_DIR"; then
    die "could not clone $FOREMAN_REPO_URL; check the repository URL, credentials, and network connection."
  fi
fi

info "bun install && bun run build"
(cd "$FOREMAN_INSTALL_DIR" && bun install && bun run build)

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
