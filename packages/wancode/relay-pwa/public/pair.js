/* Wan Code PWA pairing shell. Never listen. Never store credentials. */
'use strict';
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}
document.getElementById('pair').addEventListener('submit', function (event) {
  event.preventDefault();
  var status = document.getElementById('status');
  try {
    var parsed = new URL(event.target.elements.origin.value);
    if (parsed.username !== '' || parsed.password !== '') throw new Error('origin');
    parsed.searchParams.forEach(function (_value, key) {
      if (/token|secret|credential|password|authorization/i.test(key)) throw new Error('origin');
    });
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'))) throw new Error('origin');
    status.textContent = 'Desktop keys stay on that machine.';
  } catch (error) {
    status.textContent = 'Use HTTPS or loopback HTTP. Do not paste secrets.';
  }
});
