CREATE TABLE "dashboard_sessions" (
    "id" BIGSERIAL NOT NULL,
    "client_id" BIGINT NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "dashboard_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dashboard_sessions_token_hash_key" ON "dashboard_sessions"("token_hash");

CREATE INDEX "dashboard_sessions_client_id_idx" ON "dashboard_sessions"("client_id");

ALTER TABLE "dashboard_sessions" ADD CONSTRAINT "dashboard_sessions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE ON "dashboard_sessions" TO ledger_app;
GRANT USAGE ON SEQUENCE "dashboard_sessions_id_seq" TO ledger_app;
