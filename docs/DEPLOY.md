# Deployment Runbook

This guide walks a person with a VPS and domain through taking the portfolio site live. Read all sections relevant to your situation before executing commands.

## Prerequisites

You need:
1. A VPS with Docker and Docker Compose installed (Ubuntu 22.04 LTS recommended)
2. A domain name you control
3. SSH access to the VPS
4. 2+ GB RAM and 10 GB free disk space

### Install Docker and Docker Compose (Ubuntu/Debian)

If your VPS doesn't have Docker installed:

```bash
# Update package manager
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add your user to the docker group (optional; lets you run docker without sudo)
sudo usermod -aG docker $USER
newgrp docker

# Verify installation
docker --version
docker compose version
```

## Local Development (Before Deploying)

**This step is optional for the person buying a VPS, but critical for the development team.**

Test the stack locally before deployment to catch issues early:

```bash
# Navigate to repo root
cd /path/to/portfolio2.0

# Copy the example environment file
cp infra/.env.example infra/.env

# Start the stack (this pulls and builds images; first run takes 2-3 minutes)
docker compose -f infra/docker-compose.yml up

# Wait for all services to start (look for "web" showing as healthy)
# Open http://localhost in your browser

# When done, stop the stack
docker compose -f infra/docker-compose.yml down
```

## Preparing the VPS

### 1. Clone the Repository

SSH into your VPS and clone the repo:

```bash
ssh user@your.vps.ip

# Clone the repo
git clone https://github.com/yourusername/portfolio2.0.git
cd portfolio2.0

# If the repo is private, use SSH keys (configure on GitHub first):
# git clone git@github.com:yourusername/portfolio2.0.git
```

### 2. Configure DNS Records

Before deploying, point your domain to the VPS. Add these DNS records at your registrar:

- **A record**: `@` (or your root domain) → `<VPS_IP_ADDRESS>`
- **CNAME record** (optional, for www subdomain): `www` → `@`

Wait 5-15 minutes for DNS to propagate. Test:

```bash
nslookup your-domain.com
# Should return your VPS IP
```

**Important:** TLS certificate provisioning requires a valid, resolvable domain. The stack will fail if DNS doesn't resolve yet.

### 3. Set Up Environment Variables

Create a `.env` file in `infra/` with production credentials:

```bash
cd portfolio2.0

# Copy the example
cp infra/.env.example infra/.env

# Edit with your production values
nano infra/.env
```

Edit these fields in `infra/.env`:

```bash
# MUST CHANGE FOR PRODUCTION
DOMAIN=your-domain.com

# MUST CHANGE FOR PRODUCTION: Use strong, random passwords
POSTGRES_USER=portfolio_user
POSTGRES_PASSWORD=$(openssl rand -base64 32)  # Generate this
POSTGRES_DB=portfolio

# Optional: Change if you want a different app port
PORT=3000
```

**Security note:** The `.env` file contains database passwords. Protect it:

```bash
chmod 600 infra/.env
```

### 4. Make the Deploy Script Executable

```bash
chmod +x infra/deploy.sh
```

## First Deployment

### Step 1: Run the Deployment Script

```bash
cd /path/to/portfolio2.0

# Source environment variables
set -a
source infra/.env
set +a

# Run the deployment script
bash infra/deploy.sh
```

The script will:
1. Pull latest code (if git)
2. Build Docker images
3. Start postgres, caddy, and web services
4. Wait for postgres to be ready
5. Run database migrations (if schema exists)
6. Wait for the app to respond
7. Display the status of all services

### Step 2: Verify the Deployment

```bash
# Check service status
docker compose -f infra/docker-compose.yml ps

# All services should show "Up" status

# View logs to confirm everything started correctly
docker compose -f infra/docker-compose.yml logs

# Test HTTPS (if domain is configured)
curl -I https://your-domain.com

# Test HTTP redirect
curl -I http://your-domain.com
# Should respond with 301 redirect to HTTPS
```

Open your domain in a browser. The site should load over HTTPS.

### Step 3: Verify TLS Certificate

```bash
# Check certificate details
echo | openssl s_client -servername your-domain.com -connect your-domain.com:443 2>/dev/null | \
  openssl x509 -noout -text | grep -A2 "Validity\|Subject:"

# Should show:
# - Subject includes your-domain.com
# - Validity dates are current and future
# - Issuer is Let's Encrypt (or your ACME provider)
```

