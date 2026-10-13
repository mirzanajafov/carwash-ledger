CREATE TABLE "audit_queue" (
    "journal_id" BIGINT NOT NULL,
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_queue_pkey" PRIMARY KEY ("journal_id")
);

CREATE TABLE "audit_log" (
    "seq" BIGINT NOT NULL,
    "journal_id" BIGINT NOT NULL,
    "leaf" BYTEA NOT NULL,
    "chain" BYTEA NOT NULL,
    "sequenced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("seq")
);

CREATE TABLE "audit_nodes" (
    "level" SMALLINT NOT NULL,
    "idx" BIGINT NOT NULL,
    "hash" BYTEA NOT NULL,

    CONSTRAINT "audit_nodes_pkey" PRIMARY KEY ("level","idx")
);

CREATE UNIQUE INDEX "audit_log_journal_id_key" ON "audit_log"("journal_id");

ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_hash_sizes" CHECK (length("leaf") = 32 AND length("chain") = 32);
ALTER TABLE "audit_nodes" ADD CONSTRAINT "audit_nodes_hash_size" CHECK (length("hash") = 32 AND "level" >= 0 AND "idx" >= 0);

CREATE FUNCTION queue_for_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_queue (journal_id) VALUES (NEW.id);
  RETURN NEW;
END
$$;

CREATE TRIGGER journals_queue_for_audit AFTER INSERT ON "journals" FOR EACH ROW EXECUTE FUNCTION queue_for_audit();

GRANT SELECT, INSERT, DELETE ON "audit_queue" TO ledger_app;
GRANT SELECT, INSERT ON "audit_log", "audit_nodes" TO ledger_app;
GRANT SELECT ON "audit_queue", "audit_log", "audit_nodes" TO ledger_audit;
