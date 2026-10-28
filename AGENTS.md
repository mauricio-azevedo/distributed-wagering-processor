# Agent Instructions

## Before making changes

- Read README.md and CONTRIBUTING.md.
- Read docs/system-contract.md, ARCHITECTURE.md, and relevant ADRs under
  docs/decisions/ before changing financial behavior or persistence.
- Read docs/implementation-plan.md for the current slice and
  docs/acceptance.yaml for the acceptance ids it must turn green.
- Read docs/openapi.yaml before changing an HTTP endpoint and docs/asyncapi.yaml
  before changing a message or an event; change the contract first.
- Inspect the existing implementation and follow its conventions.
- Keep changes within the requested scope.

## Stack and commands

Use Bun, TypeScript in strict mode, NestJS, MikroORM, PostgreSQL,
LocalStack, and Docker Compose.

Use the Bun version specified in .bun-version and preserve bun.lock.
Use the existing Makefile:

- bun install --frozen-lockfile
- make fmt
- make check

Read the Makefile before adding commands. Prefer ordinary tooling and
small local helpers over custom verification or orchestration systems.

## Architecture

- Keep domain code independent of NestJS, MikroORM, HTTP, and SQS.
- Put use cases and ports in the application layer.
- Put transport, persistence, and external-service adapters in infrastructure.
- Reuse the same financial use case across HTTP and SQS.
- Create abstractions when the implementation needs them.
- Record consequential architectural choices using the existing ADR format.

## Financial correctness

- Never represent money using JavaScript number or floating-point arithmetic.
- Preserve the documented exact money representation and string serialization.
- Keep financial state, ledger, inbox completion, and outbox insertion atomic.
- Enforce concurrency and persistent idempotency through PostgreSQL.
- Publish integration events and acknowledge messages only after commit.
- Keep ledger entries immutable and terminal transaction outcomes stable.
- Preserve the original observed balance when replaying a terminal operation.
- Keep guarantees valid across multiple application instances.

## Verification

- Write the failing test before the production code: unit test for domain
  behavior, integration test for an adapter, concurrency test for a race.
- Add focused tests with each behavior change.
- Use real PostgreSQL and LocalStack for integration tests.
- Use actual parallelism and independent processes for concurrency tests.
- Reconcile affected wallet balances against the ledger in financial scenarios.
- Run relevant checks while working and make check before completion.
- Never weaken checks or remove assertions to obtain a passing result.
- Report checks that could not run and explain why.

## Documentation

- Treat docs/openapi.yaml and docs/asyncapi.yaml as the authoritative transport
  contracts; DTOs and message classes implement them, and runtime validation
  stays in code.
- Document behavior and interpretations in docs/system-contract.md.
- Keep ARCHITECTURE.md aligned with the implemented design.
- Link to authoritative definitions instead of maintaining duplicate schemas.
- Distinguish planned behavior from implemented and verified behavior.
- Resolve contradictions explicitly before building on them.

## Completion

Follow CONTRIBUTING.md for issue, branch, and PR conventions.

Leave the project board alone. Its own workflows move a card to Backlog, In
review, and Done; Ready and In progress are the maintainer's. Moving one from
the CLI costs several calls and proves nothing about the change.

Update the affected docs/acceptance.yaml entries in the same change.

Report what changed, how it was verified, and any remaining limitations.
Never claim a check passed unless it was run successfully.
