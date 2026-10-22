# BuildX

**An autonomous AI coding agent.** Give it a task in plain language — it spins up an isolated microVM, writes code, runs tests, iterates, and streams everything live to your dashboard.

> Think: Devin / Jules / Copilot Agent, but self-hosted on Cloudflare.

---

## What it does

1. You describe a task (bug fix, feature, refactor).
2. BuildX dispatches it to a Cloudflare Queue.
3. A Worker picks it up, spins up an **Upstash Box** microVM, and runs the AI agent loop.
4. The agent writes code, runs shell commands, executes tests, and debugs — all inside the isolated sandbox.
5. Every step streams to the dashboard in real time via SSE. Browser disconnection does not stop execution.
6. Results land in Neon PostgreSQL; artifacts in Cloudflare R2 (or MinIO locally).

---

## Architecture

```
Browser
  │  POST /api/runs        GET /api/runs/:id/stream (SSE, resumable)
  ▼                        ▲
Cloudflare Workers (Next.js 16 App Router via @opennextjs/cloudflare)
  │                        │
  ├─ Cloudflare Queues ────┘   async dispatch, dead-letter queue
  │
  ├─ Neon PostgreSQL           authoritative state: users, runs, events,
  │                            quotas, leases, transactional outbox
  │
  ├─ Cloudflare R2             large artifacts, snapshots, build logs
  │   (local dev: MinIO via docker compose)
  │
  ├─ Cloudflare KV             disposable cache only (TTL ≥ 60 s)
  │
  └─ Upstash Box ──────────── sole production sandbox (isolated microVM)
                   shell, file ops, builds, tests, cancellation
```

| Layer | Service |
|---|---|
| Compute & routing | Cloudflare Workers (`@opennextjs/cloudflare`) |
| Async job dispatch | Cloudflare Queues + Dead-Letter Queue |
| Transactional state | Neon PostgreSQL (Drizzle ORM, `@neondatabase/serverless`) |
| Sandbox execution | Upstash Box (microVM, isolated per run) |
| Artifact storage | Cloudflare R2 (production); MinIO (local dev) |
| Disposable cache | Cloudflare KV |
| Live event stream | SSE — `Last-Event-ID` replay, 15 s heartbeats, 64 KB bounds |

---

## Monorepo structure

```
buildx/
├ apps/
│   └── web/                     Next.js 16 dashboard + API + Worker entry
│       ├── app/api/             REST + SSE endpoints
│       ├── lib/
│       │   ├── queue/           Queue producer & idempotent consumer
│       │   ├── cloudflare/      Typed bindings, KV cache helper
│       │   ├── run-creation.ts  Atomic quota + outbox + queue dispatch
│       │   └── sandbox.ts       Sandbox resolver (Box only in production)
│       ├── worker/index.ts      Custom Worker entry (HTTP + Queue consumer)
│       └── wrangler.jsonc       Wrangler bindings & resource config
│
├ packages/
│   ├── agent/                   AI agent loop (AI SDK 7, tool harness, skills, MCP)
│   ├── db/                      Drizzle schema, transitions, outbox, leases, auth
│   ├── sandbox/                 Sandbox interface + BoxSandbox (Upstash Box)
│   ├── shared/                  RunEvent model, Zod schemas, loadEnv()
│   └── storage/                 Storage interface (R2/MinIO), presign ops
│
├ scripts/
│   └── init-storage.ts          Idempotent CreateBucket for buildx-workspaces
│
├ infra/
│   └── docker-compose.yml       Postgres + MinIO + LiteLLM for local dev
│
├ CLOUDFLARE_DEPLOYMENT.md     Full ops guide (provision → deploy → rollback)
└── .env.example                 All environment variables with descriptions
```

---

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | 20+ |
| pnpm | 12 |
| Wrangler CLI | `pnpm --filter @buildx/web exec wrangler --version` |
| Cloudflare account | Workers, Queues, R2, KV enabled |
| Neon account | PostgreSQL project + pooled connection string |
| Upstash account | Box API key |
| Docker | for local dev (Postgres, MinIO, LiteLLM) |

---

## Local development

```bash
# 1. Clone and install
git clone https://github.com/Mahadi-rsio/buildx
cd buildx
pnpm install

# 2. Copy and fill in environment variables
cp .env.example apps/web/.env.local
# Edit apps/web/.env.local — at minimum:
#   DATABASE_URL, LITELLM_API_KEY, UPSTASH_BOX_API_KEY, BETTER_AUTH_SECRET

# 3. Start the infra (Postgres + MinIO + LiteLLM)
pnpm infra:up
# → Postgres on 127.0.0.1:5432
# → MinIO on 127.0.0.1:9000 (API) / 9001 (console)
# → LiteLLM proxy on 127.0.0.1:4000

# 4. Run database migrations
pnpm --filter @buildx/db exec drizzle-king push
# or: pnpm --filter @buildx/db migrate

# 5. Initialize storage buckets
pnpm storage:init

# 6. Start the dev server
pnpm dev
# → http://localhost:3000
```

> **Sandbox**: every run executes in Upstash Box. There is no local execution fallback, in development or production.

---

## Key environment variables

