/* Wan Code PWA pairing shell. Never listen. Never store credentials. */
'use strict';
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}
function allowedOrigin(value) {
  var parsed = new URL(value);
  if (parsed.username !== '' || parsed.password !== '') throw new Error('origin');
  parsed.searchParams.forEach(function (_value, key) {
    if (/token|secret|credential|password|authorization/i.test(key)) throw new Error('origin');
  });
  if (parsed.hash.length > 0) throw new Error('origin');
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'))) throw new Error('origin');
  return parsed.origin;
}
function allowedPairingCode(value) {
  if (typeof value !== 'string') throw new Error('pair');
  var trimmed = value.replace(/^\s+|\s+$/g, '');
  if (trimmed === '') return '';
  if (trimmed.indexOf('.') !== -1) throw new Error('pair');
  if (/token|secret|credential|password|authorization/i.test(trimmed)) throw new Error('pair');
  var normalized = trimmed.toUpperCase().replace(/[-\s]/g, '');
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(normalized)) throw new Error('pair');
  return normalized.slice(0, 4) + '-' + normalized.slice(4);
}
function identityRequest(request) {
  return new Promise(function (resolve, reject) {
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(new Error('identity')); };
  });
}
function openIdentityDb() {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.open !== 'function') throw new Error('identity');
  var request = indexedDB.open('wancode-relay-identity', 1);
  request.onupgradeneeded = function () {
    if (!request.result.objectStoreNames.contains('device')) request.result.createObjectStore('device');
  };
  return identityRequest(request);
}
function identityStore(db, mode) {
  return db.transaction('device', mode).objectStore('device');
}
function bytesToBase64(bytes) {
  var view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  var binary = '';
  for (var i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}
function base64ToBytes(value) {
  var binary = atob(value);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function randomDeviceId() {
  var bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}
function mintIdentity() {
  if (!crypto || !crypto.subtle) return Promise.reject(new Error('identity'));
  var subtle = crypto.subtle;
  return Promise.all([
    subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']),
    subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']),
  ]).then(function (pairs) {
    return Promise.all([
      subtle.exportKey('spki', pairs[0].publicKey).then(bytesToBase64),
      subtle.exportKey('pkcs8', pairs[0].privateKey).then(bytesToBase64),
      subtle.exportKey('spki', pairs[1].publicKey).then(bytesToBase64),
      subtle.exportKey('pkcs8', pairs[1].privateKey).then(bytesToBase64),
    ]).then(function (keys) {
      return JSON.stringify({
        protocolVersion: 1,
        deviceId: randomDeviceId(),
        publicKey: keys[0],
        privateKey: keys[1],
        encryptionPublicKey: keys[2],
        encryptionPrivateKey: keys[3],
      });
    });
  });
}
function enrollIdentity() {
  return openIdentityDb().then(function (db) {
    return identityRequest(identityStore(db, 'readonly').get('wancode-relay-identity')).then(function (existing) {
      function publicIdentity(parsed) {
        if (!parsed || typeof parsed.deviceId !== 'string' || !/^[0-9a-f]{32}$/.test(parsed.deviceId)) throw new Error('identity');
        if (typeof parsed.publicKey !== 'string' || typeof parsed.encryptionPublicKey !== 'string' || typeof parsed.privateKey !== 'string' || typeof parsed.encryptionPrivateKey !== 'string') throw new Error('identity');
        return { deviceId: parsed.deviceId, publicKey: parsed.publicKey, encryptionPublicKey: parsed.encryptionPublicKey, privateKey: parsed.privateKey, encryptionPrivateKey: parsed.encryptionPrivateKey };
      }
      if (typeof existing === 'string' && existing.length > 0) return publicIdentity(JSON.parse(existing));
      return mintIdentity().then(function (blob) {
        var minted = JSON.parse(blob);
        return identityRequest(identityStore(db, 'readwrite').put(blob, 'wancode-relay-identity')).then(function () {
          return publicIdentity(minted);
        });
      });
    });
  });
}
function rememberPublicDesktop(desktop, selfDeviceId) {
  if (!desktop || typeof desktop !== 'object' || Array.isArray(desktop)) throw new Error('desktop');
  if ('privateKey' in desktop || 'encryptionPrivateKey' in desktop) throw new Error('desktop');
  if (typeof desktop.deviceId !== 'string' || desktop.deviceId.length === 0 || desktop.deviceId === selfDeviceId) throw new Error('desktop');
  if (typeof desktop.encryptionPublicKey !== 'string' || desktop.encryptionPublicKey.length === 0) throw new Error('desktop');
  sessionStorage.setItem('wancode-relay-desktop', JSON.stringify({ deviceId: desktop.deviceId, encryptionPublicKey: desktop.encryptionPublicKey }));
}
function redeemPairing(origin, pairingCode, identity) {
  return fetch(origin + '/v1/pairing/redeem', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      pairingCode: pairingCode,
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      encryptionPublicKey: identity.encryptionPublicKey,
    }),
  }).then(function (response) {
    return response.json().then(function (json) {
      if (!response.ok) throw new Error('pair');
      if (!json || typeof json !== 'object') throw new Error('pair');
      if ('privateKey' in json || (json.desktop && ('privateKey' in json.desktop || 'encryptionPrivateKey' in json.desktop))) throw new Error('pair');
      if (typeof json.accessToken !== 'string' || json.accessToken.length === 0) throw new Error('pair');
      if (!json.device || typeof json.device.userId !== 'string' || json.device.userId.length === 0) throw new Error('pair');
      return { desktop: json.desktop, userId: json.device.userId, accessToken: json.accessToken };
    });
  });
}
function relaySocketUrl(origin) {
  var parsed = new URL(origin);
  return (parsed.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + parsed.host + '/v1';
}
function signHandshake(identity, userId, now) {
  var nonce = randomDeviceId();
  var claims = {
    direction: 'outbound',
    nonce: nonce,
    publicKey: identity.publicKey,
    capabilities: ['session.observe', 'session.prompt', 'session.approve', 'session.cancel'],
  };
  var canonical = new TextEncoder().encode(JSON.stringify(claims));
  return crypto.subtle.importKey('pkcs8', base64ToBytes(identity.privateKey), { name: 'Ed25519' }, false, ['sign']).then(function (key) {
    return crypto.subtle.sign({ name: 'Ed25519' }, key, canonical);
  }).then(function (signature) {
    return {
      protocolVersion: 1,
      id: 'hs:' + identity.deviceId + ':' + nonce,
      kind: 'handshake',
      sentAt: now,
      actor: { userId: userId, deviceId: identity.deviceId },
      ciphertext: 'v1:hs:' + bytesToBase64(new TextEncoder().encode(JSON.stringify({ claims: claims, signature: bytesToBase64(signature) }))),
    };
  });
}
var pairedSocket;
var pairedSession;
function dialRelay(origin, accessToken, envelope) {
  if (typeof WebSocket !== 'function') return Promise.reject(new Error('pair'));
  return new Promise(function (resolve, reject) {
    var socket = new WebSocket(relaySocketUrl(origin));
    var timer = setTimeout(function () {
      try { socket.close(); } catch (ignored) {}
      reject(new Error('pair'));
    }, 5000);
    socket.addEventListener('open', function () {
      socket.send(JSON.stringify({ accessToken: accessToken, envelope: envelope }));
    });
    socket.addEventListener('message', function (event) {
      clearTimeout(timer);
      if (typeof event.data !== 'string') {
        try { socket.close(); } catch (ignored) {}
        reject(new Error('pair'));
        return;
      }
      try {
        var ack = JSON.parse(event.data);
        if (!ack || ack.kind !== 'handshake-ack') throw new Error('pair');
      } catch (error) {
        try { socket.close(); } catch (ignored) {}
        reject(new Error('pair'));
        return;
      }
      if (pairedSocket && pairedSocket !== socket) {
        try { pairedSocket.close(); } catch (ignored) {}
      }
      pairedSocket = socket;
      resolve(socket);
    }, { once: true });
    socket.addEventListener('error', function () {
      clearTimeout(timer);
      reject(new Error('pair'));
    });
  });
}
function allowedSession(value) {
  if (typeof value !== 'string') throw new Error('follow');
  var trimmed = value.replace(/^\s+|\s+$/g, '');
  if (trimmed === '' || /[\r\n]/.test(trimmed) || /token|secret|credential|password|authorization/i.test(trimmed)) throw new Error('follow');
  return trimmed;
}
function allowedFollow(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192 || /\0/.test(value)) throw new Error('follow');
  return value;
}
function sealBox(senderPrivateKey, senderPublicKey, recipientPublicKey, envelopeId, aad, plaintext) {
  var subtle = crypto.subtle;
  return Promise.all([
    subtle.importKey('pkcs8', base64ToBytes(senderPrivateKey), { name: 'X25519' }, false, ['deriveBits']),
    subtle.importKey('spki', base64ToBytes(recipientPublicKey), { name: 'X25519' }, false, []),
  ]).then(function (keys) {
    return subtle.deriveBits({ name: 'X25519', public: keys[1] }, keys[0], 256);
  }).then(function (shared) {
    return subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']).then(function (hkdfKey) {
      return subtle.deriveBits({
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode(envelopeId),
        info: new TextEncoder().encode('wancode-relay-v1'),
      }, hkdfKey, 256);
    });
  }).then(function (keyBytes) {
    return subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']).then(function (aesKey) {
      var iv = crypto.getRandomValues(new Uint8Array(12));
      return subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: aad, tagLength: 128 }, aesKey, plaintext).then(function (sealedBuf) {
        var sealed = new Uint8Array(sealedBuf);
        if (sealed.byteLength < 16) throw new Error('follow');
        return {
          alg: 'x25519-hkdf-aes-256-gcm',
          senderEncryptionPublicKey: senderPublicKey,
          iv: bytesToBase64(iv),
          tag: bytesToBase64(sealed.slice(sealed.byteLength - 16)),
          ciphertext: bytesToBase64(sealed.slice(0, sealed.byteLength - 16)),
        };
      });
    });
  });
}
function sealFollowUp(session, follow) {
  var now = Date.now();
  var id = 'prompt:' + session.identity.deviceId + ':' + randomDeviceId();
  var payload = { kind: 'prompt', sessionId: follow.sessionId, text: follow.text };
  var actor = { userId: session.userId, deviceId: session.identity.deviceId };
  var aad = new TextEncoder().encode([id, 'prompt', String(now), actor.userId, actor.deviceId, ''].join('\n'));
  var plaintext = new TextEncoder().encode(JSON.stringify(payload));
  return sealBox(session.identity.encryptionPrivateKey, session.identity.encryptionPublicKey, session.desktop.encryptionPublicKey, id, aad, plaintext).then(function (box) {
    return {
      protocolVersion: 1,
      id: id,
      kind: 'prompt',
      sentAt: now,
      actor: actor,
      ciphertext: 'v1:box:' + bytesToBase64(new TextEncoder().encode(JSON.stringify(box))),
    };
  });
}
function sendSealed(session, envelope) {
  if (!session.socket || session.socket.readyState !== 1) return Promise.reject(new Error('follow'));
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      session.socket.removeEventListener('message', onMessage);
      reject(new Error('follow'));
    }, 5000);
    function onMessage(event) {
      if (typeof event.data !== 'string') return;
      try {
        var reply = JSON.parse(event.data);
        if (reply && reply.push) return;
        clearTimeout(timer);
        session.socket.removeEventListener('message', onMessage);
        if (!reply || !reply.delivery || typeof reply.delivery.envelopeId !== 'string') throw new Error('follow');
        resolve(reply.delivery);
      } catch (error) {
        clearTimeout(timer);
        session.socket.removeEventListener('message', onMessage);
        reject(new Error('follow'));
      }
    }
    session.socket.addEventListener('message', onMessage);
    session.socket.send(JSON.stringify({
      accessToken: session.accessToken,
      destinationDeviceId: session.desktop.deviceId,
      envelope: envelope,
    }));
  });
}
function rememberedDesktopId() {
  try {
    var raw = sessionStorage.getItem('wancode-relay-desktop');
    if (raw === null || raw === '') return undefined;
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('desktop');
    if ('privateKey' in parsed || 'encryptionPrivateKey' in parsed) throw new Error('desktop');
    var keys = Object.keys(parsed);
    for (var i = 0; i < keys.length; i++) {
      if (/token|secret|credential|password|authorization|privateKey/i.test(keys[i])) throw new Error('desktop');
    }
    if (keys.length !== 2) throw new Error('desktop');
    if (typeof parsed.deviceId !== 'string' || parsed.deviceId.length === 0 || /[\r\n]/.test(parsed.deviceId)) throw new Error('desktop');
    if (typeof parsed.encryptionPublicKey !== 'string' || parsed.encryptionPublicKey.length === 0) throw new Error('desktop');
    return parsed.deviceId;
  } catch (error) {
    try { sessionStorage.removeItem('wancode-relay-desktop'); } catch (ignored) {}
    return undefined;
  }
}
function pairingStatus(deviceId) {
  var desktopId = rememberedDesktopId();
  if (typeof deviceId === 'string' && desktopId) return 'Device ' + deviceId + ' remembered desktop ' + desktopId + '. Desktop keys stay on that machine.';
  if (typeof deviceId === 'string') return 'Device ' + deviceId + '. Desktop keys stay on that machine.';
  if (desktopId) return 'Remembered desktop ' + desktopId + '. Desktop keys stay on that machine.';
  return 'Do not paste API keys or tokens.';
}
try {
  var saved = sessionStorage.getItem('wancode-relay-origin');
  if (saved) document.getElementById('pair').elements.origin.value = allowedOrigin(saved);
} catch (error) {
  try { sessionStorage.removeItem('wancode-relay-origin'); } catch (ignored) {}
}
document.getElementById('status').textContent = pairingStatus();
document.getElementById('pair').addEventListener('submit', function (event) {
  event.preventDefault();
  var status = document.getElementById('status');
  try {
    var origin = allowedOrigin(event.target.elements.origin.value);
    var pair = allowedPairingCode(event.target.elements.pair.value);
    sessionStorage.setItem('wancode-relay-origin', origin);
    enrollIdentity().then(function (identity) {
      if (!pair) {
        status.textContent = pairingStatus(identity.deviceId);
        return;
      }
      return redeemPairing(origin, pair, identity).then(function (redeemed) {
        return signHandshake(identity, redeemed.userId, Date.now()).then(function (envelope) {
          return dialRelay(origin, redeemed.accessToken, envelope);
        }).then(function (socket) {
          pairedSession = { socket: socket, accessToken: redeemed.accessToken, identity: identity, desktop: redeemed.desktop, userId: redeemed.userId };
          rememberPublicDesktop(redeemed.desktop, identity.deviceId);
          status.textContent = pairingStatus(identity.deviceId);
        });
      });
    }).catch(function (error) {
      if (error && (error.message === 'pair' || error.message === 'desktop')) {
        status.textContent = 'Use a pairing code from the desktop. Do not paste tokens.';
        return;
      }
      status.textContent = 'This browser cannot enroll a device identity.';
    });
  } catch (error) {
    if (error && error.message === 'pair') {
      status.textContent = 'Use a pairing code from the desktop. Do not paste tokens.';
      return;
    }
    try { sessionStorage.removeItem('wancode-relay-origin'); } catch (ignored) {}
    status.textContent = 'Use HTTPS or loopback HTTP. Do not paste secrets.';
  }
});
document.getElementById('follow').addEventListener('submit', function (event) {
  event.preventDefault();
  var status = document.getElementById('status');
  try {
    if (!pairedSession) {
      status.textContent = 'Pair a desktop first.';
      return;
    }
    var follow = { sessionId: allowedSession(event.target.elements.session.value), text: allowedFollow(event.target.elements.follow.value) };
    sealFollowUp(pairedSession, follow).then(function (envelope) {
      return sendSealed(pairedSession, envelope);
    }).then(function () {
      status.textContent = pairingStatus(pairedSession.identity.deviceId) + ' Follow-up sent.';
    }).catch(function () {
      status.textContent = 'Could not send follow-up to that desktop.';
    });
  } catch (error) {
    status.textContent = 'Use a live desktop session. Do not paste tokens.';
  }
});
document.getElementById('forget').addEventListener('click', function () {
  if (pairedSocket) {
    try { pairedSocket.close(); } catch (ignored) {}
  }
  pairedSocket = undefined;
  pairedSession = undefined;
  try { sessionStorage.removeItem('wancode-relay-origin'); } catch (ignored) {}
  try { sessionStorage.removeItem('wancode-relay-desktop'); } catch (ignored) {}
  document.getElementById('pair').elements.origin.value = '';
  document.getElementById('pair').elements.pair.value = '';
  document.getElementById('follow').elements.session.value = '';
  document.getElementById('follow').elements.follow.value = '';
  document.getElementById('status').textContent = 'Forgot this origin. Device identity stays in this browser.';
});
