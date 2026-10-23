import type { SettlementDayList, SettlementDayView } from '@carwash/contracts'
import type { CalendarReply } from '../psp/psp.client.ts'
import type { BreakRow, FileRow, FileSummaryRow, LineRow } from './settlements.repository.ts'

export function dayListView(calendar: CalendarReply, files: readonly FileSummaryRow[]): SettlementDayList {
  return {
    object: 'list',
    day_seconds: calendar.kind === 'answer' ? calendar.daySeconds : null,
    current_day: calendar.kind === 'answer' ? calendar.currentDay : null,
    data: files.map((file) => ({ ...file, received_at: file.received_at.toISOString(), breaks: file.breaks ?? {} })),
  }
}

export function dayView(currency: string, day: number, file: FileRow | undefined, lines: readonly LineRow[], breaks: BreakRow[]): SettlementDayView {
  return {
    object: 'settlement_day',
    day,
    currency,
    file: file ? { ...file, received_at: file.received_at.toISOString() } : null,
    lines: lines.map((line) => ({ ...line, operated_at: line.operated_at.toISOString() })),
    breaks,
  }
}
