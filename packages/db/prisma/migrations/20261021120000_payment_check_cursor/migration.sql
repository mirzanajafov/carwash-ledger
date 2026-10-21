SET lock_timeout = '2s';

ALTER TABLE "payments" ADD COLUMN "updated_xid" xid8 NOT NULL DEFAULT '0';
ALTER TABLE "payments" ALTER COLUMN "updated_xid" SET DEFAULT pg_current_xact_id();
ALTER TABLE "refunds" ADD COLUMN "updated_xid" xid8 NOT NULL DEFAULT '0';
ALTER TABLE "refunds" ALTER COLUMN "updated_xid" SET DEFAULT pg_current_xact_id();

CREATE FUNCTION stamp_updated_xid() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_xid := pg_current_xact_id();
  RETURN NEW;
END
$$;

CREATE TRIGGER payments_stamp BEFORE INSERT OR UPDATE ON "payments" FOR EACH ROW EXECUTE FUNCTION stamp_updated_xid();
ALTER TABLE "payments" ENABLE ALWAYS TRIGGER payments_stamp;
CREATE TRIGGER refunds_stamp BEFORE INSERT OR UPDATE ON "refunds" FOR EACH ROW EXECUTE FUNCTION stamp_updated_xid();
ALTER TABLE "refunds" ENABLE ALWAYS TRIGGER refunds_stamp;

CREATE TRIGGER payments_protect BEFORE UPDATE ON "payments" FOR EACH ROW EXECUTE FUNCTION ledger_protect('id');
CREATE TRIGGER refunds_protect BEFORE UPDATE ON "refunds" FOR EACH ROW EXECUTE FUNCTION ledger_protect('id', 'payment_id');

CREATE INDEX "payments_updated_xid_idx" ON "payments"("updated_xid");
CREATE INDEX "refunds_updated_xid_idx" ON "refunds"("updated_xid");
CREATE INDEX "journals_created_xid_idx" ON "journals"("created_xid");

CREATE TABLE "invariant_cursors" (
    "name" TEXT NOT NULL,
    "snapshot" pg_snapshot NOT NULL,
    "taken_at" TIMESTAMPTZ(6) NOT NULL,
    "merchants" JSONB NOT NULL,

    CONSTRAINT "invariant_cursors_pkey" PRIMARY KEY ("name")
);

GRANT SELECT, INSERT, UPDATE ON "invariant_cursors" TO ledger_audit;