See [` .env.example`](.env.example) for the full annotated list.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon PostgreSQL pooled connection string |
| `UPSTASH_BOX_API_KEY` | ✅ | Upstash Box API key (the only sandbox backend) |
| `LITELLM_API_KEY` | ✅ | App-scoped LiteLLM virtual key |
| `BETTER_AUTH_SECRET` | ✅ | Auth secret — `openssl rand -base64 32` |
| `LITELLM_BASE_URL` | | LiteLLM proxy base URL, default `http://localhost:4000/v1` |
| `OPENROUTER_API_KEY` | | Enables the full OpenRouter catalog in the picker |
| `AGENT_MODEL` | | Model ID, default `auto` (LiteLLM) |
| `AGENT_MAX_STEPS` | | Max agent loop steps, default `40` |

Cloudflare bindings (`BUILDX_QUEUE`, `BUILDX_KV`, `BUILDX_R2`) are provided automatically by Wrangler — they are **not** environment variables.

---

## Running tests, lint, typecheck

```bash
pnpm typecheck   # tsc across all packages
pnpm lint        # ESLint across all packages
pnpm test        # node:test across all packages (agent test uses in-process mock server)
```

Tests for the Cloudflare migration (concurrency, outbox, quota, SSE replay, cancellation, leases) live in [`apps/web/lib/cloudflare-migration.test.ts`](apps/web/lib/cloudflare-migration.test.ts).

---

## Deploying to Cloudflare Workers

> **Full step-by-step instructions, secrets setup, and rollback procedures:** [`CLOUDFLARE_DEPLOYMENT.md`](CLOUDFLARE_DEPLOYMENT.md)

### Quick reference

```bash
# 1. Provision Cloudflare resources (one-time)
pnpm --filter @buildx/web exec wrangler queues create buildx-runs
pnpm --filter @buildx/web exec wrangler queues create buildx-runs-dlq
pnpm --filter @buildx/web exec wrangler r2 bucket create buildx-artifacts
pnpm --filter @buildx/web exec wrangler kv namespace create buildx-cache-kv

# 2. Set production secrets
pnpm --filter @buildx/web exec wrangler secret put DATABASE_URL
pnpm --filter @buildx/web exec wrangler secret put UPSTASH_BOX_API_KEY
pnpm --filter @buildx/web exec wrangler secret put LITELLM_API_KEY
pnpm --filter @buildx/web exec wrangler secret put BETTER_AUTH_SECRET

# 3. Build Worker bundle
pnpm --filter @buildx/web build:worker

# 4. Dry-run (verify bindings, no traffic)
pnpm --filter @buildx/web exec wrangler deploy --dry-run

# 5. Deploy
pnpm --filter @buildx/web deploy
```

### Rollback

```bash
# List recent deployments
pnpm --filter @buildx/web exec wrangler deployments list

# Roll back to a previous deployment
pnpm --filter @buildx/web exec wrangler rollback <deployment-id>
```

---

## API reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/config` | Check agent config / API key status |
| `POST` | `/api/runs` | Create a new run (atomic quota + queue dispatch) |
| `GET` | `/api/runs` | List runs |
| `GET` | `/api/runs/:id` | Get run details |
| `GET` | `/api/runs/:id/stream` | SSE event stream (supports `Last-Event-ID`) |
| `POST` | `/api/runs/:id/stop` | Request cancellation |
| `GET` | `/api/workspaces/:id/files` | Browse workspace files |
| `GET` | `/api/artifacts/[...key]` | Serve R2 artifacts (ownership checked) |

---

## Correctness safeguards

- **Atomic quota reservation**: quota, run record, and outbox row are written in a single transaction.
- **Transactional outbox**: if Queue publish fails, the outbox row drives reconciliation on the next attempt.
- **Lease fencing**: workers that lose their lease cannot mutate run state (`claimRunById` checks `lease_token`).
- **Idempotent consumers**: duplicate Queue deliveries are detected by `run_id` and skip re-execution.
- **Dead-letter queue**: exhausted retries land in `buildx-runs-dlq` for inspection without data loss.
- **SSE replay**: clients reconnect with `Last-Event-ID`; events are replayed from Neon from that point forward.
- **Remote cancellation**: Box execution is cancelled via the Upstash Box API independently of DB lease expiry.
- **Browser disconnect safety**: SSE streams are decoupled from execution — the agent loop runs to completion regardless.

---

## Tech stack

| Category | Technology |
|---|---|
| Framework | Next.js 16.4 (App Router) |
| Runtime | Cloudflare Workers (`@opennextjs/cloudflare`) |
| AI harness | AI SDK 7 (`ai@7`, `@ai-sdk/openai`) |
| Database ORM | Drizzle ORM |
| Database | Neon PostgreSQL (`@neondatabase/serverless`) |
| Sandbox | Upstash Box |
| Auth | Better Auth |
| Package manager | pnpm 12 (monorepo) |
| Language | TypeScript 5 |

---

## Contributing

1. Fork and branch from `master`.
2. Run `pnpm typecheck && pnpm lint && pnpm test` — all must pass.
3. Open a pull request with a description of the change.

---

## License

MIT