FROM node:24-slim AS deps
WORKDIR /app
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends patch \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/failpoints/package.json packages/failpoints/
COPY packages/ledger/package.json packages/ledger/
COPY packages/outbox/package.json packages/outbox/
COPY packages/recon/package.json packages/recon/
COPY packages/audit/package.json packages/audit/
COPY packages/audit-pg/package.json packages/audit-pg/
COPY packages/pg/package.json packages/pg/
COPY packages/invariants/package.json packages/invariants/
COPY packages/testkit/package.json packages/testkit/
COPY apps/api/package.json apps/api/
COPY apps/psp/package.json apps/psp/
COPY apps/witness/package.json apps/witness/
COPY tools/chaos/package.json tools/chaos/
RUN pnpm install --frozen-lockfile --filter @carwash/chaos... --filter @carwash/api... --filter @carwash/psp... --filter @carwash/witness...
COPY packages packages
COPY apps apps
COPY tools/chaos tools/chaos
ARG MUTANT=
RUN set -e; for m in $(echo "$MUTANT" | tr '+' ' '); do patch -p1 --forward --fuzz=0 < "tools/chaos/mutants/$m.patch"; done
RUN pnpm --filter @carwash/db generate && pnpm --filter "@carwash/api..." --filter "@carwash/psp..." --filter "@carwash/witness..." build

FROM postgres:18
COPY --from=ghcr.io/shopify/toxiproxy:2.12.0 /toxiproxy /usr/local/bin/toxiproxy-server
COPY --from=apache/kafka-native:4.3.1 /opt/kafka/kafka.Kafka /usr/local/bin/kafka-native
COPY --from=apache/kafka-native:4.3.1 /etc/kafka/docker/log4j2.yaml /opt/kafka/log4j2.yaml
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
COPY --from=deps --chown=postgres:postgres /app /app
RUN mkdir -p /app/tools/chaos/results && chown postgres:postgres /app/tools/chaos/results
ENV LEDGER_ADMIN_URL=postgresql://carwash@127.0.0.1:5432/postgres
USER postgres
WORKDIR /app/tools/chaos
ENTRYPOINT ["node", "--conditions=source", "src/harness.ts"]
