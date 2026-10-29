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
else
# A block of ten per worktree, with room for the ports the next slices publish, inside a band that
# common services and the ephemeral range both leave alone: shifting the defaults by the slot
# instead would walk onto whatever else the host happens to publish next to 3000 or 5433.
STACK_PORT_BASE := $(shell expr 24000 + 10 \* $(STACK_SLOT))
HTTP_PORT ?= $(STACK_PORT_BASE)
POSTGRES_PORT ?= $(shell expr $(STACK_PORT_BASE) + 1)
LOCALSTACK_PORT ?= $(shell expr $(STACK_PORT_BASE) + 2)
endif
export COMPOSE_PROJECT_NAME STACK_IMAGE HTTP_PORT POSTGRES_PORT LOCALSTACK_PORT

.PHONY: help stack check fmt fmt-check lint typecheck test audit build dev infra migrate up down

help: ## List the targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-zA-Z_-]+:.*## / { printf "  %-10s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

stack: ## Print this checkout's Compose project, image and published ports
	@printf '%s=%s\n' COMPOSE_PROJECT_NAME '$(COMPOSE_PROJECT_NAME)' STACK_SLOT '$(STACK_SLOT)' \
	  STACK_IMAGE '$(STACK_IMAGE)' HTTP_PORT '$(HTTP_PORT)' POSTGRES_PORT '$(POSTGRES_PORT)' \
	  LOCALSTACK_PORT '$(LOCALSTACK_PORT)'

check: fmt-check lint typecheck test audit build ## Run the whole quality gate; verifies only, never rewrites

fmt: ## Rewrite files with Prettier
	$(BUN) x prettier --write .

fmt-check: ## Fail if Prettier would change a file
	$(BUN) x prettier --check .

lint: ## Lint with ESLint
	$(BUN) x eslint .

typecheck: ## Type-check with tsc, no emit
	$(BUN) x tsc --noEmit

test: infra ## Run the test suites with bun test, against the Compose dependencies
	$(BUN) test

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
