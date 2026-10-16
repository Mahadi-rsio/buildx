# Phase Plan — Auth + Local Postgres + Local MinIO + Fly.io Free-Tier Sandbox Lifecycle

> Source of truth for the current work stream. Supersedes the dated sections in `plan.md` while this
> stream is active. Stack decisions: **Better Auth + Drizzle ORM + PostgreSQL (Docker)** for data/auth,
> **MinIO (Docker)** for S3-compatible object storage, **Fly Machines** for the remote sandbox behind the
> existing `Sandbox` interface.

## Step 0 — Read first, then plan

Before writing any code:

1. Read the existing code and confirm paths (some may not exist yet):
   - `packages/sandbox/src/index.ts` (Sandbox interface), `packages/sandbox/src/daemon.ts` (DaemonSandbox)
   - `services/sandbox-daemon/server.mjs` (in-sandbox daemon)
   - `infra/fly-image/Dockerfile`
   - `apps/web/lib/sandbox.ts` (currently one global SANDBOX_BASE_URL/TOKEN)
   - `packages/db/` (create if missing; replace any Neon-specific code)
   - `arcetecture.md` / `plan.md` / `todo.md` (update at the end incl. Neon -> local Postgres + MinIO)
2. Read official docs: Better Auth, Drizzle ORM, AWS SDK v3 (S3 client + presigner), Fly Machines API.
3. Write this plan against the above (files, DB schema, risks, assumptions), then implement.
4. Any field/option that can't be confirmed in official docs gets isolated behind a small function with a
   `TODO(verify)` comment and is listed in the final report.

### Items to verify that are NOT confirmed (track all of these)

- Fly: `skip_launch` on machine create; volume delete-while-attached; Machines API rate limits; exact
  app-creation and IP-allocation request shapes.
- Better Auth: Drizzle adapter setup for provider `"pg"`; CLI command that generates the auth schema; the
  Next.js route handler helper; reading the session in server code; built-in rate-limiting option name;
  the email-verification flow.
- MinIO: which Docker image (see Part A1); a working healthcheck; path-style addressing requirements with
  the AWS SDK; presigned-URL behaviour with a separate public endpoint.

## Rules that apply to every phase

