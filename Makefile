.DEFAULT_GOAL := help
SHELL := /usr/bin/env bash
.SHELLFLAGS := -e -o pipefail -c
BUN ?= bun

# One Compose stack per checkout, so two worktrees run the gate at the same time and stopping one
# leaves the other up. docker/stack.sh names the stack and numbers it: the main worktree is slot 0,
# hence the project name and the ports a single clone always had, and every linked worktree takes
# the next slot and shifts the three published ports by it. Compose reads the project, the image and
# the ports from the environment; .env builds the service URLs from the same ports, so the addresses
# the suites read always reach the containers these variables started. `make stack` reports them,
# and any of them, STACK_SLOT included, can be overridden from the environment or the command line.
STACK := $(shell docker/stack.sh)
ifneq ($(words $(STACK)),2)
$(error docker/stack.sh could not name this checkout's stack; its reason is above)
endif
COMPOSE_PROJECT_NAME ?= $(firstword $(STACK))
STACK_SLOT ?= $(lastword $(STACK))
STACK_IMAGE ?= $(COMPOSE_PROJECT_NAME)
ifeq ($(STACK_SLOT),0)
HTTP_PORT ?= 3000
POSTGRES_PORT ?= 5433
LOCALSTACK_PORT ?= 4566
# The host ports the load topology publishes for its three api instances (compose.load.yaml,
# OPS-008). Slot 0 publishes three fixed ports rather than a block, and the two next to 3000 are
# free of the other defaults, so the range starts where the single instance already publishes: one
# of the three instances always answers on the address a reviewer knows.
LOAD_API_PORTS ?= $(HTTP_PORT)-$(shell expr $(HTTP_PORT) + 2)
else
# A block of ten per worktree, with room for the ports the next slices publish, inside a band that
# common services and the ephemeral range both leave alone: shifting the defaults by the slot
# instead would walk onto whatever else the host happens to publish next to 3000 or 5433.
STACK_PORT_BASE := $(shell expr 24000 + 10 \* $(STACK_SLOT))
HTTP_PORT ?= $(STACK_PORT_BASE)
POSTGRES_PORT ?= $(shell expr $(STACK_PORT_BASE) + 1)
LOCALSTACK_PORT ?= $(shell expr $(STACK_PORT_BASE) + 2)
# Inside the same block of ten, after the three ports the stack itself publishes, so a worktree
# running the load experiment still collides with nothing another checkout published.
LOAD_API_PORTS ?= $(shell expr $(STACK_PORT_BASE) + 3)-$(shell expr $(STACK_PORT_BASE) + 5)
endif
export COMPOSE_PROJECT_NAME STACK_IMAGE HTTP_PORT POSTGRES_PORT LOCALSTACK_PORT LOAD_API_PORTS

# Where the suites run, which is never where the stack runs (`ops.suite-isolation`). One set of
# containers serves both: docker/postgres creates wagering_test beside wagering and
# docker/localstack creates the three queues a second time under this prefix, so `make demo` and
# `make check` no longer have to take turns. The addresses follow this checkout's PostgreSQL port
# like every other one, and `make stack` reports them. The prefix is kept in step with the one
# docker/localstack/queues.sh creates.
TEST_DATABASE_URL ?= postgres://wagering_app:wagering_app@localhost:$(POSTGRES_PORT)/wagering_test
TEST_MIGRATION_DATABASE_URL ?= \
  postgres://wagering_migrator:wagering_migrator@localhost:$(POSTGRES_PORT)/wagering_test
TEST_QUEUE_PREFIX ?= test-

.PHONY: help stack check fmt fmt-check lint typecheck test audit build dev infra migrate up down demo

help: ## List the targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-zA-Z_-]+:.*## / { printf "  %-10s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# The load experiment reads this output instead of recomputing the arithmetic above, so the ports
# it drives are the ports this checkout publishes and there is one place that decides them.
stack: ## Print this checkout's Compose project, image, published ports and suite addresses
	@printf '%s=%s\n' COMPOSE_PROJECT_NAME '$(COMPOSE_PROJECT_NAME)' STACK_SLOT '$(STACK_SLOT)' \
	  STACK_IMAGE '$(STACK_IMAGE)' HTTP_PORT '$(HTTP_PORT)' POSTGRES_PORT '$(POSTGRES_PORT)' \
	  LOCALSTACK_PORT '$(LOCALSTACK_PORT)' LOAD_API_PORTS '$(LOAD_API_PORTS)' \
	  TEST_DATABASE_URL '$(TEST_DATABASE_URL)' \
	  TEST_MIGRATION_DATABASE_URL '$(TEST_MIGRATION_DATABASE_URL)' \
	  TEST_QUEUE_PREFIX '$(TEST_QUEUE_PREFIX)'

# `make-check-gate` (OPS-001, `ops.repository-gate`): this target is the gate, and the `ci` workflow
# runs this same target, so green locally means green in CI and nothing merges red.
check: fmt-check lint typecheck test audit build ## Run the whole quality gate; verifies only, never rewrites

fmt: ## Rewrite files with Prettier
	$(BUN) x prettier --write .

fmt-check: ## Fail if Prettier would change a file
	$(BUN) x prettier --check .

lint: ## Lint with ESLint
	$(BUN) x eslint .

typecheck: ## Type-check with tsc, no emit
	$(BUN) x tsc --noEmit

# The suites read their addresses from here and not from .env: an exported variable wins over it,
# so the database and the queues of the stack stay out of reach of a truncation or a receive even
# when .env names them. Everything else they need, .env still carries. TESTS is whatever `bun test`
# takes, so one suite is iterated on inside the same isolation the gate runs under:
# `make test TESTS=test/unit`.
test: infra ## Run the test suites with bun test, against the suites' database and queues
	DATABASE_URL='$(TEST_DATABASE_URL)' MIGRATION_DATABASE_URL='$(TEST_MIGRATION_DATABASE_URL)' \
	  SQS_QUEUE_PREFIX='$(TEST_QUEUE_PREFIX)' $(BUN) test $(TESTS)

audit: ## Fail on a known vulnerability in the dependency tree
	$(BUN) audit

build: ## Build the container image
	docker compose build

dev: migrate ## Run the service from source with reload, against the Compose dependencies
	$(BUN) --watch run src/main.ts

infra: ## Start PostgreSQL and LocalStack and wait until both are healthy
	docker compose up --detach --wait postgres localstack

migrate: infra ## Apply pending migrations as the migrator role
	$(BUN) run src/infrastructure/persistence/migrate.ts

up: ## Start the whole stack: dependencies, migrations and the service
	docker compose up --build --detach --wait

down: ## Stop the stack and drop its data
	docker compose down --volumes

# The one target that drives the containers instead of an application a suite boots, which is why it
# starts the whole stack and not just the dependencies: what it demonstrates is the topology of
# compose.yaml. It needs no `make down` around it: the suites address their own database and their
# own queues (`ops.suite-isolation`).
demo: up ## Walk through the demonstrations of docs/demonstrations.md against the running stack
	$(BUN) run demo/walkthrough.ts
