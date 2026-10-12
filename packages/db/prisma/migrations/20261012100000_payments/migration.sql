CREATE TYPE "client_scope" AS ENUM ('client', 'admin');

CREATE TYPE "capture_mode" AS ENUM ('auto', 'manual');

CREATE TYPE "payment_status" AS ENUM ('created', 'authorized', 'captured', 'refunded', 'canceled', 'failed');

CREATE TYPE "attempt_kind" AS ENUM ('authorize', 'capture', 'cancel', 'refund', 'payout');

CREATE TYPE "attempt_status" AS ENUM ('pending', 'succeeded', 'declined');

CREATE TYPE "refund_status" AS ENUM ('pending', 'succeeded', 'failed');

CREATE TYPE "payout_status" AS ENUM ('pending', 'succeeded', 'failed');

CREATE TYPE "idempotency_state" AS ENUM ('started', 'finished');

CREATE TABLE "api_clients" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" BYTEA NOT NULL,
    "scope" "client_scope" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "api_clients_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchants" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "account_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "client_id" BIGINT NOT NULL,
    "merchant_id" BIGINT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "capture_mode" "capture_mode" NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'created',
    "token" TEXT NOT NULL,
    "psp_charge_id" TEXT,
    "captured_amount" BIGINT NOT NULL DEFAULT 0,
    "refunded_amount" BIGINT NOT NULL DEFAULT 0,
    "fee" BIGINT NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "capture_journal_id" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refunds" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "payment_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "refund_status" NOT NULL DEFAULT 'pending',
    "fee_refund" BIGINT NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "journal_id" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payouts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "merchant_id" BIGINT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "payout_status" NOT NULL DEFAULT 'pending',
    "failure_reason" TEXT,
    "journal_id" BIGINT,
    "reversal_journal_id" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "attempts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "kind" "attempt_kind" NOT NULL,
    "status" "attempt_status" NOT NULL DEFAULT 'pending',
    "payment_id" UUID,
    "refund_id" UUID,
    "payout_id" UUID,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "psp_operation_id" TEXT,
    "decline_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "attempts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "idempotency_keys" (
    "client_id" BIGINT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "request_hash" BYTEA NOT NULL,
    "state" "idempotency_state" NOT NULL DEFAULT 'started',
    "recovery_point" TEXT NOT NULL DEFAULT 'started',
    "payment_id" UUID,
    "refund_id" UUID,
    "payout_id" UUID,
    "locked_until" TIMESTAMPTZ(6),
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("client_id","key")
);

