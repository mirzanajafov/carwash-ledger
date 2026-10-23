CREATE TABLE "reconciliations" (
    "currency" CHAR(3) NOT NULL,
    "files" INTEGER NOT NULL,
    "read_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reconciliations_pkey" PRIMARY KEY ("currency")
);

GRANT SELECT, INSERT, UPDATE ON "reconciliations" TO ledger_app;
GRANT SELECT ON "reconciliations" TO ledger_audit;
