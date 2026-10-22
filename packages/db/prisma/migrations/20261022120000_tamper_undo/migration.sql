CREATE TABLE "tamper_undo" (
    "journal_id" BIGINT NOT NULL,
    "tamper_class" SMALLINT NOT NULL,
    "seq" BIGINT NOT NULL,
    "witnessed_size" BIGINT NOT NULL,
    "undo" JSONB NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tamper_undo_pkey" PRIMARY KEY ("journal_id"),
    CONSTRAINT "tamper_undo_class" CHECK ("tamper_class" BETWEEN 1 AND 3)
);

CREATE UNIQUE INDEX "tamper_undo_one" ON "tamper_undo" ((true));
