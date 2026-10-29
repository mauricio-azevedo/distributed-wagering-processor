# Contributing

## Quality gate

- `make check` runs the whole gate. CI runs the same target, so green locally means green in CI.
- Each step is its own target: `make fmt-check`, `make lint`, `make typecheck`, `make test`, `make audit`, `make build`. Run one while iterating, `check` before pushing.
- `make test` starts PostgreSQL and LocalStack through Compose (`make infra`, idempotent) and runs every suite against them; `make build` builds the image. Docker is therefore a prerequisite of the gate. The suites read the container addresses from `.env`, copied once from `.env.example`.
- The suites need the dependencies and nothing else of the stack. They send to `wager-transactions.fifo`, drive a consumer of their own and claim outbox rows themselves, so an `api` or `worker` instance left running from `make up` or `make demo` competes with them for the same queues and rows. Run `make down` (or `docker compose stop api worker`) before the gate; `make infra` then brings back exactly what the suites need.
- The gate is per checkout: each `git worktree` gets its own Compose project, image and published ports, so two of them run `make check` at the same time and `make down` in one leaves the other running. `make stack` prints what this checkout uses. A single clone, CI included, keeps `3000`, `5433` and `4566`.
- A worktree numbers its ports by its position in `git worktree list`, so removing one renumbers the ones created after it. Compose recreates a container whose published port moved, which is why that costs nothing; run `make down` before removing a worktree so no stack is left holding a port under the old numbering, and `docker compose ls` shows the stacks a removed worktree left behind.
- Only `make` passes the stack to Compose. A `docker compose` command typed by hand in a worktree addresses the project Compose names after the directory, which is not the one `make` started, so run `eval "$(make -s stack)"` in that shell first.
- `make fmt` rewrites files; `check` runs `fmt-check` instead. Everything under `check` only verifies and fails if it would change something; CI never rewrites.
- A failing check is fixed, not silenced. No skipped test, no lint-disable comment, no deleted assertion. Green earned that way is red with a lie on top.
- `make audit` fails on a known vulnerability in the dependency tree. A transitive advisory with no fix available gets a severity floor on the target, not a skip.
- `make` alone lists the targets.
- The Bun version is pinned in `.bun-version`. CI installs exactly that one, so a version difference is a change to that file and not a surprise in a job log. The `Dockerfile` base image carries the same version; a bump changes both files.
- `@types/bun` carries the Bun version in `.bun-version` as its floor, narrower than the major-only ranges beside it: the package describes the runtime, so types older than the runtime CI installs would typecheck against a Bun that is not there.
- Add a step by adding a target and putting it under `check`. A CI job outside `check` says why it is outside.

## Pull requests

- Contains one self-contained change.
- Small enough to be read in fifteen minutes.
- Titles follow Conventional Commits: `type(scope): summary`. The title becomes the squash commit message, so it is the only line that survives the merge. `!` marks a breaking change: a correct caller would fail.
- Adds or updates related tests and docs.
- The body comes from `.github/pull_request_template.md`.

## CI

- `ci` copies `.env.example` to `.env` and runs `make check` on every PR and on push to `main`; on failure it prints the container logs.
- `pr-title` validates the PR title. It sits outside `make check` because it reads the PR, not the code.
- Actions are pinned to a full commit SHA, version in a comment: `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`. Tags can be moved; SHAs can't.

## Repository settings

- Merge commits and rebase merging are disabled: squash is the only merge button.
- Squash messages default to PR titles only.
- Merged branches are deleted automatically.
- Automatic closure of linked issues is enabled.
- Actions must be pinned to a full commit SHA. A tag reference (`@v4`) is rejected.

## Rulesets

- `main` takes no direct pushes. Every change lands through a squash-merged PR.
- A PR branch must be up to date with `main` before it can merge. Rebase, do not merge `main` in.
- The required status checks must pass: `ci` and `pr-title`.

## ADRs

- An ADR is written, in the same PR, whenever a technical decision is costly or difficult to change.
- The format is MADR 4.0.0, as recorded in ADR 0000. The four templates and when to reach for each: [docs/decisions/README.md](docs/decisions/README.md).
- One decision per file, named `NNNN-title-with-dashes.md` with consecutive numbers. The `status` frontmatter carries the lifecycle: `proposed`, `accepted`, `rejected`, `deprecated`, `superseded by ADR-NNNN`.

## Board

- Work is tracked on the project board. Every open issue has a card. A PR gets no card of its own: it moves the card of the issue it was branched from.
- Columns: Backlog → Ready → In progress → In review → Done.
  - Backlog: every new issue lands here.
  - Ready: scoped, next in line.
  - In progress: branch created.
  - In review: PR open.
  - Done: merged or closed.
- Automatic, by the board's own workflows: a new issue lands in Backlog; a PR linked to an issue moves the issue to In review; a closed issue moves to Done.
- Manual: Ready and In progress. Move the card when you pick the issue up and when you create the branch.
- From the CLI: `gh project item-edit` moves a card; `gh project item-list 13 --owner mauricio-azevedo` shows the board.

## Issues and branches

- Issues use the forms in `.github/ISSUE_TEMPLATE/`. Blank issues are off, so every issue has what's needed to act on it.
- A branch is created from an issue: `gh issue develop <issue-number> --checkout`. Merging the PR from that branch closes the issue; no `Closes #123` needed.
