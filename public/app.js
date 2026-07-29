const $ = (id) => document.getElementById(id);

function setPill(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.className = `pill pill-${kind}`;
}

/* ---- Service worker ---- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      reg.addEventListener('updatefound', () => {
        const incoming = reg.installing;
        if (!incoming) return;
        incoming.addEventListener('statechange', () => {
          // A new version is ready and an old one is still controlling the page.
          if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
            incoming.postMessage('SKIP_WAITING');
          }
        });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        location.reload();
      });
    } catch (error) {
      console.warn('service worker registration failed', error);
    }
  });
}

/* ---- Install prompt ---- */

let deferredPrompt = null;
const installBtn = $('install-btn');

window.addEventListener('beforeinstallprompt', (event) => {
  // Chrome fires this only when the install criteria are met; take control of
  // when the prompt is shown.
  event.preventDefault();
  deferredPrompt = event;
  if (installBtn) installBtn.hidden = false;
});

installBtn?.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.hidden = true;
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  if (installBtn) installBtn.hidden = true;
  setPill($('pwa-status'), 'installed', 'ok');
});

/* ---- Offline banner ---- */

const banner = $('offline-banner');
const syncOnlineState = () => {
  if (banner) banner.hidden = navigator.onLine;
};
window.addEventListener('online', () => {
  syncOnlineState();
  void refreshStatus();
});
window.addEventListener('offline', syncOnlineState);
syncOnlineState();

/* ---- Status ---- */

async function probe(path) {
  // cache: 'no-store' matters — these must not be persisted anywhere.
  const res = await fetch(path, { cache: 'no-store' });
  return res.ok;
}

async function refreshStatus() {
  try {
    setPill($('app-status'), (await probe('/healthz')) ? 'online' : 'error', 'ok');
  } catch {
    setPill($('app-status'), 'unreachable', 'err');
  }

  try {
    const ready = await probe('/readyz');
    setPill($('db-status'), ready ? 'connected' : 'unavailable', ready ? 'ok' : 'err');
  } catch {
    setPill($('db-status'), 'unreachable', 'err');
  }
}

const standalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;
setPill(
  $('pwa-status'),
  standalone ? 'installed' : 'browser tab',
  standalone ? 'ok' : 'idle',
);

void refreshStatus();
