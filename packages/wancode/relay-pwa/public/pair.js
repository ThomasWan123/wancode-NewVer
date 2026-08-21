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
      if (typeof existing === 'string' && existing.length > 0) {
        var parsed = JSON.parse(existing);
        if (parsed && typeof parsed.deviceId === 'string' && /^[0-9a-f]{32}$/.test(parsed.deviceId)) return parsed.deviceId;
        throw new Error('identity');
      }
      return mintIdentity().then(function (blob) {
        var minted = JSON.parse(blob);
        return identityRequest(identityStore(db, 'readwrite').put(blob, 'wancode-relay-identity')).then(function () {
          return minted.deviceId;
        });
      });
    });
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
    sessionStorage.setItem('wancode-relay-origin', origin);
    enrollIdentity().then(function (deviceId) {
      status.textContent = pairingStatus(deviceId);
    }).catch(function () {
      status.textContent = 'This browser cannot enroll a device identity.';
    });
  } catch (error) {
    try { sessionStorage.removeItem('wancode-relay-origin'); } catch (ignored) {}
    status.textContent = 'Use HTTPS or loopback HTTP. Do not paste secrets.';
  }
});
document.getElementById('forget').addEventListener('click', function () {
  try { sessionStorage.removeItem('wancode-relay-origin'); } catch (ignored) {}
  try { sessionStorage.removeItem('wancode-relay-desktop'); } catch (ignored) {}
  document.getElementById('pair').elements.origin.value = '';
  document.getElementById('status').textContent = 'Forgot this origin. Device identity stays in this browser.';
});
