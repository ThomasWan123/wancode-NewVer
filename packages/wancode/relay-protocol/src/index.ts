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
  type RelayRoute,
  type RelayStore,
} from './envelope.ts'
export {
  assertDeviceEncryptionPublicKey,
  assertDevicePublicKey,
  createStoredDeviceIdentity,
  createWebCryptoDeviceIdentity,
  generateDeviceKeyPair,
  parseStoredDeviceIdentity,
  publicDeviceIdentity,
  serializeStoredDeviceIdentity,
  signDevicePayload,
  verifyDevicePayload,
  type DeviceKeyPair,
  type PublicDeviceIdentity,
  type StoredDeviceIdentity,
} from './device-keys.ts'
export {
  RELAY_DEVICE_ID_BYTES,
  createWebCryptoDeviceId,
  generateWebCryptoDeviceKeyPair,
} from './webcrypto-keys.ts'
export {
  createStaticOidcIdentityProvider,
  parseOidcIdentityAssertion,
  type OidcIdentityProviderConfig,
  type RelayIdentityClaims,
  type RelayIdentityProvider,
} from './identity.ts'
export {
  assertOidcJwksUrl,
  createJwksOidcIdentityProvider,
  fetchOidcJwks,
  parseRelayJsonWebKeySet,
  type JwksOidcIdentityProviderConfig,
  type RelayJsonWebKeySet,
  type RelayJwksFetch,
} from './oidc-jwks.ts'
export {
  listRelayAccountDevices,
  registerRelayDevice,
  revokeRelayDevice,
  type RegisterRelayDeviceInput,
  type RelayDeviceStore,
  type RevokeRelayDeviceInput,
} from './devices.ts'
export {
  RELAY_CAPABILITIES,
  RELAY_HANDSHAKE_NONCE_BYTES,
  createRelayHandshakeNonce,
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
  parseRelayWireCommand,
  parseRelayWireDelivery,
  parseRelayWireHandshake,
  type RelayWireCommand,
  type RelayWireDelivery,
  type RelayWireHandshake,
} from './wire.ts'
export {
  assertOutboundRelayUrl,
} from './url.ts'
export {
  connectOutboundRelay,
  type AcknowledgeOutboundRelayFrameInput,
  type ConnectOutboundRelayInput,
  type OutboundRelayConnection,
  type SendOutboundRelayFrameInput,
} from './outbound.ts'
export {
  assertOutboundRelayHttpUrl,
  httpUrlFromOutboundRelayUrl,
  issueOutboundRelayToken,
  listOutboundRelayDevices,
  registerOutboundRelayDevice,
  revokeOutboundRelayDevice,
  type OutboundRelayAccessToken,
  type OutboundRelayControlInput,
  type OutboundRelayDevice,
  type OutboundRelayRevocation,
  type RegisterOutboundRelayDeviceInput,
  type RelayControlFetch,
} from './control-client.ts'
export {
  RELAY_ACCESS_TOKEN_TTL_MS,
  createMemoryRelayTokenIssuer,
  issueRelayAccessToken,
  type IssueRelayAccessTokenInput,
  type IssuedRelayAccessToken,
  type RelayTokenIssuer,
} from './tokens.ts'
export {
  routeRelayEnvelope,
  type RelayRouteStore,
  type RouteRelayEnvelopeInput,
} from './route.ts'
export {
  RELAY_RATE_LIMIT_MAX_EVENTS,
  RELAY_RATE_LIMIT_WINDOW_MS,
  createMemoryRelayRateLimiter,
  type MemoryRelayRateLimiterConfig,
  type RelayRateLimiter,
} from './rate-limit.ts'
export {
  createMemoryRelayAuditLog,
  parseRelayAuditEvent,
  recordRelayAuditEvent,
  type RelayAuditAction,
  type RelayAuditEvent,
  type RelayAuditLog,
  type RelayAuditOutcome,
} from './audit.ts'
export {
  acknowledgeRelayMailbox,
  createMemoryRelayMailbox,
  createMemoryRelayPresence,
  deliverRelayEnvelope,
  reclaimRelayMailbox,
  type AcknowledgeRelayMailboxInput,
  type DeliverRelayEnvelopeInput,
  type ReclaimRelayMailboxInput,
  type RelayDelivery,
  type RelayDeliveryOutcome,
  type RelayLiveSink,
  type RelayMailbox,
  type RelayPresence,
} from './delivery.ts'
export {
  assertSealedApplicationEnvelope,
  createSealedRelayEnvelope,
  openSealedRelayPayload,
  type RelayApplicationKind,
  type RelayApplicationPayload,
  type SealedRelayEnvelopeInput,
} from './payload.ts'
