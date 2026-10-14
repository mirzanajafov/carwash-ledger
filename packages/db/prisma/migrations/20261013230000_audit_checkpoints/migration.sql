CREATE TABLE "audit_checkpoints" (
    "size" BIGINT NOT NULL,
    "root" BYTEA NOT NULL,
    "signature" BYTEA NOT NULL,
    "witness_key" TEXT NOT NULL,
    "signed_at" TIMESTAMPTZ(6) NOT NULL,
    "stored_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_checkpoints_pkey" PRIMARY KEY ("size")
);

ALTER TABLE "audit_checkpoints" ADD CONSTRAINT "audit_checkpoints_sizes" CHECK ("size" > 0 AND length("root") = 32 AND length("signature") = 64);

GRANT SELECT, INSERT ON "audit_checkpoints" TO ledger_app;
GRANT SELECT ON "audit_checkpoints" TO ledger_audit;
