/**
 * A provider profile describes a model-hosting backend that the kernel
 * can route lease requests to. It carries enough metadata for the
 * scheduler to match capability requirements and enforce rate budgets.
 */
export interface ProviderProfile {
  readonly id: string
  readonly displayName: string
  readonly endpoint: string
  readonly capabilities: readonly string[]
  readonly maxConcurrentLeases: number
  readonly priority: number
  readonly enabled: boolean
}
