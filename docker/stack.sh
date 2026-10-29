#!/usr/bin/env bash
# Prints "<compose project> <slot> <http port> <postgres port> <localstack port>" for the checkout
# in the current directory: the identity the Makefile gives this checkout's Compose stack, and the
# three ports it publishes. The project namespaces the containers, the network, the volume and the
# image; the slot decides the ports. Two checkouts therefore run `make check` at the same time, and
# `make down` in one leaves the other running.
#
# The main worktree keeps the repository's own name and takes slot 0, so a plain clone publishes the
# ports it always did. A linked worktree adds its directory name and takes its position in
# `git worktree list`, unique among the worktrees that exist at that moment. Export STACK_SLOT to
# pin a slot; a pinned one is used as given.
#
# The slot is derived, never searched: nothing here looks at what the host already publishes, so a
# checkout answers the same ports every time, and a port one of them is already using fails
# `docker compose` with Compose's own message.
set -euo pipefail

# A block of ten per slot, with room for the ports the next slices publish, inside a band that
# common services and the ephemeral range both leave alone. Slot 0 is the exception: it keeps the
# three ports a single clone has always published.
SLOT_BASE=24000
SLOT_WIDTH=10

# Compose accepts lowercase letters, digits, dashes and underscores, and starts with the first two.
sanitize() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9_-]/-/g' -e 's/^[^a-z0-9]*//'
}

ports_of() {
  local base
  if [ "$1" -eq 0 ]; then
    printf '3000 5433 4566'
  else
    base=$((SLOT_BASE + SLOT_WIDTH * $1))
    printf '%s %s %s' "$base" "$((base + 1))" "$((base + 2))"
  fi
}

# Outside a repository, an exported tree has no worktrees to collide with and Compose's own default
# is the answer.
if ! toplevel=$(git rev-parse --show-toplevel 2>/dev/null); then
  project=$(sanitize "$(basename "$PWD")")
  slot=0
else
  main=''
  slot=''
  index=0
  while IFS= read -r worktree; do
    if [ "$index" -eq 0 ]; then
      main=$worktree
    fi
    if [ "$worktree" = "$toplevel" ]; then
      slot=$index
    fi
    index=$((index + 1))
  done < <(git worktree list --porcelain | sed -n 's/^worktree //p')

  # A checkout outside `git worktree list` has no slot to derive, which STACK_SLOT answers. It is
  # read below, so this only refuses a checkout that has not pinned one.
  if [ -z "$slot" ] && [ -z "${STACK_SLOT:-}" ]; then
    echo "stack.sh: $toplevel is not in git worktree list; export STACK_SLOT to pick its ports" >&2
    exit 1
  fi

  project=$(basename "$main")
  if [ "$slot" -ne 0 ]; then
    project="$project-$(basename "$toplevel")"
  fi
  project=$(sanitize "$project")
fi

if [ -n "${STACK_SLOT:-}" ]; then
  case $STACK_SLOT in
    *[!0-9]*)
      echo "stack.sh: STACK_SLOT is '$STACK_SLOT'; it has to be a whole number, like 7" >&2
      exit 1
      ;;
  esac

  slot=$STACK_SLOT
fi

printf '%s %s %s\n' "$project" "$slot" "$(ports_of "$slot")"
