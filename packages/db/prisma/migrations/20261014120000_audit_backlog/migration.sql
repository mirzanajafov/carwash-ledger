INSERT INTO "audit_queue" ("journal_id")
SELECT j."id" FROM "journals" j
WHERE NOT EXISTS (SELECT 1 FROM "audit_log" a WHERE a."journal_id" = j."id")
  AND NOT EXISTS (SELECT 1 FROM "audit_queue" q WHERE q."journal_id" = j."id")
ORDER BY j."id";
