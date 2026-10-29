#!/usr/bin/env bash
# Prints "<compose project> <slot>" for the checkout in the current directory: the identity the
# Makefile gives this checkout's Compose stack. The project namespaces the containers, the network,
# the volume and the image; the slot shifts the published host ports. Two checkouts therefore run
# `make check` at the same time, and `make down` in one leaves the other running.
#
# The main worktree keeps the repository's own name and slot 0, so a plain clone publishes the ports
# it always did. A linked worktree adds its directory name and takes its position in
# `git worktree list`, unique among the worktrees that exist at that moment.
#
# Removing a worktree renumbers the ones created after it, which changes their ports. Compose
# recreates a container whose published port moved, so the next `make` call is enough; a stack still
# running under the old numbering is the one case that needs `make down` first. Export STACK_SLOT to
# pin a checkout to a port offset of your own.
set -euo pipefail

# Compose accepts lowercase letters, digits, dashes and underscores, and starts with the first two.
sanitize() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9_-]/-/g' -e 's/^[^a-z0-9]*//'
}

# Outside a repository, an exported tree has no worktrees to collide with and Compose's own default
# is the answer.
if ! toplevel=$(git rev-parse --show-toplevel 2>/dev/null); then
  printf '%s 0\n' "$(sanitize "$(basename "$PWD")")"
  exit 0
fi

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

if [ -z "$slot" ]; then
  echo "stack.sh: $toplevel is not in git worktree list; export STACK_SLOT to pick its ports" >&2
  exit 1
fi

project=$(basename "$main")
if [ "$slot" -ne 0 ]; then
  project="$project-$(basename "$toplevel")"
fi

printf '%s %s\n' "$(sanitize "$project")" "$slot"
