#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_password="$LEDGER_OWNER_PASSWORD" \
  -v app_password="$LEDGER_APP_PASSWORD" \
  -v audit_password="$LEDGER_AUDIT_PASSWORD" <<'SQL'
CREATE ROLE ledger_owner LOGIN CREATEDB PASSWORD :'owner_password';
CREATE ROLE ledger_app LOGIN PASSWORD :'app_password';
CREATE ROLE ledger_audit LOGIN PASSWORD :'audit_password';
CREATE DATABASE ledger OWNER ledger_owner;
SQL
