export interface Restartable {
  start(): void
}

export class Supervisor {
  readonly #bootFailures = new Map<Restartable, number>()
  #stopped = false

  get stopped(): boolean {
    return this.#stopped
  }

  restart(restartable: Restartable): void {
    this.#later(restartable, 0)
  }

  restartAfterFailedBoot(restartable: Restartable): void {
    this.#later(restartable, (this.#bootFailures.get(restartable) ?? 0) + 1)
  }

  stopRestarting(): void {
    this.#stopped = true
  }

  #later(restartable: Restartable, bootFailures: number): void {
    if (this.#stopped) return
    this.#bootFailures.set(restartable, bootFailures)
    setTimeout(
      () => {
        if (!this.#stopped) restartable.start()
      },
      Math.min(4000, 500 * 2 ** bootFailures),
    )
  }
}
