#!/bin/bash
#
# deploy.sh - Production deployment script for portfolio 2.0
#
# Usage:
#   cd /path/to/repo
#   bash infra/deploy.sh
#
# This script is idempotent and designed to run repeatedly without side effects.
# It assumes:
#   - You are in the repo root
#   - .env file exists with production credentials (DOMAIN, POSTGRES_PASSWORD, etc.)
#   - Docker and docker compose are installed
#
# On failure, exits with code 1 and prints the error to stderr.

set -euo pipefail

# Colors for output (optional; works on most terminals)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/infra/docker-compose.yml"
SCHEMA_FILE="${REPO_ROOT}/web/src/lib/db/schema.sql"
MIGRATION_CONTAINER="portfolio2_postgres_1" # May need adjustment based on your docker compose project name
COMPOSE_PROJECT="portfolio2"

echo -e "${GREEN}[deploy.sh] Starting deployment${NC}"

# Error handler
cleanup_on_error() {
  local line_num=$1
  echo -e "${RED}[deploy.sh] ERROR at line ${line_num}${NC}" >&2
  exit 1
}
trap 'cleanup_on_error ${LINENO}' ERR

# Step 1: Pull latest changes (if in a git repo)
if [ -d "${REPO_ROOT}/.git" ]; then
  echo -e "${YELLOW}[deploy.sh] Pulling latest changes...${NC}"
  cd "${REPO_ROOT}"
  git pull origin HEAD
else
  echo -e "${YELLOW}[deploy.sh] Not a git repository; skipping pull${NC}"
fi

# Step 2: Build the stack
echo -e "${YELLOW}[deploy.sh] Building Docker images...${NC}"
cd "${REPO_ROOT}"
docker compose -f "${COMPOSE_FILE}" build --pull

# Step 3: Start the stack
echo -e "${YELLOW}[deploy.sh] Starting services...${NC}"
cd "${REPO_ROOT}"
docker compose -f "${COMPOSE_FILE}" up -d

# Step 4: Wait for Postgres to be healthy
echo -e "${YELLOW}[deploy.sh] Waiting for Postgres to be healthy...${NC}"
for i in {1..30}; do
  if docker compose -f "${COMPOSE_FILE}" exec -T postgres pg_isready -U "${POSTGRES_USER:-postgres}" >/dev/null 2>&1; then
    echo -e "${GREEN}[deploy.sh] Postgres is healthy${NC}"
    break
  fi
  if [ $i -eq 30 ]; then
    echo -e "${RED}[deploy.sh] Postgres health check failed after 30 attempts${NC}" >&2
    exit 1
  fi
  echo -e "${YELLOW}[deploy.sh] Waiting for Postgres... (${i}/30)${NC}"
  sleep 1
done

# Step 5: Run database migrations if schema.sql exists
if [ -f "${SCHEMA_FILE}" ]; then
  echo -e "${YELLOW}[deploy.sh] Running database migrations from ${SCHEMA_FILE}...${NC}"

  # Read the schema file and execute it in postgres container
  docker compose -f "${COMPOSE_FILE}" exec -T postgres psql \
    -U "${POSTGRES_USER:-postgres}" \
    -d "${POSTGRES_DB:-portfolio}" \
    -f /dev/stdin < "${SCHEMA_FILE}"

  echo -e "${GREEN}[deploy.sh] Database migrations completed${NC}"
else
  echo -e "${YELLOW}[deploy.sh] Schema file not found at ${SCHEMA_FILE}; skipping migrations${NC}"
fi

# Step 6: Wait for app to be healthy
echo -e "${YELLOW}[deploy.sh] Waiting for app to be healthy...${NC}"
for i in {1..30}; do
  if docker compose -f "${COMPOSE_FILE}" exec -T web sh -c 'wget --quiet --tries=1 --spider http://localhost:'"${PORT:-3000}"' || curl -sf http://localhost:'"${PORT:-3000}"' >/dev/null' 2>/dev/null; then
    echo -e "${GREEN}[deploy.sh] App is healthy${NC}"
    break
  fi
  if [ $i -eq 30 ]; then
    echo -e "${RED}[deploy.sh] App health check failed after 30 attempts${NC}" >&2
    exit 1
  fi
  echo -e "${YELLOW}[deploy.sh] Waiting for app... (${i}/30)${NC}"
  sleep 1
done

# Step 7: Restart stack to ensure clean state
echo -e "${YELLOW}[deploy.sh] Restarting stack...${NC}"
cd "${REPO_ROOT}"
docker compose -f "${COMPOSE_FILE}" restart

# Final wait for all services
echo -e "${YELLOW}[deploy.sh] Waiting for all services to be healthy...${NC}"
sleep 3

# Verify all services are running
echo -e "${YELLOW}[deploy.sh] Verifying all services...${NC}"
cd "${REPO_ROOT}"
docker compose -f "${COMPOSE_FILE}" ps

echo -e "${GREEN}[deploy.sh] Deployment completed successfully!${NC}"
echo -e "${GREEN}[deploy.sh] Stack is running. Check status with: docker compose -f ${COMPOSE_FILE} ps${NC}"
echo -e "${GREEN}[deploy.sh] View logs with: docker compose -f ${COMPOSE_FILE} logs -f${NC}"
