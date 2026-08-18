/** Fail-closed Wan Code remote-control protocol: envelopes, tokens, keys, and handshake. */

export { RelayAuthorizationError, type RelayErrorCode } from './errors.ts'
export {
  RELAY_PROTOCOL_VERSION,
  createMemoryRelayStore,
  dispatchRelayEnvelope,
  parseRelayEnvelope,
  type RelayAccessToken,
  type RelayActor,
  type RelayDevice,
  type RelayDispatchInput,
  type RelayDispatchResult,
  type RelayEnvelope,
  type RelayFrameKind,
  type RelayStore,
} from './envelope.ts'
export {
  generateDeviceKeyPair,
  signDevicePayload,
  verifyDevicePayload,
  type DeviceKeyPair,
} from './device-keys.ts'
export {
  RELAY_CAPABILITIES,
  createSignedHandshakeEnvelope,
  openOutboundSession,
  type OutboundHandshakeClaims,
  type OutboundSession,
  type RelayCapability,
  type RelayHandshakeDirection,
  type SignedHandshakeEnvelopeInput,
} from './handshake.ts'
