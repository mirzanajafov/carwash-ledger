#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v psp_password="$PSP_DB_PASSWORD" <<'SQL'
CREATE ROLE psp LOGIN PASSWORD :'psp_password';
CREATE DATABASE psp OWNER psp;
SQL
