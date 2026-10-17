# BuildX Cloudflare Workers Deployment Guide

This guide documents the architecture, resource provisioning, secrets configuration, deployment commands, and rollback procedures for deploying BuildX on **Cloudflare Workers**.

---

## 1. Architecture Overview

- **Compute & Routing**: Next.js 16 App Router on Cloudflare Workers using `@opennextjs/cloudflare`.
- **Job Dispatch**: Cloudflare Queues (`buildx-runs`) with Dead-Letter Queue (`buildx-runs-dlq`).
- **Transactional State & Authoritative Source**: Neon PostgreSQL (`DATABASE_URL`).
  - Users, projects, runs, append-only events, quotas, leases, and transactional outbox.
  - Connected via `@neondatabase/serverless` (WebSocket driver in Workers) or Cloudflare Hyperdrive.
- **MicroVM Execution**: Upstash Box (`UPSTASH_BOX_API_KEY`).
  - **The sole sandbox in production**. Local filesystem/shell execution is strictly forbidden in production environments.
  - Remote Box processes are isolated per workspace and can be explicitly cancelled/paused decoupled from database leases.
- **Large Objects & Artifacts**: Cloudflare R2 (`buildx-artifacts`).
  - Bounded storage for snapshots, test logs, and build artifacts.
  - Protected with strict authorization checks based on user/run ownership.
- **Transient Cache**: Cloudflare KV (`buildx-cache-kv`).
  - Disposable cache data only (minimum TTL: 60s). Authoritative data is never stored in KV.
- **Live Event Streaming**: Server-Sent Events (SSE) via `/api/runs/[id]/stream`.
  - Reconnectable with `Last-Event-ID`, 15-second heartbeats (`: ping\n\n`) to prevent Cloudflare edge timeouts, bounded payloads (64KB max), and decoupling from client connection lifecycles.

---

## 2. Prerequisites & CLI Tools

Ensure you have authenticated with Cloudflare and have `pnpm` installed:

```bash
# Verify Wrangler authentication
pnpm --filter @buildx/web exec wrangler whoami
```

---

## 3. Provisioning Cloudflare Resources

Run the following commands once to set up the required Cloudflare resources:

### A. Cloudflare Queues
```bash
# Primary queue for run execution jobs
pnpm --filter @buildx/web exec wrangler queues create buildx-runs

# Dead-letter queue for exhausted retries
pnpm --filter @buildx/web exec wrangler queues create buildx-runs-dlq
```

### B. Cloudflare R2 Bucket
```bash
pnpm --filter @buildx/web exec wrangler r2 bucket create buildx-artifacts
```

### C. Cloudflare KV Namespace
```bash
# Create production KV namespace
pnpm --filter @buildx/web exec wrangler kv namespace create buildx-cache-kv

# Create preview/development KV namespace (optional)
pnpm --filter @buildx/web exec wrangler kv namespace create buildx-cache-kv --preview
```
*Note: Copy the returned `id` and `preview_id` into `apps/web/wrangler.jsonc` under `kv_namespaces` if you customize them.*

### D. (Optional) Cloudflare Hyperdrive for Neon
If you wish to use Hyperdrive for connection pooling and acceleration between Cloudflare edge nodes and Neon PostgreSQL:
```bash
pnpm --filter @buildx/web exec wrangler hyperdrive create buildx-neon-hyperdrive \
  --connection-string="postgresql://neondb_owner:<password>@<neon-host>/neondb?sslmode=require"
```
*Copy the returned Hyperdrive `id` into `apps/web/wrangler.jsonc` under `hyperdrive`.*

---

## 4. Configuring Production Secrets

Production secrets must never be committed to source control. Set them directly via Wrangler:

```bash
cd apps/web

# 1. Authoritative Neon PostgreSQL Connection String
pnpm exec wrangler secret put DATABASE_URL
# Enter: postgresql://neondb_owner:<password>@<neon-host>/neondb?sslmode=require

# 2. Upstash Box API Key (Mandatory for production microVM sandbox)
pnpm exec wrangler secret put UPSTASH_BOX_API_KEY
# Enter your Upstash Box token

# 3. OpenAI / AI SDK API Key
pnpm exec wrangler secret put OPENAI_API_KEY
# Enter your OpenAI/compatible API key

# 4. Better Auth Secret
pnpm exec wrangler secret put BETTER_AUTH_SECRET
# Enter: generated via `openssl rand -base64 32`
```

---

## 5. Applying Database Migrations to Neon

Before deploying the Worker, ensure the Neon PostgreSQL schema is up to date:

```bash
DATABASE_URL="postgresql://neondb_owner:<password>@<neon-host>/neondb?sslmode=require" \
pnpm --filter @buildx/db migrate
```

---

## 6. Build & Deployment Commands

### Build Cloudflare Worker Bundle
Run OpenNext Cloudflare builder to compile Next.js 16 and transform it into the Cloudflare Worker bundle (`apps/web/.open-next/worker.js` and `assets`):

```bash
pnpm --filter @buildx/web build:worker
```

### Dry Run (Verify configuration & bundle)
```bash
cd apps/web
pnpm exec wrangler deploy --dry-run
```

### Deploy to Production
```bash
cd apps/web
pnpm exec wrangler deploy
```

Or from repo root:
```bash
pnpm --filter @buildx/web run deploy
```

---

## 7. Rollback Guidance

If a bad deployment is detected, Cloudflare Workers supports instantaneous atomic rollbacks:

### View Deployment History
```bash
cd apps/web
pnpm exec wrangler deployments list
```

### Roll Back to Previous Deployment
```bash
cd apps/web
# Roll back to the previous deployment version:
pnpm exec wrangler rollback

# Or roll back to a specific version ID:
pnpm exec wrangler rollback <deployment-version-id>
```

---

## 8. Verifications & Correctness Safeguards

- **Transactional Outbox**: Every run is created inside an atomic Neon transaction that simultaneously decrements the user's daily quota and writes an `outbox` row. If queue dispatch fails, the outbox reconciler (`reconcileOutbox`) re-dispatches pending messages.
- **Lease Fencing & Atomic Claiming**: Workers claim runs via `claimRunById` which atomically verifies user concurrency limits (`runs_one_active_per_user_idx`) and sets a fencing lease token (`lease_id`). If a lease expires, the old worker is fenced from emitting events or writing to the database.
- **Decoupled Remote Box Cancellation**: Cancelling a run flags the DB and immediately issues an API call to pause/suspend the Upstash Box instance (`cancelRemoteBoxExecution`), ensuring microVM execution stops even if background lease checks take time.
- **No Local Execution**: `LocalSandbox` explicitly throws an error in production environments (`NODE_ENV === "production"` or `OPENNEXT_CLOUDFLARE === "true"`).
- **SSE Reliability**: Streams send keepalive pings every 15s to keep connections alive on Cloudflare edge networks, use `Last-Event-ID` for client reconnect/replay, cap message size to 64KB, and keep runs executing even if the browser disconnects.
