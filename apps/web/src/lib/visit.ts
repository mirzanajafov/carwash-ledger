export type DemoStep = 'pulled-plug' | 'checked-journal'

export function reportStep(step: DemoStep): void {
  document.dispatchEvent(new CustomEvent('najafov:action', { detail: step }))
}
