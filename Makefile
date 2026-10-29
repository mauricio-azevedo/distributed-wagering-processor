.DEFAULT_GOAL := demo
SHELL := /usr/bin/env bash
.SHELLFLAGS := -e -o pipefail -c
BUN ?= bun

# One Compose stack per checkout, so two worktrees run the gate at the same time and stopping one
# leaves the other up. docker/stack.sh names the stack, numbers it and picks the three ports of its
# slot: the main worktree starts at slot 0, hence the project name and the ports a single clone
# always had, every linked worktree starts at the next slot, and a slot with a port already in use
# is skipped for the next free one, which the script announces. STACK_SLOT pins a slot and is taken
# as given. Compose reads the project, the image and the ports from the environment; .env builds the
# service URLs from the same ports, so the addresses the suites read always reach the containers
# these variables started. `make stack` reports them, and any of them can be overridden from the
# environment or the command line.
STACK := $(shell STACK_SLOT='$(STACK_SLOT)' docker/stack.sh)
ifneq ($(words $(STACK)),5)
$(error docker/stack.sh could not name this checkout's stack; its reason is above)
endif
COMPOSE_PROJECT_NAME ?= $(word 1,$(STACK))
STACK_SLOT ?= $(word 2,$(STACK))
STACK_IMAGE ?= $(COMPOSE_PROJECT_NAME)
HTTP_PORT ?= $(word 3,$(STACK))
POSTGRES_PORT ?= $(word 4,$(STACK))
LOCALSTACK_PORT ?= $(word 5,$(STACK))
# The host ports the load topology publishes for its three api instances (compose.load.yaml,
# OPS-008). Slot 0 publishes three fixed ports rather than a block, and the two next to 3000 are
# free of the other defaults, so the range starts where the single instance already publishes: one
# of the three instances always answers on the address a reviewer knows. Every other slot takes the
# range from inside its own block of ten, after the three ports the stack itself publishes, so a
# worktree running the load experiment collides with nothing another checkout published.
ifeq ($(STACK_SLOT),0)
LOAD_API_PORTS ?= $(HTTP_PORT)-$(shell expr $(HTTP_PORT) + 2)
else
LOAD_API_PORTS ?= $(shell expr $(HTTP_PORT) + 3)-$(shell expr $(HTTP_PORT) + 5)
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

.PHONY: help stack check fmt fmt-check lint typecheck test audit build dev infra migrate up down \
  demo drill logs

# Printed where a reader is already stuck, so the command that explains a failure arrives with the
# failure instead of in a document. One sentence and one command, in that order, everywhere.
next = { printf '%s\nNext: %s\n' '$(1)' '$(2)' >&2; exit 1; }

# The prerequisites of anything run from the host, as the files they produce: `make` installs them
# once and then leaves them alone. Neither one overwrites what is there — an existing .env is a
# configuration someone chose.
node_modules: package.json bun.lock
	$(BUN) install --frozen-lockfile
	@touch node_modules

.env:
	@cp .env.example .env
	@printf '.env created from .env.example.\n'

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
check: node_modules fmt-check lint typecheck test audit build ## Run the whole quality gate; verifies only, never rewrites

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
test: node_modules .env infra ## Run the test suites with bun test, against the suites' database and queues
	DATABASE_URL='$(TEST_DATABASE_URL)' MIGRATION_DATABASE_URL='$(TEST_MIGRATION_DATABASE_URL)' \
	  SQS_QUEUE_PREFIX='$(TEST_QUEUE_PREFIX)' $(BUN) test $(TESTS)

audit: ## Fail on a known vulnerability in the dependency tree
	$(BUN) audit

build: ## Build the container image
	docker compose build

dev: .env migrate ## Run the service from source with reload, against the Compose dependencies
	$(BUN) --watch run src/main.ts

infra: ## Start PostgreSQL and LocalStack and wait until both are healthy
	@docker compose up --detach --wait postgres localstack \
	  || $(call next,PostgreSQL or LocalStack did not come up.,make logs SERVICES="postgres localstack")

migrate: node_modules .env infra ## Apply pending migrations as the migrator role
	$(BUN) run src/infrastructure/persistence/migrate.ts

up: ## Start the whole stack: dependencies, migrations and the service
	@docker compose up --build --detach --wait \
	  || $(call next,The stack did not reach readiness.,make logs)

down: ## Stop the stack and drop its data
	docker compose down --volumes

# What a reader wants the moment something above fails, and the one form of it that reaches this
# checkout's containers rather than whatever Compose would name after the directory. SERVICES
# narrows it: `make logs SERVICES=worker`.
logs: ## Print the stack's logs; SERVICES names which services
	@docker compose logs --tail 100 $(SERVICES)

# The one target that drives the containers instead of an application a suite boots, which is why it
# starts the whole stack and not just the dependencies: what it demonstrates is the topology of
# compose.yaml. It needs no `make down` around it: the suites address their own database and their
# own queues (`ops.suite-isolation`).
demo: node_modules .env up ## Walk through the demonstrations of docs/demonstrations.md against the running stack
	$(BUN) run demo/walkthrough.ts

# Not part of `make check`: it edits the source on purpose. It refuses to start unless the files it
# mutates are as committed, and restores each one before the next mutation.
drill: node_modules .env infra ## Break an invariant on purpose and run the cases that catch it
	$(BUN) run demo/mutation-drill.ts
