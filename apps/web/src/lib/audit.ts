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
  state: AuditState | null
  seq: string
}

export type AuditPanelAction = { type: 'loaded'; state: AuditState } | { type: 'typed'; seq: string }

export const EMPTY: AuditPanelState = { state: null, seq: '' }

function newestSeq(state: AuditState | null): number | null {
  return state?.checkpoint && state.checkpoint.tree_size > 0 ? state.checkpoint.tree_size - 1 : null
}

export function reduce(panel: AuditPanelState, action: AuditPanelAction): AuditPanelState {
  if (action.type === 'typed') return { ...panel, seq: action.seq }
  const { tamper } = action.state
  if (tamper && tamper.at !== panel.state?.tamper?.at) return { state: action.state, seq: String(tamper.seq) }
  const newest = newestSeq(action.state)
  if (panel.seq === '' && newestSeq(panel.state) === null && newest !== null) return { state: action.state, seq: String(newest) }
  return { ...panel, state: action.state }
}
