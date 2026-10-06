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

  function showAuthError(msg) { authError.className = 'form-error'; authError.textContent = msg || ''; }

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

  // 20MB keeps things comfortably inside Cloudinary's free tier even with
  // a few videos in the mix; raise it in one place here if that's too tight.
  var MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

  // Images, video, and documents (PDF/Word/etc.) all go through the same
  // /auto/upload endpoint, which inspects the file and returns which kind
  // it detected — the caller renders accordingly (img / video / file link).
  function uploadToCloudinary(file) {
    var cfg = window.CLOUDINARY_CONFIG;
    if (!cfg || !cfg.cloudName || cfg.cloudName === 'PASTE_ME') {
      return Promise.reject(new Error('Upload isn\u2019t configured yet.'));
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return Promise.reject(new Error('That file is over the 20MB limit.'));
    }
    var fd = new FormData();
    fd.append('file', file);
    fd.append('upload_preset', cfg.uploadPreset);
    return fetch('https://api.cloudinary.com/v1_1/' + cfg.cloudName + '/auto/upload', {
      method: 'POST', body: fd
    }).then(function (r) {
      if (!r.ok) throw new Error('Upload failed.');
      return r.json();
    }).then(function (data) {
      return { url: data.secure_url, resourceType: data.resource_type, name: file.name };
    });
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

  document.getElementById('forgot-password-btn').addEventListener('click', function () {
    var email = document.getElementById('signin-email').value.trim();
    if (!email) {
      showAuthError('Enter your email above first, then tap "Forgot password?" again.');
      document.getElementById('signin-email').focus();
      return;
    }
    showAuthError('');
    auth.sendPasswordResetEmail(email).then(function () {
      authError.className = 'form-success';
      authError.textContent = '\u2713 Password reset email sent to ' + email + '.';
    }).catch(function (err) { showAuthError(friendlyError(err)); });
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
    messages: document.getElementById('tab-messages'),
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
  var myLikedPostIds = new Set();
  var expandedComments = new Set();
  var commentsCache = {};
  var commentUnsubs = {};

  function toggleLike(postId, alreadyLiked, postAuthorUid, postTitle) {
    var likeDocId = postId + '_' + currentUid;
    var postRef = db.collection('posts').doc(postId);
    if (alreadyLiked) {
      myLikedPostIds.delete(postId);
      renderFeedOnce();
      return db.collection('postLikes').doc(likeDocId).delete().then(function () {
        return postRef.update({ likeCount: FieldValue.increment(-1) });
      });
    }
    myLikedPostIds.add(postId);
    renderFeedOnce();
    return db.collection('postLikes').doc(likeDocId).set({
      postId: postId, uid: currentUid, createdAt: FieldValue.serverTimestamp()
    }).then(function () { return postRef.update({ likeCount: FieldValue.increment(1) }); })
      .then(function () { return notifyIfNotSelf(postAuthorUid, 'like', { postId: postId, postTitle: postTitle }); });
  }

  function loadMyLikes() {
    return db.collection('postLikes').where('uid', '==', currentUid).get().then(function (snap) {
      myLikedPostIds = new Set();
      snap.forEach(function (doc) { myLikedPostIds.add(doc.data().postId); });
      renderFeedOnce();
    });
  }

  // Comments stay subscribed live only while their section is expanded, so
  // a new comment from someone else appears without reopening the post.
  function subscribeComments(postId) {
    if (commentUnsubs[postId]) return;
    commentUnsubs[postId] = db.collection('postComments').where('postId', '==', postId)
      .onSnapshot(function (snap) {
        var arr = [];
        snap.forEach(function (doc) { var d = doc.data(); d.id = doc.id; arr.push(d); });
        arr.sort(function (a, b) {
          return ((a.createdAt && a.createdAt.seconds) || 0) - ((b.createdAt && b.createdAt.seconds) || 0);
        });
        commentsCache[postId] = arr;
        renderFeedOnce();
      });
  }

  function toggleComments(postId) {
    if (expandedComments.has(postId)) {
      expandedComments.delete(postId);
      if (commentUnsubs[postId]) { commentUnsubs[postId](); delete commentUnsubs[postId]; }
      renderFeedOnce();
      return;
    }
    expandedComments.add(postId);
    renderFeedOnce();
    subscribeComments(postId);
  }

  function buildCommentsSection(postId, postAuthorUid, postTitle) {
    var wrap = document.createElement('div');
    wrap.className = 'comments-section';
    var list = document.createElement('div');
    list.className = 'comments-list';
    var cached = commentsCache[postId];
    if (!cached) {
      list.innerHTML = '<p class="form-note">Loading comments\u2026</p>';
    } else if (!cached.length) {
      list.innerHTML = '<p class="form-note">No comments yet \u2014 be the first.</p>';
    } else {
      cached.forEach(function (c) {
        var row = document.createElement('div');
        row.className = 'comment-row';
        var head = document.createElement('p');
        head.className = 'comment-meta';
        var when = c.createdAt && c.createdAt.toDate ? relTime(c.createdAt.toDate()) : '';
        head.textContent = (c.authorName || 'Member') + (when ? ' \u00b7 ' + when : '');
        var ctext = document.createElement('p');
        ctext.className = 'comment-text';
        ctext.textContent = c.text || '';
        row.appendChild(head); row.appendChild(ctext);
        if (currentUid && (c.authorUid === currentUid || amAdmin)) {
          var del = document.createElement('button');
          del.type = 'button'; del.className = 'btn btn-ghost btn-sm btn-danger comment-del';
          del.textContent = 'Delete';
          del.addEventListener('click', function () {
            del.disabled = true;
            db.collection('postComments').doc(c.id).delete().then(function () {
              return db.collection('posts').doc(postId).update({ commentCount: FieldValue.increment(-1) });
            }).then(function () {
              commentsCache[postId] = (commentsCache[postId] || []).filter(function (x) { return x.id !== c.id; });
              renderFeedOnce();
            }).catch(function () { del.disabled = false; });
          });
          row.appendChild(del);
        }
        list.appendChild(row);
      });
    }
    wrap.appendChild(list);

    if (currentUid) {
      var form = document.createElement('form');
      form.className = 'comment-form';
      var input = document.createElement('input');
      input.type = 'text'; input.className = 'field-input'; input.placeholder = 'Add a comment...'; input.required = true;
      var btn = document.createElement('button');
      btn.type = 'submit'; btn.className = 'btn btn-ghost btn-sm'; btn.textContent = 'Post';
      form.appendChild(input); form.appendChild(btn);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var val = input.value.trim();
        if (!val) return;
        btn.disabled = true;
        input.value = '';
        db.collection('postComments').add({
          postId: postId, authorUid: currentUid,
          authorName: (myProfile && myProfile.displayName) || auth.currentUser.email,
          text: val, createdAt: FieldValue.serverTimestamp()
        }).then(function () {
          return db.collection('posts').doc(postId).update({ commentCount: FieldValue.increment(1) });
        }).then(function () {
          return notifyIfNotSelf(postAuthorUid, 'comment', { postId: postId, postTitle: postTitle });
        }).catch(function () { input.value = val; }).then(function () { btn.disabled = false; });
      });
      wrap.appendChild(form);
    }
    return wrap;
  }

  // Renders a post's attachment appropriately for its kind. Falls back to
  // the older photoURL-only field for posts created before video/document
  // support existed, which always get treated as an image.
  function buildAttachment(p) {
    var url = p.attachmentURL || p.photoURL;
    var type = p.attachmentType || (p.photoURL ? 'image' : null);
    if (!url || !type) return document.createDocumentFragment();

    if (type === 'video') {
      var video = document.createElement('video');
      video.src = url; video.controls = true; video.preload = 'metadata'; video.className = 'story-video';
      return video;
    }
    if (type === 'image') {
      var img = document.createElement('img');
      img.src = url; img.alt = ''; img.className = 'story-photo'; img.loading = 'lazy';
      return img;
    }
    // Anything else (pdf, doc, zip, ...) -> a plain download link, since it
    // can't be meaningfully previewed inline.
    var link = document.createElement('a');
    link.href = url; link.target = '_blank'; link.rel = 'noopener';
    link.className = 'story-file-link';
    link.textContent = '\ud83d\udcce ' + (p.attachmentName || 'Download attachment');
    return link;
  }

  function buildStoryCard(id, p) {
    var card = document.createElement('article');
    card.className = 'story-card';

    if (editingId === id) {
      card.appendChild(buildEditForm(id, p));
      return card;
    }

    card.appendChild(buildAttachment(p));

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

    var reactions = document.createElement('div');
    reactions.className = 'story-reactions';
    var liked = myLikedPostIds.has(id);
    var likeBtn = document.createElement('button');
    likeBtn.type = 'button';
    likeBtn.className = 'reaction-btn' + (liked ? ' liked' : '');
    likeBtn.textContent = (liked ? '\u2764' : '\u2661') + ' ' + (p.likeCount || 0);
    likeBtn.addEventListener('click', function () {
      if (!currentUid) return;
      likeBtn.disabled = true;
      toggleLike(id, liked, p.authorUid, p.title).catch(function () {}).then(function () { likeBtn.disabled = false; });
    });
    reactions.appendChild(likeBtn);
    var commentBtn = document.createElement('button');
    commentBtn.type = 'button';
    commentBtn.className = 'reaction-btn';
    var cc = p.commentCount || 0;
    commentBtn.textContent = '\ud83d\udcac ' + cc + (cc === 1 ? ' comment' : ' comments');
    commentBtn.addEventListener('click', function () { toggleComments(id); });
    reactions.appendChild(commentBtn);
    body.appendChild(reactions);

    if (expandedComments.has(id)) {
      body.appendChild(buildCommentsSection(id, p.authorUid, p.title));
    }

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

    var hasAttachment = !!(p.attachmentURL || p.photoURL);
    var photoRow = document.createElement('label');
    photoRow.className = 'file-label';
    photoRow.textContent = hasAttachment ? 'Replace attachment' : 'Attach a photo, video, or document';
    var photoInput = document.createElement('input');
    photoInput.type = 'file'; photoInput.accept = 'image/*,video/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.zip';
    photoRow.appendChild(photoInput);

    var removeRow = null, removeCheck = null;
    if (hasAttachment) {
      removeRow = document.createElement('label');
      removeRow.className = 'checkbox-label';
      removeCheck = document.createElement('input');
      removeCheck.type = 'checkbox';
      removeRow.appendChild(removeCheck);
      removeRow.appendChild(document.createTextNode(' Remove current attachment'));
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
      status.textContent = file ? 'Uploading\u2026' : 'Saving\u2026';

      var photoWork = file ? uploadToCloudinary(file) : Promise.resolve(undefined);
      photoWork.then(function (result) {
        var update = { title: title, body: bodyText, updatedAt: FieldValue.serverTimestamp() };
        if (file) {
          update.attachmentURL = result.url; update.attachmentType = result.resourceType; update.attachmentName = result.name;
          update.photoURL = null;
        } else if (removeCheck && removeCheck.checked) {
          update.attachmentURL = null; update.attachmentType = null; update.attachmentName = null; update.photoURL = null;
        }
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
    var file = document.getElementById('post-attachment').files[0];
    var submitBtn = postForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    postStatus.textContent = file ? 'Uploading\u2026' : 'Posting\u2026';

    (file ? uploadToCloudinary(file) : Promise.resolve(null)).then(function (result) {
      return db.collection('posts').add({
        title: title,
        body: body,
        attachmentURL: result ? result.url : null,
        attachmentType: result ? result.resourceType : null,
        attachmentName: result ? result.name : null,
        authorUid: user.uid,
        authorName: user.displayName || user.email,
        likeCount: 0,
        commentCount: 0,
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


  /* ---------- delete account ---------- */

  var deleteBtn = document.getElementById('delete-account-btn');
  var deleteForm = document.getElementById('delete-account-form');
  var deleteStatus = document.getElementById('delete-status');

  deleteBtn.addEventListener('click', function () {
    deleteForm.hidden = false; deleteBtn.hidden = true;
    document.getElementById('delete-password').focus();
  });
  document.getElementById('delete-cancel-btn').addEventListener('click', function () {
    deleteForm.reset(); deleteForm.hidden = true; deleteBtn.hidden = false; deleteStatus.textContent = '';
  });

  // Delete every doc a query returns, in batches (Firestore caps at 500).
  function deleteQueryDocs(query) {
    return query.get().then(function (snap) {
      var docs = snap.docs, chain = Promise.resolve();
      for (var i = 0; i < docs.length; i += 400) {
        (function (chunk) {
          chain = chain.then(function () {
            var batch = db.batch();
            chunk.forEach(function (d) { batch.delete(d.ref); });
            return batch.commit();
          });
        })(docs.slice(i, i + 400));
      }
      return chain;
    });
  }

  function deleteMyData(uid) {
    var quiet = function () {};
    // Likes and comments on other people's posts: remove, then fix the counters.
    var likes = db.collection('postLikes').where('uid', '==', uid).get().then(function (snap) {
      return Promise.all(snap.docs.map(function (d) {
        return d.ref.delete().then(function () {
          return db.collection('posts').doc(d.data().postId).update({ likeCount: FieldValue.increment(-1) });
        }).catch(quiet);
      }));
    });
    var comments = db.collection('postComments').where('authorUid', '==', uid).get().then(function (snap) {
      return Promise.all(snap.docs.map(function (d) {
        return d.ref.delete().then(function () {
          return db.collection('posts').doc(d.data().postId).update({ commentCount: FieldValue.increment(-1) });
        }).catch(quiet);
      }));
    });
    return Promise.all([likes, comments]).then(function () {
      return Promise.all([
        deleteQueryDocs(db.collection('posts').where('authorUid', '==', uid)),
        deleteQueryDocs(db.collection('friendRequests').where('fromUid', '==', uid)),
        deleteQueryDocs(db.collection('friendRequests').where('toUid', '==', uid)),
        db.collection('posterRequests').doc(uid).delete().catch(quiet)
      ]);
    }).then(function () {
      return db.collection('users').doc(uid).delete();
    });
  }

  deleteForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var user = auth.currentUser;
    var submitBtn = deleteForm.querySelector('button[type="submit"]');
    if (document.getElementById('delete-confirm').value.trim() !== 'DELETE') {
      deleteStatus.textContent = 'Type DELETE (capitals) to confirm.';
      return;
    }
    submitBtn.disabled = true;
    deleteStatus.className = 'form-note';
    deleteStatus.textContent = 'Deleting\u2026';
    var cred = firebase.auth.EmailAuthProvider.credential(user.email, document.getElementById('delete-password').value);
    // Re-check the password first so nothing is removed on a wrong one.
    user.reauthenticateWithCredential(cred).then(function () {
      return deleteMyData(user.uid);
    }).then(function () {
      return user.delete();
    }).then(function () {
      deleteForm.reset();
      deleteForm.hidden = true; deleteBtn.hidden = false; deleteStatus.textContent = '';
    }).catch(function (err) {
      deleteStatus.className = 'form-error';
      deleteStatus.textContent = (err && err.code === 'auth/wrong-password') || (err && err.code === 'auth/invalid-credential')
        ? 'Wrong password.' : 'Couldn\u2019t delete your account: ' + (err && err.message ? err.message : 'try again.');
    }).then(function () { submitBtn.disabled = false; });
  });

  /* ---------- profile ---------- */

  var myProfile = null;
  var profilePreviewAvatar = document.getElementById('profile-preview-avatar');
  var profilePreviewName = document.getElementById('profile-preview-name');
  var profilePreviewLocation = document.getElementById('profile-preview-location');
  var profilePreviewBio = document.getElementById('profile-preview-bio');

  function renderProfilePreview(overridePhotoUrl) {
    profilePreviewAvatar.innerHTML = '';
    var photo = overridePhotoUrl || (myProfile && myProfile.photoURL);
    if (photo) {
      var img = document.createElement('img');
      img.src = photo; img.alt = ''; img.className = 'avatar-img';
      profilePreviewAvatar.appendChild(img);
    } else {
      var span = document.createElement('span');
      span.className = 'story-avatar';
      span.textContent = initials((myProfile && myProfile.displayName) || '');
      profilePreviewAvatar.appendChild(span);
    }
    profilePreviewName.textContent = (myProfile && myProfile.displayName) || 'Your profile';
    var loc = (myProfile && myProfile.location) || '';
    profilePreviewLocation.textContent = loc ? '\ud83d\udccd ' + loc : '';
    profilePreviewLocation.hidden = !loc;
    var bio = (myProfile && myProfile.bio) || '';
    profilePreviewBio.textContent = bio || 'No bio yet \u2014 tap Edit profile to add one.';
    profilePreviewBio.classList.toggle('is-empty', !bio);
  }

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
      document.getElementById('profile-photo-pending').hidden = true;
      renderProfilePreview();
    });
  }

  // Normal profile view by default; "Edit profile" reveals the form below
  // the (still-live) preview card, Cancel discards any unsaved typing.
  var profileEditBtn = document.getElementById('profile-edit-btn');
  var profileCancelBtn = document.getElementById('profile-cancel-btn');

  function closeEditForm() {
    profileForm.hidden = true;
    profileEditBtn.hidden = false;
    profileName.value = myProfile.displayName || '';
    profileBio.value = myProfile.bio || '';
    profileLocation.value = myProfile.location || '';
    profilePhoto.value = '';
    document.getElementById('profile-photo-pending').hidden = true;
    renderProfilePreview();
  }

  profileEditBtn.addEventListener('click', function () {
    profileForm.hidden = false;
    profileEditBtn.hidden = true;
    profileName.focus();
  });
  profileCancelBtn.addEventListener('click', closeEditForm);

  // Instant preview the moment a photo is picked, before it's even uploaded
  // or saved — clearly marked as a pending preview, with a way to back out
  // so an unsaved choice never looks like it already took effect.
  var profilePhotoPending = document.getElementById('profile-photo-pending');
  var profilePhotoCancel = document.getElementById('profile-photo-cancel');

  profilePhoto.addEventListener('change', function () {
    var file = profilePhoto.files[0];
    if (file) {
      renderProfilePreview(URL.createObjectURL(file));
      profilePhotoPending.hidden = false;
    }
  });
  profilePhotoCancel.addEventListener('click', function () {
    profilePhoto.value = '';
    profilePhotoPending.hidden = true;
    renderProfilePreview();
  });

  profileForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var saveBtn = profileForm.querySelector('button[type="submit"]');
    saveBtn.disabled = true;
    profileStatus.className = 'form-note';
    profileStatus.textContent = profilePhoto.files[0] ? 'Uploading photo\u2026' : 'Saving\u2026';

    var update = {
      displayName: profileName.value.trim(),
      bio: profileBio.value.trim(),
      location: profileLocation.value.trim()
    };
    if (!myProfile.dob && profileDob.value) update.dob = profileDob.value;

    var photoWork = profilePhoto.files[0] ? uploadToCloudinary(profilePhoto.files[0]) : Promise.resolve(undefined);
    photoWork.then(function (result) {
      if (result) update.photoURL = result.url;
      return db.collection('users').doc(currentUid).update(update);
    }).then(function () {
      return auth.currentUser.updateProfile({ displayName: update.displayName });
    }).then(function () {
      profilePhoto.value = '';
      profilePhotoPending.hidden = true;
      profileStatus.className = 'form-success';
      profileStatus.textContent = '\u2713 Saved \u2014 this is now visible to other members.';
      whoAmI.textContent = update.displayName;
      setTimeout(function () {
        profileStatus.textContent = '';
        profileForm.hidden = true;
        profileEditBtn.hidden = false;
      }, 2200);
      return loadMyProfile().then(loadAllUsers).then(renderFeedOnce);
    }).catch(function (err) {
      profileStatus.className = 'form-error';
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
      var actionsWrap = buildRelationshipControl(u);
      var msgBtn = document.createElement('button');
      msgBtn.type = 'button'; msgBtn.className = 'btn btn-ghost btn-sm';
      msgBtn.textContent = '\u2709 Message';
      msgBtn.addEventListener('click', function () { openConversation(u); });
      actionsWrap.appendChild(msgBtn);
      row.appendChild(actionsWrap);
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

  /* ---------- messages ---------- */

  var inboxList = document.getElementById('inbox-list');
  var inboxView = document.getElementById('inbox-view');
  var threadView = document.getElementById('thread-view');
  var threadBack = document.getElementById('thread-back');
  var threadWith = document.getElementById('thread-with');
  var threadMessages = document.getElementById('thread-messages');
  var threadForm = document.getElementById('thread-form');
  var threadInput = document.getElementById('thread-input');

  var inboxUnsub = null;
  var threadUnsub = null;
  var activeConvId = null, activeOtherUid = null;
  var messagesBadge = document.getElementById('messages-badge');

  function convIdFor(otherUid) {
    return currentUid < otherUid ? (currentUid + '_' + otherUid) : (otherUid + '_' + currentUid);
  }

  // Unread tracking uses two fixed fields (lastReadAt0/lastReadAt1) keyed
  // to each conversation's sorted participants array, rather than a map
  // field — simpler to write safely under Firestore rules.
  function myReadField(participants) {
    return participants[0] === currentUid ? 'lastReadAt0' : 'lastReadAt1';
  }
  function isUnread(c) {
    if (c.lastMessageBy === currentUid || !c.lastMessageAt) return false;
    var mine = c[myReadField(c.participants)];
    return !mine || mine.seconds < c.lastMessageAt.seconds;
  }
  function markRead(convId, participants) {
    var field = myReadField(participants);
    var payload = {};
    payload[field] = FieldValue.serverTimestamp();
    return db.collection('conversations').doc(convId).set(payload, { merge: true });
  }

  function loadInbox() {
    if (inboxUnsub) inboxUnsub();
    inboxUnsub = db.collection('conversations')
      .where('participants', 'array-contains', currentUid)
      .onSnapshot(function (snap) {
        var convs = [];
        snap.forEach(function (doc) { convs.push({ id: doc.id, data: doc.data() }); });
        convs.sort(function (a, b) {
          var as = (a.data.lastMessageAt && a.data.lastMessageAt.seconds) || 0;
          var bs = (b.data.lastMessageAt && b.data.lastMessageAt.seconds) || 0;
          return bs - as;
        });

        var unreadCount = convs.filter(function (c) { return isUnread(c.data); }).length;
        messagesBadge.hidden = unreadCount === 0;
        if (unreadCount) messagesBadge.textContent = String(unreadCount);

        if (!convs.length) {
          inboxList.innerHTML = '<p class="form-note">No conversations yet \u2014 message someone from the Members tab.</p>';
          return;
        }
        inboxList.innerHTML = '';
        convs.forEach(function (c) {
          var otherUid = c.data.participants[0] === currentUid ? c.data.participants[1] : c.data.participants[0];
          var other = usersByUid[otherUid];
          var unread = isUnread(c.data);
          var row = document.createElement('div');
          row.className = 'member-row inbox-row' + (unread ? ' unread' : '');
          row.appendChild(avatarEl(otherUid, other ? other.displayName : 'Member'));
          var info = document.createElement('div');
          info.className = 'member-info';
          var name = document.createElement('p');
          name.className = 'member-name';
          name.textContent = (other && other.displayName) || 'Member';
          var preview = document.createElement('p');
          preview.className = 'member-sub';
          var prefix = c.data.lastMessageBy === currentUid ? 'You: ' : '';
          preview.textContent = prefix + (c.data.lastMessage || '');
          info.appendChild(name); info.appendChild(preview);
          row.appendChild(info);
          if (unread) {
            var dot = document.createElement('span');
            dot.className = 'unread-dot';
            row.appendChild(dot);
          }
          row.addEventListener('click', function () { openConversation(other || { id: otherUid, displayName: 'Member' }); });
          inboxList.appendChild(row);
        });
      }, function () {
        inboxList.innerHTML = '<p class="form-note">Couldn\u2019t load messages.</p>';
      });
  }

  function openConversation(otherUser) {
    document.querySelector('#main-tabs .tab-btn[data-tab="messages"]').click();
    activeOtherUid = otherUser.id;
    activeConvId = convIdFor(otherUser.id);
    var participants = [currentUid, otherUser.id].sort();
    threadWith.textContent = otherUser.displayName || 'Member';
    inboxView.hidden = true;
    threadView.hidden = false;
    threadMessages.innerHTML = '<p class="form-note">Loading\u2026</p>';

    db.collection('conversations').doc(activeConvId).set({
      participants: participants
    }, { merge: true }).then(function () { markRead(activeConvId, participants); });

    if (threadUnsub) threadUnsub();
    threadUnsub = db.collection('conversations').doc(activeConvId).collection('messages')
      .orderBy('createdAt')
      .onSnapshot(function (snap) {
        threadMessages.innerHTML = '';
        if (snap.empty) { threadMessages.innerHTML = '<p class="form-note">Say hello \u2014 no messages yet.</p>'; return; }
        snap.forEach(function (doc) {
          var m = doc.data();
          var bubble = document.createElement('div');
          bubble.className = 'msg-bubble ' + (m.fromUid === currentUid ? 'mine' : 'theirs');
          var text = document.createElement('span');
          text.textContent = m.text || '';
          bubble.appendChild(text);
          var time = document.createElement('span');
          time.className = 'msg-time';
          time.textContent = m.createdAt && m.createdAt.toDate ? relTime(m.createdAt.toDate()) : '';
          bubble.appendChild(time);
          threadMessages.appendChild(bubble);
        });
        threadMessages.scrollTop = threadMessages.scrollHeight;
        // Still looking at this thread when a new message lands -> stays read.
        if (activeConvId) markRead(activeConvId, participants);
      }, function () {
        threadMessages.innerHTML = '<p class="form-note">Couldn\u2019t load this conversation.</p>';
      });
  }

  threadBack.addEventListener('click', function () {
    if (threadUnsub) { threadUnsub(); threadUnsub = null; }
    threadView.hidden = true;
    inboxView.hidden = false;
    activeConvId = null; activeOtherUid = null;
  });

  threadForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = threadInput.value.trim();
    if (!text || !activeConvId) return;
    var sendBtn = threadForm.querySelector('button[type="submit"]');
    sendBtn.disabled = true;
    threadInput.value = '';
    db.collection('conversations').doc(activeConvId).collection('messages').add({
      fromUid: currentUid, text: text, createdAt: FieldValue.serverTimestamp()
    }).then(function () {
      return db.collection('conversations').doc(activeConvId).set({
        lastMessage: text, lastMessageAt: FieldValue.serverTimestamp(), lastMessageBy: currentUid
      }, { merge: true });
    }).then(function () {
      return notifyIfNotSelf(activeOtherUid, 'message', { convId: activeConvId });
    }).catch(function () { threadInput.value = text; })
      .then(function () { sendBtn.disabled = false; threadInput.focus(); });
  });

  /* ---------- notifications ---------- */

  var notifBell = document.getElementById('notif-bell');
  var notifBadge = document.getElementById('notif-badge');
  var notifPanel = document.getElementById('notif-panel');
  var notifList = document.getElementById('notif-list');
  var notifUnsub = null;
  var lastNotifs = [];

  // Writes a notification doc for toUid, unless toUid is me (liking or
  // messaging yourself shouldn't notify you). Never blocks the caller on
  // failure — a missed notification isn't worth surfacing an error for.
  function notifyIfNotSelf(toUid, type, extra) {
    if (!toUid || toUid === currentUid) return Promise.resolve();
    var payload = Object.assign({
      toUid: toUid, type: type, fromUid: currentUid,
      fromName: (myProfile && myProfile.displayName) || auth.currentUser.email,
      read: false, createdAt: FieldValue.serverTimestamp()
    }, extra || {});
    return db.collection('notifications').add(payload).catch(function () {});
  }

  function notifText(n) {
    if (n.type === 'like') return (n.fromName || 'Someone') + ' liked your story \u201c' + (n.postTitle || '') + '\u201d';
    if (n.type === 'comment') return (n.fromName || 'Someone') + ' commented on your story \u201c' + (n.postTitle || '') + '\u201d';
    if (n.type === 'message') return (n.fromName || 'Someone') + ' sent you a message';
    return (n.fromName || 'Someone') + ' did something';
  }

  function renderNotifList() {
    var unread = lastNotifs.filter(function (n) { return !n.data.read; }).length;
    notifBadge.hidden = unread === 0;
    if (unread) notifBadge.textContent = String(unread > 9 ? '9+' : unread);

    if (!lastNotifs.length) {
      notifList.innerHTML = '<p class="form-note">No notifications yet.</p>';
      return;
    }
    notifList.innerHTML = '';
    lastNotifs.slice(0, 25).forEach(function (n) {
      var row = document.createElement('div');
      row.className = 'notif-row' + (n.data.read ? '' : ' unread');
      var text = document.createElement('div');
      var main = document.createElement('span');
      main.textContent = notifText(n.data);
      var time = document.createElement('span');
      time.className = 'notif-time';
      time.textContent = n.data.createdAt && n.data.createdAt.toDate ? relTime(n.data.createdAt.toDate()) : '';
      text.appendChild(main); text.appendChild(time);
      row.appendChild(text);
      if (n.data.type === 'message') {
        row.classList.add('clickable');
        row.addEventListener('click', function () {
          notifPanel.hidden = true;
          var other = usersByUid[n.data.fromUid] || { id: n.data.fromUid, displayName: n.data.fromName };
          openConversation(other);
        });
      }
      notifList.appendChild(row);
    });
  }

  function loadNotifications() {
    if (notifUnsub) notifUnsub();
    notifUnsub = db.collection('notifications').where('toUid', '==', currentUid)
      .onSnapshot(function (snap) {
        var arr = [];
        snap.forEach(function (doc) { arr.push({ id: doc.id, data: doc.data() }); });
        arr.sort(function (a, b) {
          return ((b.data.createdAt && b.data.createdAt.seconds) || 0) - ((a.data.createdAt && a.data.createdAt.seconds) || 0);
        });
        lastNotifs = arr;
        renderNotifList();
      }, function () {
        notifList.innerHTML = '<p class="form-note">Couldn\u2019t load notifications.</p>';
      });
  }

  function markAllNotifsRead() {
    var unread = lastNotifs.filter(function (n) { return !n.data.read; });
    unread.forEach(function (n) {
      db.collection('notifications').doc(n.id).update({ read: true }).catch(function () {});
    });
  }

  notifBell.addEventListener('click', function () {
    notifPanel.hidden = !notifPanel.hidden;
    if (!notifPanel.hidden) markAllNotifsRead();
  });

  /* ---------- auth state ---------- */

  auth.onAuthStateChanged(function (user) {
    editingId = null;
    if (!user) {
      if (feedUnsub) { feedUnsub(); feedUnsub = null; }
      if (inboxUnsub) { inboxUnsub(); inboxUnsub = null; }
      if (threadUnsub) { threadUnsub(); threadUnsub = null; }
      if (notifUnsub) { notifUnsub(); notifUnsub = null; }
      Object.keys(commentUnsubs).forEach(function (k) { commentUnsubs[k](); });
      commentUnsubs = {};
      lastSnap = null; lastNotifs = [];
      currentUid = null; amAdmin = false;
      friendUids = new Set(); outgoingByUid = {}; incomingByUid = {};
      myLikedPostIds = new Set(); expandedComments = new Set(); commentsCache = {};
      threadView.hidden = true; inboxView.hidden = false;
      activeConvId = null; activeOtherUid = null;
      notifPanel.hidden = true; notifBadge.hidden = true;
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
    loadMyLikes();
    loadNotifications();

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

    loadAllUsers().then(function () {
      loadRelationships();
      loadInbox();
    });
  });
})();