CREATE TABLE "anomalies" (
    "id" BIGSERIAL NOT NULL,
    "attempt_id" UUID,
    "kind" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anomalies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_clients_key_hash_key" ON "api_clients"("key_hash");

CREATE UNIQUE INDEX "merchants_code_key" ON "merchants"("code");

CREATE UNIQUE INDEX "merchants_account_id_key" ON "merchants"("account_id");

CREATE UNIQUE INDEX "payments_psp_charge_id_key" ON "payments"("psp_charge_id");

CREATE UNIQUE INDEX "payments_capture_journal_id_key" ON "payments"("capture_journal_id");

CREATE INDEX "payments_merchant_id_created_at_idx" ON "payments"("merchant_id", "created_at");

CREATE UNIQUE INDEX "refunds_journal_id_key" ON "refunds"("journal_id");

CREATE INDEX "refunds_payment_id_idx" ON "refunds"("payment_id");

CREATE UNIQUE INDEX "payouts_journal_id_key" ON "payouts"("journal_id");

CREATE UNIQUE INDEX "payouts_reversal_journal_id_key" ON "payouts"("reversal_journal_id");

CREATE INDEX "payouts_merchant_id_created_at_idx" ON "payouts"("merchant_id", "created_at");

CREATE UNIQUE INDEX "attempts_psp_operation_id_key" ON "attempts"("psp_operation_id");

CREATE INDEX "attempts_payment_id_idx" ON "attempts"("payment_id");

CREATE INDEX "attempts_refund_id_idx" ON "attempts"("refund_id");

CREATE INDEX "attempts_payout_id_idx" ON "attempts"("payout_id");

CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");

CREATE UNIQUE INDEX "anomalies_attempt_id_kind_key" ON "anomalies"("attempt_id", "kind");

ALTER TABLE "merchants" ADD CONSTRAINT "merchants_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payments" ADD CONSTRAINT "payments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payments" ADD CONSTRAINT "payments_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payments" ADD CONSTRAINT "payments_capture_journal_id_fkey" FOREIGN KEY ("capture_journal_id") REFERENCES "journals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "journals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payouts" ADD CONSTRAINT "payouts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payouts" ADD CONSTRAINT "payouts_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "journals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payouts" ADD CONSTRAINT "payouts_reversal_journal_id_fkey" FOREIGN KEY ("reversal_journal_id") REFERENCES "journals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "attempts" ADD CONSTRAINT "attempts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "attempts" ADD CONSTRAINT "attempts_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "attempts" ADD CONSTRAINT "attempts_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "anomalies" ADD CONSTRAINT "anomalies_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "payments_captured_range" CHECK ("captured_amount" >= 0 AND "captured_amount" <= "amount"),
  ADD CONSTRAINT "payments_refunded_range" CHECK ("refunded_amount" >= 0 AND "refunded_amount" <= "captured_amount"),
  ADD CONSTRAINT "payments_fee_range" CHECK ("fee" >= 0 AND ("captured_amount" = 0 OR "fee" < "captured_amount"));

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "refunds_fee_refund_range" CHECK ("fee_refund" >= 0 AND "fee_refund" <= "amount");

ALTER TABLE "payouts" ADD CONSTRAINT "payouts_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "attempts"
  ADD CONSTRAINT "attempts_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "attempts_parent" CHECK (
    ("kind" IN ('authorize', 'capture', 'cancel') AND "payment_id" IS NOT NULL AND "refund_id" IS NULL AND "payout_id" IS NULL)
    OR ("kind" = 'refund' AND "payment_id" IS NOT NULL AND "refund_id" IS NOT NULL AND "payout_id" IS NULL)
    OR ("kind" = 'payout' AND "payout_id" IS NOT NULL AND "payment_id" IS NULL AND "refund_id" IS NULL)
  );

CREATE UNIQUE INDEX "attempts_one_live_authorize" ON "attempts" ("payment_id")
  WHERE "kind" = 'authorize' AND "status" IN ('pending', 'succeeded');

CREATE UNIQUE INDEX "attempts_one_live_settlement" ON "attempts" ("payment_id")
  WHERE "kind" IN ('capture', 'cancel') AND "status" IN ('pending', 'succeeded');

CREATE UNIQUE INDEX "attempts_one_live_refund" ON "attempts" ("refund_id")
  WHERE "kind" = 'refund' AND "status" IN ('pending', 'succeeded');

CREATE UNIQUE INDEX "attempts_one_live_payout" ON "attempts" ("payout_id")
  WHERE "kind" = 'payout' AND "status" IN ('pending', 'succeeded');

CREATE INDEX "attempts_pending_by_age" ON "attempts" ("created_at") WHERE "status" = 'pending';

GRANT SELECT ON "api_clients" TO ledger_app;
GRANT SELECT, INSERT ON "merchants", "anomalies" TO ledger_app;
GRANT SELECT, INSERT, UPDATE ON "payments", "refunds", "payouts", "attempts" TO ledger_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "idempotency_keys" TO ledger_app;
GRANT USAGE ON SEQUENCE "merchants_id_seq", "anomalies_id_seq" TO ledger_app;
GRANT SELECT ON "api_clients", "merchants", "payments", "refunds", "payouts", "attempts", "idempotency_keys", "anomalies" TO ledger_audit;
