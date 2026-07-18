# Task 5 Report — Route Lifecycle Orchestrator

## Commits
- `e5f2f65` feat: orchestrate durable route lifecycle
- `7b039c0` fix: resolve all six review findings for route lifecycle
- (current) fix: resolve all five re-review findings for route lifecycle

## Task 5 Re-review Fixes

### Finding 1: Runtime description validator
- Added `validateDescription()` helper in `src/route-service.ts` that rejects non-string types (numbers, booleans, objects) at runtime with `INVALID_SLUG` error
- Called before slug lock in both `publish()` and `update()`
- Tests: `rejects non-string description types at runtime`, `rejects non-string description types at runtime before side effects`

### Finding 2: DNS cleanup wrapping + reconciler isolation
- Wrapped `findOwnedRecord` call in `performDnsCleanup()` with try-catch that persists errors via `store.recordError()` before re-throwing
- Wrapped the entire `reconcilePending()` for-loop body in try-catch so unexpected errors in one row don't prevent processing of subsequent rows
- Tests: `persists findOwnedRecord errors in performDnsCleanup`, `reconcile continues processing later rows after one fails`

### Finding 3: Reconciler re-evaluation (backoff + concurrency)
- Inside each slug-lock callback in the reconciler, re-checks backoff using fresh `current.updatedAt` after re-reading the row
- Covers both `creating` and `deleting` statuses
- Tests: `reconcile re-checks backoff from fresh row after slug lock`, `reconcile creating: concurrent slug lock queues behind lock, re-evaluates stale row`

### Finding 4: Pre-lock update validation
- Moved `validateDescription()` and `validatePort()` calls before slug lock in `update()`
- Port-change comparison (`input.port !== route.port`) and probe remain inside the lock (they depend on route state)
- Tests: `validates port policy before acquiring slug lock`, `validates description before acquiring slug lock`

### Finding 5: Exact event arrays
- Added `significant()` method to `SharedEventLog` that filters out internal `store.get` calls
- Replaced `containsSubsequence()` with `toEqual(log.significant())` for core publish, remove, and missing-ID recovery event-order tests
- Tests: `full event order with Cloudflare`, `publish without Cloudflare`, `full event order for remove with Cloudflare`, `full event order for remove with missing-id recovery`
