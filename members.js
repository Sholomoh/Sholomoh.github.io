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
  var profileInterests = document.getElementById('profile-interests');
  var profileHideLocation = document.getElementById('profile-hide-location');
  var profileHideStats = document.getElementById('profile-hide-stats');
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
      if (tab !== 'members' && typeof closeMemberProfile === 'function') closeMemberProfile();
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
  var heldBack = {};          // new stories from others, hidden until the pill is tapped
  var newestSeen = 0;         // newest createdAt (ms) already accounted for
  var feedInitialised = false;
  var feedSearch = document.getElementById('feed-search');
  var feedSort = document.getElementById('feed-sort');
  var feedFilter = document.getElementById('feed-filter');
  var newPill = document.getElementById('new-stories-pill');
  var FEED_PAGE = 50;
  var feedLimit = FEED_PAGE;
  var expandedStories = new Set();
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

  function goToAuthor(uid) {
    if (!uid) return;
    if (uid === currentUid) {
      document.querySelector('#main-tabs .tab-btn[data-tab="profile"]').click();
      return;
    }
    var u = usersByUid[uid];
    if (!u) return;
    document.querySelector('#main-tabs .tab-btn[data-tab="members"]').click();
    openMemberProfile(u);
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
    var headAv = avatarEl(p.authorUid, p.authorName);
    headAv.classList.add('clickable');
    headAv.addEventListener('click', function () { goToAuthor(p.authorUid); });
    head.appendChild(headAv);
    var headText = document.createElement('div');
    var h3 = document.createElement('h3');
    h3.textContent = p.title || '';
    var meta = document.createElement('p');
    meta.className = 'story-meta';
    var when = p.createdAt && p.createdAt.toDate ? relTime(p.createdAt.toDate()) : '';
    var edited = p.updatedAt && p.createdAt && p.updatedAt.seconds !== p.createdAt.seconds;
    var authorLink = document.createElement('span');
    authorLink.className = 'author-link';
    authorLink.textContent = p.authorName || '';
    authorLink.addEventListener('click', function () { goToAuthor(p.authorUid); });
    meta.appendChild(authorLink);
    meta.appendChild(document.createTextNode((when ? ' \u00b7 ' + when : '') + (edited ? ' \u00b7 edited' : '')));
    headText.appendChild(h3); headText.appendChild(meta);
    head.appendChild(headText);
    body.appendChild(head);

    var text = document.createElement('p');
    text.className = 'story-text';
    text.textContent = p.body || '';
    body.appendChild(text);
    var fullText = String(p.body || '');
    if (fullText.length > 300 || fullText.split('\n').length > 6) {
      var open = expandedStories.has(id);
      if (!open) text.classList.add('clamped');
      var more = document.createElement('button');
      more.type = 'button'; more.className = 'read-more-btn';
      more.textContent = open ? 'Show less' : 'Read more';
      more.addEventListener('click', function () {
        var nowOpen = text.classList.toggle('clamped') === false;
        if (nowOpen) expandedStories.add(id); else expandedStories.delete(id);
        more.textContent = nowOpen ? 'Show less' : 'Read more';
      });
      body.appendChild(more);
    }

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

  function updatePill() {
    var n = Object.keys(heldBack).length;
    newPill.hidden = n === 0;
    if (n) newPill.textContent = '\u2191 ' + n + ' new ' + (n === 1 ? 'story' : 'stories');
  }

  function trackNewStories(snap) {
    var ids = {};
    var maxMs = newestSeen;
    var reading = window.scrollY > 150;
    snap.forEach(function (doc) {
      ids[doc.id] = true;
      var d = doc.data();
      var cd = toDate(d.createdAt);
      var ms = cd ? cd.getTime() : 0;
      if (feedInitialised && ms > newestSeen && d.authorUid !== currentUid && reading) heldBack[doc.id] = true;
      if (ms > maxMs) maxMs = ms;
    });
    Object.keys(heldBack).forEach(function (id) { if (!ids[id]) delete heldBack[id]; });
    newestSeen = maxMs;
    feedInitialised = true;
  }

  newPill.addEventListener('click', function () {
    heldBack = {};
    renderFeedOnce();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  feedSearch.addEventListener('input', function () { renderFeedOnce(); });
  feedSort.addEventListener('change', function () { renderFeedOnce(); });
  feedFilter.addEventListener('change', function () { renderFeedOnce(); });

  function appendLoadMore() {
    if (!lastSnap || lastSnap.size < feedLimit) return;
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn btn-ghost load-more-btn';
    btn.textContent = 'Load older stories';
    btn.addEventListener('click', function () {
      btn.disabled = true; btn.textContent = 'Loading\u2026';
      feedLimit += FEED_PAGE;
      renderFeed();
    });
    feed.appendChild(btn);
  }

  function renderFeedOnce() {
    if (!lastSnap) return;
    var docs = [];
    lastSnap.forEach(function (doc) { docs.push(doc); });
    if (activeSubtab === 'friends') {
      docs = docs.filter(function (doc) { return friendUids.has(doc.data().authorUid); });
    }
    docs = docs.filter(function (doc) { return !heldBack[doc.id]; });
    var q = feedSearch.value.trim().toLowerCase();
    var filtersActive = !!q || feedFilter.value !== 'all';
    if (q) {
      docs = docs.filter(function (doc) {
        var d = doc.data();
        return [d.title, d.body, d.authorName].join(' ').toLowerCase().indexOf(q) !== -1;
      });
    }
    if (feedFilter.value === 'media') {
      docs = docs.filter(function (doc) { var d = doc.data(); return !!(d.attachmentURL || d.photoURL); });
    }
    if (feedSort.value === 'liked') {
      docs.sort(function (a, b) {
        var diff = num(b.data().likeCount) - num(a.data().likeCount);
        if (diff) return diff;
        var ad = toDate(a.data().createdAt), bd = toDate(b.data().createdAt);
        return (bd ? bd.getTime() : 0) - (ad ? ad.getTime() : 0);
      });
    }
    updatePill();
    feed.innerHTML = '';
    if (!docs.length && filtersActive) {
      feed.innerHTML = '<p class="form-note">No loaded stories match. Try \u201cLoad older stories\u201d below.</p>';
      appendLoadMore();
      return;
    }
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
      appendLoadMore();
      return;
    }
    docs.forEach(function (doc) { feed.appendChild(buildStoryCard(doc.id, doc.data())); });
    appendLoadMore();
  }

  function renderFeed() {
    if (feedUnsub) feedUnsub();
    feedUnsub = db.collection('posts').orderBy('createdAt', 'desc').limit(feedLimit)
      .onSnapshot(function (snap) {
        lastSnap = snap;
        trackNewStories(snap);
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

  /* ---------- profile stats, story lists, public profile ---------- */

  var profileStatsEl = document.getElementById('profile-stats');
  var profileStoriesEl = document.getElementById('profile-stories');
  var memberProfileEl = document.getElementById('member-profile');
  var memberProfileCard = document.getElementById('member-profile-card');
  var memberProfileStories = document.getElementById('member-profile-stories');

  // Older stories/users may be missing fields (or have odd values), so every
  // read below is defensive: counts default to 0, dates tolerate several shapes.
  function num(v) { v = Number(v); return isFinite(v) && v > 0 ? Math.floor(v) : 0; }
  function toDate(t) {
    if (!t) return null;
    if (typeof t.toDate === 'function') return t.toDate();
    if (t instanceof Date) return t;
    if (typeof t.seconds === 'number') return new Date(t.seconds * 1000);
    if (typeof t === 'number' || typeof t === 'string') { var d = new Date(t); return isNaN(d) ? null : d; }
    return null;
  }

  function loadUserPosts(uid) {
    // No orderBy here on purpose: avoids needing a composite index; sort client-side.
    return db.collection('posts').where('authorUid', '==', uid).get().then(function (snap) {
      var arr = [];
      snap.forEach(function (doc) { arr.push({ id: doc.id, data: doc.data() }); });
      arr.sort(function (a, b) {
        var ad = toDate(a.data.createdAt), bd = toDate(b.data.createdAt);
        return (bd ? bd.getTime() : 0) - (ad ? ad.getTime() : 0);
      });
      return arr;
    });
  }

  function fmtJoined(u) {
    var t = toDate(u && u.createdAt);
    return t ? t.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '\u2014';
  }

  function renderStats(el, posts, u, friendCount) {
    var likes = posts.reduce(function (n, p) { return n + num(p.data.likeCount); }, 0);
    var items = [[posts.length, 'Stories'], [likes, 'Likes']];
    if (friendCount !== null && friendCount !== undefined) items.push([friendCount, 'Friends']);
    items.push([fmtJoined(u), 'Joined']);
    el.innerHTML = '';
    items.forEach(function (it) {
      var box = document.createElement('div');
      box.className = 'profile-stat';
      var v = document.createElement('span'); v.className = 'profile-stat-value'; v.textContent = it[0];
      var l = document.createElement('span'); l.className = 'profile-stat-label'; l.textContent = it[1];
      box.appendChild(v); box.appendChild(l);
      el.appendChild(box);
    });
  }

  function buildMiniStory(item, opts) {
    opts = opts || {};
    var p = item.data;
    var isPinned = !!opts.pinnedId && item.id === opts.pinnedId;
    var card = document.createElement('article');
    card.className = 'mini-story' + (isPinned ? ' is-pinned' : '');
    var url = p.attachmentURL || p.photoURL;
    var type = p.attachmentType || (p.photoURL ? 'image' : null);
    if (url && type === 'image') {
      var img = document.createElement('img');
      img.src = url; img.alt = ''; img.loading = 'lazy'; img.className = 'mini-story-thumb';
      card.appendChild(img);
    }
    var body = document.createElement('div');
    body.className = 'mini-story-body';
    var h = document.createElement('h3'); h.textContent = (isPinned ? '\ud83d\udccc ' : '') + String(p.title || 'Untitled');
    var meta = document.createElement('p'); meta.className = 'story-meta';
    var cd = toDate(p.createdAt);
    var when = cd ? relTime(cd) : '';
    var kindIcon = (url && type === 'video') ? ' \u00b7 \ud83c\udfac' : (url && type !== 'image') ? ' \u00b7 \ud83d\udcce' : '';
    meta.textContent = when + (when ? ' \u00b7 ' : '') + '\u2764 ' + num(p.likeCount) + ' \u00b7 \ud83d\udcac ' + num(p.commentCount) + kindIcon;
    var snip = document.createElement('p'); snip.className = 'mini-story-text';
    var t = String(p.body || '');
    snip.textContent = t.length > 140 ? t.slice(0, 140).trim() + '\u2026' : t;
    body.appendChild(h); body.appendChild(meta); body.appendChild(snip);
    if (opts.canPin) {
      var pin = document.createElement('button');
      pin.type = 'button'; pin.className = 'btn btn-ghost btn-sm mini-pin-btn';
      pin.textContent = isPinned ? 'Unpin' : 'Pin to profile';
      pin.addEventListener('click', function () { pin.disabled = true; opts.onPin(isPinned ? null : item.id); });
      body.appendChild(pin);
    }
    card.appendChild(body);
    return card;
  }

  function renderMiniStories(el, posts, emptyMsg, opts) {
    el.innerHTML = '';
    if (!posts.length) { el.innerHTML = '<p class="form-note"></p>'; el.firstChild.textContent = emptyMsg; return; }
    posts.forEach(function (it) { el.appendChild(buildMiniStory(it, opts)); });
  }

  function refreshMyProfileExtras() {
    if (!currentUid) return;
    loadUserPosts(currentUid).then(function (posts) {
      renderStats(profileStatsEl, posts, myProfile || {}, friendUids.size);
      var pinnedId = myProfile && myProfile.pinnedPostId;
      renderMiniStories(profileStoriesEl, pinFirst(posts, pinnedId), 'You haven\u2019t posted any stories yet.', {
        pinnedId: pinnedId, canPin: true,
        onPin: function (id) {
          db.collection('users').doc(currentUid).update({ pinnedPostId: id }).then(function () {
            if (myProfile) myProfile.pinnedPostId = id;
            refreshMyProfileExtras();
          }).catch(function () { refreshMyProfileExtras(); });
        }
      });
    }).catch(function () {
      profileStoriesEl.innerHTML = '<p class="form-note">Couldn\u2019t load your stories.</p>';
    });
  }

  function buildPublicProfileCard(u) {
    var card = document.createElement('div');
    card.className = 'profile-preview';
    var banner = document.createElement('div'); banner.className = 'profile-banner';
    applyCover(banner, u.coverURL);
    var body = document.createElement('div'); body.className = 'profile-preview-body';
    var top = document.createElement('div'); top.className = 'profile-preview-top';
    var av = document.createElement('span'); av.className = 'profile-avatar-wrap';
    av.appendChild(avatarEl(u.id, u.displayName));
    top.appendChild(av);
    var actions = buildRelationshipControl(u);
    var msgBtn = document.createElement('button');
    msgBtn.type = 'button'; msgBtn.className = 'btn btn-ghost btn-sm';
    msgBtn.textContent = '\u2709 Message';
    msgBtn.addEventListener('click', function () { openConversation(u); });
    actions.appendChild(msgBtn);
    top.appendChild(actions);
    body.appendChild(top);
    var name = document.createElement('p'); name.className = 'profile-preview-name';
    name.textContent = u.displayName || 'Member';
    body.appendChild(name);
    if (u.location && canSee(u, 'hideLocation')) {
      var loc = document.createElement('p'); loc.className = 'profile-preview-location';
      loc.textContent = '\ud83d\udccd ' + u.location;
      body.appendChild(loc);
    }
    var bio = document.createElement('p');
    bio.className = 'profile-preview-bio' + (u.bio ? '' : ' is-empty');
    bio.textContent = u.bio || 'No bio yet.';
    body.appendChild(bio);
    var chips = document.createElement('div'); chips.className = 'chips';
    renderChips(chips, interestsOf(u));
    body.appendChild(chips);
    var stats = document.createElement('div'); stats.className = 'profile-stats'; stats.id = 'member-profile-stats';
    body.appendChild(stats);
    card.appendChild(banner); card.appendChild(body);
    return card;
  }

  var openProfileUid = null;
  function openMemberProfile(u) {
    openProfileUid = u.id;
    membersList.hidden = true;
    document.querySelector('#tab-members .page-intro-sm').hidden = true;
    memberProfileEl.hidden = false;
    memberProfileCard.innerHTML = '';
    memberProfileCard.appendChild(buildPublicProfileCard(u));
    memberProfileStories.innerHTML = '<p class="form-note">Loading\u2026</p>';
    loadUserPosts(u.id).then(function (posts) {
      if (openProfileUid !== u.id) return;
      var statsEl = document.getElementById('member-profile-stats');
      if (canSee(u, 'hideStats')) {
        renderStats(statsEl, posts, u, null);
      } else {
        statsEl.innerHTML = '<p class="form-note">Stats are visible to friends only.</p>';
      }
      renderMiniStories(memberProfileStories, pinFirst(posts, u.pinnedPostId), 'No stories yet.', { pinnedId: u.pinnedPostId });
    }).catch(function () {
      memberProfileStories.innerHTML = '<p class="form-note">Couldn\u2019t load stories.</p>';
    });
    window.scrollTo({ top: 0 });
  }

  function closeMemberProfile() {
    openProfileUid = null;
    memberProfileEl.hidden = true;
    membersList.hidden = false;
    document.querySelector('#tab-members .page-intro-sm').hidden = false;
  }
  document.getElementById('member-profile-back').addEventListener('click', closeMemberProfile);

  /* ---------- profile ---------- */

  var myProfile = null;
  var profilePreviewAvatar = document.getElementById('profile-preview-avatar');
  var profilePreviewName = document.getElementById('profile-preview-name');
  var profilePreviewLocation = document.getElementById('profile-preview-location');
  var profilePreviewBio = document.getElementById('profile-preview-bio');

  /* ---------- photo crop ---------- */
  var croppedPhotoFile = null;
  var cropModal = document.getElementById('crop-modal');
  var cropCanvas = document.getElementById('crop-canvas');
  var cropCtx = cropCanvas.getContext('2d');
  var cropZoom = document.getElementById('crop-zoom');
  var CROP = { img: null, ox: 0, oy: 0, dragging: false, lx: 0, ly: 0 };
  var CROP_VIEW = 280, CROP_OUT = 512;

  function cropScale() { return Math.max(CROP_VIEW / CROP.img.width, CROP_VIEW / CROP.img.height) * parseFloat(cropZoom.value); }
  function clampCrop() {
    var s = cropScale();
    var maxX = Math.max(0, (CROP.img.width * s - CROP_VIEW) / 2);
    var maxY = Math.max(0, (CROP.img.height * s - CROP_VIEW) / 2);
    CROP.ox = Math.min(maxX, Math.max(-maxX, CROP.ox));
    CROP.oy = Math.min(maxY, Math.max(-maxY, CROP.oy));
  }
  function drawCrop(ctx, size, withMask) {
    var k = size / CROP_VIEW, s = cropScale() * k;
    var w = CROP.img.width * s, h = CROP.img.height * s;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#0a1420'; ctx.fillRect(0, 0, size, size);
    ctx.drawImage(CROP.img, (size - w) / 2 + CROP.ox * k, (size - h) / 2 + CROP.oy * k, w, h);
    if (withMask) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath(); ctx.rect(0, 0, size, size);
      ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2, true);
      ctx.fill('evenodd');
      ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }
  function openCrop(file) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      CROP.img = img; CROP.ox = 0; CROP.oy = 0; cropZoom.value = 1;
      drawCrop(cropCtx, CROP_VIEW, true);
      cropModal.hidden = false;
    };
    img.onerror = function () { profilePhoto.value = ''; };
    img.src = url;
  }
  cropZoom.addEventListener('input', function () { clampCrop(); drawCrop(cropCtx, CROP_VIEW, true); });
  cropCanvas.addEventListener('pointerdown', function (e) {
    CROP.dragging = true; CROP.lx = e.clientX; CROP.ly = e.clientY;
    cropCanvas.setPointerCapture(e.pointerId);
  });
  cropCanvas.addEventListener('pointermove', function (e) {
    if (!CROP.dragging) return;
    CROP.ox += e.clientX - CROP.lx; CROP.oy += e.clientY - CROP.ly;
    CROP.lx = e.clientX; CROP.ly = e.clientY;
    clampCrop(); drawCrop(cropCtx, CROP_VIEW, true);
  });
  ['pointerup', 'pointercancel'].forEach(function (ev) {
    cropCanvas.addEventListener(ev, function () { CROP.dragging = false; });
  });
  document.getElementById('crop-cancel').addEventListener('click', function () {
    cropModal.hidden = true; profilePhoto.value = ''; croppedPhotoFile = null;
  });
  document.getElementById('crop-apply').addEventListener('click', function () {
    var out = document.createElement('canvas');
    out.width = CROP_OUT; out.height = CROP_OUT;
    drawCrop(out.getContext('2d'), CROP_OUT, false);
    out.toBlob(function (blob) {
      cropModal.hidden = true;
      if (!blob) { profilePhoto.value = ''; return; }
      croppedPhotoFile = new File([blob], 'profile.jpg', { type: 'image/jpeg' });
      renderProfilePreview(URL.createObjectURL(blob));
      profilePhotoPending.hidden = false;
    }, 'image/jpeg', 0.9);
  });

  /* ---------- privacy + pinned story helpers ---------- */
  function canSee(u, flag) { return !u[flag] || friendUids.has(u.id); }

  function pinFirst(posts, pinnedId) {
    if (!pinnedId) return posts;
    var hit = posts.filter(function (p) { return p.id === pinnedId; });
    if (!hit.length) return posts;
    return hit.concat(posts.filter(function (p) { return p.id !== pinnedId; }));
  }

  var BIO_MAX = 160;

  function parseInterests(str) {
    var seen = {}, out = [];
    String(str || '').split(',').forEach(function (s) {
      s = s.trim().replace(/\s+/g, ' ').slice(0, 24);
      var key = s.toLowerCase();
      if (s && !seen[key] && out.length < 6) { seen[key] = true; out.push(s); }
    });
    return out;
  }

  function interestsOf(u) {
    return Array.isArray(u && u.interests) ? u.interests.filter(function (x) { return typeof x === 'string' && x; }).slice(0, 6) : [];
  }

  function renderChips(el, list, max) {
    el.innerHTML = '';
    list.slice(0, max || 6).forEach(function (t) {
      var c = document.createElement('span');
      c.className = 'chip'; c.textContent = t;
      el.appendChild(c);
    });
    el.hidden = !list.length;
  }

  function updateBioCount() {
    var n = profileBio.value.length;
    var el = document.getElementById('profile-bio-count');
    el.textContent = n + '/' + BIO_MAX;
    el.classList.toggle('over', n > BIO_MAX);
  }
  profileBio.addEventListener('input', updateBioCount);

  function applyCover(bannerEl, url) {
    if (url) {
      bannerEl.style.backgroundImage = 'url("' + String(url).replace(/"/g, '%22') + '")';
      bannerEl.classList.add('has-cover');
    } else {
      bannerEl.style.backgroundImage = '';
      bannerEl.classList.remove('has-cover');
    }
  }

  function renderCompleteness() {
    var p = myProfile || {};
    var steps = [
      [!!p.photoURL, 'a profile photo'],
      [!!(p.bio && p.bio.trim()), 'a bio'],
      [!!(p.location && p.location.trim()), 'your location'],
      [!!p.coverURL, 'a cover photo']
    ];
    var done = steps.filter(function (s) { return s[0]; }).length;
    var box = document.getElementById('profile-complete');
    if (done === steps.length) { box.hidden = true; return; }
    var missing = steps.filter(function (s) { return !s[0]; }).map(function (s) { return s[1]; });
    var pct = Math.round(done / steps.length * 100);
    document.getElementById('profile-complete-text').textContent = 'Add ' + missing[0] + (missing.length > 1 ? ' (+' + (missing.length - 1) + ' more)' : '') + ' to finish your profile';
    document.getElementById('profile-complete-pct').textContent = pct + '%';
    document.getElementById('profile-complete-fill').style.width = pct + '%';
    box.hidden = false;
  }

  var removeCoverFlag = false;

  function renderProfilePreview(overridePhotoUrl, overrideCoverUrl) {
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
    var coverUrl = overrideCoverUrl !== undefined ? overrideCoverUrl : (removeCoverFlag ? null : (myProfile && myProfile.coverURL));
    applyCover(document.getElementById('profile-banner'), coverUrl);
    profilePreviewName.textContent = (myProfile && myProfile.displayName) || 'Your profile';
    var loc = (myProfile && myProfile.location) || '';
    profilePreviewLocation.textContent = loc ? '\ud83d\udccd ' + loc : '';
    profilePreviewLocation.hidden = !loc;
    var bio = (myProfile && myProfile.bio) || '';
    profilePreviewBio.textContent = bio || 'No bio yet \u2014 tap Edit profile to add one.';
    profilePreviewBio.classList.toggle('is-empty', !bio);
    renderChips(document.getElementById('profile-preview-chips'), interestsOf(myProfile));
    renderCompleteness();
    document.getElementById('profile-cover-remove').hidden = !(myProfile && myProfile.coverURL) || removeCoverFlag;
  }

  function loadMyProfile() {
    return db.collection('users').doc(currentUid).get().then(function (doc) {
      myProfile = doc.exists ? doc.data() : {};
      profileName.value = myProfile.displayName || '';
      profileBio.value = myProfile.bio || '';
      profileInterests.value = interestsOf(myProfile).join(', ');
      profileHideLocation.checked = !!myProfile.hideLocation;
      profileHideStats.checked = !!myProfile.hideStats;
      updateBioCount();
      profileLocation.value = myProfile.location || '';
      profileEmail.textContent = myProfile.email || auth.currentUser.email || '';
      if (myProfile.dob) {
        profileDobWrap.innerHTML = 'Date of birth (private \u2014 shown only to you)<p class="form-note">' + myProfile.dob + ' (can\u2019t be changed)</p>';
      }
      document.getElementById('profile-photo-pending').hidden = true;
      removeCoverFlag = false;
      renderProfilePreview();
      refreshMyProfileExtras();
    });
  }

  // Normal profile view by default; "Edit profile" reveals the form below
  // the (still-live) preview card, Cancel discards any unsaved typing.
  var profileEditBtn = document.getElementById('profile-edit-btn');
  var profileCancelBtn = document.getElementById('profile-cancel-btn');

  var profileCover = document.getElementById('profile-cover');
  var profileCoverPending = document.getElementById('profile-cover-pending');
  profileCover.addEventListener('change', function () {
    var file = profileCover.files[0];
    if (file) {
      removeCoverFlag = false;
      renderProfilePreview(undefined, URL.createObjectURL(file));
      profileCoverPending.hidden = false;
    }
  });
  document.getElementById('profile-cover-cancel').addEventListener('click', function () {
    profileCover.value = '';
    profileCoverPending.hidden = true;
    renderProfilePreview();
  });
  document.getElementById('profile-cover-remove').addEventListener('click', function () {
    removeCoverFlag = true;
    profileCover.value = '';
    profileCoverPending.hidden = true;
    renderProfilePreview();
  });

  function closeEditForm() {
    removeCoverFlag = false;
    profileCover.value = '';
    profileCoverPending.hidden = true;
    profileForm.hidden = true;
    profileEditBtn.hidden = false;
    profileName.value = myProfile.displayName || '';
    profileBio.value = myProfile.bio || '';
    profileInterests.value = interestsOf(myProfile).join(', ');
    updateBioCount();
    profileLocation.value = myProfile.location || '';
    profileHideLocation.checked = !!myProfile.hideLocation;
    profileHideStats.checked = !!myProfile.hideStats;
    profilePhoto.value = ''; croppedPhotoFile = null;
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
    if (file) openCrop(file);
  });
  profilePhotoCancel.addEventListener('click', function () {
    profilePhoto.value = ''; croppedPhotoFile = null;
    profilePhotoPending.hidden = true;
    renderProfilePreview();
  });

  profileForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var saveBtn = profileForm.querySelector('button[type="submit"]');
    saveBtn.disabled = true;
    profileStatus.className = 'form-note';
    profileStatus.textContent = (croppedPhotoFile || profileCover.files[0]) ? 'Uploading\u2026' : 'Saving\u2026';

    var update = {
      displayName: profileName.value.trim(),
      bio: profileBio.value.trim(),
      location: profileLocation.value.trim(),
      interests: parseInterests(profileInterests.value),
      hideLocation: profileHideLocation.checked,
      hideStats: profileHideStats.checked
    };
    if (!myProfile.dob && profileDob.value) update.dob = profileDob.value;

    var photoWork = croppedPhotoFile ? uploadToCloudinary(croppedPhotoFile) : Promise.resolve(undefined);
    var coverWork = profileCover.files[0] ? uploadToCloudinary(profileCover.files[0]) : Promise.resolve(undefined);
    Promise.all([photoWork, coverWork]).then(function (rs) {
      if (rs[0]) update.photoURL = rs[0].url;
      if (rs[1]) update.coverURL = rs[1].url;
      else if (removeCoverFlag) update.coverURL = null;
      return db.collection('users').doc(currentUid).update(update);
    }).then(function () {
      return auth.currentUser.updateProfile({ displayName: update.displayName });
    }).then(function () {
      profilePhoto.value = ''; croppedPhotoFile = null;
      profilePhotoPending.hidden = true;
      profileCover.value = '';
      profileCoverPending.hidden = true;
      removeCoverFlag = false;
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

  var memberSearch = document.getElementById('member-search');
  var memberSort = document.getElementById('member-sort');
  memberSearch.addEventListener('input', function () { renderMembersList(); });
  memberSort.addEventListener('change', function () { renderMembersList(); });

  function visibleMembers() {
    var q = memberSearch.value.trim().toLowerCase();
    var list = allUsers.filter(function (u) {
      if (!q) return true;
      var hay = [u.displayName, canSee(u, 'hideLocation') ? u.location : '', u.bio].concat(interestsOf(u)).join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    if (memberSort.value === 'new') {
      list.sort(function (a, b) {
        var ad = toDate(a.createdAt), bd = toDate(b.createdAt);
        return (bd ? bd.getTime() : 0) - (ad ? ad.getTime() : 0);
      });
    } else {
      list.sort(function (a, b) { return (a.displayName || '').localeCompare(b.displayName || ''); });
    }
    return list;
  }

  function renderMembersList() {
    if (!allUsers.length) { membersList.innerHTML = '<p class="form-note">No other members yet.</p>'; return; }
    var shown = visibleMembers();
    membersList.innerHTML = '';
    if (!shown.length) { membersList.innerHTML = '<p class="form-note">No members match your search.</p>'; return; }
    shown.forEach(function (u) {
      var row = document.createElement('div');
      row.className = 'member-row';
      var av = avatarEl(u.id, u.displayName);
      av.classList.add('clickable');
      av.addEventListener('click', function () { openMemberProfile(u); });
      row.appendChild(av);
      var info = document.createElement('div');
      info.className = 'member-info';
      var name = document.createElement('p');
      name.className = 'member-name clickable';
      name.addEventListener('click', function () { openMemberProfile(u); });
      name.textContent = u.displayName || u.email || 'Member';
      info.appendChild(name);
      var shownLoc = canSee(u, 'hideLocation') ? u.location : '';
      if (u.bio || shownLoc) {
        var sub = document.createElement('p');
        sub.className = 'member-sub';
        sub.textContent = [u.bio, shownLoc].filter(Boolean).join(' \u00b7 ');
        info.appendChild(sub);
      }
      var rowChips = interestsOf(u);
      if (rowChips.length) {
        var cw = document.createElement('div'); cw.className = 'chips chips-sm';
        renderChips(cw, rowChips, 3);
        info.appendChild(cw);
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
      refreshMyProfileExtras();
      if (openProfileUid && usersByUid[openProfileUid]) {
        var cu = usersByUid[openProfileUid];
        var keep = document.getElementById('member-profile-stats');
        var oldStats = keep ? keep.innerHTML : '';
        memberProfileCard.innerHTML = '';
        memberProfileCard.appendChild(buildPublicProfileCard(cu));
        document.getElementById('member-profile-stats').innerHTML = oldStats;
      }
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
      expandedStories = new Set(); feedLimit = FEED_PAGE;
      heldBack = {}; newestSeen = 0; feedInitialised = false; newPill.hidden = true;
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
