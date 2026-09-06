{
  "epoch": "E6",
  "name": "Production Simulation & Scale Validation",
  "completedAt": "2026-09-06T00:00:00Z",
  "commit": "see tag e6-complete (this file's own commit cannot contain its final hash)",
  "tag": "e6-complete",
  "testsPassing": "178/178",
  "validationOnly": true,
  "featuresAdded": 0,
  "migrationsAdded": 0,
  "phasesCompleted": [
    "PHASE_1_SEED_INFRASTRUCTURE",
    "PHASE_2_BASELINE_10K",
    "PHASE_3_LOAD_TEST_100K",
    "PHASE_4_STRESS_300K_500K",
    "PHASE_5_FAILURE_RESILIENCE_BACKUP_RESTORE",
    "PHASE_6_PERFORMANCE_REPORT_AND_GATE"
  ],
  "qualityGates": {
    "allPassing": true,
    "unitTests": "90/90",
    "securityTests": "52/52",
    "integrationTests": "36/36",
    "typecheck": "zero errors",
    "lint": "zero errors",
    "npmAuditHigh": "exit 0 (6 pre-existing moderate findings: esbuild/drizzle-kit ADR-019, uuid/exceljs ADR-027; the two HIGH findings present mid-epoch were remediated -- ADR-036)",
    "ciVerification": "NOT RUN -- all E6 commits are local on main and unpushed; the local checks above mirror CI's lint + unit-tests + integration + security-scan stages (integration/security run against the live docker stack throughout the epoch). Recommend pushing as a PR to confirm the 5 CI jobs before external sign-off."
  },
  "adrsAdded": ["ADR-034", "ADR-035", "ADR-036"],
  "adrNote": "ADR-033 (UTC calendar-frame date comparison) landed in commit 1c309b7 immediately before Phase 1 -- a pre-E6 correctness fix, not counted here.",
  "artifacts": {
    "seedTooling": "tools/seed/ (config, db, generate, cleanup, keycloak-users) -- npm run generate/cleanup/seed:users",
    "loadTestHarness": "tools/load-tests/ (k6 v2.2.0, workload.js weighted read-mix, read-mix.js ramping-arrival-rate, smoke.js, fetch-tokens.ts) -- npm run loadtest:tokens/smoke/read-mix",
    "results": [
      "docs/e6-results/phase-1-seed-infrastructure.md",
      "docs/e6-results/baseline-10k.md",
      "docs/e6-results/phase-3-load-100k.md",
      "docs/e6-results/phase-4-stress.md",
      "docs/e6-results/phase-5-failure-resilience.md",
      "docs/e6-results/E6_PERFORMANCE_REPORT.md"
    ],
    "newRunbook": "docs/runbooks/backup-restore.md",
    "toolingChange": "tools/seed/cleanup.ts now prefers the superuser DATABASE_ADMIN_URL + SET session_replication_role='replica' for teardown (skips the FK RI-trigger scan that made a 100K teardown take 11+ min; falls back to migration_user)"
  },
  "keyFindings": {
    "scaling": "Every hot read path degrades LINEARLY (never worse-than-linear) across 10K -> 100K -> 300K -> 500K. Sustainable throughput scales ~1/n with dataset size: ~30 req/s at 100K -> ~10 req/s at 300K on the validation host. GET /dashboard/expiring (O(limit)) and GET /health* (O(1)) stay flat at every size.",
    "correctness": "178/178 with a 300K-employee seed loaded; RLS isolation, append-only audit, optimistic locking all identical to the 15-row E0 fixture. Post-chaos (Phase 5) suite also 178/178.",
    "resilience": "Self-heals from Redis, Keycloak, SMTP, and worker-crash failures. Does NOT survive a Postgres connection reset -- packages/database/src/index.ts createDb() has no pool.on('error'), so a Postgres restart OR a single pg_terminate_backend on an idle connection crashes both the API and the worker (masked in prod by the container restart policy).",
    "backupRestore": "pg_dump -Fc (13.5s / 45.5MB, live, no window) + pg_restore (39s) preserves and re-enforces every security property: RLS, FORCE RLS, the NULLIF tenant guard, all 8 tenant_isolation_* policies, and the audit_events append-only grant. Roles are cluster-global -- pg_dumpall --roles-only needed separately."
  },
  "e7Backlog": [
    "pool.on('error') in createDb() -- one line, review-gated file; stops a DB blip crashing API+worker (HIGHEST value/effort)",
    "index documents(employee_id) -- fixes GET /employees/:id/documents O(n) AND the O(n^2) hard-delete",
    "composite/stored-column full-text index for employees?q= -- the GIN index idx_employees_search is never used once the RLS tenant_id predicate is in the query",
    "per-(tenant,status) rollup for dashboard/summary + document-stats -- O(n) -> O(1)",
    "index (tenant_id, created_at) WHERE deleted_at IS NULL on employees -- removes the list-page sort",
    "reminder scan: batch the notification_log dedup, bound the candidate scan to threshold dates",
    "worker IORedis .on('error') -- quiet the ECONNABORTED log spray (cosmetic)",
    "production monitors: JWKS-fetch failures, SMTP circuit-breaker, notification_log failure rate",
    "managed backups / WAL archiving / PITR (AWS epoch)"
  ],
  "knownLimitations": [
    "Sustained-load phase capped at 300K -- host RAM below the 8 GB working floor for the whole epoch. 500K is seed + EXPLAIN + smoke only; 1M deferred.",
    "A second unrelated Docker stack ran on the same engine throughout and could not be stopped -- absolute throughput numbers are a lower bound; scaling factors are the reported signal.",
    "Graceful SIGTERM drain not re-tested (Windows host cannot send a real POSIX SIGTERM) -- verified in E5 against the production Docker images; Phase 5 notes that the R1/R6 crash paths bypass it entirely.",
    "No managed backups / PITR anywhere in the repo -- docs/runbooks/backup-restore.md is a manual procedure until the AWS epoch.",
    "The 5 O(n) read paths and the pool.on('error') gap are documented and E7-scheduled, not fixed (E6 is validation-only)."
  ],
  "nextEpoch": "E7 -- AWS Production Infrastructure (open with the e7Backlog above; items 2-5 are each a single additive index/table)"
}
