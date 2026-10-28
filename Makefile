.DEFAULT_GOAL := help
SHELL := /usr/bin/env bash
.SHELLFLAGS := -e -o pipefail -c
BUN ?= bun

.PHONY: help check fmt fmt-check lint typecheck test audit build dev infra migrate up down

help: ## List the targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-zA-Z_-]+:.*## / { printf "  %-10s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

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
