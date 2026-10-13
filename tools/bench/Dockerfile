FROM node:24-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/failpoints/package.json packages/failpoints/
COPY packages/ledger/package.json packages/ledger/
COPY packages/outbox/package.json packages/outbox/
COPY packages/pg/package.json packages/pg/
COPY packages/invariants/package.json packages/invariants/
COPY packages/testkit/package.json packages/testkit/
COPY tools/bench/package.json tools/bench/
RUN pnpm install --frozen-lockfile --filter @carwash/bench...
COPY packages packages
COPY tools/bench tools/bench
RUN pnpm --filter @carwash/db generate

FROM postgres:18
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
COPY --from=deps /app /app
WORKDIR /app/tools/bench
ENTRYPOINT ["node", "--conditions=source"]
