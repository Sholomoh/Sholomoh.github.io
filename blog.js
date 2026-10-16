/* Blog: public list and post view for everyone; a post editor for the admin only.
   Text is always written with textContent (never as HTML). Media is only shown when it comes from
   this site's own Cloudinary account, or is a YouTube/Vimeo embed. */
(function () {
  'use strict';

  var listView = document.getElementById('blog-list-view');
  var postView = document.getElementById('blog-post-view');
  var editorView = document.getElementById('blog-editor');
  var listEl = document.getElementById('blog-list');
  var tagsEl = document.getElementById('blog-tags');
  var statusEl = document.getElementById('blog-status');
  var writeBtn = document.getElementById('blog-write-btn');
  var contentEl = document.getElementById('blog-post-content');
  var postAdminEl = document.getElementById('blog-post-admin');
  var editBtn = document.getElementById('blog-post-edit');

  var db = null, auth = null;
  var isAdmin = false;
  var posts = [];                 // list items: { id, data }
  var activeTag = '';
  var currentPostId = null;
  var editing = null;             // { id, data } or null for a new post
  var blocks = [];                // editor state
  var coverURL = '';

  var CLOUD = (window.CLOUDINARY_CONFIG && window.CLOUDINARY_CONFIG.cloudName) || '';
  var PRESET = (window.CLOUDINARY_CONFIG && window.CLOUDINARY_CONFIG.uploadPreset) || '';
  var MAX_IMAGE = 10 * 1024 * 1024, MAX_VIDEO = 100 * 1024 * 1024;

  /* ---------- helpers ---------- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function fmtDate(t) {
    var d = t && t.toDate ? t.toDate() : (t && t.seconds ? new Date(t.seconds * 1000) : null);
    return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  }
  function ms(t) {
    var d = t && t.toDate ? t.toDate() : (t && t.seconds ? new Date(t.seconds * 1000) : null);
    return d ? d.getTime() : 0;
  }
  // Only this site's own Cloudinary account may supply media.
  function ownMediaUrl(u) {
    return typeof u === 'string' && CLOUD && u.indexOf('https://res.cloudinary.com/' + CLOUD + '/') === 0 && u.length <= 600 ? u : '';
  }
  // YouTube/Vimeo links become embed URLs; anything else is refused.
  function toEmbedUrl(input) {
    var s = String(input || '').trim();
    var m = /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{6,20})/.exec(s);
    if (m) return 'https://www.youtube-nocookie.com/embed/' + m[1];
    m = /vimeo\.com\/(?:video\/)?(\d{6,12})/.exec(s);
    if (m) return 'https://player.vimeo.com/video/' + m[1];
    return '';
  }
  function safeEmbed(u) {
    return /^https:\/\/(www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{6,20}|player\.vimeo\.com\/video\/\d{6,12})$/.test(String(u || '')) ? u : '';
  }
  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.className = 'form-note' + (isError ? ' form-error' : '');
  }

  /* ---------- routing ---------- */
  function route() {
    var m = /^#post=([A-Za-z0-9_-]+)$/.exec(location.hash);
    if (location.hash === '#write' && isAdmin) return openEditor(null);
    if (m) return openPost(m[1]);
    showList();
  }
  function showList() {
    editorView.hidden = true; postView.hidden = true; listView.hidden = false;
    currentPostId = null;
    document.title = 'Blog — Fidel Kenyatta';
    loadList();
  }

  /* ---------- admin ---------- */
  function checkAdmin(user) {
    if (!user) { isAdmin = false; writeBtn.hidden = true; return Promise.resolve(); }
    return db.collection('admins').doc(user.uid).get().then(function (d) {
      isAdmin = !!d.exists;
    }).catch(function () { isAdmin = false; }).then(function () {
      writeBtn.hidden = !isAdmin;
      if (currentPostId) openPost(currentPostId); else if (!listView.hidden) renderList();
    });
  }

  /* ---------- public list ---------- */
  function loadList() {
    listEl.innerHTML = '';
    setStatus('Loading posts…');
    var reads = [db.collection('blogs').where('status', '==', 'published').get()];
    if (isAdmin) reads.push(db.collection('blogs').where('status', '==', 'draft').get());
    Promise.all(reads).then(function (snaps) {
      posts = [];
      snaps.forEach(function (snap) { snap.forEach(function (doc) { posts.push({ id: doc.id, data: doc.data() }); }); });
      posts.sort(function (a, b) { return ms(b.data.createdAt) - ms(a.data.createdAt); });
      setStatus('');
      renderList();
    }).catch(function () {
      setStatus('Couldn\u2019t load posts. Check your connection and try again.', true);
    });
  }

  function renderTags() {
    var counts = {};
    posts.forEach(function (p) { (p.data.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; }); });
    tagsEl.innerHTML = '';
    var all = el('button', 'chip' + (activeTag === '' ? ' is-active' : ''), 'All');
    all.type = 'button';
    all.addEventListener('click', function () { activeTag = ''; renderList(); });
    tagsEl.appendChild(all);
    Object.keys(counts).sort().forEach(function (t) {
      var b = el('button', 'chip' + (activeTag === t ? ' is-active' : ''), t + ' (' + counts[t] + ')');
      b.type = 'button';
      b.addEventListener('click', function () { activeTag = t; renderList(); });
      tagsEl.appendChild(b);
    });
  }

  function renderList() {
    renderTags();
    listEl.innerHTML = '';
    var shown = posts.filter(function (p) { return !activeTag || (p.data.tags || []).indexOf(activeTag) !== -1; });
    if (!shown.length) {
      listEl.appendChild(el('p', 'form-note', posts.length ? 'No posts with that topic yet.' : 'No posts yet. Check back soon.'));
      return;
    }
    shown.forEach(function (p) {
      var card = el('article', 'blog-card');
      card.setAttribute('role', 'link');
      card.tabIndex = 0;
      var go = function () { location.hash = '#post=' + p.id; };
      card.addEventListener('click', go);
      card.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
      var cover = ownMediaUrl(p.data.coverURL);
      if (cover) {
        var img = el('img', 'blog-card-cover'); img.src = cover; img.alt = ''; img.loading = 'lazy';
        card.appendChild(img);
      }
      var body = el('div', 'blog-card-body');
      if (p.data.status === 'draft') body.appendChild(el('span', 'blog-draft-badge', 'Draft'));
      body.appendChild(el('h2', 'blog-card-title', p.data.title || 'Untitled'));
      body.appendChild(el('p', 'blog-card-meta', fmtDate(p.data.createdAt)));
      if (p.data.excerpt) body.appendChild(el('p', 'blog-card-excerpt', p.data.excerpt));
      if ((p.data.tags || []).length) {
        var tg = el('div', 'chips chips-sm');
        p.data.tags.forEach(function (t) { tg.appendChild(el('span', 'chip', t)); });
        body.appendChild(tg);
      }
      card.appendChild(body);
      listEl.appendChild(card);
    });
  }

  /* ---------- post view ---------- */
  function openPost(id) {
    listView.hidden = true; editorView.hidden = true; postView.hidden = false;
    currentPostId = id;
    contentEl.innerHTML = '';
    contentEl.appendChild(el('p', 'form-note', 'Loading…'));
    db.collection('blogs').doc(id).get().then(function (doc) {
      contentEl.innerHTML = '';
      if (!doc.exists || (doc.data().status !== 'published' && !isAdmin)) {
        contentEl.appendChild(el('p', 'form-note', 'This post isn\u2019t available.'));
        postAdminEl.hidden = true;
        return;
      }
      var d = doc.data();
      document.title = (d.title || 'Post') + ' — Fidel Kenyatta';
      postAdminEl.hidden = !isAdmin;
      editBtn.onclick = function () { openEditor({ id: id, data: d }); };
      renderPost(d);
    }).catch(function () {
      contentEl.innerHTML = '';
      contentEl.appendChild(el('p', 'form-error', 'Couldn\u2019t load this post.'));
    });
  }

  function renderPost(d) {
    if (d.status === 'draft') contentEl.appendChild(el('span', 'blog-draft-badge', 'Draft — only you can see this'));
    contentEl.appendChild(el('h1', 'page-title blog-post-title', d.title || 'Untitled'));
    contentEl.appendChild(el('p', 'blog-card-meta', fmtDate(d.createdAt)));
    if ((d.tags || []).length) {
      var tg = el('div', 'chips chips-sm');
      d.tags.forEach(function (t) { tg.appendChild(el('span', 'chip', t)); });
      contentEl.appendChild(tg);
    }
    var cover = ownMediaUrl(d.coverURL);
    if (cover) {
      var fig = el('figure', 'blog-figure');
      var img = el('img', 'blog-img'); img.src = cover; img.alt = ''; img.loading = 'lazy';
      fig.appendChild(img); contentEl.appendChild(fig);
    }
    (d.blocks || []).forEach(function (b) { contentEl.appendChild(renderBlock(b)); });
  }

  function renderBlock(b) {
    var node;
    if (b.type === 'text') {
      node = el('p', 'blog-text', b.text);
    } else if (b.type === 'quote') {
      node = el('blockquote', 'blog-quote', b.text);
    } else if (b.type === 'photo') {
      node = el('figure', 'blog-figure');
      var url = ownMediaUrl(b.url);
      if (url) { var img = el('img', 'blog-img'); img.src = url; img.alt = b.alt || ''; img.loading = 'lazy'; node.appendChild(img); }
      if (b.caption) node.appendChild(el('figcaption', 'blog-caption', b.caption));
    } else if (b.type === 'video') {
      node = el('figure', 'blog-figure');
      var vurl = ownMediaUrl(b.url);
      if (vurl) {
        var v = el('video', 'blog-video'); v.controls = true; v.preload = 'metadata'; v.setAttribute('playsinline', ''); v.src = vurl;
        node.appendChild(v);
      }
      if (b.caption) node.appendChild(el('figcaption', 'blog-caption', b.caption));
    } else if (b.type === 'embed') {
      node = el('figure', 'blog-figure blog-embed');
      var emb = safeEmbed(b.url);
      if (emb) {
        var f = el('iframe'); f.src = emb; f.loading = 'lazy'; f.allowFullscreen = true;
        f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
        f.setAttribute('allow', 'accelerometer; encrypted-media; picture-in-picture');
        f.title = b.caption || 'Embedded video';
        node.appendChild(f);
      }
      if (b.caption) node.appendChild(el('figcaption', 'blog-caption', b.caption));
    } else {
      node = el('p', 'form-note', '');
    }
    return node;
  }

  /* ---------- editor ---------- */
  function openEditor(existing) {
    if (!isAdmin) return;
    editing = existing;
    listView.hidden = true; postView.hidden = true; editorView.hidden = false;
    document.getElementById('blog-editor-title').textContent = existing ? 'Edit post' : 'New post';
    var d = existing ? existing.data : {};
    document.getElementById('blog-title').value = d.title || '';
    document.getElementById('blog-excerpt').value = d.excerpt || '';
    document.getElementById('blog-tags-input').value = (d.tags || []).join(', ');
    document.getElementById('blog-status-input').value = d.status === 'published' ? 'published' : 'draft';
    document.getElementById('blog-delete').hidden = !existing;
    document.getElementById('blog-form-status').textContent = '';
    document.getElementById('blog-cover').value = '';
    coverURL = ownMediaUrl(d.coverURL) || '';
    blocks = (d.blocks || []).map(function (b) { return Object.assign({}, b); });
    updateCoverNote();
    renderBlocks();
    if (location.hash !== '#write' && !existing) history.replaceState(null, '', location.pathname + '#write');
    document.getElementById('blog-title').focus();
  }

  function updateCoverNote() {
    var note = document.getElementById('blog-cover-note');
    note.hidden = !coverURL;
    note.textContent = coverURL ? 'Cover image set. Choose another file to replace it.' : '';
  }

  function addBlock(type) {
    if (blocks.length >= 60) { setFormStatus('A post can have up to 60 blocks.'); return; }
    var b = { type: type };
    if (type === 'text' || type === 'quote') b.text = '';
    if (type === 'photo' || type === 'video') { b.url = ''; b.caption = ''; }
    if (type === 'photo') b.alt = '';
    if (type === 'embed') { b.url = ''; b.caption = ''; }
    blocks.push(b);
    renderBlocks();
  }

  function setFormStatus(msg) { document.getElementById('blog-form-status').textContent = msg || ''; }

  function renderBlocks() {
    var wrap = document.getElementById('blog-blocks');
    wrap.innerHTML = '';
    if (!blocks.length) wrap.appendChild(el('p', 'form-note', 'Nothing here yet. Add a paragraph, photo, or video below.'));
    blocks.forEach(function (b, i) {
      var row = el('div', 'blog-block');
      var head = el('div', 'blog-block-head');
      var labels = { text: 'Paragraph', quote: 'Quote', photo: 'Photo', video: 'Video upload', embed: 'YouTube / Vimeo' };
      head.appendChild(el('span', 'blog-block-type', labels[b.type] || b.type));
      var tools = el('span', 'blog-block-tools');
      [['Up', -1], ['Down', 1]].forEach(function (pair) {
        var bt = el('button', 'btn btn-ghost btn-sm', pair[0]); bt.type = 'button';
        bt.setAttribute('aria-label', 'Move ' + labels[b.type] + ' ' + (pair[1] < 0 ? 'up' : 'down'));
        bt.disabled = (pair[1] < 0 && i === 0) || (pair[1] > 0 && i === blocks.length - 1);
        bt.addEventListener('click', function () {
          var j = i + pair[1]; var tmp = blocks[i]; blocks[i] = blocks[j]; blocks[j] = tmp; renderBlocks();
        });
        tools.appendChild(bt);
      });
      var rm = el('button', 'btn btn-ghost btn-sm btn-danger', 'Remove'); rm.type = 'button';
      rm.addEventListener('click', function () { blocks.splice(i, 1); renderBlocks(); });
      tools.appendChild(rm);
      head.appendChild(tools);
      row.appendChild(head);

      if (b.type === 'text' || b.type === 'quote') {
        var ta = el('textarea', 'story-input'); ta.rows = 4; ta.maxLength = 4000; ta.value = b.text || '';
        ta.setAttribute('aria-label', labels[b.type]);
        ta.addEventListener('input', function () { b.text = ta.value; });
        row.appendChild(ta);
      } else if (b.type === 'photo' || b.type === 'video') {
        var file = el('input'); file.type = 'file'; file.accept = b.type === 'photo' ? 'image/*' : 'video/*';
        file.setAttribute('aria-label', 'Choose ' + (b.type === 'photo' ? 'photo' : 'video') + ' file');
        var note = el('p', 'form-note', b.url ? 'Uploaded.' : 'No file yet.');
        file.addEventListener('change', function () {
          var f = file.files[0];
          if (!f) return;
          note.textContent = 'Uploading…';
          uploadMedia(f, b.type).then(function (url) { b.url = url; note.textContent = 'Uploaded \u2713'; })
            .catch(function (err) { note.textContent = (err && err.message) || 'Upload failed.'; });
        });
        row.appendChild(file); row.appendChild(note);
        if (b.type === 'photo') {
          var alt = el('input', 'field-input'); alt.type = 'text'; alt.maxLength = 200; alt.placeholder = 'Describe the photo (for screen readers)';
          alt.value = b.alt || ''; alt.setAttribute('aria-label', 'Photo description');
          alt.addEventListener('input', function () { b.alt = alt.value; });
          row.appendChild(alt);
        }
        row.appendChild(captionInput(b));
      } else if (b.type === 'embed') {
        var link = el('input', 'field-input'); link.type = 'url'; link.maxLength = 300;
        link.placeholder = 'Paste a YouTube or Vimeo link';
        link.setAttribute('aria-label', 'YouTube or Vimeo link');
        var enote = el('p', 'form-note', b.url ? 'Video added \u2713' : 'Only YouTube and Vimeo links work.');
        link.addEventListener('change', function () {
          var emb = toEmbedUrl(link.value);
          if (emb) { b.url = emb; enote.textContent = 'Video added \u2713'; }
          else { b.url = ''; enote.textContent = 'That isn\u2019t a YouTube or Vimeo link.'; }
        });
        row.appendChild(link); row.appendChild(enote);
        row.appendChild(captionInput(b));
      }
      wrap.appendChild(row);
    });
  }

  function captionInput(b) {
    var c = el('input', 'field-input'); c.type = 'text'; c.maxLength = 240; c.placeholder = 'Caption (optional)';
    c.value = b.caption || ''; c.setAttribute('aria-label', 'Caption');
    c.addEventListener('input', function () { b.caption = c.value; });
    return c;
  }

  /* ---------- uploads (same Cloudinary preset as profile photos) ---------- */
  function uploadMedia(file, kind) {
    if (!CLOUD || !PRESET) return Promise.reject(new Error('Uploads aren\u2019t configured.'));
    var max = kind === 'photo' ? MAX_IMAGE : MAX_VIDEO;
    if (file.size > max) return Promise.reject(new Error('That file is over the ' + (max / 1048576) + ' MB limit.'));
    var fd = new FormData();
    fd.append('file', file);
    fd.append('upload_preset', PRESET);
    return fetch('https://api.cloudinary.com/v1_1/' + CLOUD + '/auto/upload', { method: 'POST', body: fd })
      .then(function (r) { if (!r.ok) throw new Error('Upload failed. Check the file type and size.'); return r.json(); })
      .then(function (data) {
        var u = ownMediaUrl(data.secure_url);
        if (!u) throw new Error('Upload came back from an unexpected address.');
        return u;
      });
  }

  document.getElementById('blog-cover').addEventListener('change', function () {
    var f = this.files[0];
    if (!f) return;
    var note = document.getElementById('blog-cover-note');
    note.hidden = false; note.textContent = 'Uploading cover…';
    uploadMedia(f, 'photo').then(function (u) { coverURL = u; updateCoverNote(); })
      .catch(function (err) { note.textContent = (err && err.message) || 'Upload failed.'; });
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-add]'), function (btn) {
    btn.addEventListener('click', function () { addBlock(btn.getAttribute('data-add')); });
  });

  /* ---------- save / delete ---------- */
  document.getElementById('blog-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!isAdmin) return;
    var title = document.getElementById('blog-title').value.trim();
    if (!title) { setFormStatus('Please add a title.'); return; }
    var clean = blocks.map(function (b) {
      var out = { type: b.type };
      if (b.text !== undefined) out.text = String(b.text).trim().slice(0, 4000);
      if (b.url !== undefined) out.url = b.url || '';
      if (b.alt !== undefined) out.alt = String(b.alt || '').slice(0, 200);
      if (b.caption !== undefined) out.caption = String(b.caption || '').slice(0, 240);
      return out;
    }).filter(function (b) {
      if (b.type === 'text' || b.type === 'quote') return !!b.text;
      if (b.type === 'photo' || b.type === 'video') return !!ownMediaUrl(b.url);
      if (b.type === 'embed') return !!safeEmbed(b.url);
      return false;
    });
    if (!clean.length) { setFormStatus('Add at least one paragraph, photo, or video.'); return; }
    var tags = document.getElementById('blog-tags-input').value.split(',')
      .map(function (t) { return t.trim().replace(/\s+/g, ' ').slice(0, 24); })
      .filter(function (t, i, arr) { return t && arr.indexOf(t) === i; }).slice(0, 5);
    var status = document.getElementById('blog-status-input').value === 'published' ? 'published' : 'draft';
    var data = {
      title: title.slice(0, 120),
      excerpt: document.getElementById('blog-excerpt').value.trim().slice(0, 240),
      tags: tags,
      status: status,
      coverURL: coverURL || '',
      blocks: clean,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    var save = document.getElementById('blog-save');
    save.disabled = true; setFormStatus('Saving…');
    var ref, job;
    if (editing) {
      ref = db.collection('blogs').doc(editing.id);
      job = ref.set(data, { merge: true });
    } else {
      ref = db.collection('blogs').doc();
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      data.authorUid = auth.currentUser.uid;
      job = ref.set(data);
    }
    job.then(function () {
      setFormStatus('');
      save.disabled = false;
      location.hash = '#post=' + ref.id;
    }).catch(function (err) {
      save.disabled = false;
      setFormStatus('Couldn\u2019t save' + (err && err.code ? ' (' + err.code + ')' : '') + '. Check the rules are published and try again.');
    });
  });

  document.getElementById('blog-delete').addEventListener('click', function () {
    if (!editing || !window.confirm('Delete this post permanently?')) return;
    db.collection('blogs').doc(editing.id).delete().then(function () {
      location.hash = '';
    }).catch(function () { setFormStatus('Couldn\u2019t delete. Try again.'); });
  });

  document.getElementById('blog-post-back').addEventListener('click', function () { location.hash = ''; });
  document.getElementById('blog-editor-back').addEventListener('click', function () {
    if (editing) location.hash = '#post=' + editing.id; else location.hash = '';
  });
  writeBtn.addEventListener('click', function () { location.hash = '#write'; });
  window.addEventListener('hashchange', function () {
    if (location.hash === '#write' && isAdmin) { openEditor(null); return; }
    route();
  });

  /* ---------- start ---------- */
  if (typeof firebase === 'undefined' || !window.FIREBASE_CONFIG) {
    setStatus('The blog couldn\u2019t load. Check your connection and refresh.', true);
    return;
  }
  if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
  db = firebase.firestore();
  auth = firebase.auth();
  auth.onAuthStateChanged(function (user) {
    checkAdmin(user).then(function () {
      if (location.hash === '#write' && isAdmin) openEditor(null); else route();
    });
  });
})();
