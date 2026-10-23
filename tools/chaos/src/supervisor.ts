export interface Restartable {
  start(): void
}

export class Supervisor {
  readonly #bootFailures = new Map<Restartable, number>()
  #stopping = false

  get stopping(): boolean {
    return this.#stopping
  }

  restart(process: Restartable, failedToBoot = false): void {
    if (this.#stopping) return
    const streak = failedToBoot ? (this.#bootFailures.get(process) ?? 0) + 1 : 0
    this.#bootFailures.set(process, streak)
    setTimeout(
      () => {
        if (!this.#stopping) process.start()
      },
      Math.min(4000, 500 * 2 ** streak),
    )
  }

  stop(): void {
    this.#stopping = true
  }
}