## Managing the Stack

### View Logs

```bash
cd /path/to/portfolio2.0

# All services
docker compose -f infra/docker-compose.yml logs -f

# Specific service
docker compose -f infra/docker-compose.yml logs -f web
docker compose -f infra/docker-compose.yml logs -f postgres
docker compose -f infra/docker-compose.yml logs -f caddy

# Last 50 lines
docker compose -f infra/docker-compose.yml logs --tail=50
```

### Stop/Start the Stack

```bash
# Stop all services (data persists)
docker compose -f infra/docker-compose.yml stop

# Start again
docker compose -f infra/docker-compose.yml start

# Restart a single service
docker compose -f infra/docker-compose.yml restart web
```

### Restart After VPS Reboot

The stack is configured with `restart: unless-stopped`, so it automatically starts after reboot. To verify:

```bash
docker compose -f infra/docker-compose.yml ps
```

### Execute Commands Inside Containers

```bash
# Run a command in the web container
docker compose -f infra/docker-compose.yml exec web sh

# Access the Postgres CLI
docker compose -f infra/docker-compose.yml exec postgres psql \
  -U your_postgres_user \
  -d portfolio

# Inside psql:
# \dt                 # List tables
# \l                  # List databases
# SELECT count(*) FROM game_log;  # Query data
# \q                  # Quit
```

## Database Management

### Backup the Database

```bash
cd /path/to/portfolio2.0

# Dump to a SQL file
docker compose -f infra/docker-compose.yml exec -T postgres pg_dump \
  -U your_postgres_user \
  -d portfolio > backup_$(date +%Y%m%d_%H%M%S).sql

# File is created in current directory (repo root)
```

### Restore from Backup

```bash
cd /path/to/portfolio2.0

# Restore from backup file
docker compose -f infra/docker-compose.yml exec -T postgres psql \
  -U your_postgres_user \
  -d portfolio < backup_20240101_120000.sql

# Restart web service to clear any connections
docker compose -f infra/docker-compose.yml restart web
```

### Inspect the Postgres Volume

Database files are stored in a Docker named volume (`postgres_data`). To see its location:

```bash
docker volume inspect portfolio2_0_postgres_data
# Returns JSON with "Mountpoint" path on the host
```

To back up the volume directly (advanced):

```bash
# Create a tar archive of the volume
docker run --rm -v portfolio2_0_postgres_data:/data -v $(pwd):/backup \
  alpine tar czf /backup/postgres_volume_backup.tar.gz -C / data

# Restore (warning: dangerous; stop postgres first)
docker compose -f infra/docker-compose.yml stop postgres
docker volume rm portfolio2_0_postgres_data
docker run --rm -v portfolio2_0_postgres_data:/data -v $(pwd):/backup \
  alpine tar xzf /backup/postgres_volume_backup.tar.gz -C /
```

## TLS Certificates

Caddy automatically provisions and renews TLS certificates using Let's Encrypt. No manual setup required.

### Certificate Storage

Certificates are stored in a Docker named volume:

```bash
# Inspect certificate storage location
docker volume inspect portfolio2_0_caddy_data
docker volume inspect portfolio2_0_caddy_config
```

### Force Certificate Renewal

If needed (rarely):

```bash
docker compose -f infra/docker-compose.yml exec caddy caddy reload --config /etc/caddy/Caddyfile
```

### Monitor Certificate Expiry

Let's Encrypt certificates expire after 90 days. Caddy renews them automatically 30 days before expiry. To confirm:

```bash
# Extract certificate expiry date
echo | openssl s_client -servername your-domain.com -connect your-domain.com:443 2>/dev/null | \
  openssl x509 -noout -dates
```

### Disable HTTPS (Emergency Only)

If TLS is broken and you need plain HTTP quickly:

```bash
# Temporarily set DOMAIN=localhost in infra/.env
nano infra/.env
# Change: DOMAIN=localhost

# Rebuild Caddy configuration
docker compose -f infra/docker-compose.yml up -d caddy

# Revert this as soon as DNS is fixed
```

## Troubleshooting

### Services Not Starting

