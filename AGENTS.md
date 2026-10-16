# AGENTS.md

## Repo status

- pnpm monorepo (pnpm 12). `plan.md` / `arcetecture.md` are the source of truth. Note the misspelled filename: `arcetecture.md`, not `architecture.md`.
- Built so far:
  - `packages/shared` — `RunEvent` model, zod schemas, `loadEnv()` / `envStatus()`.
  - `packages/sandbox` — fly-manager (Phase 7): `createWorkspace`, `ensureRunning`
    idempotent restore, reworked `archive` (daemon `/sync` → verify → rotate →
    destroy, strict order), `reconcile`, workspace lifecycle state machine. Also
    `FlyClient` (Machines REST, zod-validated, retries + concurrency limiter),
    daemon HTTP client (`daemonHealth`/`daemonInit`/`daemonSync`/
    `waitForDaemonHealth`), `Sandbox` interface + `DaemonSandbox` + `LocalSandbox`,
    `resolveWorkspacePath`. Tests use a FakeFlyClient + FakeStorage + fake daemon
    HTTP server (skipped if local Postgres is unreachable).
  - `packages/storage` — `Storage` interface (presign/head/copy/delete/rotate/list).
  - `packages/db` — Drizzle schema, `transition` (single-from), `claimStatus`
    (multi-from), usage sessions + quotas (`openUsageSession`, `closeUsageSession`,
    `hasCpuBudget`, `closeOpenUsageSessions`), `withAdvisoryLock`.
  - `packages/agent` — prompt, tools, `runTask` / `createAgent`.
  - `apps/web` — Next.js 16 dashboard: run form + live event stream, and a REST/SSE API.
    - API: `GET /api/config`, `GET|POST /api/runs`, `GET /api/runs/:id`,
      `GET /api/runs/:id/stream?after=`, `POST /api/runs/:id/stop`,
      `GET /api/workspaces/:id/files?path=`.
    - `lib/store.ts` keeps runs/events in memory on `globalThis` (no DB yet);
      `lib/runner.ts` runs `runTask` against a `LocalSandbox` and appends every step.
- All packages test/typecheck; root `pnpm typecheck` / `test` / `build` are green.
- `services/*`, `infra/*`, `evals` are **not yet wired into prod** — `arcetecture.md` §7 lists them;
  `services/sandbox-daemon/server.mjs` defines the daemon HTTP contract the
  `FlyClient`/daemon clients talk to.

## Commands (run these to verify)

```sh
pnpm typecheck                      # pnpm -r typecheck
pnpm test                           # pnpm -r test  (apps/web has no tests yet)
pnpm lint                           # eslint .  (includes apps/web)
pnpm build                          # pnpm -r build  (Next build)
pnpm dev                            # next dev (apps/web)
```

Tests run per package with `node --import tsx --test src/*.test.ts`. The agent
test spins up an in-process OpenAI-compatible SSE server, so no API key is needed.

## Running the dashboard

- `apps/web` reads `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `AGENT_MODEL`,
  `AGENT_MAX_STEPS` from the environment / `.env.local` (copy `.env.example`).
- Each run gets a scratch workspace at `apps/web/.workspaces/<runId>`
  (gitignored; override with `BUILDX_WORKSPACE_DIR`). The file panel reads it.
- `POST /api/runs` returns `400` when no key is set, so the UI can explain why.

## Quirks (learned the hard way)

- **pnpm 12 blocks build scripts by default** — `pnpm-workspace.yaml` needs `allowBuilds: { esbuild: true }` (esbuild's postinstall is required by tsx).
- **Relative imports inside `packages/*` must be extensionless** (`./tools`, not `./tools.js`). `moduleResolution: bundler` allows the `.js` form and tsc is happy, but Next/Turbopack cannot resolve `./x.js` → `./x.ts` and the build fails with "Module not found".
- **Workspace packages export TypeScript source** (`main`/`exports` → `./src/index.ts`), so Next needs `transpilePackages: ["@buildx/agent", "@buildx/sandbox", "@buildx/shared"]`.
- **`@ai-sdk/openai` throws at import time on an empty `OPENAI_BASE_URL`** (it builds a default provider top-level). `next.config.ts` deletes empty agent env vars before any route module loads, so a blank `KEY=` in `.env` behaves as unset.
- **`react-hooks/set-state-in-effect` is an error** — an effect must not synchronously call a function that `setState`s. Load data inside an async IIFE and only `setState` after an `await`; drive refetches with a `refreshNonce` state or via deps, not a direct call.
- **Installed AI SDK is `ai@7.0.141`** (docs say "AI SDK 6"). Verified APIs:
  - Stop condition export is `stepCountIs` (not `isStepCount` — that's internal).
  - `tool({ description, inputSchema: zodSchema, execute })` — the field is `inputSchema`, not `parameters`.
  - `agent.stream(...)` returns a **Promise** — must be `await`ed.
  - Stream parts: `text-delta` (`.text`), `tool-call`/`tool-result` (`.toolCallId`, `.toolName`, `.input`, `.output`), `tool-error` (`.error`), `error`, `abort`.
  - `StreamTextResult` accessors: `.fullStream`, `.text`, `.totalUsage`, `.steps`.
- OpenAI-compatible endpoints use `createOpenAI({ apiKey, baseURL }).chat(modelId)` (Chat Completions), not the Responses API.
- Next 16 route handlers take `{ params }: { params: Promise<{ id: string }> }` — **await `params`**. SSE responses are `ReadableStream`s; the stream route wraps each payload as `{ ts, data }` and closes on a terminal `status` event.
- Env is validated by `loadEnv()` in `@buildx/shared`; blank strings are treated as unset so defaults apply.

## When implementing

- Follow the monorepo layout in `arcetecture.md` §7 (`/apps/web`, `/packages/{agent,sandbox,db,shared}`, `/services/{sandbox-daemon,worker}`, `/infra/fly-image`, `/evals`).
- Locked-in decisions (don't re-litigate without cause):
  - **Fly Machines, not Fly Sprites** — cost; all sandbox access goes through the `Sandbox` interface (`arcetecture.md` §2.4) so the backend is swappable.
  - **Agent loop runs outside the sandbox** — model keys and the Fly token never enter the microVM.
  - **AI SDK `ToolLoopAgent`** is the default harness; `arcetecture.md` §3.4 warns option names (`stopWhen`, `prepareStep`) must be checked against the installed SDK version.
  - **Everything is an append-only event row** (`events` table) — replayable, resumable UI; persist every step. Today `apps/web` uses an in-memory `globalThis` store; swap it for `packages/db` when that lands.
  - **Verification is mandatory**: a task is not done until build/test/lint pass or the agent explains why not.
- Data model, API surface, and tool list are specified in `arcetecture.md` §4, §6, §3.1 — start from those rather than inventing schemas/endpoints.
- Implementation phases are in `plan.md` §6; current phase work should follow that order (Phase 0 foundation first).
