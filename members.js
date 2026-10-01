/*
 * members.js — sign in / sign up, the story feed, posting, and the
 * request-to-post / admin-approval flow.
 *
 * Roles (all enforced again server-side by firestore.rules, this file only
 * controls what the UI shows):
 *   - admin   -> a doc exists at admins/{uid}   (added by hand in console)
 *   - poster  -> a doc exists at posters/{uid}  (admins can approve these)
 *   - member  -> any other signed-in user (can read, can request to post)
 */
(function () {
  'use strict';

  var authSection = document.getElementById('auth-section');
  var appSection = document.getElementById('app-section');

  if (typeof firebase === 'undefined') {
    authSection.innerHTML = '<p class="form-note">Sign-in couldn\u2019t load. Check your connection and refresh.</p>';
    return;
  }
  if (!window.FIREBASE_CONFIG || window.FIREBASE_CONFIG.apiKey === 'PASTE_ME') {
    authSection.innerHTML = '<p class="form-note">Sign-in isn\u2019t configured yet.</p>';
    return;
  }

  firebase.initializeApp(window.FIREBASE_CONFIG);
  var auth = firebase.auth();
  var db = firebase.firestore();

  var whoAmI = document.getElementById('who-am-i');
  var composer = document.getElementById('composer');
  var requestBox = document.getElementById('request-access');
  var requestBtn = document.getElementById('request-btn');
  var requestStatus = document.getElementById('request-status');
  var adminPanel = document.getElementById('admin-panel');
  var requestsList = document.getElementById('requests-list');
  var feed = document.getElementById('feed');
  var postForm = document.getElementById('post-form');
  var postStatus = document.getElementById('post-status');
  var authError = document.getElementById('auth-error');

  function showAuthError(msg) { authError.textContent = msg || ''; }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function friendlyError(err) {
    var m = {
      'auth/invalid-email': 'That email address looks off.',
      'auth/user-not-found': 'No account with that email.',
      'auth/wrong-password': 'Wrong password.',
      'auth/invalid-credential': 'Wrong email or password.',
      'auth/email-already-in-use': 'An account with that email already exists.',
      'auth/weak-password': 'Password should be at least 6 characters.'
    };
    return (err && (m[err.code] || err.message)) || 'Something went wrong.';
  }

  /* ---------- auth tabs + forms ---------- */

  var tabs = document.querySelectorAll('.auth-tab');
  var signinForm = document.getElementById('signin-form');
  var signupForm = document.getElementById('signup-form');

  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      tabs.forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      var tab = t.getAttribute('data-tab');
      signinForm.hidden = tab !== 'signin';
      signupForm.hidden = tab !== 'signup';
      showAuthError('');
    });
  });

  signinForm.addEventListener('submit', function (e) {
    e.preventDefault();
    showAuthError('');
    var email = document.getElementById('signin-email').value.trim();
    var pw = document.getElementById('signin-password').value;
    auth.signInWithEmailAndPassword(email, pw).catch(function (err) {
      showAuthError(friendlyError(err));
    });
  });

  signupForm.addEventListener('submit', function (e) {
    e.preventDefault();
    showAuthError('');
    var name = document.getElementById('signup-name').value.trim();
    var email = document.getElementById('signup-email').value.trim();
    var pw = document.getElementById('signup-password').value;
    auth.createUserWithEmailAndPassword(email, pw).then(function (cred) {
      return cred.user.updateProfile({ displayName: name }).then(function () {
        return db.collection('users').doc(cred.user.uid).set({
          email: email,
          displayName: name,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
    }).catch(function (err) { showAuthError(friendlyError(err)); });
  });

  document.getElementById('signout-btn').addEventListener('click', function () {
    auth.signOut();
  });

  /* ---------- feed ---------- */

  var feedUnsub = null;

  function renderFeed() {
    if (feedUnsub) { feedUnsub(); }
    feedUnsub = db.collection('posts').orderBy('createdAt', 'desc').limit(50)
      .onSnapshot(function (snap) {
        if (snap.empty) { feed.innerHTML = '<p class="form-note">No stories yet.</p>'; return; }
        feed.innerHTML = '';
        snap.forEach(function (doc) {
          var p = doc.data();
          var when = p.createdAt && p.createdAt.toDate ? p.createdAt.toDate().toLocaleDateString() : '';
          var card = document.createElement('article');
          card.className = 'story-card';
          card.innerHTML =
            (p.photoURL ? '<img src="' + p.photoURL + '" alt="" class="story-photo" loading="lazy">' : '') +
            '<div class="story-body">' +
              '<h3>' + escapeHtml(p.title || '') + '</h3>' +
              '<p class="story-meta">' + escapeHtml(p.authorName || '') + (when ? ' \u00b7 ' + when : '') + '</p>' +
              '<p class="story-text">' + escapeHtml(p.body || '') + '</p>' +
            '</div>';
          feed.appendChild(card);
        });
      }, function () {
        feed.innerHTML = '<p class="form-note">Couldn\u2019t load stories.</p>';
      });
  }

  /* ---------- request-to-post ---------- */

  function checkRequestStatus(uid) {
    db.collection('posterRequests').doc(uid).get().then(function (doc) {
      if (doc.exists && doc.data().status === 'pending') {
        requestBtn.hidden = true;
        requestStatus.textContent = 'Request sent \u2014 waiting on approval.';
      } else {
        requestBtn.hidden = false;
        requestBtn.disabled = false;
        requestStatus.textContent = '';
      }
    });
  }

  requestBtn.addEventListener('click', function () {
    var user = auth.currentUser;
    if (!user) return;
    requestBtn.disabled = true;
    db.collection('posterRequests').doc(user.uid).set({
      email: user.email,
      displayName: user.displayName || user.email,
      status: 'pending',
      requestedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function () {
      requestBtn.hidden = true;
      requestStatus.textContent = 'Request sent \u2014 waiting on approval.';
    }).catch(function () {
      requestBtn.disabled = false;
      requestStatus.textContent = 'Could not send the request. Try again.';
    });
  });

  /* ---------- admin: approve requests ---------- */

  function loadRequests() {
    db.collection('posterRequests').where('status', '==', 'pending').get().then(function (snap) {
      if (snap.empty) { requestsList.innerHTML = '<p class="form-note">No pending requests.</p>'; return; }
      requestsList.innerHTML = '';
      snap.forEach(function (doc) {
        var r = doc.data();
        var row = document.createElement('div');
        row.className = 'request-row';
        var label = document.createElement('span');
        label.textContent = (r.displayName || r.email) + ' ';
        var sub = document.createElement('span');
        sub.className = 'muted-inline';
        sub.textContent = '(' + r.email + ')';
        label.appendChild(sub);
        var btn = document.createElement('button');
        btn.className = 'btn btn-ghost btn-sm';
        btn.textContent = 'Approve';
        btn.addEventListener('click', function () {
          btn.disabled = true;
          Promise.all([
            db.collection('posters').doc(doc.id).set({
              approvedAt: firebase.firestore.FieldValue.serverTimestamp(),
              approvedBy: auth.currentUser.uid
            }),
            db.collection('posterRequests').doc(doc.id).update({ status: 'approved' })
          ]).then(function () { row.remove(); }).catch(function () { btn.disabled = false; });
        });
        row.appendChild(label);
        row.appendChild(btn);
        requestsList.appendChild(row);
      });
    });
  }

  /* ---------- posting (posters + admins) ---------- */

  function uploadToCloudinary(file) {
    var cfg = window.CLOUDINARY_CONFIG;
    if (!cfg || !cfg.cloudName || cfg.cloudName === 'PASTE_ME') {
      return Promise.reject(new Error('Photo upload isn\u2019t configured yet.'));
    }
    var fd = new FormData();
    fd.append('file', file);
    fd.append('upload_preset', cfg.uploadPreset);
    return fetch('https://api.cloudinary.com/v1_1/' + cfg.cloudName + '/image/upload', {
      method: 'POST', body: fd
    }).then(function (r) {
      if (!r.ok) throw new Error('Photo upload failed.');
      return r.json();
    }).then(function (data) { return data.secure_url; });
  }

  postForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var user = auth.currentUser;
    if (!user) return;
    var title = document.getElementById('post-title').value.trim();
    var body = document.getElementById('post-body').value.trim();
    var file = document.getElementById('post-photo').files[0];
    var submitBtn = postForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    postStatus.textContent = file ? 'Uploading photo\u2026' : 'Posting\u2026';

    (file ? uploadToCloudinary(file) : Promise.resolve(null)).then(function (url) {
      return db.collection('posts').add({
        title: title,
        body: body,
        photoURL: url,
        authorUid: user.uid,
        authorName: user.displayName || user.email,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }).then(function () {
      postForm.reset();
      postStatus.textContent = 'Posted.';
      setTimeout(function () { postStatus.textContent = ''; }, 2500);
    }).catch(function (err) {
      postStatus.textContent = 'Could not post: ' + (err && err.message ? err.message : 'try again.');
    }).then(function () { submitBtn.disabled = false; });
  });

  /* ---------- auth state ---------- */

  auth.onAuthStateChanged(function (user) {
    if (!user) {
      if (feedUnsub) { feedUnsub(); feedUnsub = null; }
      authSection.hidden = false;
      appSection.hidden = true;
      return;
    }
    authSection.hidden = true;
    appSection.hidden = false;
    whoAmI.textContent = user.displayName || user.email;
    renderFeed();

    Promise.all([
      db.collection('admins').doc(user.uid).get().catch(function () { return { exists: false }; }),
      db.collection('posters').doc(user.uid).get().catch(function () { return { exists: false }; })
    ]).then(function (r) {
      var admin = !!(r[0] && r[0].exists);
      var poster = admin || !!(r[1] && r[1].exists);
      composer.hidden = !poster;
      requestBox.hidden = poster;
      adminPanel.hidden = !admin;
      if (!poster) checkRequestStatus(user.uid);
      if (admin) loadRequests();
    });
  });
})();
