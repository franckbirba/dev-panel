#!/bin/bash
set -euo pipefail

# Dev-Panel Hetzner infrastructure manager
# Requires: HCLOUD_TOKEN env var + hcloud CLI (brew install hcloud)
#
# Usage:
#   ./infra/hetzner.sh status          — Show nodes status
#   ./infra/hetzner.sh stop            — Power off both nodes
#   ./infra/hetzner.sh start           — Power on both nodes
#   ./infra/hetzner.sh restart         — Reboot both nodes
#   ./infra/hetzner.sh create          — Provision from scratch
#   ./infra/hetzner.sh destroy         — Delete everything (⚠️ destructive)
#   ./infra/hetzner.sh ssh services    — SSH into services node
#   ./infra/hetzner.sh ssh agents      — SSH into agents node
#   ./infra/hetzner.sh deploy          — Deploy configs to both nodes

PROJECT="devpanel"
LOCATION="fsn1"
SERVER_TYPE="cx22"
SSH_KEY_NAME="franck"
NETWORK_NAME="${PROJECT}-net"
SUBNET="10.0.0.0/24"

SERVICES="${PROJECT}-services"
AGENTS="${PROJECT}-agents"

# ─── Helpers ────────────────────────────────────────────────
get_ip() { hcloud server ip "$1" 2>/dev/null || echo "N/A"; }

status() {
  echo "=== Dev-Panel Infrastructure ==="
  echo ""
  hcloud server list -l "project=$PROJECT" -o columns=name,status,public_net_ipv4,server_type,datacenter
  echo ""
  hcloud network describe "$NETWORK_NAME" 2>/dev/null | grep -A5 "Servers" || true
}

stop_nodes() {
  echo "Stopping services node..."
  hcloud server shutdown "$SERVICES" 2>/dev/null || hcloud server poweroff "$SERVICES"
  echo "Stopping agents node..."
  hcloud server shutdown "$AGENTS" 2>/dev/null || hcloud server poweroff "$AGENTS"
  echo "Both nodes stopped."
}

start_nodes() {
  echo "Starting services node..."
  hcloud server poweron "$SERVICES"
  echo "Starting agents node..."
  hcloud server poweron "$AGENTS"
  echo "Both nodes started. Waiting for boot..."
  sleep 10
  status
}

restart_nodes() {
  echo "Rebooting services node..."
  hcloud server reboot "$SERVICES"
  echo "Rebooting agents node..."
  hcloud server reboot "$AGENTS"
  echo "Both nodes rebooting."
}

create_infra() {
  echo "=== Creating private network ==="
  hcloud network create --name "$NETWORK_NAME" --ip-range "$SUBNET" 2>/dev/null || echo "Network exists"
  hcloud network add-subnet "$NETWORK_NAME" --type server --network-zone eu-central --ip-range "$SUBNET" 2>/dev/null || echo "Subnet exists"

  echo "=== Creating services node (10.0.0.2) ==="
  hcloud server create \
    --name "$SERVICES" \
    --type "$SERVER_TYPE" \
    --image ubuntu-24.04 \
    --location "$LOCATION" \
    --ssh-key "$SSH_KEY_NAME" \
    --user-data-from-file "$(dirname "$0")/cloud-init-services.yml" \
    --label "project=$PROJECT,role=services" \
    2>/dev/null || echo "Server exists"
  hcloud server attach-to-network "$SERVICES" --network "$NETWORK_NAME" --ip 10.0.0.2 2>/dev/null || echo "Attached"

  echo "=== Creating agents node (10.0.0.3) ==="
  hcloud server create \
    --name "$AGENTS" \
    --type "$SERVER_TYPE" \
    --image ubuntu-24.04 \
    --location "$LOCATION" \
    --ssh-key "$SSH_KEY_NAME" \
    --user-data-from-file "$(dirname "$0")/cloud-init-agents.yml" \
    --label "project=$PROJECT,role=agents" \
    2>/dev/null || echo "Server exists"
  hcloud server attach-to-network "$AGENTS" --network "$NETWORK_NAME" --ip 10.0.0.3 2>/dev/null || echo "Attached"

  echo ""
  status
  echo ""
  SERVICES_IP=$(get_ip "$SERVICES")
  AGENTS_IP=$(get_ip "$AGENTS")
  echo "Point DNS devpanl.dev → ${SERVICES_IP}"
  echo "GitHub secrets: VPS_HOST=${SERVICES_IP} VPS_AGENTS_HOST=${AGENTS_IP}"
}

destroy_infra() {
  read -p "⚠️  This will DELETE all servers and data. Type 'yes' to confirm: " confirm
  if [ "$confirm" != "yes" ]; then
    echo "Aborted."
    exit 1
  fi
  echo "Destroying agents node..."
  hcloud server delete "$AGENTS" 2>/dev/null || true
  echo "Destroying services node..."
  hcloud server delete "$SERVICES" 2>/dev/null || true
  echo "Destroying network..."
  hcloud network delete "$NETWORK_NAME" 2>/dev/null || true
  echo "Infrastructure destroyed."
}

ssh_node() {
  local node="$1"
  case "$node" in
    services) hcloud server ssh "$SERVICES" -l deploy ;;
    agents)   hcloud server ssh "$AGENTS" -l deploy ;;
    *)        echo "Usage: $0 ssh [services|agents]"; exit 1 ;;
  esac
}

deploy_configs() {
  SERVICES_IP=$(get_ip "$SERVICES")
  AGENTS_IP=$(get_ip "$AGENTS")
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

  echo "=== Deploying to services node (${SERVICES_IP}) ==="
  scp "$ROOT_DIR/docker-compose.prod.yml" "deploy@${SERVICES_IP}:~/dev-panel/"
  scp "$SCRIPT_DIR/traefik.yml" "deploy@${SERVICES_IP}:~/dev-panel/traefik/"
  scp "$SCRIPT_DIR/dynamic.yml" "deploy@${SERVICES_IP}:~/dev-panel/traefik/"
  echo "Services configs deployed. Don't forget .env on the server."

  echo ""
  echo "=== Deploying to agents node (${AGENTS_IP}) ==="
  ssh "deploy@${AGENTS_IP}" "mkdir -p ~/.claude ~/dev-panel"
  scp "$SCRIPT_DIR/claude/settings.json" "deploy@${AGENTS_IP}:~/.claude/"
  scp "$SCRIPT_DIR/claude/mcp.json" "deploy@${AGENTS_IP}:~/dev-panel/.mcp.json"
  echo "Agent configs deployed. Don't forget env vars on the server."
}

# ─��─ Main ───────────────────────────────────────────────────
case "${1:-help}" in
  status)   status ;;
  stop)     stop_nodes ;;
  start)    start_nodes ;;
  restart)  restart_nodes ;;
  create)   create_infra ;;
  destroy)  destroy_infra ;;
  ssh)      ssh_node "${2:-}" ;;
  deploy)   deploy_configs ;;
  *)
    echo "Usage: $0 {status|stop|start|restart|create|destroy|ssh|deploy}"
    echo ""
    echo "  status   — Show nodes status"
    echo "  stop     — Power off both nodes"
    echo "  start    — Power on both nodes"
    echo "  restart  — Reboot both nodes"
    echo "  create   — Provision from scratch"
    echo "  destroy  — Delete everything (destructive!)"
    echo "  ssh      — SSH into a node (services|agents)"
    echo "  deploy   — Push configs to both nodes"
    ;;
esac