- Commit after each phase. Run `pnpm typecheck` and `pnpm test` after each phase.
- Every workspace/sandbox API route or server action calls `requireUser()` and checks ownership.
- Every status transition is one atomic conditional UPDATE (`WHERE status = <expected>`).
- DB writes happen BEFORE or IMMEDIATELY AFTER each Fly call (a crash never leaves a resource the DB can't see).
- Migration files are committed SQL from drizzle-kit. Never edit an applied migration; add new ones.
- No public IPs on workspace apps; Postgres and the MinIO console stay localhost-only; only the S3 API
  endpoint reaches the internet and only via TLS in production.
- Sandbox never receives credentials — only short-lived presigned URLs scoped to one key.

## Phase 1 — docker-compose (Postgres + MinIO) + Drizzle + migrations + storage:init

- `docker-compose.yml` at repo root: `postgres` (official pin, e.g. `postgres:17-alpine`, `pg_isready`
  healthcheck, port `127.0.0.1` only) and `minio` (image from `MINIO_IMAGE`, default `pgsty/minio` pinned
  tag, `server /data --console-address ":9001"`, ports `127.0.0.1:9000` / `127.0.0.1:9001`, root
  creds from env). Named volumes + healthchecks for both. Credentials never hardcoded.
- `.env.example`: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID`,
  `GITHUB_CLIENT_SECRET`, `SMTP_*`, `MINIO_IMAGE`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`,
  `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
  `S3_FORCE_PATH_STYLE=true`, `S3_BUCKET_WORKSPACES`, `S3_BUCKET_DB_BACKUPS`, `FLY_API_TOKEN`,
  `FLY_ORG_SLUG`. Real `.env` never committed (`.env` already gitignored).
- `scripts/init-storage.ts` (TypeScript, `@aws-sdk/client-s3`): idempotent CreateBucket for
  `buildx-workspaces` and `buildx-db-backups`. No `mc` client dependency.
- Drizzle wired to Postgres via `pg`/postgres.js with a connection pool; singleton `Pool` on `globalThis`
  in Next.js dev (hot-reload safe). `packages/db` becomes the only schema/queries home.
- Package scripts: `infra:up` (`docker compose up -d --wait`), `infra:down`, `db:generate`, `db:migrate`,
  `db:studio`, `storage:init`.
- Onboarding path works on a fresh clone: copy `.env.example` -> `pnpm install` -> `pnpm infra:up` ->
  `pnpm db:migrate` -> `pnpm storage:init`.
- Exit: typecheck + tests green; app boots against real Postgres + MinIO.

## Phase 2 — Storage module + tests

- One small S3 wrapper over `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, env-configured, provider-agnostic.
  - Two clients: internal client via `S3_ENDPOINT` (`head`/`copy`/`delete`/`list`); signing client via
    `S3_PUBLIC_ENDPOINT` (presigned PUT/GET handed to the sandbox).
  - Operations: `presignPut(key, expiresIn)`, `presignGet(key, expiresIn)`, `head(key)`, `copy(src, dst)`,
    `delete(key)`, `rotate(key)` (key -> key.prev), `list(prefix)`. Path-style addressing.
  - Presigned URLs: max 15 min, one key each; never hand root credentials to the sandbox.
  - Dev may use MinIO root credentials; production must use a dedicated service account restricted to the
    two buckets (documented).
- Verify a URL signed for the public host is accepted by MinIO (signed host must match the host the sandbox calls).
- Tests against REAL MinIO from docker compose (or testcontainers):
  - presigned PUT then GET round-trips a file; a presigned URL expires; a URL for key A cannot read key B.
- Exit: `pnpm test` green; same test suite runs against the configured endpoint.

## Phase 3 — Better Auth + protected dashboard + requireUser

- Better Auth wired to Drizzle (provider `"pg"`), same database. Generate auth tables with the Better Auth
  CLI and merge into the single `packages/db` schema so BuildX tables can FK to the auth user (match the
  id column type; do not assume).
- Login: email + password and GitHub OAuth. Email verification REQUIRED before workspace creation; in dev
  without SMTP, log the verification link to the server console.
- Mount auth route handler in Next.js. Helpers in `apps/web/lib/auth`: `getSession()` (server) and
  `requireUser()` (throws 401-style when unauthenticated). Every route/action touching projects, workspaces,
  runs, or sandboxes calls `requireUser()` + ownership check.
- Rate limiting on auth endpoints (verify option name); secure cookies in production.
- `BETTER_AUTH_SECRET`: strong random, required at startup (fail fast if missing).
- Pages: sign-in, sign-up, verify-email notice, protected dashboard layout (redirect unauthenticated to
  sign-in). Minimal shadcn UI.
- Exit: typecheck + tests green; unauthenticated requests to workspace/sandbox routes rejected; unverified
  user cannot create a workspace.

## Phase 4 — Core BuildX schema, transitions + quota functions

- Drizzle tables per `arcetecture.md`, plus: `workspaces`, `usage_sessions`, `daily_requests`.
  - `workspaces`: id, user_id, name, status, fly_app, fly_volume_id (nullable), fly_machine_id (nullable),
    region, daemon_token_encrypted, last_active_at, last_synced_at, backup_bytes, backup_sha256,
    image_digest, lockfile_hash, created_at, updated_at. `UNIQUE(user_id)` (one workspace per user).
  - Conventions: uuid PKs, created_at/updated_at timestamptz, FK to auth user, indexes on user_id and status.
- `db.transition(id, from, to)` -> boolean (single conditional UPDATE).
- Quota functions:
  - Monthly CPU-hours = closed `usage_sessions` + elapsed time of any open session (refuse restore when used up).
  - Daily counter: one atomic `INSERT ... ON CONFLICT (user_id, day) DO UPDATE SET count = count + 1 WHERE
    count < 30 RETURNING count`. Day boundary midnight Asia/Dhaka. Refund on server-side failure.
  - Per-request limits: max 25 steps, max 10 min, one active run per user.
  - Idle constant `FREE_IDLE_MINUTES = 5`.
- Test: daily counter never exceeds 30 under 100 concurrent requests.
- Exit: typecheck + tests green; migrations in place.

## Phase 5 — Daemon hardening + tests (`services/sandbox-daemon/server.mjs`)

- Fail closed if auth token missing (refuse start / reject every request).
- Per-workspace token via `POST /init` (only endpoint accepted before init), compared in constant time.
- Add `GET /health`, `POST /init` (token + restoreUrl: download + extract into /workspace),
  `POST /sync` (uploadUrl: create tar.zst archive, upload, return `{size, sha256}`), last-activity tracking.
- Per-command timeout, max output size, process-tree cleanup on timeout/cancel, path validation (nothing
  outside /workspace readable/writable).
- Archive format: tar.zst of /workspace excluding `node_modules`, `.next`, `.turbo`, `dist`, `.cache`,
  `.pnpm-store`, `.env*`. Hard cap 200 MB per backup (configurable), reject larger with clear user error.
- Update `infra/fly-image/Dockerfile`: Node, pnpm, git, zstd, tar, curl, pre-warmed pnpm store (next,
  react, tailwind). Pin image by digest in config.
- Tests: token required; path escapes blocked.
- Exit: typecheck + tests green.

## Phase 6 — fly-client (`packages/sandbox/src`)

- `fly-client.ts`: typed (zod) wrapper for apps, volumes, machines (create/start/stop/destroy/wait/get/list):
  - retry + exponential backoff on 429/5xx honouring `Retry-After`; concurrency limiter; TODO(verify) for
    `skip_launch`, volume-delete-while-attached, rate limits, app-creation/IP-allocation shapes.
- `fly-manager.ts`: `createWorkspaceApp`, `restore`, `archive`, `reconcile`. DB writes before/immediately
  after each Fly call.
- Machine config: shared-cpu-1x, 1 GB RAM + swap, volume mounted at /workspace, no public services, restart
  policy `no`. Any update uses the lease flow and sends the FULL config (replace, not merge).
- Workspace app: dedicated Fly app with private network (name = app name), NO public IP; verify app has none.
- Fake Fly client for tests.
- Exit: typecheck + tests green.

## Phase 7 — fly-manager archive/restore

- `createWorkspace(userId, name)`: verified email + no existing workspace. Insert row FIRST (status=creating),
  then create the Fly app (network name = app name, no public IP, no volume/machine yet), then status=archived
  with empty/initial backup.
- `ensureRunning(workspaceId)` (idempotent, called by every sandbox tool call):
  - running -> touch last_active_at.
  - archived -> transition restoring: check quotas -> create 1 GB volume (region `sin`, fallback region on
    capacity failure), write volume_id immediately -> create machine WITH volume mount, write machine_id
    immediately -> wait started -> poll daemon /health -> call /init with short-lived presigned restore URL +
    fresh per-workspace token -> install deps only if lockfile hash changed -> open usage session -> running.
  - restoring/archiving by another caller -> wait with timeout, then proceed.
- `archive` (reaper / quota exhaustion / user action): running -> archiving, then STRICT ORDER:
  a) daemon /sync -> temp key via presigned PUT; b) VERIFY upload (storage.head size == daemon-reported;
  store sha256); c) rotate key -> key.prev, tmp -> key (keep last 2); d) only now destroy machine (force),
  then delete volume; e) close usage session, clear machine_id/volume_id, -> archived.
  - Any of a–c fails: delete nothing, set archive_failed, retry w/ backoff up to 30 min, then alert.
    Never delete a volume before a verified backup exists.
  - Nothing changed since last backup -> skip upload, go straight to destroy.
  - New work arrives while archiving -> let archiving finish, then restore. Never cancel archiving.
