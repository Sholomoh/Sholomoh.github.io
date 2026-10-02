/*
 * members.js — sign in/up, profiles, the friend system, the story feed
 * (community + friends, with edit/delete), posting, and the
 * request-to-post / admin-approval flow.
 *
 * Roles (enforced again server-side by firestore.rules — this file only
 * controls what the UI shows):
 *   - admin   -> a doc exists at admins/{uid}   (added by hand in console)
 *   - poster  -> a doc exists at posters/{uid}  (admins can approve these)
 *   - member  -> any other signed-in user (can read, can request to post,
 *                can always use profiles/friends regardless of posting)
 *
 * Friends: represented purely by friendRequests/{fromUid_toUid} docs with
 * status pending/accepted/declined — no separate "friendships" collection.
 * The friends feed is the same posts data as the community feed, just
 * filtered client-side to authors you're friends with.
 *
 * Session length: Firebase Auth is set to LOCAL persistence below, so once
 * someone signs in they stay signed in on that device/browser indefinitely
 * until they tap "Sign out" or clear site data. Only this page loads the
 * Firebase SDK, so visiting other pages and coming back doesn't sign you
 * out — the session is saved in the browser itself.
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
  var FieldValue = firebase.firestore.FieldValue;
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function () {});

  /* ---------- shared DOM refs ---------- */

  var whoAmI = document.getElementById('who-am-i');
  var authError = document.getElementById('auth-error');

  var composerWrap = document.getElementById('composer-wrap');
  var composer = document.getElementById('composer');
  var composerToggle = document.getElementById('composer-toggle');
  var composerCancel = document.getElementById('composer-cancel');
  var requestBox = document.getElementById('request-access');
  var requestBtn = document.getElementById('request-btn');
  var requestStatus = document.getElementById('request-status');
  var feed = document.getElementById('feed');
  var postForm = document.getElementById('post-form');
  var postStatus = document.getElementById('post-status');

  var adminTabBtn = document.getElementById('admin-tab-btn');
  var adminBadge = document.getElementById('admin-badge');
  var requestsList = document.getElementById('requests-list');

  var requestsBadge = document.getElementById('requests-badge');
  var incomingList = document.getElementById('incoming-requests-list');
  var outgoingList = document.getElementById('outgoing-requests-list');

  var membersList = document.getElementById('members-list');

  var profileForm = document.getElementById('profile-form');
  var profileName = document.getElementById('profile-name');
  var profileBio = document.getElementById('profile-bio');
  var profileLocation = document.getElementById('profile-location');
  var profilePhoto = document.getElementById('profile-photo');
  var profileDobWrap = document.getElementById('profile-dob-wrap');
  var profileDob = document.getElementById('profile-dob');
  var profileEmail = document.getElementById('profile-email');
  var profileStatus = document.getElementById('profile-status');

  /* ---------- small helpers ---------- */

  function showAuthError(msg) { authError.textContent = msg || ''; }

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

  function avatarEl(uid, name) {
    var u = usersByUid[uid];
    if (u && u.photoURL) {
      var img = document.createElement('img');
      img.src = u.photoURL; img.alt = ''; img.className = 'avatar-img';
      return img;
    }
    var span = document.createElement('span');
    span.className = 'story-avatar';
    span.textContent = initials(u ? u.displayName : name);
    return span;
  }

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
          bio: '',
          location: '',
          photoURL: null,
          createdAt: FieldValue.serverTimestamp()
        });
      });
    }).catch(function (err) { showAuthError(friendlyError(err)); });
  });

  document.getElementById('signout-btn').addEventListener('click', function () {
    auth.signOut();
  });

  /* ---------- main tabs ---------- */

  var mainTabBtns = document.querySelectorAll('#main-tabs .tab-btn');
  var panels = {
    stories: document.getElementById('tab-stories'),
    members: document.getElementById('tab-members'),
    requests: document.getElementById('tab-requests'),
    profile: document.getElementById('tab-profile'),
    admin: document.getElementById('tab-admin')
  };
  mainTabBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      mainTabBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var tab = btn.getAttribute('data-tab');
      Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== tab; });
    });
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

  /* ---------- feed sub-tabs (community / friends) ---------- */

  var activeSubtab = 'community';
  var subtabBtns = document.querySelectorAll('#feed-subtabs .subtab-btn');
  subtabBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      subtabBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      activeSubtab = btn.getAttribute('data-subtab');
      renderFeedOnce();
    });
  });

  /* ---------- feed (with edit/delete for author or admin) ---------- */

  var feedUnsub = null;
  var currentUid = null, amAdmin = false;
  var editingId = null;
  var lastSnap = null;

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
    head.appendChild(avatarEl(p.authorUid, p.authorName));
    var headText = document.createElement('div');
    var h3 = document.createElement('h3');
    h3.textContent = p.title || '';
    var meta = document.createElement('p');
    meta.className = 'story-meta';
    var when = p.createdAt && p.createdAt.toDate ? relTime(p.createdAt.toDate()) : '';
    var edited = p.updatedAt && p.createdAt && p.updatedAt.seconds !== p.createdAt.seconds;
    meta.textContent = (p.authorName || '') + (when ? ' \u00b7 ' + when : '') + (edited ? ' \u00b7 edited' : '');
    headText.appendChild(h3); headText.appendChild(meta);
    head.appendChild(headText);
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
        var update = { title: title, body: bodyText, updatedAt: FieldValue.serverTimestamp() };
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

  function renderFeedOnce() {
    if (!lastSnap) return;
    var docs = [];
    lastSnap.forEach(function (doc) { docs.push(doc); });
    if (activeSubtab === 'friends') {
      docs = docs.filter(function (doc) { return friendUids.has(doc.data().authorUid); });
    }
    feed.innerHTML = '';
    if (!docs.length) {
      if (activeSubtab === 'friends') {
        var p1 = document.createElement('p');
        p1.className = 'form-note';
        p1.textContent = friendUids.size
          ? 'None of your friends have posted yet.'
          : 'You haven\u2019t connected with anyone yet \u2014';
        var link = document.createElement('a');
        link.href = '#'; link.textContent = ' find members to add';
        link.addEventListener('click', function (e) {
          e.preventDefault();
          document.querySelector('#main-tabs .tab-btn[data-tab="members"]').click();
        });
        feed.appendChild(p1);
        if (!friendUids.size) feed.appendChild(link);
      } else {
        feed.innerHTML = '<p class="form-note">No stories yet.</p>';
      }
      return;
    }
    docs.forEach(function (doc) { feed.appendChild(buildStoryCard(doc.id, doc.data())); });
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
      requestedAt: FieldValue.serverTimestamp()
    }).then(function () {
      requestBtn.hidden = true;
      requestStatus.textContent = 'Request sent \u2014 waiting on approval.';
    }).catch(function () {
      requestBtn.disabled = false;
      requestStatus.textContent = 'Could not send the request. Try again.';
    });
  });

  /* ---------- admin: approve posting requests ---------- */

  function loadPosterRequests() {
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
              approvedAt: FieldValue.serverTimestamp(),
              approvedBy: auth.currentUser.uid
            }),
            db.collection('posterRequests').doc(doc.id).update({ status: 'approved' })
          ]).then(function () { loadPosterRequests(); }).catch(function () { btn.disabled = false; });
        });
        row.appendChild(label);
        row.appendChild(btn);
        requestsList.appendChild(row);
      });
    });
  }

  /* ---------- posting (posters + admins) ---------- */

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
        createdAt: FieldValue.serverTimestamp()
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

  /* ---------- profile ---------- */

  var myProfile = null;

  function loadMyProfile() {
    return db.collection('users').doc(currentUid).get().then(function (doc) {
      myProfile = doc.exists ? doc.data() : {};
      profileName.value = myProfile.displayName || '';
      profileBio.value = myProfile.bio || '';
      profileLocation.value = myProfile.location || '';
      profileEmail.textContent = myProfile.email || auth.currentUser.email || '';
      if (myProfile.dob) {
        profileDobWrap.innerHTML = 'Date of birth (private \u2014 shown only to you)<p class="form-note">' + myProfile.dob + ' (can\u2019t be changed)</p>';
      }
    });
  }

  profileForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var saveBtn = profileForm.querySelector('button[type="submit"]');
    saveBtn.disabled = true;
    profileStatus.textContent = profilePhoto.files[0] ? 'Uploading photo\u2026' : 'Saving\u2026';

    var update = {
      displayName: profileName.value.trim(),
      bio: profileBio.value.trim(),
      location: profileLocation.value.trim()
    };
    if (!myProfile.dob && profileDob.value) update.dob = profileDob.value;

    var photoWork = profilePhoto.files[0] ? uploadToCloudinary(profilePhoto.files[0]) : Promise.resolve(undefined);
    photoWork.then(function (url) {
      if (url) update.photoURL = url;
      return db.collection('users').doc(currentUid).update(update);
    }).then(function () {
      return auth.currentUser.updateProfile({ displayName: update.displayName });
    }).then(function () {
      profileStatus.textContent = 'Saved.';
      whoAmI.textContent = update.displayName;
      setTimeout(function () { profileStatus.textContent = ''; }, 2000);
      return loadMyProfile().then(loadAllUsers).then(renderFeedOnce);
    }).catch(function (err) {
      profileStatus.textContent = 'Could not save: ' + (err && err.message ? err.message : 'try again.');
    }).then(function () { saveBtn.disabled = false; });
  });

  /* ---------- members directory ---------- */

  var usersByUid = {};
  var allUsers = [];

  function loadAllUsers() {
    return db.collection('users').limit(200).get().then(function (snap) {
      usersByUid = {}; allUsers = [];
      snap.forEach(function (doc) {
        var d = doc.data(); d.id = doc.id;
        usersByUid[doc.id] = d;
        if (doc.id !== currentUid) allUsers.push(d);
      });
      allUsers.sort(function (a, b) { return (a.displayName || '').localeCompare(b.displayName || ''); });
      renderMembersList();
    });
  }

  function renderMembersList() {
    if (!allUsers.length) { membersList.innerHTML = '<p class="form-note">No other members yet.</p>'; return; }
    membersList.innerHTML = '';
    allUsers.forEach(function (u) {
      var row = document.createElement('div');
      row.className = 'member-row';
      row.appendChild(avatarEl(u.id, u.displayName));
      var info = document.createElement('div');
      info.className = 'member-info';
      var name = document.createElement('p');
      name.className = 'member-name';
      name.textContent = u.displayName || u.email || 'Member';
      info.appendChild(name);
      if (u.bio || u.location) {
        var sub = document.createElement('p');
        sub.className = 'member-sub';
        sub.textContent = [u.bio, u.location].filter(Boolean).join(' \u00b7 ');
        info.appendChild(sub);
      }
      row.appendChild(info);
      row.appendChild(buildRelationshipControl(u));
      membersList.appendChild(row);
    });
  }

  function buildRelationshipControl(u) {
    var wrap = document.createElement('div');
    wrap.className = 'member-actions';

    if (friendUids.has(u.id)) {
      var tag = document.createElement('span');
      tag.className = 'friend-tag'; tag.textContent = 'Friends';
      var rm = document.createElement('button');
      rm.className = 'btn btn-ghost btn-sm btn-danger'; rm.textContent = 'Remove';
      rm.addEventListener('click', function () { removeRelationship(u.id); });
      wrap.appendChild(tag); wrap.appendChild(rm);
      return wrap;
    }
    if (outgoingByUid[u.id] && outgoingByUid[u.id].status === 'pending') {
      var p = document.createElement('span'); p.className = 'form-note'; p.textContent = 'Requested';
      var cancel = document.createElement('button');
      cancel.className = 'btn btn-ghost btn-sm'; cancel.textContent = 'Cancel';
      cancel.addEventListener('click', function () { removeRelationship(u.id); });
      wrap.appendChild(p); wrap.appendChild(cancel);
      return wrap;
    }
    if (incomingByUid[u.id] && incomingByUid[u.id].status === 'pending') {
      var accept = document.createElement('button');
      accept.className = 'btn btn-primary btn-sm'; accept.textContent = 'Accept';
      accept.addEventListener('click', function () { respondToRequest(incomingByUid[u.id].id, 'accepted'); });
      var decline = document.createElement('button');
      decline.className = 'btn btn-ghost btn-sm'; decline.textContent = 'Decline';
      decline.addEventListener('click', function () { respondToRequest(incomingByUid[u.id].id, 'declined'); });
      wrap.appendChild(accept); wrap.appendChild(decline);
      return wrap;
    }
    var add = document.createElement('button');
    add.className = 'btn btn-ghost btn-sm';
    add.textContent = 'Add friend';
    add.addEventListener('click', function () {
      add.disabled = true;
      sendFriendRequest(u).catch(function () { add.disabled = false; });
    });
    wrap.appendChild(add);
    return wrap;
  }

  /* ---------- friend requests ---------- */

  var friendUids = new Set();
  var outgoingByUid = {};
  var incomingByUid = {};

  function sendFriendRequest(u) {
    var me = currentUid;
    var reverseId = u.id + '_' + me;
    var forwardId = me + '_' + u.id;
    return db.collection('friendRequests').doc(reverseId).get().then(function (doc) {
      if (doc.exists && doc.data().status === 'pending') {
        return db.collection('friendRequests').doc(reverseId).update({
          status: 'accepted', respondedAt: FieldValue.serverTimestamp()
        });
      }
      return db.collection('friendRequests').doc(forwardId).set({
        fromUid: me, fromName: myProfile.displayName || auth.currentUser.email,
        toUid: u.id, toName: u.displayName || u.email,
        status: 'pending', createdAt: FieldValue.serverTimestamp()
      });
    }).then(loadRelationships);
  }

  function respondToRequest(reqId, status) {
    return db.collection('friendRequests').doc(reqId).update({
      status: status, respondedAt: FieldValue.serverTimestamp()
    }).then(loadRelationships);
  }

  function removeRelationship(otherUid) {
    var entry = outgoingByUid[otherUid] || incomingByUid[otherUid];
    if (!entry) return Promise.resolve();
    return db.collection('friendRequests').doc(entry.id).delete().then(loadRelationships);
  }

  function loadRelationships() {
    var uid = currentUid;
    return Promise.all([
      db.collection('friendRequests').where('fromUid', '==', uid).get(),
      db.collection('friendRequests').where('toUid', '==', uid).get()
    ]).then(function (r) {
      friendUids = new Set();
      outgoingByUid = {}; incomingByUid = {};
      var incomingPending = [], outgoingPending = [];
      r[0].forEach(function (doc) {
        var d = doc.data();
        outgoingByUid[d.toUid] = { id: doc.id, status: d.status };
        if (d.status === 'accepted') friendUids.add(d.toUid);
        if (d.status === 'pending') outgoingPending.push({ id: doc.id, uid: d.toUid, name: d.toName });
      });
      r[1].forEach(function (doc) {
        var d = doc.data();
        incomingByUid[d.fromUid] = { id: doc.id, status: d.status };
        if (d.status === 'accepted') friendUids.add(d.fromUid);
        if (d.status === 'pending') incomingPending.push({ id: doc.id, uid: d.fromUid, name: d.fromName });
      });

      requestsBadge.hidden = incomingPending.length === 0;
      if (incomingPending.length) requestsBadge.textContent = String(incomingPending.length);

      renderRequestRows(incomingList, incomingPending, true);
      renderRequestRows(outgoingList, outgoingPending, false);
      renderMembersList();
      renderFeedOnce();
    });
  }

  function renderRequestRows(container, list, isIncoming) {
    if (!list.length) {
      container.innerHTML = '<p class="form-note">' + (isIncoming ? 'No incoming requests.' : 'No pending sent requests.') + '</p>';
      return;
    }
    container.innerHTML = '';
    list.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'request-row';
      var label = document.createElement('span');
      label.textContent = item.name || 'Member';
      row.appendChild(label);
      if (isIncoming) {
        var accept = document.createElement('button');
        accept.className = 'btn btn-primary btn-sm'; accept.textContent = 'Accept';
        accept.addEventListener('click', function () { respondToRequest(item.id, 'accepted'); });
        var decline = document.createElement('button');
        decline.className = 'btn btn-ghost btn-sm'; decline.textContent = 'Decline';
        decline.addEventListener('click', function () { respondToRequest(item.id, 'declined'); });
        row.appendChild(accept); row.appendChild(decline);
      } else {
        var cancel = document.createElement('button');
        cancel.className = 'btn btn-ghost btn-sm'; cancel.textContent = 'Cancel';
        cancel.addEventListener('click', function () { removeRelationship(item.uid); });
        row.appendChild(cancel);
      }
      container.appendChild(row);
    });
  }

  /* ---------- auth state ---------- */

  auth.onAuthStateChanged(function (user) {
    editingId = null;
    if (!user) {
      if (feedUnsub) { feedUnsub(); feedUnsub = null; }
      lastSnap = null;
      currentUid = null; amAdmin = false;
      friendUids = new Set(); outgoingByUid = {}; incomingByUid = {};
      authSection.hidden = false;
      appSection.hidden = true;
      return;
    }
    authSection.hidden = true;
    appSection.hidden = false;
    currentUid = user.uid;
    whoAmI.textContent = user.displayName || user.email;
    renderFeed();
    loadMyProfile();

    Promise.all([
      db.collection('admins').doc(user.uid).get().catch(function () { return { exists: false }; }),
      db.collection('posters').doc(user.uid).get().catch(function () { return { exists: false }; })
    ]).then(function (r) {
      var admin = !!(r[0] && r[0].exists);
      var poster = admin || !!(r[1] && r[1].exists);
      amAdmin = admin;
      composerWrap.hidden = !poster;
      requestBox.hidden = poster;
      adminTabBtn.hidden = !admin;
      if (!poster) checkRequestStatus(user.uid);
      if (admin) loadPosterRequests();
      renderFeedOnce();
    });

    loadAllUsers().then(loadRelationships);
  });
})();
