FROM node:24-slim AS deps
WORKDIR /app
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends patch \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/ledger/package.json packages/ledger/
COPY packages/pg/package.json packages/pg/
COPY packages/invariants/package.json packages/invariants/
COPY packages/testkit/package.json packages/testkit/
COPY tools/chaos/package.json tools/chaos/
RUN pnpm install --frozen-lockfile --filter @carwash/chaos...
COPY packages packages
COPY tools/chaos tools/chaos
ARG MUTANT=
RUN if [ -n "$MUTANT" ]; then patch -p1 --forward < "tools/chaos/mutants/$MUTANT.patch"; fi
RUN pnpm --filter @carwash/db generate

FROM postgres:18
COPY --from=ghcr.io/shopify/toxiproxy:2.12.0 /toxiproxy /usr/local/bin/toxiproxy-server
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
COPY --from=deps --chown=postgres:postgres /app /app
RUN mkdir -p /app/tools/chaos/results && chown postgres:postgres /app/tools/chaos/results
ENV LEDGER_ADMIN_URL=postgresql://carwash@127.0.0.1:5432/postgres
USER postgres
WORKDIR /app/tools/chaos
ENTRYPOINT ["node", "--conditions=source", "src/harness.ts"]
