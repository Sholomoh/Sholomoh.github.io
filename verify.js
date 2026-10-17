/* Email verification banner: shown to signed-in members whose email isn't verified yet.
   Grandfathered accounts (from before verification) keep full access and see a gentle note. */
(function () {
  'use strict';
  var box = document.getElementById('verify-banner');
  if (!box || typeof firebase === 'undefined' || !window.FIREBASE_CONFIG) return;
  if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
  var auth = firebase.auth();
  var db = firebase.firestore();
  var cooldownTimer = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function hide() { box.hidden = true; box.innerHTML = ''; }

  function show(user, grandfathered) {
    box.innerHTML = '';
    var text = el('p', 'verify-text', grandfathered
      ? 'Your account was created before email checks. Verifying your email helps keep it secure. You keep full access either way.'
      : 'Please verify your email to post, comment, message and join. Check your inbox, and your spam folder too.');
    box.appendChild(text);
    var status = el('p', 'verify-status', '');
    var row = el('div', 'verify-row');
    var send = el('button', 'btn btn-primary btn-sm', 'Send verification email'); send.type = 'button';
    send.addEventListener('click', function () {
      send.disabled = true;
      user.sendEmailVerification().then(function () {
        status.textContent = 'Sent. Open the link in your email, then tap “I’ve verified”.';
        var left = 60;
        clearInterval(cooldownTimer);
        cooldownTimer = setInterval(function () {
          left--;
          if (left <= 0) { clearInterval(cooldownTimer); send.disabled = false; send.textContent = 'Send again'; }
          else { send.textContent = 'Send again in ' + left + 's'; }
        }, 1000);
      }).catch(function (err) {
        send.disabled = false;
        status.textContent = err && err.code === 'auth/too-many-requests'
          ? 'Too many emails sent. Please wait a few minutes.'
          : 'Couldn’t send it. Check your connection and try again.';
      });
    });
    var check = el('button', 'btn btn-ghost btn-sm', 'I’ve verified'); check.type = 'button';
    check.addEventListener('click', function () {
      check.disabled = true;
      // Reload the account and refresh the sign-in token so the new "verified" status is picked up.
      user.reload().then(function () { return user.getIdToken(true); }).then(function () {
        var now = auth.currentUser;
        if (now && now.emailVerified) { status.textContent = '✓ Verified. Thank you.'; setTimeout(hide, 1500); }
        else { status.textContent = 'Not verified yet. Open the link in your email first.'; check.disabled = false; }
      }).catch(function () { check.disabled = false; status.textContent = 'Couldn’t check right now. Try again.'; });
    });
    row.appendChild(send); row.appendChild(check);
    box.appendChild(row);
    box.appendChild(status);
    box.hidden = false;
  }

  auth.onAuthStateChanged(function (user) {
    if (!user || user.emailVerified) { hide(); return; }
    db.collection('legacyAccounts').doc(user.uid).get().then(function (d) {
      show(user, d.exists);
    }).catch(function () { show(user, false); });
  });
})();
