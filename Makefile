SHELL := /bin/bash
.DEFAULT_GOAL := help

COMPOSE := docker compose
HOST_PORT ?= 8300

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

# --- Local development -------------------------------------------------------

.PHONY: install
install: ## Install npm dependencies
	npm install

.PHONY: dev
dev: ## Run the app locally with hot reload (needs a reachable Postgres)
	npm run dev

.PHONY: build
build: ## Compile TypeScript to dist/
	npm run build

.PHONY: typecheck
typecheck: ## Type-check without emitting
	npm run typecheck

.PHONY: icons
icons: ## Regenerate the PWA icons from assets/mark.png (macOS)
	./tools/gen-icons.sh

# --- Containers --------------------------------------------------------------

.PHONY: up
up: ## Build and start the stack in the background
	$(COMPOSE) up -d --build

.PHONY: down
down: ## Stop the stack, keeping the database volume
	$(COMPOSE) down

.PHONY: restart
restart: ## Recreate the app container only
	$(COMPOSE) up -d --build app

.PHONY: logs
logs: ## Follow logs from all services
	$(COMPOSE) logs -f --tail 100

.PHONY: ps
ps: ## Show container status
	$(COMPOSE) ps

.PHONY: psql
psql: ## Open a psql shell on the database
	$(COMPOSE) exec db psql -U $${POSTGRES_USER:-connect} -d $${POSTGRES_DB:-connect}

.PHONY: health
health: ## Probe the running app
	@curl -fsS http://127.0.0.1:$(HOST_PORT)/healthz && echo
	@curl -fsS http://127.0.0.1:$(HOST_PORT)/readyz  && echo

# --- Deployment --------------------------------------------------------------

.PHONY: deploy
deploy: ## Deploy on the VPS (run from the project root there)
	./deploy/deploy.sh

.PHONY: backup
backup: ## Dump the database to backups/ with a timestamped filename
	@mkdir -p backups
	$(COMPOSE) exec -T db pg_dump -U $${POSTGRES_USER:-connect} \
		-d $${POSTGRES_DB:-connect} \
		| gzip > backups/connect-$$(date +%Y%m%d-%H%M%S).sql.gz
	@ls -lh backups | tail -1

# --- Housekeeping ------------------------------------------------------------

.PHONY: clean
clean: ## Remove build output and local dependencies
	rm -rf dist node_modules

.PHONY: nuke
nuke: ## Stop the stack AND DELETE the database volume (irreversible)
	@read -p "This deletes all database data. Type 'yes' to continue: " ok; \
	 [ "$$ok" = "yes" ] || { echo "aborted"; exit 1; }
	$(COMPOSE) down -v
