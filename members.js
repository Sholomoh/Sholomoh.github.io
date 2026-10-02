/*
 * members.js — sign in / sign up, the story feed (with edit/delete), posting,
 * and the request-to-post / admin-approval flow.
 *
 * Roles (enforced again server-side by firestore.rules — this file only
 * controls what the UI shows):
 *   - admin   -> a doc exists at admins/{uid}   (added by hand in console)
 *   - poster  -> a doc exists at posters/{uid}  (admins can approve these)
 *   - member  -> any other signed-in user (can read, can request to post)
 *
 * Session length: Firebase Auth is set to LOCAL persistence below, so once
 * someone signs in they stay signed in on that device/browser indefinitely
 * — no fixed expiry — until they tap "Sign out" or clear site data. Only
 * this page loads the Firebase SDK, so visiting other pages on the site and
 * coming back doesn't sign you out: the session is saved in the browser
 * (IndexedDB), so onAuthStateChanged below picks it straight back up.
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
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function () {});

  var whoAmI = document.getElementById('who-am-i');
  var composerWrap = document.getElementById('composer-wrap');
  var composer = document.getElementById('composer');
  var composerToggle = document.getElementById('composer-toggle');
  var composerCancel = document.getElementById('composer-cancel');
  var requestBox = document.getElementById('request-access');
  var requestBtn = document.getElementById('request-btn');
  var requestStatus = document.getElementById('request-status');
  var adminSection = document.getElementById('admin-section');
  var adminToggle = document.getElementById('admin-toggle');
  var adminPanel = document.getElementById('admin-panel');
  var adminBadge = document.getElementById('admin-badge');
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

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function relTime(date) {
    var diff = (Date.now() - date.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    return date.toLocaleDateString();
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

  /* ---------- composer show/hide ---------- */

  composerToggle.addEventListener('click', function () {
    composer.hidden = !composer.hidden;
    if (!composer.hidden) document.getElementById('post-title').focus();
  });
  composerCancel.addEventListener('click', function () {
    postForm.reset();
    composer.hidden = true;
  });

  /* ---------- admin panel show/hide ---------- */

  adminToggle.addEventListener('click', function () {
    adminPanel.hidden = !adminPanel.hidden;
  });

  /* ---------- feed (with edit/delete for author or admin) ---------- */

  var feedUnsub = null;
  var currentUid = null, amAdmin = false;
  var editingId = null;

  function buildStoryCard(id, p) {
    var card = document.createElement('article');
    card.className = 'story-card';

    if (editingId === id) {
      card.appendChild(buildEditForm(id, p));
      return card;
    }

    if (p.photoURL) {
      var img = document.createElement('img');
      img.src = p.photoURL; img.alt = ''; img.className = 'story-photo'; img.loading = 'lazy';
      card.appendChild(img);
    }

    var body = document.createElement('div');
    body.className = 'story-body';

    var head = document.createElement('div');
    head.className = 'story-head';
    var avatar = document.createElement('span');
    avatar.className = 'story-avatar';
    avatar.textContent = initials(p.authorName);
    var headText = document.createElement('div');
    var h3 = document.createElement('h3');
    h3.textContent = p.title || '';
    var meta = document.createElement('p');
    meta.className = 'story-meta';
    var when = p.createdAt && p.createdAt.toDate ? relTime(p.createdAt.toDate()) : '';
    var edited = p.updatedAt && p.createdAt && p.updatedAt.seconds !== p.createdAt.seconds;
    meta.textContent = (p.authorName || '') + (when ? ' \u00b7 ' + when : '') + (edited ? ' \u00b7 edited' : '');
    headText.appendChild(h3); headText.appendChild(meta);
    head.appendChild(avatar); head.appendChild(headText);
    body.appendChild(head);

    var text = document.createElement('p');
    text.className = 'story-text';
    text.textContent = p.body || '';
    body.appendChild(text);

    if (currentUid && (p.authorUid === currentUid || amAdmin)) {
      var actions = document.createElement('div');
      actions.className = 'story-actions';
      var editBtn = document.createElement('button');
      editBtn.type = 'button'; editBtn.className = 'btn btn-ghost btn-sm';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', function () { editingId = id; renderFeedOnce(); });
      var delBtn = document.createElement('button');
      delBtn.type = 'button'; delBtn.className = 'btn btn-ghost btn-sm btn-danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', function () {
        if (!window.confirm('Delete this story? This can\u2019t be undone.')) return;
        delBtn.disabled = true;
        db.collection('posts').doc(id).delete().catch(function () { delBtn.disabled = false; });
      });
      actions.appendChild(editBtn); actions.appendChild(delBtn);
      body.appendChild(actions);
    }

    card.appendChild(body);
    return card;
  }

  function buildEditForm(id, p) {
    var wrap = document.createElement('div');
    wrap.className = 'story-body';

    var titleInput = document.createElement('input');
    titleInput.type = 'text'; titleInput.className = 'field-input'; titleInput.value = p.title || '';
    var bodyInput = document.createElement('textarea');
    bodyInput.className = 'story-input'; bodyInput.value = p.body || '';

    var photoRow = document.createElement('label');
    photoRow.className = 'file-label';
    photoRow.textContent = p.photoURL ? 'Replace photo' : 'Add photo';
    var photoInput = document.createElement('input');
    photoInput.type = 'file'; photoInput.accept = 'image/*';
    photoRow.appendChild(photoInput);

    var removeRow = null, removeCheck = null;
    if (p.photoURL) {
      removeRow = document.createElement('label');
      removeRow.className = 'checkbox-label';
      removeCheck = document.createElement('input');
      removeCheck.type = 'checkbox';
      removeRow.appendChild(removeCheck);
      removeRow.appendChild(document.createTextNode(' Remove current photo'));
    }

    var status = document.createElement('p');
    status.className = 'form-note';

    var actions = document.createElement('div');
    actions.className = 'form-actions';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button'; saveBtn.className = 'btn btn-primary'; saveBtn.textContent = 'Save';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn btn-ghost btn-sm'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function () { editingId = null; renderFeedOnce(); });
    actions.appendChild(saveBtn); actions.appendChild(cancelBtn);

    saveBtn.addEventListener('click', function () {
      var title = titleInput.value.trim();
      var bodyText = bodyInput.value.trim();
      if (!title || !bodyText) { status.textContent = 'Title and story can\u2019t be empty.'; return; }
      var file = photoInput.files[0];
      saveBtn.disabled = true;
      status.textContent = file ? 'Uploading photo\u2026' : 'Saving\u2026';

      var photoWork = file ? uploadToCloudinary(file) : Promise.resolve(undefined);
      photoWork.then(function (url) {
        var update = {
          title: title, body: bodyText,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        if (file) update.photoURL = url;
        else if (removeCheck && removeCheck.checked) update.photoURL = null;
        return db.collection('posts').doc(id).update(update);
      }).then(function () {
        editingId = null;
        renderFeedOnce();
      }).catch(function (err) {
        status.textContent = 'Could not save: ' + (err && err.message ? err.message : 'try again.');
        saveBtn.disabled = false;
      });
    });

    wrap.appendChild(titleInput);
    wrap.appendChild(bodyInput);
    wrap.appendChild(photoRow);
    if (removeRow) wrap.appendChild(removeRow);
    wrap.appendChild(actions);
    wrap.appendChild(status);
    return wrap;
  }

  var lastSnap = null;

  function renderFeedOnce() {
    if (!lastSnap) return;
    feed.innerHTML = '';
    if (lastSnap.empty) { feed.innerHTML = '<p class="form-note">No stories yet.</p>'; return; }
    lastSnap.forEach(function (doc) { feed.appendChild(buildStoryCard(doc.id, doc.data())); });
  }

  function renderFeed() {
    if (feedUnsub) feedUnsub();
    feedUnsub = db.collection('posts').orderBy('createdAt', 'desc').limit(50)
      .onSnapshot(function (snap) {
        lastSnap = snap;
        renderFeedOnce();
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
      adminBadge.hidden = snap.empty;
      if (!snap.empty) adminBadge.textContent = String(snap.size);
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
          ]).then(function () {
            row.remove();
            var n = requestsList.querySelectorAll('.request-row').length;
            adminBadge.hidden = n === 0;
            adminBadge.textContent = String(n);
            if (n === 0) requestsList.innerHTML = '<p class="form-note">No pending requests.</p>';
          }).catch(function () { btn.disabled = false; });
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
      composer.hidden = true;
      setTimeout(function () { postStatus.textContent = ''; }, 2500);
    }).catch(function (err) {
      postStatus.textContent = 'Could not post: ' + (err && err.message ? err.message : 'try again.');
    }).then(function () { submitBtn.disabled = false; });
  });

  /* ---------- auth state ---------- */

  auth.onAuthStateChanged(function (user) {
    editingId = null;
    if (!user) {
      if (feedUnsub) { feedUnsub(); feedUnsub = null; }
      lastSnap = null;
      currentUid = null; amAdmin = false;
      authSection.hidden = false;
      appSection.hidden = true;
      return;
    }
    authSection.hidden = true;
    appSection.hidden = false;
    currentUid = user.uid;
    whoAmI.textContent = user.displayName || user.email;
    renderFeed();

    Promise.all([
      db.collection('admins').doc(user.uid).get().catch(function () { return { exists: false }; }),
      db.collection('posters').doc(user.uid).get().catch(function () { return { exists: false }; })
    ]).then(function (r) {
      var admin = !!(r[0] && r[0].exists);
      var poster = admin || !!(r[1] && r[1].exists);
      amAdmin = admin;
      composerWrap.hidden = !poster;
      requestBox.hidden = poster;
      adminSection.hidden = !admin;
      if (!poster) checkRequestStatus(user.uid);
      if (admin) loadRequests();
      renderFeedOnce();
    });
  });
})();
