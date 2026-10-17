/* Warrior Fellowship: members-only posts, photos/videos/documents, discussions, likes, reshare, reports.
   All text is written with textContent. Media is only shown from this site's own Cloudinary account. */
(function () {
  'use strict';

  var gateEl = document.getElementById('fw-gate');
  var mainEl = document.getElementById('fw-main');
  var adminEl = document.getElementById('fw-admin');
  var composeEl = document.getElementById('fw-compose');
  var feedEl = document.getElementById('fw-feed');
  var statusEl = document.getElementById('fw-status');
  var moreBtn = document.getElementById('fw-more');

  // The verse text: paste it from your own TPT (or AMP) copy between the backticks. Leave it empty to show links only.
  var VERSE_TEXT = ``;

  var KINDS = [
    { key: 'all', label: 'All' },
    { key: 'encouragement', label: 'Encouragement' },
    { key: 'testimony', label: 'Testimony' },
    { key: 'prayer', label: 'Prayer' },
    { key: 'teaching', label: 'Teaching' },
    { key: 'other', label: 'Other' }
  ];
  var activeKind = 'all';
  var kindNames = { encouragement: 'Encouragement', testimony: 'Testimony', prayer: 'Prayer request', teaching: 'Teaching', other: 'Other' };

  var db = null, auth = null, me = null;
  var isAdmin = false;
  var isMember = false;
  var cursor = null, pageSize = 25;
  var posts = {};            // id -> data (cache for reshares)
  var myLikes = {}, myCommentLikes = {};
  var nameCache = null;
  var CLOUD = (window.CLOUDINARY_CONFIG && window.CLOUDINARY_CONFIG.cloudName) || '';
  var PRESET = (window.CLOUDINARY_CONFIG && window.CLOUDINARY_CONFIG.uploadPreset) || '';
  var MAX_IMG_DOC = 20 * 1024 * 1024, MAX_VIDEO = 100 * 1024 * 1024;
  var DOC_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv'];

  /* ---------- helpers ---------- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function iso(name) { return '\u2068' + String(name == null ? '' : name) + '\u2069'; }
  function ms(t) { return t && t.toDate ? t.toDate().getTime() : (t && t.seconds ? t.seconds * 1000 : 0); }
  function timeAgo(t) {
    var d = ms(t); if (!d) return '';
    var s = Math.max(0, Math.round((Date.now() - d) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function ownMedia(u) {
    return typeof u === 'string' && CLOUD && u.indexOf('https://res.cloudinary.com/' + CLOUD + '/') === 0 && u.length <= 600 ? u : '';
  }
  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.className = 'form-note' + (isError ? ' form-error' : '');
  }
  function viewerName() {
    if (nameCache) return Promise.resolve(nameCache);
    return db.collection('users').doc(me.uid).get().then(function (d) {
      nameCache = (d.exists && d.data().displayName) || 'Member';
      return nameCache;
    }).catch(function () { return 'Member'; });
  }
  function notify(toUid, type, extra) {
    if (!toUid || toUid === me.uid) return;
    viewerName().then(function (name) {
      var data = { toUid: toUid, fromUid: me.uid, fromName: name, type: type, read: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp() };
      if (extra) Object.keys(extra).forEach(function (k) { data[k] = extra[k]; });
      return db.collection('notifications').add(data);
    }).catch(function () {});
  }
  function snippetOf(text) { var s = String(text || '').replace(/\s+/g, ' ').trim(); return s.length > 80 ? s.slice(0, 80) + '…' : s; }

  /* ---------- access ---------- */
  function showGate(html) {
    gateEl.hidden = false; mainEl.hidden = true;
    gateEl.innerHTML = '';
    gateEl.appendChild(html);
  }
  function gateMessage(text, action) {
    var box = el('div', 'fw-gate-box');
    box.appendChild(el('p', 'fw-gate-text', text));
    if (action) box.appendChild(action);
    return box;
  }
  function linkBtn(text, href, primary) {
    var a = el('a', 'btn ' + (primary ? 'btn-primary' : 'btn-ghost'), text); a.href = href; return a;
  }

  function checkAccess(user) {
    if (!user) {
      showGate(gateMessage('Warrior Fellowship is a faith community for approved members. Sign in with your Members account to continue.',
        linkBtn('Sign in with Members', 'members.html', true)));
      return Promise.resolve();
    }
    return Promise.all([
      db.collection('admins').doc(user.uid).get(),
      db.collection('fellowshipMembers').doc(user.uid).get(),
      db.collection('fellowshipRequests').doc(user.uid).get()
    ]).then(function (r) {
      isAdmin = r[0].exists;
      isMember = r[1].exists;
      // Admins can always open the page (to approve people and to join themselves).
      if (isMember || isAdmin) return openFellowship();
      if (r[2].exists) {
        showGate(gateMessage('Your request to join is waiting for approval. You\u2019ll see the fellowship once it\u2019s approved.'));
        return;
      }
      var btn = el('button', 'btn btn-primary', 'Request to join'); btn.type = 'button';
      btn.addEventListener('click', function () {
        btn.disabled = true;
        viewerName().then(function (name) {
          return db.collection('fellowshipRequests').doc(me.uid).set({
            uid: me.uid, name: name, status: 'pending', requestedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        }).then(function () { return checkAccess(me); })
          .catch(function () { btn.disabled = false; setStatus('Couldn\u2019t send your request. Try again.', true); });
      });
      showGate(gateMessage('Warrior Fellowship is a faith community, by approval. Send a request and it will be reviewed.', btn));
    }).catch(function () {
      showGate(gateMessage('Couldn\u2019t check your access. Check your connection and refresh.'));
    });
  }

  function setVerse() {
    var t = document.getElementById('fw-verse-text');
    var s = String(VERSE_TEXT || '').trim();
    if (s) { t.textContent = s; t.hidden = false; }
  }

  function loadMemberCount() {
    db.collection('fellowshipMembers').get().then(function (snap) {
      document.getElementById('fw-count').textContent = snap.size + (snap.size === 1 ? ' member' : ' members');
    }).catch(function () {});
  }

  function renderFilters() {
    var box = document.getElementById('fw-filters');
    box.innerHTML = '';
    KINDS.forEach(function (k) {
      var b = el('button', 'fw-filter' + (activeKind === k.key ? ' is-active' : ''), k.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', activeKind === k.key ? 'true' : 'false');
      b.addEventListener('click', function () { activeKind = k.key; renderFilters(); applyFilter(); });
      box.appendChild(b);
    });
  }

  function applyFilter() {
    Array.prototype.forEach.call(feedEl.querySelectorAll('.fw-post'), function (card) {
      var k = card.getAttribute('data-kind') || 'other';
      card.hidden = !(activeKind === 'all' || k === activeKind);
    });
  }

  function openFellowship() {
    gateEl.hidden = true; mainEl.hidden = false;
    adminEl.hidden = !isAdmin;
    if (isAdmin) loadAdmin();
    setVerse();
    loadMemberCount();
    renderFilters();
    var role = document.getElementById('fw-role');
    role.hidden = false;
    role.textContent = isAdmin ? 'Admin' : 'Member';
    if (isMember) renderComposer(); else renderAdminJoin();
    loadPosts(true);
  }

  // Admins who aren't in the fellowship yet can add themselves here, then they can post.
  function renderAdminJoin() {
    composeEl.innerHTML = '';
    var box = el('div', 'fw-gate-box');
    box.appendChild(el('p', 'fw-gate-text', 'You\u2019re an admin, but you aren\u2019t a fellowship member yet. Join to post, comment and like. You can also approve other people from the panel above.'));
    var btn = el('button', 'btn btn-primary', 'Join the fellowship as admin'); btn.type = 'button';
    btn.addEventListener('click', function () {
      btn.disabled = true;
      viewerName().then(function (name) {
        return db.collection('fellowshipMembers').doc(me.uid).set({
          uid: me.uid, name: name, approvedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      }).then(function () { return checkAccess(me); })
        .catch(function () { btn.disabled = false; setStatus('Couldn\u2019t add you. Check the rules are published and try again.', true); });
    });
    box.appendChild(btn);
    composeEl.appendChild(box);
  }

  /* ---------- composer ---------- */
  function classify(file) {
    var t = String(file.type || '').toLowerCase();
    var ext = (String(file.name || '').split('.').pop() || '').toLowerCase();
    if (t === 'image/svg+xml' || ext === 'svg') return null;
    if (t.indexOf('image/') === 0) return 'image';
    if (t.indexOf('video/') === 0) return 'video';
    if (DOC_EXT.indexOf(ext) !== -1) return 'file';
    return null;
  }

  function renderComposer() {
    composeEl.innerHTML = '';
    var box = el('form', 'fw-composer');
    var ta = el('textarea', 'story-input'); ta.rows = 3; ta.maxLength = 4000; ta.placeholder = 'Share an encouragement, testimony, prayer request or teaching…';
    ta.setAttribute('aria-label', 'Your post');
    var kindRow = el('label', 'fw-kind-row', 'Type ');
    var kindSel = el('select', 'field-input');
    ['encouragement', 'testimony', 'prayer', 'teaching', 'other'].forEach(function (k) {
      var o = el('option', '', kindNames[k]); o.value = k; kindSel.appendChild(o);
    });
    kindSel.setAttribute('aria-label', 'Type of post');
    kindRow.appendChild(kindSel);
    var fileIn = el('input'); fileIn.type = 'file'; fileIn.multiple = true;
    fileIn.accept = 'image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv';
    fileIn.setAttribute('aria-label', 'Attach photos, videos or documents');
    var chosen = el('p', 'form-note fw-chosen', '');
    var row = el('div', 'fw-composer-row');
    var btn = el('button', 'btn btn-primary btn-sm', 'Post'); btn.type = 'submit';
    row.appendChild(el('span', 'fw-hint', 'Up to 10 files'));
    row.appendChild(btn);
    var files = [];
    fileIn.addEventListener('change', function () {
      var picked = Array.prototype.slice.call(fileIn.files, 0);
      files = []; var msg = [];
      picked.forEach(function (f) {
        var kind = classify(f);
        var max = kind === 'video' ? MAX_VIDEO : MAX_IMG_DOC;
        if (!kind) msg.push(f.name + ' (type not allowed)');
        else if (f.size > max) msg.push(f.name + ' (too large)');
        else if (files.length >= 10) msg.push(f.name + ' (more than 10 files)');
        else files.push({ file: f, kind: kind });
      });
      chosen.textContent = files.length ? files.length + ' file' + (files.length === 1 ? '' : 's') + ' ready' + (msg.length ? '. Skipped: ' + msg.join(', ') : '') : (msg.length ? 'Skipped: ' + msg.join(', ') : '');
    });
    box.appendChild(kindRow); box.appendChild(ta); box.appendChild(fileIn); box.appendChild(chosen); box.appendChild(row);
    box.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = ta.value.trim();
      if (!body && !files.length) { setStatus('Write something or attach a file.', true); return; }
      btn.disabled = true; setStatus('Posting…');
      uploadAll(files).then(function (atts) {
        return viewerName().then(function (name) {
          return db.collection('fellowshipPosts').add({
            authorUid: me.uid, authorName: name, body: body, attachments: atts,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            likeCount: 0, commentCount: 0, reshareOf: null, reshareNote: '', kind: kindSel.value
          });
        });
      }).then(function () {
        ta.value = ''; fileIn.value = ''; files = []; chosen.textContent = '';
        setStatus('Posted.');
        return loadPosts(true);
      }).catch(function (err) {
        setStatus((err && err.message) || 'Couldn\u2019t post. Check the rules are published and try again.', true);
      }).then(function () { btn.disabled = false; });
    });
    composeEl.appendChild(box);
  }

  function uploadOne(f, kind) {
    if (!CLOUD || !PRESET) return Promise.reject(new Error('Uploads aren\u2019t configured.'));
    var fd = new FormData();
    fd.append('file', f);
    fd.append('upload_preset', PRESET);
    return fetch('https://api.cloudinary.com/v1_1/' + CLOUD + '/auto/upload', { method: 'POST', body: fd })
      .then(function (r) { if (!r.ok) throw new Error('Upload failed for ' + f.name + '.'); return r.json(); })
      .then(function (data) {
        var u = ownMedia(data.secure_url);
        if (!u) throw new Error('Upload came back from an unexpected address.');
        return { type: kind, url: u, name: String(f.name || 'file').slice(0, 200), size: f.size };
      });
  }
  function uploadAll(files) {
    var out = [];
    return files.reduce(function (p, item) {
      return p.then(function () { return uploadOne(item.file, item.kind); }).then(function (a) { out.push(a); });
    }, Promise.resolve()).then(function () { return out; });
  }

  /* ---------- feed ---------- */
  function loadPosts(reset) {
    if (reset) { cursor = null; feedEl.innerHTML = ''; posts = {}; }
    var q = db.collection('fellowshipPosts').orderBy('createdAt', 'desc').limit(pageSize);
    if (cursor) q = q.startAfter(cursor);
    setStatus(reset ? 'Loading…' : '');
    return Promise.all([q.get(), db.collection('fellowshipLikes').where('uid', '==', me.uid).get()]).then(function (r) {
      var snap = r[0];
      r[1].forEach(function (d) { myLikes[d.data().postId] = true; });
      if (snap.size) cursor = snap.docs[snap.docs.length - 1];
      moreBtn.hidden = snap.size < pageSize;
      if (reset && !snap.size) feedEl.appendChild(el('p', 'form-note', 'No posts yet. Be the first to share.'));
      snap.forEach(function (doc) {
        posts[doc.id] = doc.data();
        feedEl.appendChild(buildPost(doc.id, doc.data()));
      });
      setStatus('');
      applyFilter();
      openFromHash();
    }).catch(function () {
      setStatus('Couldn\u2019t load posts. Check your connection and try again.', true);
    });
  }
  moreBtn.addEventListener('click', function () { loadPosts(false); });

  function openFromHash() {
    var m = /^#post=([A-Za-z0-9_-]+)$/.exec(location.hash);
    if (!m) return;
    var card = feedEl.querySelector('[data-post="' + m[1] + '"]');
    if (!card) return;
    card.scrollIntoView({ block: 'start' });
    card.classList.add('is-highlight');
    var open = card.querySelector('.fw-discuss-toggle');
    if (open && !card.querySelector('.fw-discussion')) open.click();
  }

  function buildPost(id, d) {
    var card = el('article', 'fw-post');
    card.setAttribute('data-post', id);
    card.setAttribute('data-kind', d.kind || 'other');
    var head = el('div', 'fw-post-head');
    var av = el('span', 'fw-avatar', (d.authorName || 'M').trim().charAt(0).toUpperCase());
    head.appendChild(av);
    var meta = el('div', 'fw-post-meta');
    meta.appendChild(el('bdi', 'fw-author', d.authorName || 'Member'));
    meta.appendChild(el('span', 'fw-time', ' \u00b7 ' + timeAgo(d.createdAt) + (d.updatedAt ? ' \u00b7 edited' : '')));
    head.appendChild(meta);
    if (d.kind && kindNames[d.kind]) head.appendChild(el('span', 'fw-kind fw-kind-' + d.kind, kindNames[d.kind]));
    card.appendChild(head);

    if (d.reshareOf) {
      var note = el('p', 'fw-reshare-note', d.reshareNote || '');
      if (d.reshareNote) card.appendChild(note);
      card.appendChild(el('p', 'fw-reshare-label', '\u21bb Reshared'));
      var box = el('div', 'fw-embed');
      box.appendChild(el('p', 'form-note', 'Loading original…'));
      card.appendChild(box);
      loadOriginal(d.reshareOf).then(function (orig) {
        box.innerHTML = '';
        if (!orig) { box.appendChild(el('p', 'form-note', 'The original post was removed.')); return; }
        box.appendChild(el('p', 'fw-embed-author', '')).appendChild(el('bdi', '', orig.data.authorName || 'Member'));
        box.appendChild(el('p', 'fw-embed-text', snippetOf(orig.data.body) || '(attachments only)'));
        var open = el('a', 'fw-embed-link', 'Open original'); open.href = '#post=' + orig.id;
        open.addEventListener('click', function (e) { e.preventDefault(); location.hash = '#post=' + orig.id; });
        box.appendChild(open);
      });
    }

    if (d.body) card.appendChild(el('p', 'fw-body', d.body));
    if ((d.attachments || []).length) card.appendChild(buildAttachments(d.attachments));

    var actions = el('div', 'fw-actions');
    var liked = !!myLikes[id];
    var like = el('button', 'fw-action' + (liked ? ' is-liked' : ''), (liked ? '\u2665 ' : '\u2661 ') + (Number(d.likeCount) || 0));
    like.type = 'button'; like.setAttribute('aria-pressed', liked ? 'true' : 'false');
    like.addEventListener('click', function () { togglePostLike(id, d, like); });
    actions.appendChild(like);

    var disc = el('button', 'fw-action fw-discuss-toggle', '\ud83d\udcac ' + (Number(d.commentCount) || 0)); disc.type = 'button';
    disc.setAttribute('aria-label', 'Discussion, ' + (Number(d.commentCount) || 0) + ' comments');
    disc.addEventListener('click', function () {
      var existing = card.querySelector('.fw-discussion');
      if (existing) { existing.remove(); return; }
      card.appendChild(buildDiscussion(id, d));
    });
    actions.appendChild(disc);

    var rs = el('button', 'fw-action', '\u21bb Reshare'); rs.type = 'button';
    rs.addEventListener('click', function () { openReshare(card, id, d); });
    actions.appendChild(rs);

    var cp = el('button', 'fw-action', '\ud83d\udd17 Copy link'); cp.type = 'button';
    cp.addEventListener('click', function () { copyLink(cp, id); });
    actions.appendChild(cp);

    if (d.authorUid !== me.uid) {
      var rp = el('button', 'fw-action fw-danger-soft', '\u2691 Report'); rp.type = 'button';
      rp.addEventListener('click', function () { openReport(card, id, d); });
      actions.appendChild(rp);
    }
    if (d.authorUid === me.uid && !d.reshareOf) {
      var ed = el('button', 'fw-action', 'Edit'); ed.type = 'button';
      ed.addEventListener('click', function () { editPost(card, id, d); });
      actions.appendChild(ed);
    }
    if (d.authorUid === me.uid || isAdmin) {
      var dl = el('button', 'fw-action fw-danger-soft', 'Delete'); dl.type = 'button';
      dl.addEventListener('click', function () {
        if (!window.confirm('Delete this post?')) return;
        db.collection('fellowshipPosts').doc(id).delete().then(function () { card.remove(); })
          .catch(function () { setStatus('Couldn\u2019t delete that post.', true); });
      });
      actions.appendChild(dl);
    }
    card.appendChild(actions);
    return card;
  }

  var originalCache = {};
  function loadOriginal(id) {
    if (originalCache[id] !== undefined) return Promise.resolve(originalCache[id]);
    return db.collection('fellowshipPosts').doc(id).get().then(function (doc) {
      originalCache[id] = doc.exists ? { id: doc.id, data: doc.data() } : null;
      return originalCache[id];
    }).catch(function () { return null; });
  }

  function buildAttachments(list) {
    var wrap = el('div', 'fw-attachments');
    list.forEach(function (a) {
      var url = ownMedia(a.url);
      if (!url) return;   // links we can't trust are not shown at all
      if (a.type === 'image') {
        var img = el('img', 'fw-img'); img.src = url; img.alt = a.name || 'Photo'; img.loading = 'lazy';
        wrap.appendChild(img);
      } else if (a.type === 'video') {
        var v = el('video', 'fw-video'); v.controls = true; v.preload = 'metadata'; v.setAttribute('playsinline', ''); v.src = url;
        wrap.appendChild(v);
      } else {
        var link = el('a', 'fw-file', '\ud83d\udcce ' + (a.name || 'Document') + (a.size ? ' \u00b7 ' + Math.max(1, Math.round(a.size / 1024)) + ' KB' : ''));
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        wrap.appendChild(link);
      }
    });
    return wrap;
  }

  /* ---------- likes ---------- */
  function togglePostLike(id, d, btn) {
    var liked = !!myLikes[id];
    var batch = db.batch();
    var likeRef = db.collection('fellowshipLikes').doc(id + '_' + me.uid);
    var postRef = db.collection('fellowshipPosts').doc(id);
    if (liked) {
      batch.delete(likeRef);
      batch.update(postRef, { likeCount: firebase.firestore.FieldValue.increment(-1) });
    } else {
      batch.set(likeRef, { postId: id, uid: me.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      batch.update(postRef, { likeCount: firebase.firestore.FieldValue.increment(1) });
    }
    myLikes[id] = !liked;
    d.likeCount = Math.max(0, (Number(d.likeCount) || 0) + (liked ? -1 : 1));
    refreshLike(btn, id, d);
    batch.commit().then(function () {
      if (!liked && d.authorUid !== me.uid) notify(d.authorUid, 'fellowLike', { postId: id, postTitle: snippetOf(d.body) || 'a post' });
    }).catch(function () {
      myLikes[id] = liked;
      d.likeCount = Math.max(0, (Number(d.likeCount) || 0) + (liked ? 1 : -1));
      refreshLike(btn, id, d);
      setStatus('Couldn\u2019t update that like. Try again.', true);
    });
  }
  function refreshLike(btn, id, d) {
    var on = !!myLikes[id];
    btn.textContent = (on ? '\u2665 ' : '\u2661 ') + (Number(d.likeCount) || 0);
    btn.className = 'fw-action' + (on ? ' is-liked' : '');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /* ---------- reshare, edit, copy, report ---------- */
  function openReshare(card, id, d) {
    var existing = card.querySelector('.fw-panel');
    if (existing) { existing.remove(); return; }
    var panel = el('div', 'fw-panel');
    var ta = el('textarea', 'story-input'); ta.rows = 2; ta.maxLength = 500; ta.placeholder = 'Add your note (optional)';
    ta.setAttribute('aria-label', 'Note to add when resharing');
    var go = el('button', 'btn btn-primary btn-sm', 'Reshare to the fellowship'); go.type = 'button';
    go.addEventListener('click', function () {
      go.disabled = true;
      var original = d.reshareOf || id;
      viewerName().then(function (name) {
        return db.collection('fellowshipPosts').add({
          authorUid: me.uid, authorName: name, body: '', attachments: [],
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          likeCount: 0, commentCount: 0, reshareOf: original, reshareNote: ta.value.trim().slice(0, 500)
        });
      }).then(function () {
        panel.remove(); setStatus('Reshared.'); return loadPosts(true);
      }).catch(function () { go.disabled = false; setStatus('Couldn\u2019t reshare. Try again.', true); });
    });
    panel.appendChild(ta); panel.appendChild(go);
    card.appendChild(panel);
    ta.focus();
  }

  function editPost(card, id, d) {
    var existing = card.querySelector('.fw-panel');
    if (existing) { existing.remove(); return; }
    var panel = el('div', 'fw-panel');
    var ta = el('textarea', 'story-input'); ta.rows = 4; ta.maxLength = 4000; ta.value = d.body || '';
    ta.setAttribute('aria-label', 'Edit your post');
    var save = el('button', 'btn btn-primary btn-sm', 'Save'); save.type = 'button';
    save.addEventListener('click', function () {
      save.disabled = true;
      db.collection('fellowshipPosts').doc(id).update({ body: ta.value.trim(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
        .then(function () { return loadPosts(true); })
        .catch(function () { save.disabled = false; setStatus('Couldn\u2019t save your edit.', true); });
    });
    panel.appendChild(ta); panel.appendChild(save);
    card.appendChild(panel);
  }

  function copyLink(btn, id) {
    var url = location.origin + location.pathname + '#post=' + id;
    var original = btn.textContent;
    var done = function (ok) { btn.textContent = ok ? 'Link copied \u2713' : 'Copy failed'; setTimeout(function () { btn.textContent = original; }, 1800); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
    else done(false);
  }

  function openReport(card, id, d) {
    var existing = card.querySelector('.fw-panel');
    if (existing) { existing.remove(); return; }
    var panel = el('div', 'fw-panel');
    var sel = el('select', 'field-input');
    ['Spam', 'Harassment or bullying', 'Inappropriate content', 'Other'].forEach(function (r) { var o = el('option', '', r); o.value = r; sel.appendChild(o); });
    sel.setAttribute('aria-label', 'Reason for reporting');
    var send = el('button', 'btn btn-primary btn-sm', 'Send report'); send.type = 'button';
    send.addEventListener('click', function () {
      send.disabled = true;
      db.collection('reports').doc(me.uid + '_' + id).set({
        type: 'fellowshipPost', targetId: id, postId: id, reportedUid: d.authorUid || '',
        reportedName: String(d.authorName || 'Member').slice(0, 100), reporterUid: me.uid, reason: sel.value,
        details: '', snippet: snippetOf(d.body).slice(0, 160), status: 'open',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }).then(function () { panel.innerHTML = ''; panel.appendChild(el('p', 'form-success', '\u2713 Thanks. An admin will review it.')); })
        .catch(function () { send.disabled = false; setStatus('You\u2019ve already reported this, or it couldn\u2019t be sent.', true); });
    });
    panel.appendChild(sel); panel.appendChild(send);
    card.appendChild(panel);
  }

  /* ---------- discussion ---------- */
  function buildDiscussion(postId, d) {
    var box = el('section', 'fw-discussion');
    var list = el('div', 'fw-comments');
    box.appendChild(list);
    var compose = el('div', 'fw-comment-compose');
    box.appendChild(compose);
    list.appendChild(el('p', 'form-note', 'Loading comments…'));
    loadComments(postId, d, box);
    return box;
  }

  function loadComments(postId, d, box) {
    var list = box.querySelector('.fw-comments');
    Promise.all([
      db.collection('fellowshipComments').where('postId', '==', postId).get(),
      db.collection('fellowshipCommentLikes').where('uid', '==', me.uid).get()
    ]).then(function (r) {
      var items = [];
      r[0].forEach(function (doc) { items.push({ id: doc.id, data: doc.data() }); });
      r[1].forEach(function (doc) { myCommentLikes[doc.data().commentId] = true; });
      renderComments(postId, d, box, items);
    }).catch(function () { list.innerHTML = ''; list.appendChild(el('p', 'form-error', 'Couldn\u2019t load comments.')); });
  }

  function renderComments(postId, d, box, items) {
    var list = box.querySelector('.fw-comments');
    var compose = box.querySelector('.fw-comment-compose');
    list.innerHTML = '';
    var ids = {};
    items.forEach(function (it) { ids[it.id] = true; });
    var tops = items.filter(function (it) { return !it.data.parentId || !ids[it.data.parentId]; });
    var kids = {};
    items.forEach(function (it) { if (it.data.parentId && ids[it.data.parentId]) (kids[it.data.parentId] = kids[it.data.parentId] || []).push(it); });
    tops.sort(function (a, b) { return ms(a.data.createdAt) - ms(b.data.createdAt); });
    if (!items.length) list.appendChild(el('p', 'form-note', 'No comments yet.'));
    tops.forEach(function (it) {
      list.appendChild(buildComment(postId, d, box, it, false));
      (kids[it.id] || []).sort(function (a, b) { return ms(a.data.createdAt) - ms(b.data.createdAt); })
        .forEach(function (r) { list.appendChild(buildComment(postId, d, box, r, true)); });
    });
    compose.innerHTML = '';
    compose.appendChild(commentForm(postId, d, box, null, 'Write a comment…', 'Comment'));
  }

  function commentForm(postId, d, box, parentId, placeholder, label, onCancel) {
    var form = el('form', 'fw-comment-form');
    var ta = el('textarea', 'story-input'); ta.rows = 2; ta.maxLength = 1000; ta.placeholder = placeholder;
    ta.setAttribute('aria-label', placeholder);
    var row = el('div', 'fw-composer-row');
    var btn = el('button', 'btn btn-primary btn-sm', label); btn.type = 'submit';
    row.appendChild(btn);
    if (onCancel) { var c = el('button', 'btn btn-ghost btn-sm', 'Cancel'); c.type = 'button'; c.addEventListener('click', onCancel); row.appendChild(c); }
    form.appendChild(ta); form.appendChild(row);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = ta.value.trim();
      if (!text) return;
      btn.disabled = true;
      viewerName().then(function (name) {
        var ref = db.collection('fellowshipComments').doc();
        var batch = db.batch();
        batch.set(ref, { postId: postId, parentId: parentId || null, authorUid: me.uid, authorName: name,
          text: text, likeCount: 0, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
        batch.update(db.collection('fellowshipPosts').doc(postId), { commentCount: firebase.firestore.FieldValue.increment(1), lastCommentId: ref.id });
        return batch.commit();
      }).then(function () {
        if (parentId) {
          var parent = null;
          // reply: tell the person being replied to
          db.collection('fellowshipComments').doc(parentId).get().then(function (p) {
            if (p.exists) notify(p.data().authorUid, 'fellowReply', { postId: postId, postTitle: snippetOf(d.body) || 'a post' });
          });
        } else {
          notify(d.authorUid, 'fellowComment', { postId: postId, postTitle: snippetOf(d.body) || 'a post' });
        }
        return refreshPostCounts(postId).then(function () { return loadComments(postId, d, box); });
      }).catch(function () { setStatus('Couldn\u2019t post that comment. Try again.', true); })
        .then(function () { btn.disabled = false; });
    });
    setTimeout(function () { if (parentId) ta.focus(); }, 0);
    return form;
  }

  function refreshPostCounts(postId) {
    return db.collection('fellowshipPosts').doc(postId).get().then(function (doc) {
      if (!doc.exists) return;
      var card = feedEl.querySelector('[data-post="' + postId + '"] .fw-discuss-toggle');
      if (card) card.textContent = '\ud83d\udcac ' + (Number(doc.data().commentCount) || 0);
    }).catch(function () {});
  }

  function buildComment(postId, d, box, it, isReply) {
    var c = it.data;
    var art = el('article', 'fw-comment' + (isReply ? ' is-reply' : ''));
    var head = el('p', 'fw-comment-meta');
    head.appendChild(el('bdi', '', c.authorName || 'Member'));
    head.appendChild(document.createTextNode(' \u00b7 ' + timeAgo(c.createdAt) + (c.editedAt ? ' \u00b7 edited' : '')));
    art.appendChild(head);
    var txt = el('p', 'fw-comment-text', c.text || '');
    art.appendChild(txt);
    var acts = el('div', 'fw-actions');
    var liked = !!myCommentLikes[it.id];
    var cnt = Number(c.likeCount) || 0;
    var like = el('button', 'fw-action' + (liked ? ' is-liked' : ''), (liked ? '\u2665 ' : '\u2661 ') + cnt); like.type = 'button';
    like.setAttribute('aria-pressed', liked ? 'true' : 'false');
    like.addEventListener('click', function () { toggleCommentLike(postId, d, box, it, like); });
    acts.appendChild(like);
    if (!isReply) {
      var rep = el('button', 'fw-action', 'Reply'); rep.type = 'button';
      rep.addEventListener('click', function () {
        var ex = art.querySelector('.fw-comment-form');
        if (ex) { ex.remove(); return; }
        art.appendChild(commentForm(postId, d, box, it.id, 'Write a reply…', 'Reply', function () { art.querySelector('.fw-comment-form').remove(); }));
      });
      acts.appendChild(rep);
    }
    if (c.authorUid !== me.uid) {
      var rp = el('button', 'fw-action fw-danger-soft', 'Report'); rp.type = 'button';
      rp.addEventListener('click', function () { openCommentReport(art, postId, it); });
      acts.appendChild(rp);
    }
    if (c.authorUid === me.uid) {
      var ed = el('button', 'fw-action', 'Edit'); ed.type = 'button';
      ed.addEventListener('click', function () { editComment(art, it, txt, function () { loadComments(postId, d, box); }); });
      acts.appendChild(ed);
    }
    if (c.authorUid === me.uid || isAdmin) {
      var dl = el('button', 'fw-action fw-danger-soft', 'Delete'); dl.type = 'button';
      dl.addEventListener('click', function () {
        if (!window.confirm('Delete this comment?')) return;
        deleteComment(postId, it.id).then(function () { return loadComments(postId, d, box); })
          .catch(function () { setStatus('Couldn\u2019t delete that comment.', true); });
      });
      acts.appendChild(dl);
    }
    art.appendChild(acts);
    return art;
  }

  function toggleCommentLike(postId, d, box, it, btn) {
    var liked = !!myCommentLikes[it.id];
    var batch = db.batch();
    var likeRef = db.collection('fellowshipCommentLikes').doc(it.id + '_' + me.uid);
    var cRef = db.collection('fellowshipComments').doc(it.id);
    if (liked) { batch.delete(likeRef); batch.update(cRef, { likeCount: firebase.firestore.FieldValue.increment(-1) }); }
    else { batch.set(likeRef, { commentId: it.id, uid: me.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() }); batch.update(cRef, { likeCount: firebase.firestore.FieldValue.increment(1) }); }
    myCommentLikes[it.id] = !liked;
    it.data.likeCount = Math.max(0, (Number(it.data.likeCount) || 0) + (liked ? -1 : 1));
    btn.textContent = (!liked ? '\u2665 ' : '\u2661 ') + it.data.likeCount;
    btn.className = 'fw-action' + (!liked ? ' is-liked' : '');
    batch.commit().then(function () {
      if (!liked && it.data.authorUid !== me.uid) notify(it.data.authorUid, 'fellowLike', { postId: postId, postTitle: snippetOf(d.body) || 'a comment' });
    }).catch(function () {
      myCommentLikes[it.id] = liked;
      it.data.likeCount = Math.max(0, (Number(it.data.likeCount) || 0) + (liked ? 1 : -1));
      loadComments(postId, d, box);
      setStatus('Couldn\u2019t update that like.', true);
    });
  }

  // Deleting a comment also lowers the post's count, in the same batch.
  function deleteComment(postId, commentId) {
    var batch = db.batch();
    batch.delete(db.collection('fellowshipComments').doc(commentId));
    batch.update(db.collection('fellowshipPosts').doc(postId), { commentCount: firebase.firestore.FieldValue.increment(-1), lastCommentId: commentId });
    return batch.commit().then(function () { return refreshPostCounts(postId); });
  }

  function editComment(art, it, txt, done) {
    var ex = art.querySelector('.fw-comment-form');
    if (ex) { ex.remove(); return; }
    var form = el('form', 'fw-comment-form');
    var ta = el('textarea', 'story-input'); ta.rows = 2; ta.maxLength = 1000; ta.value = it.data.text || '';
    var row = el('div', 'fw-composer-row');
    var save = el('button', 'btn btn-primary btn-sm', 'Save'); save.type = 'submit';
    row.appendChild(save);
    form.appendChild(ta); form.appendChild(row);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var t = ta.value.trim(); if (!t) return;
      db.collection('fellowshipComments').doc(it.id).update({ text: t, editedAt: firebase.firestore.FieldValue.serverTimestamp() })
        .then(done).catch(function () { setStatus('Couldn\u2019t save that edit.', true); });
    });
    art.insertBefore(form, art.querySelector('.fw-actions'));
    txt.hidden = true;
  }

  function openCommentReport(art, postId, it) {
    var ex = art.querySelector('.fw-panel');
    if (ex) { ex.remove(); return; }
    var panel = el('div', 'fw-panel');
    var sel = el('select', 'field-input');
    ['Spam', 'Harassment or bullying', 'Inappropriate content', 'Other'].forEach(function (r) { var o = el('option', '', r); o.value = r; sel.appendChild(o); });
    sel.setAttribute('aria-label', 'Reason for reporting');
    var send = el('button', 'btn btn-primary btn-sm', 'Send report'); send.type = 'button';
    send.addEventListener('click', function () {
      send.disabled = true;
      db.collection('reports').doc(me.uid + '_' + it.id).set({
        type: 'fellowshipComment', targetId: it.id, postId: postId, reportedUid: it.data.authorUid || '',
        reportedName: String(it.data.authorName || 'Member').slice(0, 100), reporterUid: me.uid, reason: sel.value,
        details: '', snippet: snippetOf(it.data.text).slice(0, 160), status: 'open',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }).then(function () { panel.innerHTML = ''; panel.appendChild(el('p', 'form-success', '\u2713 Thanks. An admin will review it.')); })
        .catch(function () { send.disabled = false; setStatus('You\u2019ve already reported this comment, or it couldn\u2019t be sent.', true); });
    });
    panel.appendChild(sel); panel.appendChild(send);
    art.appendChild(panel);
  }

  /* ---------- admin: join requests and members ---------- */
  function loadAdmin() {
    var reqEl = document.getElementById('fw-requests');
    var memEl = document.getElementById('fw-members');
    var sumEl = document.getElementById('fw-admin-summary');
    var reqCount = 0;
    db.collection('fellowshipRequests').get().then(function (snap) {
      reqCount = snap.size;
      // Open the admin panel by itself when someone is waiting to be approved.
      if (reqCount > 0) document.getElementById('fw-admin').open = true;
      reqEl.innerHTML = '';
      if (snap.empty) reqEl.appendChild(el('p', 'form-note', 'No pending requests.'));
      snap.forEach(function (doc) {
        var r = doc.data();
        var row = el('div', 'fw-admin-row');
        row.appendChild(el('bdi', 'fw-admin-name', r.name || 'Member'));
        var ok = el('button', 'btn btn-primary btn-sm', 'Approve'); ok.type = 'button';
        var no = el('button', 'btn btn-ghost btn-sm fw-danger-soft', 'Decline'); no.type = 'button';
        ok.addEventListener('click', function () {
          ok.disabled = true; no.disabled = true;
          var batch = db.batch();
          batch.set(db.collection('fellowshipMembers').doc(doc.id), { uid: doc.id, name: r.name || 'Member', approvedAt: firebase.firestore.FieldValue.serverTimestamp() });
          batch.delete(db.collection('fellowshipRequests').doc(doc.id));
          batch.commit().then(function () {
            notify(doc.id, 'fellowApproved', { postTitle: 'Warrior Fellowship' });
            return loadAdmin();
          }).catch(function () { ok.disabled = false; no.disabled = false; setStatus('Couldn\u2019t approve. Try again.', true); });
        });
        no.addEventListener('click', function () {
          if (!window.confirm('Decline this request?')) return;
          db.collection('fellowshipRequests').doc(doc.id).delete().then(loadAdmin).catch(function () { setStatus('Couldn\u2019t decline. Try again.', true); });
        });
        row.appendChild(ok); row.appendChild(no);
        reqEl.appendChild(row);
      });
    }).catch(function () { reqEl.innerHTML = ''; reqEl.appendChild(el('p', 'form-error', 'Couldn\u2019t load requests.')); });

    db.collection('fellowshipMembers').get().then(function (snap) {
      memEl.innerHTML = '';
      if (snap.empty) memEl.appendChild(el('p', 'form-note', 'No members yet.'));
      sumEl.textContent = 'Admin · ' + reqCount + (reqCount === 1 ? ' request' : ' requests') + ' · ' + snap.size + (snap.size === 1 ? ' member' : ' members');
      snap.forEach(function (doc) {
        var m = doc.data();
        var row = el('div', 'fw-admin-row');
        row.appendChild(el('bdi', 'fw-admin-name', m.name || 'Member'));
        if (doc.id !== me.uid) {
          var rm = el('button', 'btn btn-ghost btn-sm fw-danger-soft', 'Remove'); rm.type = 'button';
          rm.addEventListener('click', function () {
            if (!window.confirm('Remove this member from the fellowship?')) return;
            db.collection('fellowshipMembers').doc(doc.id).delete().then(loadAdmin).catch(function () { setStatus('Couldn\u2019t remove. Try again.', true); });
          });
          row.appendChild(rm);
        }
        memEl.appendChild(row);
      });
    }).catch(function () { memEl.innerHTML = ''; memEl.appendChild(el('p', 'form-error', 'Couldn\u2019t load members.')); });
  }

  /* ---------- start ---------- */
  if (typeof firebase === 'undefined' || !window.FIREBASE_CONFIG) {
    showGate(gateMessage('The fellowship couldn\u2019t load. Check your connection and refresh.'));
    return;
  }
  if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
  db = firebase.firestore();
  auth = firebase.auth();
  auth.onAuthStateChanged(function (user) {
    me = user || null;
    nameCache = null;
    myLikes = {}; myCommentLikes = {};
    checkAccess(user);
  });
  window.addEventListener('hashchange', openFromHash);
})();
