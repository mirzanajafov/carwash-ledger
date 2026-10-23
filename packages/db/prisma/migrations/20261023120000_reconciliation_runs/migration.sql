CREATE TABLE "reconciliation_runs" (
    "id" BIGSERIAL NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "files" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reconciliation_runs_currency_files_idx" ON "reconciliation_runs"("currency", "files");

GRANT SELECT, INSERT ON "reconciliation_runs" TO ledger_app;
GRANT USAGE ON SEQUENCE "reconciliation_runs_id_seq" TO ledger_app;
