#!/usr/bin/env bash
# Prints "<compose project> <slot> <http port> <postgres port> <localstack port>" for the checkout
# in the current directory: the identity the Makefile gives this checkout's Compose stack, and the
# three ports it publishes. The project namespaces the containers, the network, the volume and the
# image; the slot decides the ports. Two checkouts therefore run `make check` at the same time, and
# `make down` in one leaves the other running.
#
# The main worktree keeps the repository's own name and starts at slot 0, so a plain clone publishes
# the ports it always did. A linked worktree adds its directory name and starts at its position in
# `git worktree list`, unique among the worktrees that exist at that moment.
#
# A slot whose ports are not all free is skipped, and the move is announced on stderr: a reviewer
# whose host already publishes 3000 gets a stack instead of a failure, and is told where it is. The
# step of that search is the number of worktrees, so the slots a checkout will consider are its own
# and then every one that leaves the other worktrees theirs — two of them searching at the same
# moment cannot pick the same slot. Nothing is remembered, so a checkout returns to its own slot as
# soon as those ports are free again. Export STACK_SLOT to pin a slot; a pinned one is used as
# given, ports in use included.
set -euo pipefail

# A block of ten per slot, with room for the ports the next slices publish, inside a band that
# common services and the ephemeral range both leave alone. Slot 0 is the exception: it keeps the
# three ports a single clone has always published.
SLOT_BASE=24000
SLOT_WIDTH=10

# How many slots a checkout tries before it gives up and asks for one. Twenty is more stacks than a
# host runs; ports held by something that is not a stack at all is the case this bounds.
SEARCH=20

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

# Whether this checkout can publish $1: either nothing is listening on it, or what is listening is a
# container of this checkout's own stack, which is the one occupant `make` is about to address
# anyway — so `make up` on a checkout that is already up keeps the slot it is already on.
free_for_us() {
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then
    return 0
  fi

  [ -n "$(docker ps --quiet --filter "publish=$1" \
    --filter "label=com.docker.compose.project=$project" 2>/dev/null)" ]
}

# Outside a repository, an exported tree has no worktrees to collide with and Compose's own default
# is the answer.
if ! toplevel=$(git rev-parse --show-toplevel 2>/dev/null); then
  project=$(sanitize "$(basename "$PWD")")
  slot=0
  worktrees=1
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

  if [ -z "$slot" ]; then
    echo "stack.sh: $toplevel is not in git worktree list; export STACK_SLOT to pick its ports" >&2
    exit 1
  fi

  project=$(basename "$main")
  if [ "$slot" -ne 0 ]; then
    project="$project-$(basename "$toplevel")"
  fi
  project=$(sanitize "$project")
  worktrees=$index
fi

if [ -n "${STACK_SLOT:-}" ]; then
  case $STACK_SLOT in
    *[!0-9]*)
      echo "stack.sh: STACK_SLOT is '$STACK_SLOT'; it has to be a whole number, like 7" >&2
      exit 1
      ;;
  esac

  printf '%s %s %s\n' "$project" "$STACK_SLOT" "$(ports_of "$STACK_SLOT")"
  exit 0
fi

taken=''
probe=$slot
last=$((slot + SEARCH * worktrees))
while [ "$probe" -le "$last" ]; do
  read -r http postgres localstack <<<"$(ports_of "$probe")"

  for port in "$http" "$postgres" "$localstack"; do
    if ! free_for_us "$port"; then
      if [ -z "$taken" ]; then
        taken=$port
      fi
      probe=$((probe + worktrees))
      continue 2
    fi
  done

  if [ -n "$taken" ]; then
    echo "Port $taken is taken, so this checkout uses slot $probe: http://localhost:$http" >&2
  fi

  printf '%s %s %s %s %s\n' "$project" "$probe" "$http" "$postgres" "$localstack"
  exit 0
done

echo "stack.sh: every slot from $slot to $last has a port in use, starting with $taken;" \
  "stop a stack with make down, or export STACK_SLOT to pick a slot" >&2
exit 1
