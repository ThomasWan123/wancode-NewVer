import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  configureWancodeHarnessHome,
  configureWancodeTelemetry,
  WANCODE_APP_ID,
  WANCODE_PRODUCT_NAME,
  WANCODE_WINDOW_TITLE,
} from '../src/product.ts'

describe('Wancode product identity', () => {
  it('uses one stable native identity across the desktop shell', () => {
      expect(WANCODE_PRODUCT_NAME).toBe('WanCodeNewVer')
      expect(WANCODE_WINDOW_TITLE).toBe('WanCodeNewVer')
      expect(WANCODE_APP_ID).toBe('com.wancode.desktop')
  })

  it('isolates Harness data under Wancode user data by default', () => {
    const environment: Record<string, string | undefined> = {}

    expect(configureWancodeHarnessHome('C:\\Users\\Example\\AppData\\Wancode', environment))
      .toBe(join('C:\\Users\\Example\\AppData\\Wancode', 'harness'))
    expect(environment.DSH_HOME).toBe(
      join('C:\\Users\\Example\\AppData\\Wancode', 'harness'),
    )
  })

  it('preserves an explicit Harness home override', () => {
    const environment = { DSH_HOME: 'D:\\Agents\\shared' }

    expect(configureWancodeHarnessHome('C:\\ignored', environment))
      .toBe('D:\\Agents\\shared')
    expect(environment.DSH_HOME).toBe('D:\\Agents\\shared')
  })

  it('disables upstream telemetry by default while preserving an explicit choice', () => {
    const defaultEnvironment: Record<string, string | undefined> = {}
    const optedInEnvironment = { DSH_TELEMETRY_DISABLED: '' }

    configureWancodeTelemetry(defaultEnvironment)
    configureWancodeTelemetry(optedInEnvironment)

    expect(defaultEnvironment.DSH_TELEMETRY_DISABLED).toBe('1')
    expect(optedInEnvironment.DSH_TELEMETRY_DISABLED).toBe('')
  })
})
