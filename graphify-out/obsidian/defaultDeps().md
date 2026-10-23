---
source_file: "apps/web/lib/job-worker.ts"
type: "code"
community: "Community 14"
location: "L118"
tags:
  - graphify/code
  - graphify/INFERRED
  - community/Community_14
---

# defaultDeps()

## Connections
- [[acquireWorkspaceLock()]] - `indirect_call` [INFERRED]
- [[appendEvent()]] - `indirect_call` [INFERRED]
- [[claimNextQueuedRun()]] - `indirect_call` [INFERRED]
- [[finishRun()]] - `indirect_call` [INFERRED]
- [[flushAppends()]] - `indirect_call` [INFERRED]
- [[getDb()]] - `calls` [EXTRACTED]
- [[heartbeatRun()]] - `indirect_call` [INFERRED]
- [[job-worker.ts]] - `contains` [EXTRACTED]
- [[readRunControl()]] - `indirect_call` [INFERRED]
- [[recoverTimedOutRuns()]] - `indirect_call` [INFERRED]
- [[releaseRunLease()]] - `indirect_call` [INFERRED]
- [[releaseWorkspaceLock()]] - `indirect_call` [INFERRED]
- [[renewWorkspaceLock()]] - `indirect_call` [INFERRED]
- [[requeueRun()]] - `indirect_call` [INFERRED]
- [[runWorker()]] - `calls` [EXTRACTED]
- [[startRun()]] - `indirect_call` [INFERRED]
- [[workspaceIdentityFor()]] - `indirect_call` [INFERRED]

#graphify/code #graphify/INFERRED #community/Community_14