import { CheckpointView, TamperView, VerificationRunView } from '@carwash/contracts'
import * as z from 'zod/mini'

export const AuditState = z.object({
  tamper: z.nullable(TamperView),
  tamperAvailable: z.boolean(),
  checkpoint: z.nullable(CheckpointView),
  witnessKey: z.nullable(z.string()),
  verification: z.nullable(VerificationRunView),
})

export type AuditState = z.infer<typeof AuditState>

export interface AuditPanelState {
  server: AuditState | null
  seq: string
  seeded: boolean
  tamperAt: string | null
}

export type AuditPanelAction = { type: 'loaded'; server: AuditState } | { type: 'typed'; seq: string }

export const EMPTY: AuditPanelState = { server: null, seq: '', seeded: false, tamperAt: null }

export function reduce(panel: AuditPanelState, action: AuditPanelAction): AuditPanelState {
  if (action.type === 'typed') return { ...panel, seq: action.seq, seeded: true }
  const { server } = action
  if (server.tamper && server.tamper.at !== panel.tamperAt) {
    return { ...panel, server, seq: String(server.tamper.seq), seeded: true, tamperAt: server.tamper.at }
  }
  if (!panel.seeded && server.checkpoint && server.checkpoint.tree_size > 0) {
    return { ...panel, server, seq: String(server.checkpoint.tree_size - 1), seeded: true }
  }
  return { ...panel, server }
}
