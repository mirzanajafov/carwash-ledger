CREATE TABLE "settlement_files" (
    "id" TEXT NOT NULL,
    "day" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "lines" INTEGER NOT NULL,
    "gross" BIGINT NOT NULL,
    "fee" BIGINT NOT NULL,
    "net" BIGINT NOT NULL,
    "journal_id" BIGINT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_files_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "settlement_lines" (
    "file_id" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "operation" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "gross" BIGINT NOT NULL,
    "fee" BIGINT NOT NULL,
    "net" BIGINT NOT NULL,
    "operated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "settlement_lines_pkey" PRIMARY KEY ("file_id","line")
);

CREATE TABLE "recon_breaks" (
    "id" BIGSERIAL NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "day" BIGINT NOT NULL,
    "class" TEXT NOT NULL,
    "file_id" TEXT,
    "line" INTEGER,
    "journal_ref" TEXT,
    "attempt_id" UUID,
    "detail" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recon_breaks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "settlement_files_day_currency_key" ON "settlement_files"("day", "currency");

CREATE INDEX "settlement_lines_reference_idx" ON "settlement_lines"("reference");

CREATE INDEX "recon_breaks_currency_day_idx" ON "recon_breaks"("currency", "day");

ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "settlement_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_kind_known" CHECK ("kind" IN ('capture', 'refund'));
ALTER TABLE "recon_breaks" ADD CONSTRAINT "recon_breaks_class_known"
  CHECK ("class" IN ('missing_line', 'duplicate_line', 'wrong_amount', 'fee_difference', 'unknown_line'));

GRANT SELECT, INSERT ON "settlement_files", "settlement_lines" TO ledger_app;
GRANT SELECT, INSERT, DELETE ON "recon_breaks" TO ledger_app;
GRANT USAGE ON SEQUENCE "recon_breaks_id_seq" TO ledger_app;
GRANT SELECT ON "settlement_files", "settlement_lines", "recon_breaks" TO ledger_audit;
