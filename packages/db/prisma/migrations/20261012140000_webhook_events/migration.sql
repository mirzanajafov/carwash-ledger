CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "attempt_id" UUID,
    "outcome" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "checks" INTEGER NOT NULL DEFAULT 1,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_events_outcome_received_at_idx" ON "webhook_events"("outcome", "received_at");

ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_outcome_known"
  CHECK ("outcome" IN ('applied', 'already', 'anomaly', 'not_at_psp', 'unmatched', 'reported'));

GRANT SELECT, INSERT, UPDATE, DELETE ON "webhook_events" TO ledger_app;
GRANT SELECT ON "webhook_events" TO ledger_audit;
