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
  var profileShowPresence = document.getElementById('profile-show-presence');
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
      try { sessionStorage.setItem('sholomoh:tab', tab); } catch (e) {}
      if (tab === 'members' && typeof refreshPresence === 'function') refreshPresence(false);
      if (tab !== 'members' && typeof closeMemberProfile === 'function') closeMemberProfile();
    });
  });

  // After a refresh, return to the tab you were on (unless a shared link is opening something).
  var tabRestored = false;
  function restoreTab() {
    if (tabRestored) return;
    if (/^#[us]=/.test(location.hash)) { tabRestored = true; return; }
    var saved = null;
    try { saved = sessionStorage.getItem('sholomoh:tab'); } catch (e) {}
    if (!saved || !panels[saved]) { tabRestored = true; return; }
    var btn = document.querySelector('#main-tabs .tab-btn[data-tab="' + saved + '"]');
    if (!btn || btn.hidden || btn.style.display === 'none') return; // e.g. Admin before the admin check finishes
    tabRestored = true;
    btn.click();
  }

  /* ---------- composer show/hide ---------- */

  var draftTitle = document.getElementById('post-title');
  var draftBody = document.getElementById('post-body');
  var draftTimer = null;
  function draftKey() { return currentUid ? 'sholomoh:draft:' + currentUid : null; }
  function readDraft() {
    var k = draftKey();
    if (!k) return null;
    try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; }
  }
  function saveDraft() {
    var k = draftKey();
    if (!k) return;
    try {
      if (!draftTitle.value.trim() && !draftBody.value.trim()) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify({ title: draftTitle.value, body: draftBody.value }));
    } catch (e) { /* storage unavailable: skip silently */ }
    updateDraftUI();
  }
  function clearDraft() {
    var k = draftKey();
    if (k) { try { localStorage.removeItem(k); } catch (e) {} }
    updateDraftUI();
  }
  function updateDraftUI() {
    var d = readDraft();
    composerToggle.textContent = (d && composer.hidden) ? '\u270e Continue draft' : '+ New story';
  }
  function restoreDraft() {
    var d = readDraft();
    if (d && !draftTitle.value && !draftBody.value) {
      draftTitle.value = d.title || ''; draftBody.value = d.body || '';
      postStatus.textContent = 'Draft restored.';
      setTimeout(function () { if (postStatus.textContent === 'Draft restored.') postStatus.textContent = ''; }, 2500);
    }
  }
  [draftTitle, draftBody].forEach(function (el) {
    el.addEventListener('input', function () { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 400); });
  });

  composerToggle.addEventListener('click', function () {
    composer.hidden = !composer.hidden;
    if (!composer.hidden) { restoreDraft(); draftTitle.focus(); }
    updateDraftUI();
  });
  composerCancel.addEventListener('click', function () {
    postForm.reset();
    clearDraft();
    composer.hidden = true;
    updateDraftUI();
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

  var editingCommentId = null;
  var replyingToId = null;
  var replyValue = '';
  var editingCommentValue = null;

  function buildCommentsSection(postId, postAuthorUid, postTitle) {
    function buildReplyForm(parent) {
      var rform = document.createElement('form');
      rform.className = 'comment-form reply-form';
      var rinput = document.createElement('input');
      rinput.type = 'text'; rinput.className = 'field-input'; rinput.maxLength = 1000; rinput.required = true;
      rinput.placeholder = 'Reply to ' + (parent.authorName || 'comment') + '...';
      rinput.value = replyValue;
      rinput.addEventListener('input', function () { replyValue = rinput.value; });
      var rpost = document.createElement('button');
      rpost.type = 'submit'; rpost.className = 'btn btn-ghost btn-sm'; rpost.textContent = 'Reply';
      var rcancel = document.createElement('button');
      rcancel.type = 'button'; rcancel.className = 'btn btn-ghost btn-sm'; rcancel.textContent = 'Cancel';
      rcancel.addEventListener('click', function () { replyingToId = null; replyValue = ''; renderFeedOnce(); });
      rform.appendChild(rinput); rform.appendChild(rpost); rform.appendChild(rcancel);
      rform.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var val = rinput.value.trim();
        if (!val) return;
        rpost.disabled = true;
        db.collection('postComments').add({
          postId: postId, parentId: parent.id, authorUid: currentUid,
          authorName: (myProfile && myProfile.displayName) || 'Member',
          text: val, createdAt: FieldValue.serverTimestamp()
        }).then(function () {
          return db.collection('posts').doc(postId).update({ commentCount: FieldValue.increment(1) });
        }).then(function () {
          replyingToId = null; replyValue = '';
          var jobs = [notifyIfNotSelf(parent.authorUid, 'reply', { postId: postId, postTitle: postTitle })];
          if (postAuthorUid !== parent.authorUid) jobs.push(notifyIfNotSelf(postAuthorUid, 'comment', { postId: postId, postTitle: postTitle }));
          return Promise.all(jobs);
        }).catch(function () { rpost.disabled = false; });
      });
      setTimeout(function () { rinput.focus(); }, 0);
      return rform;
    }

    var wrap = document.createElement('div');
    wrap.className = 'comments-section';
    var list = document.createElement('div');
    list.className = 'comments-list';
    var cached = commentsCache[postId];
    if (cached) cached = cached.filter(function (c) { return !blockedUids.has(c.authorUid); });
    if (!cached) {
      list.innerHTML = '<p class="form-note">Loading comments\u2026</p>';
    } else if (!cached.length) {
      list.innerHTML = '<p class="form-note">No comments yet \u2014 be the first.</p>';
    } else {
      var renderOne = function (c, isReply) {
        var row = document.createElement('div');
        row.className = 'comment-row' + (isReply ? ' reply' : '');
        var head = document.createElement('p');
        head.className = 'comment-meta';
        var when = c.createdAt && c.createdAt.toDate ? relTime(c.createdAt.toDate()) : '';
        head.textContent = (c.authorName || 'Member') + (when ? ' \u00b7 ' + when : '') + (c.editedAt ? ' \u00b7 edited' : '');
        row.appendChild(head);
        if (editingCommentId === c.id) {
          var eform = document.createElement('form');
          eform.className = 'comment-form';
          var einput = document.createElement('input');
          einput.type = 'text'; einput.className = 'field-input'; einput.value = editingCommentValue !== null ? editingCommentValue : (c.text || ''); einput.maxLength = 1000; einput.required = true;
          einput.addEventListener('input', function () { editingCommentValue = einput.value; });
          var esave = document.createElement('button');
          esave.type = 'submit'; esave.className = 'btn btn-ghost btn-sm'; esave.textContent = 'Save';
          var ecancel = document.createElement('button');
          ecancel.type = 'button'; ecancel.className = 'btn btn-ghost btn-sm'; ecancel.textContent = 'Cancel';
          ecancel.addEventListener('click', function () { editingCommentId = null; editingCommentValue = null; renderFeedOnce(); });
          eform.appendChild(einput); eform.appendChild(esave); eform.appendChild(ecancel);
          eform.addEventListener('submit', function (ev) {
            ev.preventDefault();
            var nv = einput.value.trim();
            if (!nv) return;
            if (nv === (c.text || '')) { editingCommentId = null; editingCommentValue = null; renderFeedOnce(); return; }
            esave.disabled = true;
            db.collection('postComments').doc(c.id).update({ text: nv, editedAt: FieldValue.serverTimestamp() })
              .then(function () { editingCommentId = null; editingCommentValue = null; })
              .catch(function () { esave.disabled = false; esave.textContent = 'Retry'; });
          });
          row.appendChild(eform);
          list.appendChild(row);
          setTimeout(function () { einput.focus(); }, 0);
          return;
        }
        var ctext = document.createElement('p');
        ctext.className = 'comment-text';
        ctext.textContent = c.text || '';
        row.appendChild(ctext);
        if (currentUid && !isReply) {
          var replyBtn = document.createElement('button');
          replyBtn.type = 'button'; replyBtn.className = 'btn btn-ghost btn-sm comment-del';
          replyBtn.textContent = 'Reply';
          replyBtn.addEventListener('click', function () { replyingToId = c.id; replyValue = ''; renderFeedOnce(); });
          row.appendChild(replyBtn);
        }
        if (currentUid && c.authorUid !== currentUid) {
          var crep = document.createElement('button');
          crep.type = 'button'; crep.className = 'btn btn-ghost btn-sm comment-del';
          crep.textContent = 'Report';
          crep.addEventListener('click', function () {
            openReport({ type: 'comment', targetId: c.id, postId: postId, reportedUid: c.authorUid, reportedName: c.authorName, snippet: c.text });
          });
          row.appendChild(crep);
        }
        if (currentUid && c.authorUid === currentUid) {
          var edit = document.createElement('button');
          edit.type = 'button'; edit.className = 'btn btn-ghost btn-sm comment-del';
          edit.textContent = 'Edit';
          edit.addEventListener('click', function () { editingCommentId = c.id; editingCommentValue = null; renderFeedOnce(); });
          row.appendChild(edit);
        }
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
        if (replyingToId === c.id) list.appendChild(buildReplyForm(c));
      };
      var byId = {};
      cached.forEach(function (c) { byId[c.id] = c; });
      var kids = {};
      var tops = cached.filter(function (c) {
        if (c.parentId && byId[c.parentId]) { (kids[c.parentId] = kids[c.parentId] || []).push(c); return false; }
        return true; // top-level, or a reply whose parent was deleted
      });
      tops.forEach(function (c) {
        renderOne(c, false);
        (kids[c.id] || []).forEach(function (r) { renderOne(r, true); });
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
          authorName: (myProfile && myProfile.displayName) || 'Member',
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
      makeActivatable(img, function () { openLightbox(url); }, 'View full image');
      // A blurred, dimmed copy of the photo fills any empty space beside it.
      var wrap = document.createElement('div');
      wrap.className = 'story-photo-wrap';
      wrap.style.setProperty('--bg', 'url("' + String(url).replace(/["\\\n]/g, encodeURIComponent) + '")');
      wrap.appendChild(img);
      return wrap;
    }
    // Anything else (pdf, doc, zip, ...) -> a plain download link, since it
    // can't be meaningfully previewed inline.
    var link = document.createElement('a');
    link.href = url; link.target = '_blank'; link.rel = 'noopener';
    link.className = 'story-file-link';
    link.textContent = '\ud83d\udcce ' + (p.attachmentName || 'Download attachment');
    return link;
  }

  /* ---------- online status / last seen + tab-title unread count ---------- */
  var presenceMap = {};              // uid -> last seen (ms)
  var presenceTimer = null, presenceFetchedAt = 0;
  var PRESENCE_BEAT_MS = 90000, ONLINE_WITHIN_MS = 150000;
  var baseTitle = document.title;
  var unreadNotifCount = 0, unreadMsgCount = 0;

  function updateTitleBadge() {
    var n = unreadNotifCount + unreadMsgCount;
    document.title = (n ? '(' + (n > 9 ? '9+' : n) + ') ' : '') + baseTitle;
  }

  function pingPresence() {
    if (!currentUid || (myProfile && myProfile.hidePresence)) return;
    db.collection('presence').doc(currentUid).set({ lastSeen: FieldValue.serverTimestamp() }).catch(function () {});
  }
  function stopPresence() {
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
  }
  function startPresence() {
    stopPresence();
    if (!currentUid) return;
    if (myProfile && myProfile.hidePresence) {
      db.collection('presence').doc(currentUid).delete().catch(function () {});
      presenceMap = {};
      return;
    }
    pingPresence();
    presenceTimer = setInterval(function () {
      if (document.visibilityState === 'visible') pingPresence();
    }, PRESENCE_BEAT_MS);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') pingPresence();
  });

  function presenceInfo(uid) {
    if (!uid || uid === currentUid || (myProfile && myProfile.hidePresence) || blockedUids.has(uid)) return null;
    var ms = presenceMap[uid];
    if (!ms) return null;
    if (Date.now() - ms < ONLINE_WITHIN_MS) return { online: true, text: 'Online' };
    return { online: false, text: 'Last seen ' + relTime(new Date(ms)) };
  }

  function buildPresenceEl(uid) {
    var info = presenceInfo(uid);
    if (!info) return null;
    var el = document.createElement('span');
    el.className = 'presence' + (info.online ? ' online' : '');
    el.textContent = (info.online ? '\u25cf ' : '') + info.text;
    return el;
  }

  function updateThreadPresence() {
    var el = document.getElementById('thread-presence');
    var info = activeOtherUid ? presenceInfo(activeOtherUid) : null;
    el.hidden = !info;
    el.className = 'thread-presence' + (info && info.online ? ' online' : '');
    el.textContent = info ? (info.online ? '\u25cf ' : '') + info.text : '';
  }

  function refreshPresence(force) {
    if (!currentUid || (myProfile && myProfile.hidePresence)) return Promise.resolve();
    if (!force && Date.now() - presenceFetchedAt < 30000) return Promise.resolve();
    presenceFetchedAt = Date.now();
    return db.collection('presence').get().then(function (snap) {
      var map = {};
      snap.forEach(function (d) {
        var t = toDate(d.data().lastSeen);
        if (t) map[d.id] = t.getTime();
      });
      presenceMap = map;
      renderMembersList();
      rerenderOpenProfileCard();
      updateThreadPresence();
    }).catch(function () {});
  }

  // Refresh periodically, but only while a screen that shows status is open.
  setInterval(function () {
    if (document.visibilityState !== 'visible' || !currentUid) return;
    if (!panels.members.hidden || !threadView.hidden) refreshPresence(true);
  }, 120000);

  /* ---------- blocking ---------- */
  var blockedUids = new Set();

  function renderBlockedList() {
    var el = document.getElementById('blocked-list');
    el.innerHTML = '';
    if (!blockedUids.size) { el.innerHTML = '<p class="form-note">You haven\u2019t blocked anyone.</p>'; return; }
    blockedUids.forEach(function (uid) {
      var u = usersByUid[uid];
      var row = document.createElement('div');
      row.className = 'likes-row';
      var nm = document.createElement('span');
      nm.textContent = (u && u.displayName) || 'Member';
      nm.style.flex = '1';
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn btn-ghost btn-sm'; btn.textContent = 'Unblock';
      btn.addEventListener('click', function () { btn.disabled = true; unblockMember(uid); });
      row.appendChild(nm); row.appendChild(btn);
      el.appendChild(row);
    });
  }

  function loadBlocks() {
    return db.collection('blocks').where('blockerUid', '==', currentUid).get().then(function (snap) {
      blockedUids = new Set();
      snap.forEach(function (d) { blockedUids.add(d.data().blockedUid); });
      renderBlockedList();
    });
  }

  function afterBlockChange() {
    renderBlockedList(); renderFeedOnce(); renderMembersList();
    rerenderOpenProfileCard(); renderNotifList(); loadInbox(); loadRelationships();
  }

  function blockMember(u) {
    var me = currentUid;
    return db.collection('blocks').doc(me + '_' + u.id).set({
      blockerUid: me, blockedUid: u.id, createdAt: FieldValue.serverTimestamp()
    }).then(function () {
      blockedUids.add(u.id);
      // Blocking also ends any friendship / pending request between you.
      return Promise.all([
        db.collection('friendRequests').doc(me + '_' + u.id).delete().catch(function () {}),
        db.collection('friendRequests').doc(u.id + '_' + me).delete().catch(function () {})
      ]);
    }).then(afterBlockChange);
  }

  function unblockMember(uid) {
    return db.collection('blocks').doc(currentUid + '_' + uid).delete().then(function () {
      blockedUids.delete(uid);
      afterBlockChange();
    }).catch(function () { renderBlockedList(); });
  }

  /* ---------- reporting ---------- */
  var reportModal = document.getElementById('report-modal');
  var reportStatus = document.getElementById('report-status');
  var reportSend = document.getElementById('report-send');
  var reportTarget = null;
  function closeReport() { reportModal.hidden = true; reportTarget = null; }
  document.getElementById('report-cancel').addEventListener('click', closeReport);
  reportModal.addEventListener('click', function (e) { if (e.target === reportModal) closeReport(); });

  function openReport(info) {
    reportTarget = info;
    document.getElementById('report-title').textContent = info.type === 'comment' ? 'Report this comment' : 'Report this story';
    document.getElementById('report-details').value = '';
    reportStatus.className = 'form-note'; reportStatus.textContent = '';
    reportSend.disabled = false;
    reportModal.hidden = false;
    document.getElementById('report-reason').focus();
  }

  reportSend.addEventListener('click', function () {
    if (!reportTarget || !currentUid) return;
    var t = reportTarget;
    reportSend.disabled = true;
    db.collection('reports').doc(currentUid + '_' + t.targetId).set({
      type: t.type, targetId: t.targetId, postId: t.postId,
      reportedUid: t.reportedUid || '', reportedName: t.reportedName || 'Member',
      reporterUid: currentUid,
      reason: document.getElementById('report-reason').value,
      details: document.getElementById('report-details').value.trim().slice(0, 300),
      snippet: String(t.snippet || '').slice(0, 160),
      status: 'open', createdAt: FieldValue.serverTimestamp()
    }).then(function () {
      reportStatus.className = 'form-success';
      reportStatus.textContent = '\u2713 Thanks \u2014 an admin will review this.';
      setTimeout(closeReport, 1400);
    }).catch(function () {
      reportStatus.className = 'form-error';
      reportStatus.textContent = 'You\u2019ve already reported this, or it couldn\u2019t be sent.';
      reportSend.disabled = false;
    });
  });

  /* ---------- full-size image viewer ---------- */
  var lightbox = document.getElementById('lightbox');
  var lightboxImg = document.getElementById('lightbox-img');
  function closeLightbox() { lightbox.hidden = true; lightboxImg.src = ''; }
  function openLightbox(url) {
    lightboxImg.src = url;
    lightbox.hidden = false;
    document.getElementById('lightbox-close').focus();
  }
  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', function (e) { if (e.target === lightbox) closeLightbox(); });

  /* ---------- who liked a story ---------- */
  var likesModal = document.getElementById('likes-modal');
  var likesList = document.getElementById('likes-list');
  function closeLikes() { likesModal.hidden = true; }
  document.getElementById('likes-close').addEventListener('click', closeLikes);
  likesModal.addEventListener('click', function (e) { if (e.target === likesModal) closeLikes(); });

  function openLikes(postId) {
    likesList.innerHTML = '<p class="form-note">Loading\u2026</p>';
    likesModal.hidden = false;
    document.getElementById('likes-close').focus();
    db.collection('postLikes').where('postId', '==', postId).get().then(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { rows.push(doc.data()); });
      rows.sort(function (a, b) {
        var ad = toDate(a.createdAt), bd = toDate(b.createdAt);
        return (bd ? bd.getTime() : 0) - (ad ? ad.getTime() : 0);
      });
      likesList.innerHTML = '';
      if (!rows.length) { likesList.innerHTML = '<p class="form-note">No likes yet.</p>'; return; }
      rows.forEach(function (r) {
        var u = usersByUid[r.uid];
        var row = document.createElement('div');
        row.className = 'likes-row';
        var name = (u && u.displayName) || 'Member';
        var av = avatarEl(r.uid, name);
        row.appendChild(av);
        var label = document.createElement('span');
        label.textContent = r.uid === currentUid ? name + ' (you)' : name;
        row.appendChild(label);
        if (u) {
          makeActivatable(row, function () { closeLikes(); goToAuthor(r.uid); }, 'View ' + name + '\u2019s profile');
          row.classList.add('clickable');
        }
        likesList.appendChild(row);
      });
    }).catch(function () {
      likesList.innerHTML = '<p class="form-note">Couldn\u2019t load the list.</p>';
    });
  }

  /* ---------- single story view (opened from notifications) ---------- */
  var tabStories = document.getElementById('tab-stories');
  var storyFocus = document.getElementById('story-focus');
  var storyFocusCard = document.getElementById('story-focus-card');
  var focusId = null, focusUnsub = null, focusData = null;

  function renderFocus() {
    if (!focusId) return;
    storyFocusCard.innerHTML = '';
    if (!focusData) {
      storyFocusCard.innerHTML = '<p class="form-note">This story is no longer available.</p>';
      return;
    }
    storyFocusCard.appendChild(buildStoryCard(focusId, focusData));
  }
  function closeStoryFocus() {
    if (focusUnsub) { focusUnsub(); focusUnsub = null; }
    focusId = null; focusData = null;
    storyFocus.hidden = true;
    tabStories.classList.remove('focus-mode');
    clearHash('s');
  }
  function openStoryFocus(postId) {
    document.querySelector('#main-tabs .tab-btn[data-tab="stories"]').click();
    closeStoryFocus();
    focusId = postId;
    setHash('s=' + postId);
    tabStories.classList.add('focus-mode');
    storyFocus.hidden = false;
    storyFocusCard.innerHTML = '<p class="form-note">Loading\u2026</p>';
    expandedComments.add(postId);
    subscribeComments(postId);
    focusUnsub = db.collection('posts').doc(postId).onSnapshot(function (doc) {
      focusData = doc.exists ? doc.data() : null;
      renderFocus();
    }, function () {
      focusData = null; renderFocus();
    });
    window.scrollTo({ top: 0 });
  }
  document.getElementById('story-focus-back').addEventListener('click', closeStoryFocus);
  var storyFocusCopy = document.getElementById('story-focus-copy');
  storyFocusCopy.addEventListener('click', function () { if (focusId) copyLink(storyFocusCopy, 's=' + focusId); });

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
    makeActivatable(headAv, function () { goToAuthor(p.authorUid); }, 'View ' + (p.authorName || 'author') + '\u2019s profile');
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
    makeActivatable(authorLink, function () { goToAuthor(p.authorUid); });
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
    likeBtn.setAttribute('aria-pressed', liked ? 'true' : 'false');
    likeBtn.setAttribute('aria-label', (liked ? 'Unlike' : 'Like') + ' this story, ' + (p.likeCount || 0) + ' likes');
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
    if (currentUid && p.authorUid !== currentUid) {
      var repBtn = document.createElement('button');
      repBtn.type = 'button'; repBtn.className = 'reaction-btn';
      repBtn.textContent = '\u2691 Report';
      repBtn.setAttribute('aria-label', 'Report this story');
      repBtn.addEventListener('click', function () {
        openReport({ type: 'post', targetId: id, postId: id, reportedUid: p.authorUid, reportedName: p.authorName,
          snippet: (p.title || '') + (p.body ? ': ' + p.body : '') });
      });
      reactions.appendChild(repBtn);
    }
    if ((p.likeCount || 0) > 0) {
      var whoBtn = document.createElement('button');
      whoBtn.type = 'button';
      whoBtn.className = 'reaction-btn';
      whoBtn.textContent = 'Who liked';
      whoBtn.addEventListener('click', function () { openLikes(id); });
      reactions.appendChild(whoBtn);
    }
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
    renderFocus();
    if (!lastSnap) return;
    var docs = [];
    lastSnap.forEach(function (doc) { docs.push(doc); });
    if (activeSubtab === 'friends') {
      docs = docs.filter(function (doc) { return friendUids.has(doc.data().authorUid); });
    }
    docs = docs.filter(function (doc) { return !heldBack[doc.id] && !blockedUids.has(doc.data().authorUid); });
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
      displayName: user.displayName || 'Member',
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

  function adminRow(nameText, subText, buttons) {
    var row = document.createElement('div');
    row.className = 'request-row';
    var label = document.createElement('span');
    label.textContent = nameText + ' ';
    if (subText) {
      var sub = document.createElement('span');
      sub.className = 'muted-inline';
      sub.textContent = subText;
      label.appendChild(sub);
    }
    row.appendChild(label);
    var wrap = document.createElement('span');
    wrap.className = 'request-actions';
    buttons.forEach(function (bt) { wrap.appendChild(bt); });
    row.appendChild(wrap);
    return row;
  }

  function adminBtn(text, danger, onClick) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-sm' + (danger ? ' btn-danger' : '');
    btn.textContent = text;
    btn.addEventListener('click', function () {
      if (danger && !window.confirm(text + '? This can be undone later.')) return;
      btn.disabled = true;
      onClick().then(loadPosterRequests).catch(function () {
        btn.disabled = false; btn.textContent = 'Retry';
      });
    });
    return btn;
  }

  /* ---------- admin: scrub emails saved as author names ---------- */
  var scrubResult = document.getElementById('scrub-result');
  var scrubScan = document.getElementById('scrub-scan');

  function runInChunks(items, size, fn) {
    var failed = 0, i = 0;
    function next() {
      if (i >= items.length) return Promise.resolve(failed);
      var chunk = items.slice(i, i + size); i += size;
      return Promise.all(chunk.map(function (it) {
        return fn(it).catch(function () { failed++; });
      })).then(next);
    }
    return next();
  }

  scrubScan.addEventListener('click', function () {
    scrubScan.disabled = true;
    scrubResult.innerHTML = '<p class="form-note">Scanning\u2026</p>';
    Promise.all([db.collection('posts').get(), db.collection('postComments').get()]).then(function (r) {
      var hits = [];
      r[0].forEach(function (d) { if (String(d.data().authorName || '').indexOf('@') !== -1) hits.push({ coll: 'posts', id: d.id, uid: d.data().authorUid }); });
      r[1].forEach(function (d) { if (String(d.data().authorName || '').indexOf('@') !== -1) hits.push({ coll: 'postComments', id: d.id, uid: d.data().authorUid }); });
      scrubResult.innerHTML = '';
      if (!hits.length) {
        scrubResult.innerHTML = '<p class="form-success">\u2713 None found \u2014 no stories or comments show an email as the name.</p>';
        return;
      }
      var msg = document.createElement('p');
      msg.className = 'form-note';
      msg.textContent = 'Found ' + hits.length + ' item' + (hits.length === 1 ? '' : 's') + ' showing an email as the author name.';
      var fix = document.createElement('button');
      fix.type = 'button'; fix.className = 'btn btn-ghost btn-sm'; fix.textContent = 'Replace with member names';
      var status = document.createElement('p');
      status.className = 'form-note';
      fix.addEventListener('click', function () {
        fix.disabled = true;
        status.textContent = 'Fixing\u2026';
        runInChunks(hits, 15, function (h) {
          var u = usersByUid[h.uid];
          var name = (u && u.displayName) || 'Member';
          return db.collection(h.coll).doc(h.id).update({ authorName: name });
        }).then(function (failed) {
          status.className = failed ? 'form-error' : 'form-success';
          status.textContent = failed
            ? 'Fixed ' + (hits.length - failed) + ', but ' + failed + ' failed. Comments need the updated Firestore rules (admin may edit authorName).'
            : '\u2713 Fixed ' + hits.length + '.';
          fix.disabled = !!failed;
        });
      });
      scrubResult.appendChild(msg); scrubResult.appendChild(fix); scrubResult.appendChild(status);
    }).catch(function () {
      scrubResult.innerHTML = '<p class="form-error">Couldn\u2019t scan. Check your connection and try again.</p>';
    }).then(function () { scrubScan.disabled = false; });
  });

  var adminReqCount = 0, adminReportCount = 0;
  function updateAdminBadge() {
    var n = adminReqCount + adminReportCount;
    adminBadge.hidden = n === 0;
    if (n) adminBadge.textContent = String(n);
  }

  function loadReports() {
    var el = document.getElementById('reports-list');
    db.collection('reports').where('status', '==', 'open').get().then(function (snap) {
      adminReportCount = snap.size; updateAdminBadge();
      el.innerHTML = '';
      if (snap.empty) { el.innerHTML = '<p class="form-note">No open reports.</p>'; return; }
      snap.forEach(function (doc) {
        var r = doc.data();
        var row = document.createElement('div');
        row.className = 'report-row';
        var title = document.createElement('p');
        title.className = 'report-title';
        title.textContent = (r.type === 'comment' ? 'Comment' : 'Story') + ' by ' + (r.reportedName || 'Member') + ' \u2014 ' + (r.reason || 'Reported');
        row.appendChild(title);
        if (r.snippet) { var sn = document.createElement('p'); sn.className = 'report-snippet'; sn.textContent = r.snippet; row.appendChild(sn); }
        if (r.details) { var dt = document.createElement('p'); dt.className = 'form-note'; dt.textContent = 'Reporter says: ' + r.details; row.appendChild(dt); }
        var acts = document.createElement('div');
        acts.className = 'request-actions';
        function mk(text, danger, fn) {
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'btn btn-ghost btn-sm' + (danger ? ' btn-danger' : ''); b.textContent = text;
          b.addEventListener('click', function () {
            if (danger && !window.confirm(text + '?')) return;
            b.disabled = true;
            Promise.resolve(fn()).then(loadReports).catch(function () { b.disabled = false; b.textContent = 'Retry'; });
          });
          return b;
        }
        acts.appendChild(mk('View', false, function () { openStoryFocus(r.postId); return new Promise(function () {}); }));
        acts.appendChild(mk('Delete content', true, function () {
          var kill = r.type === 'comment'
            ? db.collection('postComments').doc(r.targetId).delete().then(function () {
                return db.collection('posts').doc(r.postId).update({ commentCount: FieldValue.increment(-1) }).catch(function () {});
              })
            : db.collection('posts').doc(r.targetId).delete();
          return kill.then(function () { return db.collection('reports').doc(doc.id).delete(); });
        }));
        acts.appendChild(mk('Dismiss', false, function () { return db.collection('reports').doc(doc.id).delete(); }));
        row.appendChild(acts);
        el.appendChild(row);
      });
    }).catch(function () {
      el.innerHTML = '<p class="form-error">Couldn\u2019t load reports.</p>';
    });
  }

  function loadPosterRequests() {
    var postersList = document.getElementById('posters-list');
    Promise.all([
      db.collection('posterRequests').where('status', '==', 'pending').get(),
      db.collection('posters').get()
    ]).then(function (r) {
      var snap = r[0], posters = r[1];
      adminReqCount = snap.size; updateAdminBadge();

      requestsList.innerHTML = '';
      if (snap.empty) requestsList.innerHTML = '<p class="form-note">No pending requests.</p>';
      snap.forEach(function (doc) {
        var rq = doc.data();
        var approve = adminBtn('Approve', false, function () {
          // Grant first; only mark the request approved once the grant exists.
          return db.collection('posters').doc(doc.id).set({
            approvedAt: FieldValue.serverTimestamp(), approvedBy: auth.currentUser.uid
          }).then(function () { return db.collection('posterRequests').doc(doc.id).update({ status: 'approved' }); });
        });
        var decline = adminBtn('Decline', true, function () {
          // Deleting the request lets the member apply again later.
          return db.collection('posterRequests').doc(doc.id).delete();
        });
        requestsList.appendChild(adminRow(rq.displayName || 'Member', rq.email ? '(' + rq.email + ')' : '', [approve, decline]));
      });

      postersList.innerHTML = '';
      if (posters.empty) postersList.innerHTML = '<p class="form-note">No approved posters yet.</p>';
      posters.forEach(function (doc) {
        var u = usersByUid[doc.id];
        var when = toDate(doc.data().approvedAt);
        var revoke = adminBtn('Revoke', true, function () {
          return db.collection('posters').doc(doc.id).delete();
        });
        postersList.appendChild(adminRow((u && u.displayName) || 'Member', when ? 'since ' + when.toLocaleDateString() : '', [revoke]));
      });
    }).catch(function () {
      requestsList.innerHTML = '<p class="form-error">Couldn\u2019t load admin data. Check your connection and try again.</p>';
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
        authorName: user.displayName || 'Member',
        likeCount: 0,
        commentCount: 0,
        createdAt: FieldValue.serverTimestamp()
      });
    }).then(function () {
      postForm.reset();
      clearDraft();
      postStatus.textContent = 'Posted.';
      composer.hidden = true;
      updateDraftUI();
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
        db.collection('posterRequests').doc(uid).delete().catch(quiet),
        deleteQueryDocs(db.collection('blocks').where('blockerUid', '==', uid)),
        db.collection('presence').doc(uid).delete().catch(quiet),
        db.collection('userDob').doc(uid).delete().catch(quiet),
        db.collection('userLocations').doc(uid).delete().catch(quiet)
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
      pin.setAttribute('aria-label', (isPinned ? 'Unpin ' : 'Pin ') + String(p.title || 'story') + (isPinned ? '' : ' to profile'));
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
    var linkBtn = document.createElement('button');
    linkBtn.type = 'button'; linkBtn.className = 'btn btn-ghost btn-sm';
    linkBtn.textContent = '\ud83d\udd17 Copy link';
    linkBtn.addEventListener('click', function () { copyLink(linkBtn, 'u=' + u.id); });
    actions.appendChild(linkBtn);
    var blockBtn = document.createElement('button');
    blockBtn.type = 'button'; blockBtn.className = 'btn btn-ghost btn-sm btn-danger';
    var isBlocked = blockedUids.has(u.id);
    blockBtn.textContent = isBlocked ? 'Unblock' : 'Block';
    blockBtn.addEventListener('click', function () {
      if (!isBlocked && !window.confirm('Block ' + (u.displayName || 'this member') + '? You won\u2019t see their stories, comments or messages, and any friendship will end.')) return;
      blockBtn.disabled = true;
      (isBlocked ? unblockMember(u.id) : blockMember(u)).catch(function () { blockBtn.disabled = false; });
    });
    actions.appendChild(blockBtn);
    top.appendChild(actions);
    body.appendChild(top);
    var name = document.createElement('p'); name.className = 'profile-preview-name';
    name.textContent = u.displayName || 'Member';
    body.appendChild(name);
    var pEl2 = buildPresenceEl(u.id);
    if (pEl2) { pEl2.classList.add('presence-block'); body.appendChild(pEl2); }
    if (locationOf(u)) {
      var loc = document.createElement('p'); loc.className = 'profile-preview-location';
      loc.textContent = '\ud83d\udccd ' + locationOf(u);
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
    refreshPresence(false);
    setHash('u=' + u.id);
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
    clearHash('u');
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
      cropCanvas.focus();
    };
    img.onerror = function () { profilePhoto.value = ''; };
    img.src = url;
  }
  cropZoom.addEventListener('input', function () { if (!CROP.img) return; clampCrop(); drawCrop(cropCtx, CROP_VIEW, true); });
  cropCanvas.addEventListener('pointerdown', function (e) {
    CROP.dragging = true; CROP.lx = e.clientX; CROP.ly = e.clientY;
    cropCanvas.setPointerCapture(e.pointerId);
  });
  cropCanvas.addEventListener('pointermove', function (e) {
    if (!CROP.dragging || !CROP.img) return;
    CROP.ox += e.clientX - CROP.lx; CROP.oy += e.clientY - CROP.ly;
    CROP.lx = e.clientX; CROP.ly = e.clientY;
    clampCrop(); drawCrop(cropCtx, CROP_VIEW, true);
  });
  ['pointerup', 'pointercancel'].forEach(function (ev) {
    cropCanvas.addEventListener(ev, function () { CROP.dragging = false; });
  });
  cropCanvas.addEventListener('keydown', function (e) {
    if (!CROP.img) return;
    var step = 12, used = true;
    if (e.key === 'ArrowLeft') CROP.ox += step;
    else if (e.key === 'ArrowRight') CROP.ox -= step;
    else if (e.key === 'ArrowUp') CROP.oy += step;
    else if (e.key === 'ArrowDown') CROP.oy -= step;
    else if (e.key === '+' || e.key === '=') cropZoom.value = Math.min(3, parseFloat(cropZoom.value) + 0.1);
    else if (e.key === '-') cropZoom.value = Math.max(1, parseFloat(cropZoom.value) - 0.1);
    else used = false;
    if (used) { e.preventDefault(); clampCrop(); drawCrop(cropCtx, CROP_VIEW, true); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!lightbox.hidden) { closeLightbox(); }
    else if (!reportModal.hidden) { closeReport(); }
    else if (!likesModal.hidden) { closeLikes(); }
    else if (!cropModal.hidden) { document.getElementById('crop-cancel').click(); }
    else if (typeof notifPanel !== 'undefined' && !notifPanel.hidden) { notifPanel.hidden = true; notifBell.setAttribute('aria-expanded', 'false'); notifBell.focus(); }
  });
  document.getElementById('crop-cancel').addEventListener('click', function () {
    cropModal.hidden = true; profilePhoto.value = ''; croppedPhotoFile = null;
  });
  document.getElementById('crop-apply').addEventListener('click', function () {
    if (!CROP.img) { cropModal.hidden = true; return; }
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

  // Friends-only locations live in userLocations/{uid} (rules enforce who can read them).
  var friendLocations = {};
  function locationOf(u) {
    return u.hideLocation ? (friendLocations[u.id] || '') : (u.location || '');
  }
  function loadFriendLocations() {
    var jobs = [];
    friendUids.forEach(function (fid) {
      var fu = usersByUid[fid];
      if (!fu || !fu.hideLocation || friendLocations[fid] !== undefined) return;
      jobs.push(db.collection('userLocations').doc(fid).get().then(function (d) {
        friendLocations[fid] = d.exists ? (d.data().location || '') : '';
      }).catch(function () {}));
    });
    return Promise.all(jobs);
  }

  function pinFirst(posts, pinnedId) {
    if (!pinnedId) return posts;
    var hit = posts.filter(function (p) { return p.id === pinnedId; });
    if (!hit.length) return posts;
    return hit.concat(posts.filter(function (p) { return p.id !== pinnedId; }));
  }

  /* ---------- accessibility + links helpers ---------- */
  function makeActivatable(el, fn, label) {
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    if (label) el.setAttribute('aria-label', label);
    el.addEventListener('click', fn);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); }
    });
  }

  function setHash(val) {
    try { history.replaceState(null, '', location.pathname + location.search + '#' + val); } catch (e) {}
  }
  function clearHash(kind) {
    if (location.hash.indexOf('#' + kind + '=') === 0) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    }
  }
  function copyLink(btn, hashVal) {
    var url = location.origin + location.pathname + '#' + hashVal;
    var original = btn.textContent;
    function done(ok) {
      btn.textContent = ok ? 'Link copied \u2713' : 'Copy failed';
      setTimeout(function () { btn.textContent = original; }, 1800);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  }

  function filterByInterest(tag) {
    document.querySelector('#main-tabs .tab-btn[data-tab="members"]').click();
    closeMemberProfile();
    memberSearch.value = tag;
    renderMembersList();
    window.scrollTo({ top: 0 });
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
      var c = document.createElement('button');
      c.type = 'button'; c.className = 'chip'; c.textContent = t;
      c.setAttribute('aria-label', 'Find members interested in ' + t);
      c.addEventListener('click', function () { filterByInterest(t); });
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

  // Date of birth -> userDob/{uid} (owner-only). Hidden location -> userLocations/{uid}
  // (owner + friends). Legacy values still sitting in the public users doc are moved
  // across here, and only removed from the public doc once the private write succeeded.
  function loadMyPrivate(p) {
    var ref = function (c) { return db.collection(c).doc(currentUid); };
    return Promise.all([
      ref('userDob').get().catch(function () { return null; }),
      ref('userLocations').get().catch(function () { return null; })
    ]).then(function (r) {
      var dobDoc = r[0], locDoc = r[1];
      var legacyDob = p.dob || null;
      var legacyLoc = p.hideLocation && p.location ? p.location : null;
      var cleanup = {};
      var jobs = [];
      if (p.email) cleanup.email = FieldValue.delete();
      p.dob = (dobDoc && dobDoc.exists && dobDoc.data().dob) || legacyDob || null;
      if (p.hideLocation) p.location = (locDoc && locDoc.exists && locDoc.data().location) || legacyLoc || '';
      if (legacyDob && !(dobDoc && dobDoc.exists)) {
        jobs.push(ref('userDob').set({ dob: legacyDob }).then(function () { cleanup.dob = FieldValue.delete(); }));
      } else if (legacyDob) { cleanup.dob = FieldValue.delete(); }
      if (legacyLoc) {
        jobs.push(ref('userLocations').set({ location: legacyLoc }).then(function () { cleanup.location = ''; }));
      }
      return Promise.all(jobs.map(function (jb) { return jb.catch(function () {}); })).then(function () {
        if (Object.keys(cleanup).length) return ref('users').update(cleanup).catch(function () {});
      });
    }).catch(function () {});
  }

  function loadMyProfile() {
    return db.collection('users').doc(currentUid).get().then(function (doc) {
      myProfile = doc.exists ? doc.data() : {};
      return loadMyPrivate(myProfile);
    }).then(function () {
      profileName.value = myProfile.displayName || '';
      profileBio.value = myProfile.bio || '';
      profileInterests.value = interestsOf(myProfile).join(', ');
      profileHideLocation.checked = !!myProfile.hideLocation;
      profileHideStats.checked = !!myProfile.hideStats;
    profileShowPresence.checked = !myProfile.hidePresence;
      updateBioCount();
      profileLocation.value = myProfile.location || '';
      profileEmail.textContent = auth.currentUser.email || '';
      if (myProfile.dob) {
        profileDobWrap.innerHTML = 'Date of birth (private \u2014 shown only to you)<p class="form-note">' + myProfile.dob + ' (can\u2019t be changed)</p>';
      }
      document.getElementById('profile-photo-pending').hidden = true;
      removeCoverFlag = false;
      renderProfilePreview();
      refreshMyProfileExtras();
      startPresence();
      refreshPresence(true);
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
    profileShowPresence.checked = !myProfile.hidePresence;
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
      location: profileHideLocation.checked ? '' : profileLocation.value.trim(),
      interests: parseInterests(profileInterests.value),
      hideLocation: profileHideLocation.checked,
      hideStats: profileHideStats.checked,
      hidePresence: !profileShowPresence.checked
    };
    var locVal = profileLocation.value.trim();
    var hideLoc = profileHideLocation.checked;
    var dobVal = (!myProfile.dob && profileDob.value) ? profileDob.value : null;

    var photoWork = croppedPhotoFile ? uploadToCloudinary(croppedPhotoFile) : Promise.resolve(undefined);
    var coverWork = profileCover.files[0] ? uploadToCloudinary(profileCover.files[0]) : Promise.resolve(undefined);
    Promise.all([photoWork, coverWork]).then(function (rs) {
      if (rs[0]) update.photoURL = rs[0].url;
      if (rs[1]) update.coverURL = rs[1].url;
      else if (removeCoverFlag) update.coverURL = null;
      var pre = [];
      if (hideLoc) pre.push(db.collection('userLocations').doc(currentUid).set({ location: locVal }));
      if (dobVal) pre.push(db.collection('userDob').doc(currentUid).set({ dob: dobVal }));
      return Promise.all(pre);
    }).then(function () {
      return db.collection('users').doc(currentUid).update(update);
    }).then(function () {
      if (!hideLoc) return db.collection('userLocations').doc(currentUid).delete().catch(function () {});
    }).then(function () {
      return auth.currentUser.updateProfile({ displayName: update.displayName });
    }).then(function () {
      profilePhoto.value = ''; croppedPhotoFile = null;
      profilePhotoPending.hidden = true;
      profileCover.value = '';
      profileCoverPending.hidden = true;
      removeCoverFlag = false;
      if (myProfile) myProfile.hidePresence = update.hidePresence;
      startPresence(); refreshPresence(true);
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
      if (blockedUids.has(u.id)) return false;
      if (!q) return true;
      var hay = [u.displayName, locationOf(u), u.bio].concat(interestsOf(u)).join(' ').toLowerCase();
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
      makeActivatable(av, function () { openMemberProfile(u); }, 'View ' + (u.displayName || 'member') + '\u2019s profile');
      row.appendChild(av);
      var info = document.createElement('div');
      info.className = 'member-info';
      var name = document.createElement('p');
      name.className = 'member-name clickable';
      makeActivatable(name, function () { openMemberProfile(u); });
      name.textContent = u.displayName || 'Member';
      info.appendChild(name);
      var pEl = buildPresenceEl(u.id);
      if (pEl) info.appendChild(pEl);
      var shownLoc = locationOf(u);
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
      sendFriendRequest(u).catch(function (err) {
        if (window.console) console.error('Add friend failed:', err && (err.code || err.message) || err);
        add.disabled = false;
        add.textContent = 'Couldn\u2019t send \u2014 retry';
      });
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
    var forwardId = me + '_' + u.id;
    // Query instead of reading a doc that may not exist: the rules only allow
    // reads on requests you're part of, and a read of a missing doc is refused.
    return db.collection('friendRequests')
      .where('fromUid', '==', u.id).where('toUid', '==', me).get().then(function (snap) {
        var pending = null;
        snap.forEach(function (d) { if (d.data().status === 'pending') pending = d; });
        if (pending) {
          return db.collection('friendRequests').doc(pending.id).update({
            status: 'accepted', respondedAt: FieldValue.serverTimestamp()
          }).then(function () { return notifyIfNotSelf(u.id, 'friendAccept'); });
        }
        return db.collection('friendRequests').doc(forwardId).set({
          fromUid: me, fromName: myProfile.displayName || 'Member',
          toUid: u.id, toName: u.displayName || 'Member',
          status: 'pending', createdAt: FieldValue.serverTimestamp()
        }).then(function () { return notifyIfNotSelf(u.id, 'friendRequest'); });
      }).then(loadRelationships);
  }

  function respondToRequest(reqId, status) {
    return db.collection('friendRequests').doc(reqId).update({
      status: status, respondedAt: FieldValue.serverTimestamp()
    }).then(function () {
      return status === 'accepted' ? notifyIfNotSelf(reqId.split('_')[0], 'friendAccept') : null;
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
        if (d.status === 'pending' && !blockedUids.has(d.fromUid)) incomingPending.push({ id: doc.id, uid: d.fromUid, name: d.fromName });
      });

      requestsBadge.hidden = incomingPending.length === 0;
      if (incomingPending.length) requestsBadge.textContent = String(incomingPending.length);

      renderRequestRows(incomingList, incomingPending, true);
      renderRequestRows(outgoingList, outgoingPending, false);
      renderMembersList();
      renderFeedOnce();
      refreshMyProfileExtras();
      rerenderOpenProfileCard();
      return loadFriendLocations().then(function () {
        renderMembersList();
        rerenderOpenProfileCard();
      });
    });
  }

  function rerenderOpenProfileCard() {
    if (!openProfileUid || !usersByUid[openProfileUid]) return;
    var cu = usersByUid[openProfileUid];
    var keep = document.getElementById('member-profile-stats');
    var oldStats = keep ? keep.innerHTML : '';
    memberProfileCard.innerHTML = '';
    memberProfileCard.appendChild(buildPublicProfileCard(cu));
    document.getElementById('member-profile-stats').innerHTML = oldStats;
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
        snap.forEach(function (doc) {
          var pp = doc.data().participants || [];
          var ou = pp[0] === currentUid ? pp[1] : pp[0];
          // Opening a chat creates an empty record; only show chats that have a message.
          if (!blockedUids.has(ou) && doc.data().lastMessage) convs.push({ id: doc.id, data: doc.data() });
        });
        convs.sort(function (a, b) {
          var as = (a.data.lastMessageAt && a.data.lastMessageAt.seconds) || 0;
          var bs = (b.data.lastMessageAt && b.data.lastMessageAt.seconds) || 0;
          return bs - as;
        });

        var unreadCount = convs.filter(function (c) { return isUnread(c.data); }).length;
        unreadMsgCount = unreadCount;
        updateTitleBadge();
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
    updateThreadPresence();
    refreshPresence(false);
    inboxView.hidden = true;
    threadView.hidden = false;
    threadMessages.innerHTML = '<p class="form-note">Loading\u2026</p>';

    db.collection('conversations').doc(activeConvId).set({
      participants: participants
    }, { merge: true }).then(function () { markRead(activeConvId, participants); subscribeConvRead(participants); });

    stopThread();
    msgLimit = MSG_PAGE; lastThreadDocs = []; otherReadMs = 0; threadHasMore = false;
    subscribeThread(participants);
  }

  var MSG_PAGE = 50;
  var msgLimit = MSG_PAGE;
  var lastThreadDocs = [];
  var otherReadMs = 0;
  var threadHasMore = false;
  var loadingEarlier = false;
  var convUnsub = null;

  /* typing indicator (field typingAt0/typingAt1 on the conversation doc) */
  var threadTyping = document.getElementById('thread-typing');
  var otherTypingSeen, typingHideTimer = null, lastTypingSentAt = 0;

  function showTyping() {
    threadTyping.hidden = false;
    clearTimeout(typingHideTimer);
    typingHideTimer = setTimeout(hideTyping, 6000);
  }
  function hideTyping() {
    clearTimeout(typingHideTimer);
    threadTyping.hidden = true;
  }
  // Tell the other person I'm typing, at most once every 3 seconds. Not sent
  // if I've hidden my online status or either of us has blocked the other.
  function sendTyping() {
    if (!activeConvId || (myProfile && myProfile.hidePresence) || blockedUids.has(activeOtherUid)) return;
    var now = Date.now();
    if (now - lastTypingSentAt < 3000) return;
    lastTypingSentAt = now;
    var f = [currentUid, activeOtherUid].sort()[0] === currentUid ? 'typingAt0' : 'typingAt1';
    var upd = {}; upd[f] = FieldValue.serverTimestamp();
    db.collection('conversations').doc(activeConvId).set(upd, { merge: true }).catch(function () {});
  }

  function stopThread() {
    if (threadUnsub) { threadUnsub(); threadUnsub = null; }
    if (convUnsub) { convUnsub(); convUnsub = null; }
    hideTyping(); lastTypingSentAt = 0;
  }

  function dayLabel(d) {
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var that = new Date(d); that.setHours(0, 0, 0, 0);
    var diff = Math.round((today - that) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function renderThread() {
    var prevH = threadMessages.scrollHeight, prevTop = threadMessages.scrollTop;
    threadMessages.innerHTML = '';
    if (!lastThreadDocs.length) { threadMessages.innerHTML = '<p class="form-note">Say hello \u2014 no messages yet.</p>'; return; }
    if (threadHasMore) {
      var more = document.createElement('button');
      more.type = 'button'; more.className = 'btn btn-ghost btn-sm load-earlier-btn';
      more.textContent = 'Load earlier messages';
      more.addEventListener('click', function () {
        more.disabled = true; more.textContent = 'Loading\u2026';
        loadingEarlier = true; msgLimit += MSG_PAGE;
        if (threadUnsub) { threadUnsub(); threadUnsub = null; }
        subscribeThread([currentUid, activeOtherUid].sort(), true);
      });
      threadMessages.appendChild(more);
    }
    var lastMine = -1;
    lastThreadDocs.forEach(function (m, i) { if (m.fromUid === currentUid) lastMine = i; });
    var lastDay = '';
    lastThreadDocs.forEach(function (m, i) {
      var cd = toDate(m.createdAt);
      if (cd) {
        var label = dayLabel(cd);
        if (label !== lastDay) {
          var div = document.createElement('div');
          div.className = 'msg-day'; div.textContent = label;
          threadMessages.appendChild(div);
          lastDay = label;
        }
      }
      var bubble = document.createElement('div');
      bubble.className = 'msg-bubble ' + (m.fromUid === currentUid ? 'mine' : 'theirs');
      var text = document.createElement('span');
      text.textContent = m.text || '';
      bubble.appendChild(text);
      var time = document.createElement('span');
      time.className = 'msg-time';
      var stamp = cd ? relTime(cd) : '';
      if (i === lastMine) {
        var status = !cd ? 'Sending\u2026' : (otherReadMs >= cd.getTime() ? 'Seen' : 'Sent');
        stamp = stamp ? stamp + ' \u00b7 ' + status : status;
      }
      time.textContent = stamp;
      bubble.appendChild(time);
      if (m.fromUid === currentUid && m._id) {
        var del = document.createElement('button');
        del.type = 'button'; del.className = 'msg-del';
        del.textContent = 'Delete';
        del.setAttribute('aria-label', 'Delete this message');
        del.addEventListener('click', function () {
          if (!window.confirm('Delete this message for everyone?')) return;
          del.disabled = true;
          db.collection('conversations').doc(activeConvId).collection('messages').doc(m._id).delete()
            .catch(function () { del.disabled = false; del.textContent = 'Retry'; });
        });
        bubble.appendChild(del);
      }
      threadMessages.appendChild(bubble);
    });
    if (loadingEarlier) {
      threadMessages.scrollTop = threadMessages.scrollHeight - prevH + prevTop;
      loadingEarlier = false;
    } else {
      threadMessages.scrollTop = threadMessages.scrollHeight;
    }
  }

  function subscribeThread(participants, keepConv) {
    threadUnsub = db.collection('conversations').doc(activeConvId).collection('messages')
      .orderBy('createdAt', 'desc').limit(msgLimit)
      .onSnapshot(function (snap) {
        var arr = [];
        snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; arr.push(d); });
        arr.reverse();
        lastThreadDocs = arr;
        if (arr.length && arr[arr.length - 1].fromUid === activeOtherUid) hideTyping();
        threadHasMore = snap.size >= msgLimit;
        renderThread();
        // Still looking at this thread when a new message lands -> stays read.
        if (activeConvId) markRead(activeConvId, participants);
      }, function () {
        threadMessages.innerHTML = '<p class="form-note">Couldn\u2019t load this conversation.</p>';
      });
  }

  // Subscribed only after the conversation doc is known to exist (rules need it).
  function subscribeConvRead(participants) {
    if (convUnsub || !activeConvId) return;
    var otherField = participants[0] === activeOtherUid ? 'lastReadAt0' : 'lastReadAt1';
    var otherTypingField = participants[0] === activeOtherUid ? 'typingAt0' : 'typingAt1';
    otherTypingSeen = undefined;
    convUnsub = db.collection('conversations').doc(activeConvId).onSnapshot(function (doc) {
      var d = doc.data() || {};
      // Typing: a new value in the other person's field means they just
      // typed. Comparing values (not clocks) keeps it immune to clock skew.
      var tt = toDate(d[otherTypingField]);
      var ttMs = tt ? tt.getTime() : 0;
      if (otherTypingSeen !== undefined && ttMs && ttMs !== otherTypingSeen &&
          !(myProfile && myProfile.hidePresence) && !blockedUids.has(activeOtherUid)) {
        showTyping();
      }
      otherTypingSeen = ttMs;
      var t = toDate(d[otherField]);
      otherReadMs = t ? t.getTime() : 0;
      if (lastThreadDocs.length) renderThread();
    }, function () {});
  }

  threadBack.addEventListener('click', function () {
    stopThread();
    threadView.hidden = true;
    inboxView.hidden = false;
    activeConvId = null; activeOtherUid = null;
  });

  var coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  function autosizeThreadInput() {
    threadInput.style.height = 'auto';
    threadInput.style.height = Math.min(threadInput.scrollHeight, 120) + 'px';
  }
  threadInput.addEventListener('input', autosizeThreadInput);
  threadInput.addEventListener('input', function () { if (threadInput.value.trim()) sendTyping(); });
  threadInput.addEventListener('keydown', function (e) {
    // Desktop: Enter sends, Shift+Enter = new line. Touch keyboards: Enter = new line.
    if (e.key === 'Enter' && !e.shiftKey && !coarsePointer && !e.isComposing) {
      e.preventDefault();
      if (threadInput.value.trim()) threadForm.requestSubmit();
    }
  });

  threadForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = threadInput.value.trim();
    if (!text || !activeConvId) return;
    var sendBtn = threadForm.querySelector('button[type="submit"]');
    sendBtn.disabled = true;
    lastTypingSentAt = 0;
    threadInput.value = '';
    autosizeThreadInput();
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
      fromName: (myProfile && myProfile.displayName) || 'Member',
      read: false, createdAt: FieldValue.serverTimestamp()
    }, extra || {});
    return db.collection('notifications').add(payload).catch(function () {});
  }

  function notifClearedMs() {
    try { return Number(localStorage.getItem('sholomoh:notifCleared:' + currentUid)) || 0; } catch (e) { return 0; }
  }

  function groupNotifs(list) {
    var map = {}, order = [];
    list.forEach(function (n) {
      var d = n.data;
      var k = d.type + ':' + (d.postId || d.convId || d.fromUid || '');
      if (!map[k]) { map[k] = { type: d.type, sample: d, items: [], names: [] }; order.push(map[k]); }
      var g = map[k];
      g.items.push(n);
      var nm = d.fromName || 'Someone';
      if (g.names.indexOf(nm) === -1) g.names.push(nm);
    });
    return order;
  }

  function groupText(g) {
    var n = g.names;
    var who = n.length === 1 ? n[0] : n.length === 2 ? n[0] + ' and ' + n[1] : n[0] + ' and ' + (n.length - 1) + ' others';
    var title = '\u201c' + (g.sample.postTitle || '') + '\u201d';
    if (g.type === 'like') return who + ' liked your story ' + title;
    if (g.type === 'comment') return who + ' commented on your story ' + title;
    if (g.type === 'reply') return who + ' replied to your comment on ' + title;
    if (g.type === 'message') return g.items.length > 1 ? who + ' sent you ' + g.items.length + ' messages' : who + ' sent you a message';
    if (g.type === 'friendRequest') return who + ' sent you a friend request';
    if (g.type === 'friendAccept') return who + ' accepted your friend request';
    return who + ' did something';
  }

  function openNotifGroup(g) {
    g.items.forEach(function (n) {
      if (!n.data.read) db.collection('notifications').doc(n.id).update({ read: true }).catch(function () {});
    });
    notifPanel.hidden = true;
    var d = g.sample;
    if ((g.type === 'like' || g.type === 'comment' || g.type === 'reply') && d.postId) {
      openStoryFocus(d.postId);
    } else if (g.type === 'message') {
      openConversation(usersByUid[d.fromUid] || { id: d.fromUid, displayName: d.fromName });
    } else if (g.type === 'friendRequest') {
      document.querySelector('#main-tabs .tab-btn[data-tab="requests"]').click();
    } else if (g.type === 'friendAccept' && usersByUid[d.fromUid]) {
      document.querySelector('#main-tabs .tab-btn[data-tab="members"]').click();
      openMemberProfile(usersByUid[d.fromUid]);
    }
  }

  function renderNotifList() {
    var cleared = notifClearedMs();
    var visible = lastNotifs.filter(function (n) {
      var cd = toDate(n.data.createdAt);
      return (!cd || cd.getTime() > cleared) && !blockedUids.has(n.data.fromUid);
    });
    var unread = visible.filter(function (n) { return !n.data.read; }).length;
    unreadNotifCount = unread;
    updateTitleBadge();
    notifBadge.hidden = unread === 0;
    if (unread) notifBadge.textContent = String(unread > 9 ? '9+' : unread);

    if (!visible.length) {
      notifList.innerHTML = '<p class="form-note">No notifications yet.</p>';
      return;
    }
    notifList.innerHTML = '';
    groupNotifs(visible).slice(0, 25).forEach(function (g) {
      var row = document.createElement('div');
      var isUnread = g.items.some(function (n) { return !n.data.read; });
      row.className = 'notif-row clickable' + (isUnread ? ' unread' : '');
      var text = document.createElement('div');
      var main = document.createElement('span');
      main.textContent = groupText(g);
      var time = document.createElement('span');
      time.className = 'notif-time';
      var cd = toDate(g.items[0].data.createdAt);
      time.textContent = cd ? relTime(cd) : '';
      text.appendChild(main); text.appendChild(time);
      row.appendChild(text);
      makeActivatable(row, function () { openNotifGroup(g); }, groupText(g));
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
    notifBell.setAttribute('aria-expanded', notifPanel.hidden ? 'false' : 'true');
  });
  document.getElementById('notif-markall').addEventListener('click', markAllNotifsRead);
  document.getElementById('notif-clear').addEventListener('click', function () {
    try { localStorage.setItem('sholomoh:notifCleared:' + currentUid, String(Date.now())); } catch (e) {}
    // Best-effort delete (needs the notifications delete rule); hidden locally either way.
    lastNotifs.forEach(function (n) { db.collection('notifications').doc(n.id).delete().catch(function () {}); });
    renderNotifList();
  });

  /* ---------- deep links: #u=<uid> (profile), #s=<postId> (story) ---------- */
  function handleHash() {
    if (!currentUid) return;
    var m = /^#([us])=([A-Za-z0-9_-]+)$/.exec(location.hash);
    if (!m) return;
    if (m[1] === 's') {
      if (focusId !== m[2]) openStoryFocus(m[2]);
    } else if (m[2] === currentUid) {
      document.querySelector('#main-tabs .tab-btn[data-tab="profile"]').click();
    } else if (usersByUid[m[2]] && openProfileUid !== m[2]) {
      document.querySelector('#main-tabs .tab-btn[data-tab="members"]').click();
      openMemberProfile(usersByUid[m[2]]);
    }
  }
  window.addEventListener('hashchange', handleHash);

  /* ---------- auth state ---------- */

  auth.onAuthStateChanged(function (user) {
    editingId = null;
    if (!user) {
      if (feedUnsub) { feedUnsub(); feedUnsub = null; }
      if (inboxUnsub) { inboxUnsub(); inboxUnsub = null; }
      stopThread(); closeStoryFocus();
      if (notifUnsub) { notifUnsub(); notifUnsub = null; }
      Object.keys(commentUnsubs).forEach(function (k) { commentUnsubs[k](); });
      commentUnsubs = {};
      lastSnap = null; lastNotifs = [];
      currentUid = null; amAdmin = false;
      friendUids = new Set(); outgoingByUid = {}; incomingByUid = {};
      myLikedPostIds = new Set(); expandedComments = new Set(); commentsCache = {};
      expandedStories = new Set(); feedLimit = FEED_PAGE; editingCommentId = null;
      postForm.reset(); updateDraftUI();
      heldBack = {}; newestSeen = 0; feedInitialised = false; newPill.hidden = true;
      threadView.hidden = true; inboxView.hidden = false;
      activeConvId = null; activeOtherUid = null;
      notifPanel.hidden = true; notifBadge.hidden = true;
      authSection.hidden = false;
      appSection.hidden = true;
      tabRestored = true;
      try { sessionStorage.removeItem('sholomoh:tab'); } catch (e) {}
      stopPresence(); presenceMap = {}; unreadNotifCount = 0; unreadMsgCount = 0; updateTitleBadge();
      return;
    }
    authSection.hidden = true;
    appSection.hidden = false;
    currentUid = user.uid;
    restoreTab();
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
      updateDraftUI();
      requestBox.hidden = poster;
      adminTabBtn.hidden = !admin;
      if (!poster) checkRequestStatus(user.uid);
      if (admin) { loadPosterRequests(); loadReports(); }
      restoreTab();
      renderFeedOnce();
    });

    loadAllUsers().then(function () {
      return loadBlocks().then(function () { renderFeedOnce(); }).catch(function () {});
    }).then(function () {
      loadRelationships();
      loadInbox();
      handleHash();
    });
  });
})();
