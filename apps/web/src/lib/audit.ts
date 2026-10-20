import type { CheckpointJson } from './verify-journal'

export interface Tamper {
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

export function seqToCheck(typed: string | null, state: AuditState | null): string {
  if (typed !== null) return typed
  if (state?.tamper) return String(state.tamper.seq)
  return state?.checkpoint ? String(state.checkpoint.tree_size - 1) : ''
}
