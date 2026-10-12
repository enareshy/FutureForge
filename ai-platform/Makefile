SHELL := /usr/bin/env bash
COMPOSE := docker compose --env-file .env -f compose.yaml

.DEFAULT_GOAL := help

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'

env: ## Create .env from the template when missing
	@[ -f .env ] || cp .env.example .env

daemon: ## Ensure the Docker daemon is running
	@./scripts/docker-daemon.sh

up: env daemon ## Start the lean local stack
	@./scripts/up.sh

down: ## Stop the stack (keeps data volumes)
	@./scripts/down.sh

ps: ## Show stack status
	@$(COMPOSE) ps

logs: ## Tail stack logs
	@$(COMPOSE) logs -f --tail=100

health: ## Report dependency health
	@./scripts/health.sh

migrate: env ## Apply database migrations
	@./scripts/migrate.sh

setup: ## Full local bootstrap (env, daemon, stack, migrations, health)
	@./scripts/setup.sh

config: ## Validate the compose configuration
	@$(COMPOSE) config -q && echo "compose config: OK"

test: ## Run platform tests
	@echo "no tests yet — populated in Phase 13"
