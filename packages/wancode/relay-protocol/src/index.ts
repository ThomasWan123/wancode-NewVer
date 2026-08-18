/** Fail-closed Wan Code remote-control protocol and outbound-only WebSocket client. */

export {
  RELAY_ERROR_CODES,
  RelayAuthorizationError,
  isRelayErrorCode,
  type RelayErrorCode,
} from './errors.ts'
export {
  RELAY_PROTOCOL_VERSION,
  assertNoPlaintextRelayFields,
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
  assertDevicePublicKey,
  generateDeviceKeyPair,
  signDevicePayload,
  verifyDevicePayload,
  type DeviceKeyPair,
} from './device-keys.ts'
export {
  createStaticOidcIdentityProvider,
  parseOidcIdentityAssertion,
  type OidcIdentityProviderConfig,
  type RelayIdentityClaims,
  type RelayIdentityProvider,
} from './identity.ts'
export {
  registerRelayDevice,
  revokeRelayDevice,
  type RegisterRelayDeviceInput,
  type RelayDeviceStore,
  type RevokeRelayDeviceInput,
} from './devices.ts'
export {
  RELAY_CAPABILITIES,
  createSignedHandshakeEnvelope,
  openOutboundSession,
  parseHandshakeAck,
  type HandshakeAck,
  type OutboundHandshakeClaims,
  type OutboundSession,
  type RelayCapability,
  type RelayHandshakeDirection,
  type SignedHandshakeEnvelopeInput,
} from './handshake.ts'
export {
  parseRelayWireHandshake,
  type RelayWireHandshake,
} from './wire.ts'
export {
  assertOutboundRelayUrl,
} from './url.ts'
export {
  connectOutboundRelay,
  type ConnectOutboundRelayInput,
  type OutboundRelayConnection,
} from './outbound.ts'
export {
  RELAY_ACCESS_TOKEN_TTL_MS,
  createMemoryRelayTokenIssuer,
  issueRelayAccessToken,
  type IssueRelayAccessTokenInput,
  type IssuedRelayAccessToken,
  type RelayTokenIssuer,
} from './tokens.ts'
