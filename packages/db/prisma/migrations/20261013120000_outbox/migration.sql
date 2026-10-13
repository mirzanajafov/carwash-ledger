CREATE TABLE "outbox" (
    "id" BIGSERIAL NOT NULL,
    "event_id" UUID NOT NULL DEFAULT uuidv7(),
    "topic" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "lane" SMALLINT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outbox_event_id_key" ON "outbox"("event_id");

ALTER TABLE "outbox" ADD CONSTRAINT "outbox_lane_range" CHECK ("lane" BETWEEN 0 AND 15);

CREATE INDEX "outbox_unpublished" ON "outbox" ("lane", "id") WHERE "published_at" IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON "outbox" TO ledger_app;
GRANT USAGE ON SEQUENCE "outbox_id_seq" TO ledger_app;
GRANT SELECT ON "outbox" TO ledger_audit;
