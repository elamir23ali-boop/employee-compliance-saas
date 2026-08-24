# syntax=docker/dockerfile:1
# Build context MUST be the repo root (docker build -f apps/api/Dockerfile .)
# -- apps/api depends on the real npm workspace packages @ecs/database and
# @ecs/shared, not published packages, so the whole monorepo is needed to
# resolve them. See docs/architecture/decisions.md (ADR-029).

FROM node:24-alpine AS base
WORKDIR /app

# --- prune: reduce the monorepo to just @ecs/api + its actual workspace deps ---
FROM base AS pruner
# Version-pinning an apk package here would tie this Dockerfile to one
# specific node:24-alpine release's package index; that index is already
# pinned by the base image tag, and libc6-compat is build-tooling only
# (never present in the final `runner` stage).
# hadolint ignore=DL3018
RUN apk add --no-cache libc6-compat
COPY . .
RUN npx turbo prune @ecs/api --docker

# --- installer: full install (incl. devDependencies) + build ---
FROM base AS installer
# Version-pinning an apk package here would tie this Dockerfile to one
# specific node:24-alpine release's package index; that index is already
# pinned by the base image tag, and libc6-compat is build-tooling only
# (never present in the final `runner` stage).
# hadolint ignore=DL3018
RUN apk add --no-cache libc6-compat
COPY --from=pruner /app/out/json/ .
RUN npm ci
COPY --from=pruner /app/out/full/ .
# turbo prune only follows package.json dependencies, not tsconfig's
# `extends` -- every package's tsconfig.json extends this root file, so it
# has to be copied in by hand or every tsc invocation below fails with
# TS5083 (cannot read tsconfig.base.json).
COPY --from=pruner /app/tsconfig.base.json ./tsconfig.base.json
RUN npx turbo build --filter=@ecs/api

# --- prod-deps: a second, production-only install against the same pruned
# package.json set -- never derived from `installer`'s node_modules, which
# still has TypeScript/@nestjs/cli/etc. in it ---
FROM base AS prod-deps
COPY --from=pruner /app/out/json/ .
RUN npm ci --omit=dev

# --- runner: only the production node_modules + built dist output reach
# the final image; nothing from `installer`'s devDependency-laden
# node_modules ever does ---
FROM base AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 ecs && adduser --system --uid 1001 --ingroup ecs apiuser
# npm/npx/corepack ship inside node:24-alpine and are never invoked at
# runtime here (CMD calls `node` directly) -- removing them drops several
# CVEs Trivy flags in npm's own vendored dependencies (tar, undici,
# brace-expansion, ...) that only matter if npm itself parses untrusted
# input, which never happens in this image. See ADR-029.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

COPY --from=prod-deps --chown=apiuser:ecs /app/node_modules ./node_modules
COPY --from=prod-deps --chown=apiuser:ecs /app/package.json ./package.json
COPY --from=installer --chown=apiuser:ecs /app/apps/api/dist ./apps/api/dist
COPY --from=installer --chown=apiuser:ecs /app/apps/api/package.json ./apps/api/package.json
# Only the built output of @ecs/api's actual workspace deps -- not their
# TS source, and not a blanket copy of packages/ that would also drag in
# any sibling workspace package this app doesn't use.
COPY --from=installer --chown=apiuser:ecs /app/packages/database/dist ./packages/database/dist
COPY --from=installer --chown=apiuser:ecs /app/packages/database/package.json ./packages/database/package.json
COPY --from=installer --chown=apiuser:ecs /app/packages/shared/dist ./packages/shared/dist
COPY --from=installer --chown=apiuser:ecs /app/packages/shared/package.json ./packages/shared/package.json

USER apiuser
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
