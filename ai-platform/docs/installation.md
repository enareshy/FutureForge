# Installation

## Prerequisites

| Requirement | Version used | Notes |
|---|---|---|
| OS | Debian 12 (bookworm), x86_64 | Firecracker microVM in this environment |
| Node.js | 22.x | existing enterprise backend |
| Python | 3.11+ | AI service layer |
| PostgreSQL | 15.19 | shared enterprise database |
| pgvector | 0.8.0 | compiled into the PostgreSQL instance |
| Docker Engine | 20.10+ | container runtime |
| Docker Compose | v2.29+ | plugin |

In this environment Docker is installed but the host has **no systemd**, so the
daemon is started explicitly by `scripts/docker-daemon.sh` (or `make daemon`).

## PostgreSQL + pgvector

The platform reuses the existing PostgreSQL cluster (port 5432). pgvector is
not packaged for Debian 12, so it is built from source:

```bash
# Build dependencies
apt-get update
apt-get install -y postgresql-server-dev-15 build-essential

# Build and install pgvector against the running PostgreSQL 15
git clone --depth 1 --branch v0.8.0 https://github.com/pgvector/pgvector.git
cd pgvector
make PG_CONFIG=/usr/lib/postgresql/15/bin/pg_config
make install PG_CONFIG=/usr/lib/postgresql/15/bin/pg_config

# Enable pgvector for the database owner.
# pgvector ships untrusted; mark it trusted so the non-superuser database
# owner can install it (the standard PostgreSQL mechanism):
echo "trusted = true" >> /usr/share/postgresql/15/extension/vector.control
```

The extension itself is created by migration `0001_init.sql` via
`make migrate`, which runs as the `helix` database owner.

Verify:

```bash
PGPASSWORD=helix psql -h 127.0.0.1 -U helix -d helix \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" \
  -c "SELECT extversion FROM pg_extension WHERE extname='vector';" \
  -c "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance;"
```

> If you prefer not to modify the shared cluster, run a dedicated
> `pgvector/pgvector:pg16` container and point `POSTGRES_*` at it. This is
> documented as an option, not the default, to keep a single database and
> avoid duplicate infrastructure.

## Docker daemon

```bash
make daemon            # or ./scripts/docker-daemon.sh
docker info            # storage=overlay2, cgroup=cgroupfs/2
```

If Compose is missing (`docker: 'compose' is not a docker command`), install
the plugin:

```bash
mkdir -p /usr/local/lib/docker/cli-plugins
curl -sSL https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version
```

## Bootstrap

```bash
make setup
```

or step by step:

```bash
make env        # .env.example -> .env
make daemon     # start dockerd
make up         # docker compose up -d (lean profile)
make migrate    # apply migrations to the `ai` schema
make health     # pgvector + schema + containers
```

## Extra profiles

```bash
# Observability stack
PROFILES=observability ./scripts/up.sh

# Search + events
PROFILES=search,events ./scripts/up.sh

# LLM tracing (requires >= 4 GiB RAM)
PROFILES=llmops ./scripts/up.sh
```

## Resource constraints

The environment has 2 vCPU and ~1 GiB free RAM. The lean profile (Redis +
SeaweedFS) fits comfortably. OpenSearch, Kafka and the Langfuse stack are
profile-gated because they each need ~1 GiB or more; run them on a larger host
or one profile at a time.

## Reset

```bash
# Stop containers but keep persistent volumes (recommended)
make down

# Stop and remove volumes (destroys local container data) — explicit opt-in
./scripts/down.sh --volumes
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Cannot connect to the Docker daemon` | run `make daemon` |
| `docker: 'compose' is not a docker command` | install the Compose plugin (above) |
| `permission denied to create extension "vector"` | add `trusted = true` to `vector.control`, or install as a superuser |
| `extension "vector" is not available` | pgvector was not built/installed into PG 15 |
| Port already in use | the enterprise app uses 3001/5173; AI ports are in `.env` |
| Container killed (OOM) | heavy profiles need more RAM; use the lean profile |
