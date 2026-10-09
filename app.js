/* App behaviour shared by every page: registers the service worker, offers "Install app",
   announces updates, and tells the visitor when they go offline. */
(function () {
  'use strict';
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  var DISMISS_KEY = 'sholomoh:installDismissed';
  var DAYS14 = 14 * 24 * 3600 * 1000;

  function dismissedRecently() {
    try { return Date.now() - Number(localStorage.getItem(DISMISS_KEY) || 0) < DAYS14; } catch (e) { return false; }
  }
  function rememberDismiss() { try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) {} }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  /* ---------- toast (updates, offline) ---------- */
  var toastEl = null;
  function hideToast() { if (toastEl) { toastEl.remove(); toastEl = null; } }
  function showToast(message, actionLabel, onAction, autoHideMs) {
    hideToast();
    toastEl = el('div', 'app-toast');
    toastEl.setAttribute('role', 'status');
    toastEl.appendChild(el('span', '', message));
    if (actionLabel) {
      var b = el('button', 'app-toast-btn', actionLabel);
      b.type = 'button';
      b.addEventListener('click', function () { onAction(); });
      toastEl.appendChild(b);
    }
    document.body.appendChild(toastEl);
    if (autoHideMs) setTimeout(hideToast, autoHideMs);
  }

  /* ---------- service worker + updates ---------- */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    var hadController = !!navigator.serviceWorker.controller;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        function offerUpdate(worker) {
          showToast('A new version is ready.', 'Reload', function () { worker.postMessage({ type: 'SKIP_WAITING' }); });
        }
        if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
        reg.addEventListener('updatefound', function () {
          var nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', function () {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(nw);
          });
        });
      }).catch(function () {});
    });
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloading) return;   // first install also "changes" controller: don't reload
      reloading = true;
      location.reload();
    });
  }

  /* ---------- offline / online ---------- */
  window.addEventListener('offline', function () { showToast('You\u2019re offline \u2014 some features won\u2019t work.'); });
  window.addEventListener('online', function () { showToast('Back online.', null, null, 2500); });

  /* ---------- install ---------- */
  if (standalone) return;                                   // already running as an app
  var deferred = null;
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  var bannerEl = null;

  function hideBanner() { if (bannerEl) { bannerEl.remove(); bannerEl = null; } }

  function showBanner(text, actionLabel, onAction) {
    if (bannerEl || dismissedRecently()) return;
    bannerEl = el('div', 'app-banner');
    bannerEl.setAttribute('role', 'dialog');
    bannerEl.setAttribute('aria-label', 'Install app');
    bannerEl.appendChild(el('span', 'app-banner-text', text));
    var row = el('span', 'app-banner-actions');
    if (actionLabel) {
      var go = el('button', 'app-banner-go', actionLabel);
      go.type = 'button';
      go.addEventListener('click', function () { onAction(); });
      row.appendChild(go);
    }
    var no = el('button', 'app-banner-no', 'Not now');
    no.type = 'button';
    no.addEventListener('click', function () { rememberDismiss(); hideBanner(); });
    row.appendChild(no);
    bannerEl.appendChild(row);
    document.body.appendChild(bannerEl);
  }

  function promptInstall() {
    if (!deferred) return;
    deferred.prompt();
    var d = deferred;
    deferred = null;
    hideBanner();
    if (d.userChoice) d.userChoice.then(function (c) { if (c && c.outcome !== 'accepted') rememberDismiss(); });
  }

  // A permanent "Install app" link in the footer, for anyone who dismissed the banner.
  function addFooterLink(onClick) {
    var footer = document.querySelector('footer p');
    if (!footer || document.getElementById('install-link')) return;
    var b = el('button', 'install-link', '\uD83D\uDCF2 Install app');
    b.type = 'button'; b.id = 'install-link';
    b.addEventListener('click', onClick);
    footer.appendChild(document.createTextNode(' \u00b7 '));
    footer.appendChild(b);
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    addFooterLink(promptInstall);
    setTimeout(function () { showBanner('Install this site as an app on your device.', 'Install', promptInstall); }, 3500);
  });
  window.addEventListener('appinstalled', function () { deferred = null; hideBanner(); var l = document.getElementById('install-link'); if (l) l.remove(); });

  if (isIOS) {
    // iPhone/iPad Safari can't show an install button; it needs a manual step.
    var iosHelp = function () { showToast('Tap the Share button, then \u201cAdd to Home Screen\u201d.', null, null, 7000); };
    addFooterLink(iosHelp);
    setTimeout(function () { showBanner('Add this site to your Home Screen to use it like an app.', 'How', iosHelp); }, 4000);
  }
})();
