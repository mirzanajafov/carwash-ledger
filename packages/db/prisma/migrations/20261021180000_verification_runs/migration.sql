CREATE TYPE "verification_status" AS ENUM ('queued', 'running', 'done', 'failed');

CREATE TABLE "verification_runs" (
    "id" BIGSERIAL NOT NULL,
    "status" "verification_status" NOT NULL DEFAULT 'queued',
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "locked_until" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "done" BIGINT NOT NULL DEFAULT 0,
    "size" BIGINT,
    "report" JSONB,
    "error" TEXT,

    CONSTRAINT "verification_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "verification_runs_one_open" ON "verification_runs" ((true)) WHERE "status" IN ('queued', 'running');

GRANT SELECT, INSERT, UPDATE, DELETE ON "verification_runs" TO ledger_app;
GRANT USAGE ON SEQUENCE "verification_runs_id_seq" TO ledger_app;
GRANT SELECT ON "verification_runs" TO ledger_audit;
