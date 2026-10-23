CREATE TABLE "reconciliations" (
    "currency" CHAR(3) NOT NULL,
    "files" INTEGER NOT NULL,

    CONSTRAINT "reconciliations_pkey" PRIMARY KEY ("currency")
);

GRANT SELECT, INSERT, UPDATE ON "reconciliations" TO ledger_app;
