CREATE TABLE "recon_cursors" (
    "currency" CHAR(3) NOT NULL,
    "files" INTEGER NOT NULL,

    CONSTRAINT "recon_cursors_pkey" PRIMARY KEY ("currency")
);

GRANT SELECT, INSERT, UPDATE ON "recon_cursors" TO ledger_app;
GRANT SELECT ON "recon_cursors" TO ledger_audit;
