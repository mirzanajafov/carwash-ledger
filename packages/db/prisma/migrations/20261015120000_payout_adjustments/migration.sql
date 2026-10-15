ALTER TABLE "payouts" ADD COLUMN     "adjustment_journal_id" BIGINT;

CREATE UNIQUE INDEX "payouts_adjustment_journal_id_key" ON "payouts"("adjustment_journal_id");

ALTER TABLE "payouts" ADD CONSTRAINT "payouts_adjustment_journal_id_fkey" FOREIGN KEY ("adjustment_journal_id") REFERENCES "journals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
