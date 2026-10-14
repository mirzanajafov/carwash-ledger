CREATE TABLE "demo_limits" (
    "name" TEXT NOT NULL,
    "last_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "demo_limits_pkey" PRIMARY KEY ("name")
);

GRANT SELECT, INSERT, UPDATE ON "demo_limits" TO ledger_app;
