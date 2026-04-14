# ============================================================================
# dev-panel — Production deployment Makefile
# ============================================================================
.PHONY: help init local deploy deploy-core deploy-all status stop clean ssh

# Config
export VPS_HOST ?= 77.42.46.87
export VPS_USER ?= deploy
export SSH_KEY ?= $(HOME)/.ssh/hetzner-vps

SSH = ssh -i $(SSH_KEY) $(VPS_USER)@$(VPS_HOST)
SCP = scp -i $(SSH_KEY)

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── Local development ───────────────────────────────────────────────────────

init: ## Initialize local .env (idempotent)
	@bash infra/init.sh local

build: ## Build dev-panel image locally
	docker build -t ghcr.io/franckbirba/dev-panel:latest .
	@echo "✅ Built ghcr.io/franckbirba/dev-panel:latest"

push: build ## Push image to GitHub Container Registry
	docker push ghcr.io/franckbirba/dev-panel:latest
	@echo "✅ Pushed to GHCR"

local: init ## Run all services locally (requires Docker Desktop)
	docker compose --profile all up -d

# ── Production deployment ───────────────────────────────────────────────────

deploy-core: push ## Deploy core stack (traefik, redis, devpanel, affine)
	@echo "🚀 Deploying core stack to $(VPS_HOST)..."
	@$(SSH) "mkdir -p ~/dev-panel/infra ~/dev-panel/storage"
	@rsync -avz --exclude='.env*' --exclude='node_modules' --exclude='storage' -e "ssh -i $(SSH_KEY)" \
		infra/ $(VPS_USER)@$(VPS_HOST):~/dev-panel/infra/
	@$(SSH) "cd ~/dev-panel && bash infra/init.sh production"
	@$(SSH) "cd ~/dev-panel && docker compose pull && docker compose --profile core up -d"
	@echo "✅ Core deployed — https://devpanl.dev"

deploy-plane: ## Deploy Plane project management
	@$(SSH) "cd ~/dev-panel && docker compose --profile plane up -d"
	@echo "✅ Plane deployed — https://plane.devpanl.dev"

deploy-penpot: ## Deploy Penpot design tool
	@$(SSH) "cd ~/dev-panel && docker compose --profile penpot up -d"
	@echo "✅ Penpot deployed — https://penpot.devpanl.dev"

deploy-monitoring: ## Deploy monitoring stack
	@$(SSH) "cd ~/dev-panel && docker compose --profile monitoring up -d"
	@echo "✅ Monitoring deployed — https://status.devpanl.dev"

deploy-all: deploy-core deploy-plane deploy-penpot deploy-monitoring ## Deploy everything

# ── Utilities ───────────────────────────────────────────────────────────────

status: ## Show service status
	@$(SSH) "cd ~/dev-panel && docker compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'"

stop: ## Stop all services
	@$(SSH) "cd ~/dev-panel && docker compose --profile all down"

clean: ## Remove all containers and volumes (⚠️ DESTRUCTIVE)
	@read -p "⚠️  This will DELETE ALL DATA. Type 'yes' to confirm: " confirm && [ "$$confirm" = "yes" ]
	@$(SSH) "cd ~/dev-panel && docker compose --profile all down -v"
	@echo "✅ Cleaned"

ssh: ## SSH into VPS
	@$(SSH)

# ── Secrets management ──────────────────────────────────────────────────────

secrets-rotate: ## Rotate all secrets (regenerate .env.production)
	@$(SSH) "cd ~/dev-panel && mv .env.production .env.production.bak && bash infra/init.sh production"
	@echo "⚠️  Review ~/dev-panel/.env.production and restart services"
