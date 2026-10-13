CREATE TABLE "inbox" (
    "consumer" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("consumer","event_id")
);

CREATE TABLE "receipt_counters" (
    "merchant" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL,

    CONSTRAINT "receipt_counters_pkey" PRIMARY KEY ("merchant")
);

CREATE TABLE "receipts" (
    "id" BIGSERIAL NOT NULL,
    "merchant" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "fee" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,
    "event_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "statements" (
    "account_id" BIGINT NOT NULL,
    "day" DATE NOT NULL,
    "debits" BIGINT NOT NULL,
    "credits" BIGINT NOT NULL,
    "entries" INTEGER NOT NULL,

    CONSTRAINT "statements_pkey" PRIMARY KEY ("account_id","day")
);

CREATE INDEX "inbox_received_at_idx" ON "inbox"("received_at");

CREATE INDEX "receipts_payment_id_idx" ON "receipts"("payment_id");

CREATE UNIQUE INDEX "receipts_merchant_number_key" ON "receipts"("merchant", "number");

GRANT SELECT, INSERT, DELETE ON "inbox" TO ledger_app;
GRANT SELECT, INSERT, UPDATE ON "receipt_counters", "statements" TO ledger_app;
GRANT SELECT, INSERT ON "receipts" TO ledger_app;
GRANT USAGE ON SEQUENCE "receipts_id_seq" TO ledger_app;
GRANT SELECT ON "inbox", "receipt_counters", "receipts", "statements" TO ledger_audit;
