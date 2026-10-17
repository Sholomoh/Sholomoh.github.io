/* About hub: one page with tabs. Each tab has its own address (about.html#skills), so old links still work. */
(function () {
  'use strict';
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.about-tab'));
  var sections = Array.prototype.slice.call(document.querySelectorAll('.about-section'));
  var valid = {};
  sections.forEach(function (s) { valid[s.getAttribute('data-section')] = true; });

  function show(key, updateHash, quiet) {
    if (!valid[key]) key = 'about';
    sections.forEach(function (s) { s.hidden = s.getAttribute('data-section') !== key; });
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tab') === key;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    if (updateHash) {
      var target = key === 'about' ? location.pathname : location.pathname + '#' + key;
      try { history.replaceState(null, '', target); } catch (e) {}
    }
    if (!quiet) window.scrollTo({ top: document.querySelector('.about-tabs').offsetTop - 8, behavior: 'auto' });
    document.title = (key === 'about' ? 'About' : document.querySelector('.about-tab[data-tab="' + key + '"]').textContent) + ' — שלמה';
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () { show(t.getAttribute('data-tab'), true); });
    t.addEventListener('keydown', function (e) {
      var i = tabs.indexOf(t), n = null;
      if (e.key === 'ArrowRight') n = tabs[(i + 1) % tabs.length];
      if (e.key === 'ArrowLeft') n = tabs[(i - 1 + tabs.length) % tabs.length];
      if (n) { e.preventDefault(); n.focus(); show(n.getAttribute('data-tab'), true); }
    });
  });
  window.addEventListener('hashchange', function () { show(location.hash.replace('#', '') || 'about', false, false); });
  show(location.hash.replace('#', '') || 'about', false, true);
})();