- Tests: two concurrent `ensureRunning` calls create exactly one machine; archive never deletes anything when
  upload/verify fails (assert no destroy/delete calls); crash after volume-create-before-machine-create
  repaired by reconciler (Phase 9).
- Exit: typecheck + tests green.

## Phase 8 — Lazy sandbox + web wiring

- `lazy-sandbox.ts`: a `Sandbox` implementation calling `ensureRunning` on first use, then delegating to
  `DaemonSandbox` with this workspace's URL + token. Normal chat starts NO machine; machine created lazily on
  the first tool call needing the sandbox (exec, read/write/edit file).
- Replace global SANDBOX_BASE_URL/TOKEN in `apps/web/lib/sandbox.ts` with a per-workspace resolver; keep
  local mode for dev/tests.
- `per-workspace` daemon token stored encrypted; presigned URLs short-lived.
- Exit: typecheck + tests green; local mode still works for dev/tests.

## Phase 9 — Reaper, reconciler, cleanup, pg_dump backup job

Background jobs, idempotent, each guarded with `pg_advisory_lock` (only one instance runs each):
- **Idle reaper (every minute):** archive workspaces idle >= FREE_IDLE_MINUTES AND no active agent run AND
  no running exec. Long builds must not be killed mid-run.
- **Reconciler (hourly):** diff Fly machines/volumes/apps vs DB; destroy orphans; close stale usage sessions;
  retry archive_failed; fail rows stuck in creating/restoring > 10 min.
