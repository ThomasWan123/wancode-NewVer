/** Authenticode trust verification for downloaded and released Windows installers. */

import { execFile } from 'node:child_process'
import { join } from 'node:path'

/** Non-secret signer facts returned after Windows trust verification. */
export interface AuthenticodeProbeResult {
  readonly subject: string
  readonly thumbprint: string
}

interface PowerShellAuthenticodeResult {
  readonly Status?: unknown
  readonly Subject?: unknown
  readonly Thumbprint?: unknown
}

/** Injectable subprocess boundary for focused tests and release tooling. */
export type AuthenticodeProbe = (
  executable: string,
  args: readonly string[],
  options: {
    readonly encoding: 'utf8'
    readonly env: NodeJS.ProcessEnv
    readonly maxBuffer: number
    readonly windowsHide: true
  },
) => Promise<{ readonly stdout: string }>

const POWERSHELL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$signature = Get-AuthenticodeSignature -LiteralPath $env:WANCODE_AUTHENTICODE_PATH',
  '[pscustomobject]@{',
  "  Status = $signature.Status.ToString()",
  "  Subject = if ($null -eq $signature.SignerCertificate) { '' } else { $signature.SignerCertificate.Subject }",
  "  Thumbprint = if ($null -eq $signature.SignerCertificate) { '' } else { $signature.SignerCertificate.Thumbprint }",
  '} | ConvertTo-Json -Compress',
].join('; ')

/** Parse the bounded JSON projection without exposing subprocess output in errors. */
export function parseAuthenticodeResult(stdout: string): AuthenticodeProbeResult {
  let value: PowerShellAuthenticodeResult
  try {
    value = JSON.parse(stdout) as PowerShellAuthenticodeResult
  } catch {
    throw new Error('Authenticode verification returned invalid JSON')
  }
  if (value.Status !== 'Valid') {
    const status = typeof value.Status === 'string' && value.Status.length > 0
      ? value.Status
      : 'Unknown'
    throw new Error(`Authenticode signature is not trusted: ${status}`)
  }
  if (typeof value.Subject !== 'string' || value.Subject.trim().length === 0) {
    throw new Error('Authenticode signature has no signer certificate')
  }
  if (typeof value.Thumbprint !== 'string' || !/^[A-Fa-f0-9]+$/u.test(value.Thumbprint)) {
    throw new Error('Authenticode signer thumbprint is missing or invalid')
  }
  return {
    subject: value.Subject.trim(),
    thumbprint: value.Thumbprint.toUpperCase(),
  }
}

function defaultProbe(
  executable: string,
  args: readonly string[],
  options: Parameters<AuthenticodeProbe>[2],
): Promise<{ readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], options, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve({ stdout })
    })
  })
}

/** Ask Windows to validate the embedded Authenticode signature and chain. */
export async function verifyWindowsAuthenticode(
  filename: string,
  environment: NodeJS.ProcessEnv = process.env,
  probe: AuthenticodeProbe = defaultProbe,
): Promise<AuthenticodeProbeResult> {
  const windowsRoot = environment.SystemRoot ?? environment.WINDIR
  if (windowsRoot === undefined || windowsRoot.trim().length === 0) {
    throw new Error('Authenticode verification requires SystemRoot or WINDIR')
  }
  const executable = join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = await probe(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SCRIPT],
    {
      encoding: 'utf8',
      env: {
        ...environment,
        WANCODE_AUTHENTICODE_PATH: filename,
      },
      maxBuffer: 16 * 1024,
      windowsHide: true,
    },
  )
  return parseAuthenticodeResult(result.stdout)
}
