export class LedgerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

export class InvalidJournalError extends LedgerError {}

export class UnknownAccountError extends LedgerError {
  readonly accountIds: readonly bigint[]

  constructor(accountIds: readonly bigint[]) {
    super(`unknown accounts: ${accountIds.join(', ')}`)
    this.accountIds = accountIds
  }
}

export class DuplicateJournalError extends LedgerError {
  readonly externalRef: string

  constructor(externalRef: string, options?: ErrorOptions) {
    super(`a journal with external ref ${externalRef} already exists`, options)
    this.externalRef = externalRef
  }
}

export class AlreadyReversedError extends LedgerError {
  readonly journalId: bigint

  constructor(journalId: bigint, options?: ErrorOptions) {
    super(`journal ${journalId} has already been reversed`, options)
    this.journalId = journalId
  }
}

export class LedgerRuleError extends LedgerError {
  readonly sqlState: string

  constructor(sqlState: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.sqlState = sqlState
  }
}

export class RetriesExhaustedError extends LedgerError {
  readonly attempts: number

  constructor(attempts: number, options?: ErrorOptions) {
    super(`gave up after ${attempts} attempts`, options)
    this.attempts = attempts
  }
}