- **Storage cleanup (daily):** delete tmp upload keys older than 24 h; retention — notify then delete backups
  of workspaces inactive 90 days.
- **DB backup (nightly):** `pg_dump` -> compressed -> `S3_BUCKET_DB_BACKUPS`, keep last 7 dumps. Documented
  restore procedure tested once. Document that Postgres + MinIO Docker volumes need host-level backups in prod.
- Test: crash-after-volume-create repaired by reconciler.
- Exit: typecheck + tests green.

## Phase 10 — UI + events (`apps/web`)

- Stream workspace events: `workspace.restoring` (with sub-steps), `workspace.ready`, `workspace.archiving`,
  `workspace.archived`.
- Show: status badge, countdown to auto-pause while running, monthly CPU-hours used (x of 5h), daily requests
  used (x of 30) with Dhaka reset time, clear messages when quota exhausted ("Your work is saved").
- Copy friendly and short.
- Exit: typecheck + lint + tests green.

## Phase 11 — Docs updates

- Update `arcetecture.md` / `plan.md` / `todo.md`: Neon -> local Postgres; MinIO decision (incl. `minio/minio`
  archived, `MINIO_IMAGE` swappable, default `pgsty/minio`); Fly sandbox lifecycle; new schema/API surface.
- Runbook in `docs/`: run one real create -> restore -> edit file -> archive -> restore cycle on Fly,
  including exposing `S3_PUBLIC_ENDPOINT` to Fly via a tunnel; confirm the file survived (hash match).
- README: startup (`pnpm infra:up && pnpm db:migrate && pnpm storage:init`), MINIO_IMAGE swap note.
- Final report: what's done, full TODO(verify) list, deviations from this spec + reasons.

## Acceptance checklist (final)

- Fresh clone: `pnpm infra:up && pnpm db:migrate && pnpm storage:init` succeeds and the app boots.
- Storage: presigned PUT->GET round-trip; presigned URL expires; URL for key A cannot read key B.
- Unauthenticated requests to workspace/sandbox routes rejected; user A cannot act on user B's workspace.
- Unverified email cannot create a workspace.
- Concurrent `ensureRunning` -> exactly one machine.
- archive never deletes anything on upload/verify failure.
- Crash after volume-create repaired by reconciler.
- Daily counter never exceeds 30 under 100 concurrent requests.
- Quota exhaustion mid-session triggers backup-then-stop.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` all green; docs runbook cycle proven live.

## Open questions / risks

- Whether `pgsty/minio` image + pinned tag exist (verify before pinning; the burden to prove the image is on us).
- `skip_launch`, volume-delete-while-attached, API rate limits, app/IP request shapes — unverified Fly fields.
- Better Auth CLI schema generation + exact option names (rate limiting).
- Separate public endpoint vs signed host — must test MinIO accepts URLs signed for the public host.
- Free-tier fly org on a single developer account may itself hit Fly API rate limits during reconcile.