ALTER TABLE "anomalies" ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "resolved_at" TIMESTAMPTZ(6),
ADD COLUMN     "resolved_by" BIGINT;

ALTER TABLE "anomalies" ADD CONSTRAINT "anomalies_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "api_clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

GRANT UPDATE ("resolution", "resolved_at", "resolved_by") ON "anomalies" TO ledger_app;
