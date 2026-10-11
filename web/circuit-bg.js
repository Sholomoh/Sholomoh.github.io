/*
 * circuit-bg.js — live motherboard-style circuitry for the page background.
 *
 * Two fixed canvases sit behind the page:
 *   1. a static layer (traces, pads, chips) drawn once per resize
 *   2. a live layer where small pulses of light travel along the traces
 *
 * Kept deliberately quiet: low-alpha traces, a vignette that dims the centre
 * where text lives, no work when the tab is hidden, static-only for people who
 * prefer reduced motion or have Data Saver on. The layout is seeded, so every
 * page shows the same board at the same screen size.
 */
(function () {
  'use strict';

  var reduce =
    (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ||
    (navigator.connection && navigator.connection.saveData);

  // 8 compass directions, clockwise from east. Odd indexes are 45° diagonals.
  var DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

  var TRACE_ALPHA = 0.11;

  var stat, live, sctx, lctx, glow;
  var W = 0, H = 0, DPR = 1, small = false, cell = 24, cols = 0, rows = 0, centerDim = 0.4, vigR = 1;
  var occ, rnd, traces, pads, vias, chips, smds;
  var pulses, flashes, raf = 0, last = 0, interval = 0;

  /* ---------- helpers ---------- */

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function inb(x, y) { return x >= 0 && y >= 0 && x < cols && y < rows; }
  function free(x, y) { return inb(x, y) && !occ[y * cols + x]; }
  function vig(x, y) {
    var t = Math.min(1, Math.sqrt((x - W / 2) * (x - W / 2) + (y - H / 2) * (y - H / 2)) / vigR);
    return centerDim + (1 - centerDim) * t;
  }

  function makeLayer() {
    var c = document.createElement('canvas');
    c.className = 'circuit-layer';
    c.setAttribute('aria-hidden', 'true');
    // Critical styles live here (not only in styles.css) so the layers are
    // always fixed behind the page, even if an old stylesheet is cached.
    c.style.cssText =
      'position:fixed;top:0;left:0;width:100%;height:100%;display:block;' +
      'pointer-events:none;z-index:-1;opacity:0;transition:opacity 1.6s ease;';
    return c;
  }

  function makeGlow() {
    var c = document.createElement('canvas');
    c.width = c.height = 48;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(24, 24, 0, 24, 24, 24);
    grad.addColorStop(0, 'rgba(0,255,136,0.85)');
    grad.addColorStop(0.35, 'rgba(0,255,136,0.25)');
    grad.addColorStop(1, 'rgba(0,255,136,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 48, 48);
    return c;
  }

  /* ---------- routing ---------- */

  // Walk a trace from (sx,sy) heading d, using PCB rules: straight runs and
  // 45° chamfers only, never crossing another trace.
  function route(sx, sy, d, maxSteps) {
    var pts = [[sx, sy]];
    var x = sx, y = sy, steps = 0, cur = d, main = d, prevDir = -1, dead = false;
    while (steps < maxSteps && !dead) {
      var diag = cur & 1;
      var len = diag ? 2 + ((rnd() * 3) | 0) : 3 + ((rnd() * 10) | 0);
      var moved = 0;
      for (var i = 0; i < len && steps < maxSteps; i++) {
        var nx = x + DIRS[cur][0], ny = y + DIRS[cur][1];
        if (!free(nx, ny)) { dead = true; break; }
        x = nx; y = ny; occ[y * cols + x] = 1; moved++; steps++;
      }
      if (moved) {
        if (prevDir === cur) pts[pts.length - 1] = [x, y]; else pts.push([x, y]);
        prevDir = cur;
      }
      if (dead || !moved) break;
      if (diag) {
        var a = (cur + 1) & 7, b = (cur + 7) & 7;
        if ((a === main || b === main) && rnd() < 0.72) cur = main;
        else { cur = rnd() < 0.5 ? a : b; main = cur; }
      } else if (rnd() < 0.5) {
        cur = (cur + (rnd() < 0.5 ? 1 : 7)) & 7;
      }
    }
    return pts;
  }

  function addTrace(pts, startPad) {
    if (!pts || pts.length < 2) return;
    var xs = [], ys = [], cum = [0], total = 0;
    for (var i = 0; i < pts.length; i++) {
      xs.push(pts[i][0] * cell);
      ys.push(pts[i][1] * cell);
      if (i) {
        var dx = xs[i] - xs[i - 1], dy = ys[i] - ys[i - 1];
        total += Math.sqrt(dx * dx + dy * dy);
        cum.push(total);
      }
    }
    if (total < cell * 5) return;
    var n = xs.length - 1;
    traces.push({ x: xs, y: ys, cum: cum, total: total });
    if (rnd() < 0.72) pads.push([xs[n], ys[n]]); else vias.push([xs[n], ys[n]]);
    if (startPad && rnd() < 0.5) pads.push([xs[0], ys[0]]);
  }

  // A bus: several parallel lanes that share one path (straights + small jogs).
  function bus() {
    var horiz = rnd() < 0.5, sign = rnd() < 0.5 ? 1 : -1;
    var main = horiz ? (sign > 0 ? 0 : 4) : (sign > 0 ? 2 : 6);
    var lanes = 3 + ((rnd() * 4) | 0);
    var sx, sy;
    if (horiz) {
      sx = ((sign > 0 ? 0 : 0.5) * cols + rnd() * cols * 0.5) | 0;
      sy = (rnd() * (rows - lanes - 2)) | 0;
    } else {
      sy = ((sign > 0 ? 0 : 0.5) * rows + rnd() * rows * 0.5) | 0;
      sx = (rnd() * (cols - lanes - 2)) | 0;
    }
    var plan = [{ s: 3 + ((rnd() * 8) | 0) }];
    var nj = 1 + ((rnd() * 3) | 0);
    for (var k = 0; k < nj; k++) {
      plan.push({ j: 2 + ((rnd() * 3) | 0), side: rnd() < 0.5 ? 1 : -1 });
      plan.push({ s: 4 + ((rnd() * 10) | 0) });
    }
    for (var lane = 0; lane < lanes; lane++) {
      var x = sx + (horiz ? 0 : lane), y = sy + (horiz ? lane : 0);
      if (!free(x, y)) continue;
      occ[y * cols + x] = 1;
      var pts = [[x, y]], dead = false;
      for (var p = 0; p < plan.length && !dead; p++) {
        var seg = plan[p];
        var dir = seg.j ? (main + seg.side + 8) & 7 : main;
        var n = seg.j || seg.s, moved = 0;
        for (var i = 0; i < n; i++) {
          var nx = x + DIRS[dir][0], ny = y + DIRS[dir][1];
          if (!free(nx, ny)) { dead = true; break; }
          x = nx; y = ny; occ[y * cols + x] = 1; moved++;
        }
        if (moved) pts.push([x, y]);
      }
      addTrace(pts, true);
    }
  }

  /* ---------- chips & small parts ---------- */

  function areaFree(x0, y0, w, h, m) {
    for (var y = y0 - m; y <= y0 + h + m; y++)
      for (var x = x0 - m; x <= x0 + w + m; x++)
        if (!free(x, y)) return false;
    return true;
  }
  function stamp(x0, y0, w, h) {
    for (var y = y0; y <= y0 + h; y++)
      for (var x = x0; x <= x0 + w; x++) occ[y * cols + x] = 1;
  }

  function chip() {
    for (var tries = 0; tries < 40; tries++) {
      var w = 5 + ((rnd() * 5) | 0), h = 5 + ((rnd() * 4) | 0);
      var x0 = 3 + ((rnd() * (cols - w - 6)) | 0), y0 = 3 + ((rnd() * (rows - h - 6)) | 0);
      if (!areaFree(x0, y0, w, h, 2)) continue;
      // on wide screens keep chips out of the central content column
      if (W > 1000 && x0 * cell < W / 2 + 440 && (x0 + w) * cell > W / 2 - 440) continue;
      stamp(x0, y0, w, h);
      chips.push({ x0: x0, y0: y0, w: w, h: h });
      // pins on each side; a contiguous group of each side gets a trace
      var sides = [
        { dir: 6, n: w, px: function (i) { return [x0 + i, y0]; } },
        { dir: 2, n: w, px: function (i) { return [x0 + i, y0 + h]; } },
        { dir: 4, n: h, px: function (i) { return [x0, y0 + i]; } },
        { dir: 0, n: h, px: function (i) { return [x0 + w, y0 + i]; } }
      ];
      sides.forEach(function (s) {
        var k = 2 + ((rnd() * Math.min(5, s.n - 2)) | 0);
        var first = 1 + ((rnd() * (s.n - 1 - k)) | 0);
        for (var i = 0; i < k; i++) {
          var p = s.px(first + i);
          addTrace(route(p[0], p[1], s.dir, 22 + ((rnd() * 50) | 0)), false);
        }
      });
      return;
    }
  }

  function smd() {
    for (var tries = 0; tries < 12; tries++) {
      var horiz = rnd() < 0.5;
      var x = (rnd() * (cols - 4)) | 0, y = (rnd() * (rows - 4)) | 0;
      var w = horiz ? 2 : 0, h = horiz ? 0 : 2;
      if (!areaFree(x, y, w, h, 1)) continue;
      stamp(x, y, w, h);
      smds.push({ x: x, y: y, horiz: horiz });
      return;
    }
  }

  /* ---------- build + draw static layer ---------- */

  function build() {
    W = window.innerWidth; H = window.innerHeight;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    small = W < 700;
    cell = small ? 20 : 24;
    cols = Math.ceil(W / cell) + 1; rows = Math.ceil(H / cell) + 1;
    centerDim = small ? 0.6 : 0.4;
    vigR = Math.sqrt(W * W + H * H) / 2;
    occ = new Uint8Array(cols * rows);
    rnd = mulberry32(20260921);
    traces = []; pads = []; vias = []; chips = []; smds = [];

    var A = cols * rows;
    var nChips = clamp(Math.round(A / 700), 1, 4);
    var nBus = clamp(Math.round(A / 500), 2, 5);
    var i;
    for (i = 0; i < nChips; i++) chip();
    for (i = 0; i < nBus; i++) bus();
    var nSingles = Math.round(A / 22);
    for (i = 0; i < nSingles; i++) {
      var d = (rnd() * 4 | 0) * 2;            // start orthogonal
      var sx = (rnd() * cols) | 0, sy = (rnd() * rows) | 0;
      if (!free(sx, sy)) continue;
      occ[sy * cols + sx] = 1;
      addTrace(route(sx, sy, d, 12 + ((rnd() * 60) | 0)), true);
    }
    var nSmd = Math.round(A / 110);
    for (i = 0; i < nSmd; i++) smd();

    [stat, live].forEach(function (c) {
      c.width = Math.round(W * DPR); c.height = Math.round(H * DPR);
    });
    drawStatic();
    initPulses();
  }

  function drawStatic() {
    var g = sctx, i, t, p;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, W, H);
    g.lineJoin = 'round'; g.lineCap = 'round';

    // traces (one path, one stroke)
    g.strokeStyle = 'rgba(0,255,136,' + TRACE_ALPHA + ')';
    g.lineWidth = 1.2;
    g.beginPath();
    for (i = 0; i < traces.length; i++) {
      t = traces[i];
      g.moveTo(t.x[0], t.y[0]);
      for (var k = 1; k < t.x.length; k++) g.lineTo(t.x[k], t.y[k]);
    }
    g.stroke();

    // pads (rings) and vias (dots)
    g.strokeStyle = 'rgba(0,255,136,0.22)';
    g.beginPath();
    for (i = 0; i < pads.length; i++) {
      p = pads[i];
      g.moveTo(p[0] + 3.4, p[1]);
      g.arc(p[0], p[1], 3.4, 0, Math.PI * 2);
    }
    g.stroke();
    g.fillStyle = 'rgba(0,255,136,0.20)';
    g.beginPath();
    for (i = 0; i < vias.length; i++) {
      p = vias[i];
      g.moveTo(p[0] + 1.9, p[1]);
      g.arc(p[0], p[1], 1.9, 0, Math.PI * 2);
    }
    g.fill();

    // chips: body, inner outline, pin ticks, pin-1 marker
    g.strokeStyle = 'rgba(0,255,136,0.20)';
    g.lineWidth = 1.2;
    for (i = 0; i < chips.length; i++) {
      var c = chips[i];
      var x = c.x0 * cell, y = c.y0 * cell, w = c.w * cell, h = c.h * cell;
      g.strokeRect(x, y, w, h);
      g.strokeStyle = 'rgba(0,255,136,0.09)';
      g.strokeRect(x + 6, y + 6, w - 12, h - 12);
      g.strokeStyle = 'rgba(0,255,136,0.20)';
      g.beginPath();
      g.arc(x + 11, y + 11, 2.2, 0, Math.PI * 2);
      for (var n = 1; n < c.w; n++) {
        g.moveTo(x + n * cell, y); g.lineTo(x + n * cell, y - 5);
        g.moveTo(x + n * cell, y + h); g.lineTo(x + n * cell, y + h + 5);
      }
      for (n = 1; n < c.h; n++) {
        g.moveTo(x, y + n * cell); g.lineTo(x - 5, y + n * cell);
        g.moveTo(x + w, y + n * cell); g.lineTo(x + w + 5, y + n * cell);
      }
      g.stroke();
    }

    // small surface-mount parts (resistor / capacitor look)
    g.strokeStyle = 'rgba(0,255,136,0.16)';
    for (i = 0; i < smds.length; i++) {
      var s = smds[i];
      var sx = s.x * cell, sy = s.y * cell, len = 2 * cell;
      g.beginPath();
      if (s.horiz) {
        g.rect(sx + cell * 0.45, sy - 3.5, cell * 1.1, 7);
        g.moveTo(sx, sy); g.lineTo(sx + cell * 0.45, sy);
        g.moveTo(sx + cell * 1.55, sy); g.lineTo(sx + len, sy);
      } else {
        g.rect(sx - 3.5, sy + cell * 0.45, 7, cell * 1.1);
        g.moveTo(sx, sy); g.lineTo(sx, sy + cell * 0.45);
        g.moveTo(sx, sy + cell * 1.55); g.lineTo(sx, sy + len);
      }
      g.stroke();
    }

    // vignette: dim the middle where the content sits
    g.globalCompositeOperation = 'destination-in';
    var grad = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, vigR);
    grad.addColorStop(0, 'rgba(0,0,0,' + centerDim + ')');
    grad.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
  }

  /* ---------- live layer: pulses ---------- */

  function retarget(p, initial) {
    var t = null;
    for (var i = 0; i < 6; i++) {
      t = traces[(Math.random() * traces.length) | 0];
      if (t.total > cell * 6) break;
    }
    p.t = t;
    p.dir = Math.random() < 0.5 ? 1 : -1;
    p.speed = 45 + Math.random() * 75;          // px per second
    p.trail = 50 + Math.random() * 70;          // px
    p.s = 0;
    p.flashed = false;
    p.wait = initial ? Math.random() * 3 : 0.4 + Math.random() * 3.5;
  }

  function initPulses() {
    pulses = []; flashes = [];
    if (reduce || !traces.length) return;
    var n = clamp(Math.round((W * H) / 38000), 12, 34);
    for (var i = 0; i < n; i++) { var p = {}; retarget(p, true); pulses.push(p); }
  }

  // Trace a sub-range [d0,d1] (distances along the trace) as one stroke.
  function strokeRange(t, d0, d1) {
    var lo = Math.max(0, Math.min(d0, d1)), hi = Math.min(t.total, Math.max(d0, d1));
    if (hi - lo < 0.5) return;
    var c = t.cum, xs = t.x, ys = t.y, i = 1, f;
    while (i < c.length - 1 && c[i] <= lo) i++;
    f = (lo - c[i - 1]) / (c[i] - c[i - 1]);
    lctx.beginPath();
    lctx.moveTo(xs[i - 1] + (xs[i] - xs[i - 1]) * f, ys[i - 1] + (ys[i] - ys[i - 1]) * f);
    while (i < c.length - 1 && c[i] < hi) { lctx.lineTo(xs[i], ys[i]); i++; }
    f = (hi - c[i - 1]) / (c[i] - c[i - 1]);
    lctx.lineTo(xs[i - 1] + (xs[i] - xs[i - 1]) * f, ys[i - 1] + (ys[i] - ys[i - 1]) * f);
    lctx.stroke();
  }

  function pointAt(t, d, out) {
    var c = t.cum, i = 1;
    d = clamp(d, 0, t.total);
    while (i < c.length - 1 && c[i] < d) i++;
    var f = (d - c[i - 1]) / (c[i] - c[i - 1]);
    out.x = t.x[i - 1] + (t.x[i] - t.x[i - 1]) * f;
    out.y = t.y[i - 1] + (t.y[i] - t.y[i - 1]) * f;
  }

  var pt = { x: 0, y: 0 };
  var SEGMENTS = 5;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < interval) return;
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    lctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    lctx.clearRect(0, 0, W, H);
    lctx.lineCap = 'round'; lctx.lineJoin = 'round';
    lctx.lineWidth = 1.6;

    var i, p, t;
    for (i = 0; i < pulses.length; i++) {
      p = pulses[i];
      if (p.wait > 0) { p.wait -= dt; continue; }
      t = p.t;
      p.s += p.speed * dt;
      var head = p.dir > 0 ? p.s : t.total - p.s;

      // arrival: light the pad at the far end once
      if (!p.flashed && p.s >= t.total) {
        p.flashed = true;
        var e = p.dir > 0 ? t.x.length - 1 : 0;
        if (flashes.length < 24) flashes.push({ x: t.x[e], y: t.y[e], life: 0 });
      }
      if (p.s - p.trail > t.total) { retarget(p, false); continue; }

      pointAt(t, head, pt);
      var v = vig(pt.x, pt.y);

      // fading tail, brightest at the head
      for (var k = 0; k < SEGMENTS; k++) {
        var a0 = k / SEGMENTS, a1 = (k + 1) / SEGMENTS;
        var d0 = head - p.dir * p.trail * (1 - a0);
        var d1 = head - p.dir * p.trail * (1 - a1);
        lctx.strokeStyle = 'rgba(0,255,136,' + (0.62 * a1 * a1 * v).toFixed(3) + ')';
        strokeRange(t, d0, d1);
      }
      if (head >= 0 && head <= t.total) {
        lctx.globalAlpha = 0.55 * v;
        lctx.drawImage(glow, pt.x - 11, pt.y - 11, 22, 22);
        lctx.globalAlpha = 1;
        lctx.fillStyle = 'rgba(190,255,225,' + (0.9 * v).toFixed(3) + ')';
        lctx.beginPath();
        lctx.arc(pt.x, pt.y, 1.5, 0, Math.PI * 2);
        lctx.fill();
      }
    }

    // pad flashes
    lctx.lineWidth = 1.2;
    for (i = flashes.length - 1; i >= 0; i--) {
      var f = flashes[i];
      f.life += dt / 0.9;
      if (f.life >= 1) { flashes.splice(i, 1); continue; }
      lctx.strokeStyle = 'rgba(0,255,136,' + ((1 - f.life) * 0.5 * vig(f.x, f.y)).toFixed(3) + ')';
      lctx.beginPath();
      lctx.arc(f.x, f.y, 3.4 + f.life * 9, 0, Math.PI * 2);
      lctx.stroke();
    }
  }

  function start() {
    if (reduce || raf || !pulses.length) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  /* ---------- boot ---------- */

  function init() {
    stat = makeLayer(); live = makeLayer();
    document.body.insertBefore(live, document.body.firstChild);
    document.body.insertBefore(stat, live);
    sctx = stat.getContext('2d'); lctx = live.getContext('2d');
    glow = makeGlow();
    build();
    interval = small ? 1000 / 30 : 0;
    requestAnimationFrame(function () {
      stat.style.opacity = '1'; live.style.opacity = '1';
    });
    start();

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });

    var rt, lastW = W, lastH = H;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () {
        // ignore the mobile address bar showing/hiding
        if (window.innerWidth === lastW && Math.abs(window.innerHeight - lastH) < 150) return;
        stop();
        build();
        interval = small ? 1000 / 30 : 0;
        lastW = W; lastH = H;
        start();
      }, 250);
    });
  }

  function safeInit() {
    try { init(); }
    catch (e) {
      [stat, live].forEach(function (c) { if (c && c.parentNode) c.parentNode.removeChild(c); });
      if (window.console) console.warn('circuit-bg disabled:', e);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeInit);
  else safeInit();
})();
