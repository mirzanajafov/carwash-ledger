FROM node:24-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/audit/package.json packages/audit/
COPY packages/audit-pg/package.json packages/audit-pg/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/env/package.json packages/env/
COPY packages/failpoints/package.json packages/failpoints/
COPY packages/http/package.json packages/http/
COPY packages/invariants/package.json packages/invariants/
COPY packages/jobs/package.json packages/jobs/
COPY packages/lab/package.json packages/lab/
COPY packages/ledger/package.json packages/ledger/
COPY packages/outbox/package.json packages/outbox/
COPY packages/pg/package.json packages/pg/
COPY packages/recon/package.json packages/recon/
COPY packages/testkit/package.json packages/testkit/
COPY apps/api/package.json apps/api/
COPY apps/psp/package.json apps/psp/
COPY apps/witness/package.json apps/witness/
COPY apps/tamper/package.json apps/tamper/
COPY apps/traffic/package.json apps/traffic/
RUN pnpm install --frozen-lockfile --filter "@carwash/db" --filter "@carwash/api..." --filter "@carwash/psp..." --filter "@carwash/witness..." --filter "@carwash/tamper..." --filter "@carwash/traffic..."
COPY packages packages
COPY apps/api apps/api
COPY apps/psp apps/psp
COPY apps/witness apps/witness
COPY apps/tamper apps/tamper
COPY apps/traffic apps/traffic
RUN pnpm --filter @carwash/db generate \
  && pnpm --filter "@carwash/api..." --filter "@carwash/psp..." --filter "@carwash/witness..." --filter "@carwash/tamper..." --filter "@carwash/traffic..." build \
  && for app in api psp witness tamper traffic db; do pnpm --config.inject-workspace-packages=true --filter "@carwash/$app" deploy --prod "/out/$app"; done

FROM base AS runtime
RUN install -d -o node -g node /var/lib/witness
ENV NODE_ENV=production
USER node
CMD ["node", "dist/main.js"]

FROM runtime AS api
COPY --from=build --chown=node:node /out/api /app

FROM runtime AS psp
COPY --from=build --chown=node:node /out/psp /app

FROM runtime AS witness
COPY --from=build --chown=node:node /out/witness /app

FROM runtime AS tamper
COPY --from=build --chown=node:node /out/tamper /app

FROM runtime AS traffic
COPY --from=build --chown=node:node /out/traffic /app

FROM api AS migrate
COPY --from=build --chown=node:node /out/db /db
WORKDIR /db
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]
