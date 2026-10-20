import type { CheckpointJson } from './verify-journal'

interface Tamper {
  tamper_class: 1 | 2 | 3
  seq: number
  journal_id: string
  witnessed_size: number
  at: string
  restores_at: string | null
}

export interface AuditState {
  tamper: Tamper | null
  tamperAvailable: boolean
  checkpoint: (CheckpointJson & { signed_at: string }) | null
  witnessKey: string | null
}

export interface AuditPanelState {
  server: AuditState | null
  seq: string
  seeded: boolean
  tamperAt: string | null
}

export type AuditPanelAction = { type: 'loaded'; server: AuditState } | { type: 'typed'; seq: string }

export const EMPTY: AuditPanelState = { server: null, seq: '', seeded: false, tamperAt: null }

export function reduce(panel: AuditPanelState, action: AuditPanelAction): AuditPanelState {
  if (action.type === 'typed') return { ...panel, seq: action.seq }
  const { server } = action
  if (server.tamper && server.tamper.at !== panel.tamperAt) {
    return { server, seq: String(server.tamper.seq), seeded: true, tamperAt: server.tamper.at }
  }
  if (!panel.seeded && server.checkpoint && server.checkpoint.tree_size > 0) {
    return { ...panel, server, seq: panel.seq === '' ? String(server.checkpoint.tree_size - 1) : panel.seq, seeded: true }
  }
  return { ...panel, server }
}
