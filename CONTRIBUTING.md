# Contributing

## Branch protection (`main`)

Configured in GitHub repo settings (Settings → Branches → branch protection
rule for `main`), not in this repo's files — recorded here so the required
state is documented and auditable (E3, ADR-024):

- Require a pull request before merging (no direct pushes to `main`)
- Require status checks to pass before merging, with these checks required:
  - `lint`
  - `unit-tests`
  - `integration`
  - `security-scan`
  - `build`
  (all five jobs from `.github/workflows/ci.yml` — see that file for what
  each stage runs; they gate each other in order via `needs:`, so a single
  required-checks list covering the terminal job would in principle suffice,
  but listing all five makes partial/skipped runs visibly fail the check
  instead of showing as "no status")
- Require branches to be up to date before merging
- Require at least 1 approving review
- Do not allow force pushes
- Do not allow deletion of the branch

## Local development

See the root `README.md` for `docker compose up`, `npm run db:migrate`, and
`npm run test:unit` / `test:security` / `test:integration`.

## Commit messages

Security-sensitive changes (anything touching RLS, auth, tenant isolation,
or migrations) need a commit message that explains *why*, not just what
changed — see `docs/architecture/decisions.md` for the ADR this repo expects
alongside such changes.