```bash
# Check service logs
docker compose -f infra/docker-compose.yml logs -f

# Common issues:
# - Port 80/443 already in use: sudo lsof -i :80 (look for conflicting processes)
# - Not enough disk space: df -h
# - Database password mismatch in .env: grep DATABASE_URL infra/.env
```

### Database Connection Errors

```bash
# Verify postgres is running and healthy
docker compose -f infra/docker-compose.yml ps

# Check postgres logs
docker compose -f infra/docker-compose.yml logs postgres

# Verify DATABASE_URL is correct
docker compose -f infra/docker-compose.yml exec web env | grep DATABASE_URL
```

### HTTPS Certificate Not Provisioning

```bash
# Check DNS resolution
nslookup your-domain.com

# Check Caddy logs for ACME errors
docker compose -f infra/docker-compose.yml logs caddy | grep -i acme

# If stuck, temporarily revert to localhost to test
DOMAIN=localhost docker compose -f infra/docker-compose.yml up -d caddy
# Then fix and re-deploy
```

### Port Already in Use

```bash
# Check what's using port 80 or 443
sudo lsof -i :80
sudo lsof -i :443

# Stop conflicting service or change docker compose ports
nano infra/docker-compose.yml
# Modify caddy ports section if needed
```

### App Container Crashes

```bash
# Check web service logs
docker compose -f infra/docker-compose.yml logs web

# Rebuild (clears any cached issues)
docker compose -f infra/docker-compose.yml build --no-cache web
docker compose -f infra/docker-compose.yml up -d
```

## Rolling Back a Deployment

If a deployment breaks the site:

### Option 1: Restart Previous Image (Quick)

```bash
cd /path/to/portfolio2.0

# Docker keeps the last few images; restart the previous one
docker compose -f infra/docker-compose.yml down
git checkout HEAD~1  # Go back one commit (requires git)
docker compose -f infra/docker-compose.yml up -d
```

### Option 2: Restore Database from Backup

```bash
cd /path/to/portfolio2.0

# If only data is corrupted, restore postgres
docker compose -f infra/docker-compose.yml exec -T postgres psql \
  -U your_postgres_user \
  -d portfolio < backup_20240101_120000.sql

docker compose -f infra/docker-compose.yml restart web
```

### Option 3: Full Rollback

```bash
cd /path/to/portfolio2.0

# Stop everything
docker compose -f infra/docker-compose.yml down

# Remove app images (not data)
docker rmi portfolio2_0_web:latest  # Adjust project name if different

# Revert code
git checkout HEAD~1

# Redeploy
bash infra/deploy.sh
```

## Updates and Maintenance

### Deploy a Code Change

```bash
cd /path/to/portfolio2.0

# Pull latest code
git pull

# Redeploy (idempotent; safe to run anytime)
bash infra/deploy.sh
```

### Update Docker Base Images

```bash
# Rebuild to pick up latest node and postgres patches
docker compose -f infra/docker-compose.yml build --pull
docker compose -f infra/docker-compose.yml up -d
```

### Prune Old Docker Images and Volumes

```bash
# WARNING: This frees disk space but cannot be undone

# Remove unused images
docker image prune -a --force

# Remove unused volumes
docker volume prune --force
```

## Monitoring and Logs (Production)

For a production system, consider:

- **Log aggregation**: Pipe container logs to an external service (e.g., CloudWatch, Papertrail, ELK)
- **Uptime monitoring**: Set up a health check endpoint (e.g., UptimeRobot polling `https://your-domain.com`)
- **Database backups**: Automate daily backups with cron:

```bash
# Add to crontab: crontab -e
0 2 * * * cd /path/to/portfolio2.0 && docker compose -f infra/docker-compose.yml exec -T postgres pg_dump -U your_postgres_user -d portfolio | gzip > /backups/portfolio_$(date +\%Y\%m\%d).sql.gz
```

## Support

For issues:
1. Check the logs: `docker compose -f infra/docker-compose.yml logs -f`
2. Verify DNS resolution: `nslookup your-domain.com`
3. Test HTTPS: `curl -Iv https://your-domain.com`
4. Check port availability: `sudo lsof -i :80 -i :443`
5. Review `.env` file for typos (password, domain name, usernames)

If the stack still won't start, provide the output of:

```bash
docker compose -f infra/docker-compose.yml logs
docker compose -f infra/docker-compose.yml ps
```
