{
  "epoch": "E7",
  "name": "AWS Production Infrastructure (Staging Deployment)",
  "completedAt": "2026-09-18T00:00:00Z",
  "commit": "see tag e7-complete (this file's own commit cannot contain its final hash)",
  "tag": "e7-complete",
  "liveUrl": "https://compliance.ai-english-os.online",
  "awsAccount": "218201720464",
  "region": "eu-west-1",
  "featuresAdded": 0,
  "migrationsAdded": 0,
  "phasesCompleted": [
    "PHASE_1_AWS_FOUNDATION",
    "PHASE_2_EC2_HOST",
    "PHASE_3_APP_DEPLOYMENT_TLS",
    "PHASE_4_SEED_DATA_SMOKE_TEST_GATE"
  ],
  "infrastructure": {
    "compute": "1x EC2 t3.micro (i-0779afd8bafdedbc9), Elastic IP 3.251.22.171",
    "database": "1x RDS PostgreSQL 18.4 db.t3.micro, Single-AZ, private, storage-encrypted, deletion-protection ON",
    "secrets": "5x Secrets Manager secrets (compliance/prod/*)",
    "networking": "default VPC, 2 security groups (compliance-app-sg, compliance-rds-sg), Hostinger DNS, Let's Encrypt via certbot",
    "containers": "redis, keycloak 26.7.2, api, worker, nginx (docker-compose.prod.yml on the EC2 host)",
    "iam": "compliance-deploy (least-privilege, no IAM/Route53/ACM; SSM SendCommand/DescribeInstanceInformation granted mid-epoch)"
  },
  "seedData": {
    "tool": "infra/aws/seed-smoke-data.sh (new) + tools/seed/{config,db,generate,keycloak-users}.ts (E6, unchanged)",
    "employees": 300,
    "documents": 704,
    "tenants": 5,
    "keycloakUsers": 5
  },
  "smokeTest": {
    "tool": "tools/load-tests/scenarios/smoke.js (E6, unchanged) against the real production URL",
    "checksSucceeded": "100.00% (60/60)",
    "httpReqFailed": "0.00% (0/40)",
    "httpReqDurationAvg": "207ms",
    "httpReqDurationP95": "379ms",
    "result": "PASS"
  },
  "bugsFoundAndFixedThisPhase": [
    "deploy-stack.sh worker-log verification race (one-shot grep ran before a freshly-restarted worker printed its startup line) -- 5f8c9d0",
    "seed-smoke-data.sh checksum pins computed from the CRLF working-tree copy instead of the LF git blob (core.autocrlf=true) -- c70ca24",
    "KEYCLOAK_ISSUER/KEYCLOAK_JWKS_URI double-scheme bug (KC_HOSTNAME secret is a full URL, deploy-stack.sh wrongly prepended another https://) -- every real JWT validation 401'd, invisible to Sub-phase B's 3 existing checks -- 8d8f09e",
    "nginx.conf never routed /auth/realms/* to keycloak, only bare /realms -- broke the corrected JWKS_URI -- fda3e29",
    "nginx cached the api container's IP at startup forever (static proxy_pass) -- every app redeploy 502'd until nginx was manually restarted -- 96c11ae"
  ],
  "qualityGates": {
    "allPassing": true,
    "unitTests": "90/90 (inherited from E6/pre-E7 -- no application code changed this epoch, infra-only)",
    "securityTests": "52/52 (inherited, as above)",
    "integrationTests": "36/36 (inherited, as above)",
    "npmAuditHigh": "exit 0 (inherited from E6/ADR-036 -- no dependency changes this epoch)",
    "note": "E7 touched infra/aws/**, docs/**, tools/seed/** invocation only -- no apps/**, packages/** changes, so the local Docker-based test suites were not re-run; nothing in this epoch could have regressed them.",
    "liveSmokeTest": "PASS -- see smokeTest above, the actual new verification this epoch performed"
  },
  "adrsAdded": [],
  "adrNote": "ADR-041 (E7 AWS deployment architecture, cost model, least-privilege deviations) was written in Phase 1, before this phase; no new ADR this phase -- all fixes here are script/config bugs, not architecture decisions.",
  "artifacts": {
    "infraScripts": "infra/aws/{bootstrap,rds-preflight,deploy-stack,setup-tls,deploy-full,seed-smoke-data}.sh, infra/aws/docker-compose.prod.yml, infra/aws/nginx/{nginx.bootstrap,nginx}.conf",
    "results": [
      "docs/e7-results/phase-1-aws-foundation.md",
      "docs/e7-results/phase-2-ec2-host.md",
      "docs/e7-results/phase-4-seed-smoke.md"
    ]
  },
  "knownLimitations": [
    "Single EC2 t3.micro, no HA/multi-AZ, Single-AZ RDS -- deliberate cost tradeoff for a staging deployment on synthetic data only (ADR-041)",
    "AWS account is on the Free Plan with a $100 signup credit expiring 2027-03-10 (~3 months of always-on runway at ~$30-35/month) -- see ADR-041",
    "DATABASE_URL/DATABASE_MIGRATION_URL use sslmode=no-verify (encrypts, doesn't validate the RDS CA chain) -- acceptable only because the path never leaves the VPC; full chain validation needs an image rebuild, documented gap",
    "apps/api/src/common/audit-context.ts's actorIp/trust-proxy gap is unfixed -- audit_events.actorIp records nginx's own container IP, not the real client IP, for every row since Sub-phase C went live; needs an image rebuild + ECR push, deliberately not bundled into this epoch's pure-config work",
    "infra/postgres/migrate.js still has no schema_migrations tracking (carried from E5) -- not yet a blocker since RDS was bootstrapped once from empty, but MUST be resolved before any future migration is applied against this live database",
    "SMTP/reminder-email delivery not smoke-tested live against the real compliance/prod/smtp provider in this environment",
    "The 5 O(n) read paths documented in E6_GATE.md's e7Backlog are still unfixed -- this epoch was infrastructure standup, not application performance work",
    "No managed backups/PITR configured on the live RDS instance beyond its own automated snapshots (backup retention 1 day, Free Plan restriction) -- docs/runbooks/backup-restore.md's manual drill was proven in E6 against a different (local) database"
  ],
  "nextEpoch": "E8 -- first real pilot customer onboarding (out of scope for this repo's current phase list until started)"
}
