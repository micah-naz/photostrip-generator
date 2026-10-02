// Photostrip Generator: everything that happens on the phone.
// Photos are kept in this browser (IndexedDB) so a refresh doesn't lose work.
// The same drawing code makes both the on-screen preview and the PDF.

(() => {
  'use strict';

  const MAX_STRIPS = 5; // strips per page
  const SLOTS_PER_STRIP = 4;
  const MAX_PHOTO_SIDE = 2000; // photos are shrunk to this size to save memory
  const PRINT_DPI = 300;
  const MAX_ZOOM = 4;

  // Paper sizes in PDF points (72 points = 1 inch).
  const PAPERS = {
    letter: { w: 612, h: 792, label: 'US Letter' },
    a4: { w: 595.28, h: 841.89, label: 'A4' },
  };
  const PAGE_MARGIN = 18; // 0.25 inch, the edge most home printers can't print on
  const STRIP_W = 144; // classic photostrip: 2 inches wide...
  const STRIP_H = 432; // ...by 6 inches tall
  const BLEED = 72 / 25.4; // 1 mm of extra background around each strip, trimmed off when cutting

  const COLORS = {
    bg: { white: '#ffffff', cream: '#f7f1e3', blush: '#f6e3e1', black: '#111111' },
    text: { gold: '#a8843a', navy: '#1f2f56', rose: '#b05a6a' },
  };

  const FONTS = {
    script: { name: '"Great Vibes"', date: '"Playfair Display"', nameSize: 0.19, dateSize: 0.068 },
    serif: { name: '"Playfair Display"', date: '"Playfair Display"', nameSize: 0.13, dateSize: 0.068 },
    typewriter: { name: '"Special Elite"', date: '"Special Elite"', nameSize: 0.12, dateSize: 0.07 },
    modern: { name: '500 1em "Montserrat"', date: '500 1em "Montserrat"', nameSize: 0.11, dateSize: 0.062 },
  };

  // ---------- State ----------

  const emptySlot = () => ({ photoId: null, zoom: 1, cx: 0.5, cy: 0.5 });
  const emptyStrip = () => ({ slots: Array.from({ length: SLOTS_PER_STRIP }, emptySlot) });

  function defaultState() {
    return {
      photos: [], // [{ id, w, h }]
      strips: Array.from({ length: MAX_STRIPS }, emptyStrip),
      same: true,
      current: 0,
      name: '',
      date: new Date().toISOString().slice(0, 10),
      dateFormat: 'upper',
      font: 'script',
      bg: 'white',
      textColor: 'auto',
      paper: null,
      cutLines: true,
    };
  }

  let state = defaultState();
  let selectedSlot = null; // index 0-3 of the slot being edited, or null
  const images = new Map(); // photoId -> HTMLImageElement
  const thumbUrls = new Map(); // photoId -> object URL

  // ---------- Storage (IndexedDB) ----------

  const db = (() => {
    let dbPromise = null;
    function open() {
      if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
          const req = indexedDB.open('photostrips', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('kv');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      return dbPromise;
    }
    async function run(mode, fn) {
      try {
        const d = await open();
        return await new Promise((resolve, reject) => {
          const tx = d.transaction('kv', mode);
          const req = fn(tx.objectStore('kv'));
          tx.oncomplete = () => resolve(req && req.result);
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) {
        console.warn('Storage unavailable', e);
        return undefined;
      }
    }
    return {
      get: (key) => run('readonly', (s) => s.get(key)),
      set: (key, value) => run('readwrite', (s) => s.put(value, key)),
      del: (key) => run('readwrite', (s) => s.delete(key)),
      clear: () => run('readwrite', (s) => s.clear()),
    };
  })();

  let saveTimer = null;
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    return db.set('state', JSON.parse(JSON.stringify(state)));
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
  }
  // Phones often close a tab in the background; save straight away when that might happen.
  document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) saveNow(); });
  window.addEventListener('pagehide', () => { if (saveTimer) saveNow(); });

  // ---------- Helpers ----------

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function stripAt(i) {
    return state.strips[state.same ? 0 : i];
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function formatDate(value, style) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    if (!m) return '';
    const [, y, mo, d] = m;
    const long = `${MONTHS[Number(mo) - 1]} ${Number(d)}, ${y}`;
    if (style === 'upper') return long.toUpperCase();
    if (style === 'long') return long;
    if (style === 'dots') return `${mo}.${d}.${y}`;
    return `${mo}/${d}/${y.slice(2)}`;
  }

  // ---------- Strip geometry and drawing ----------

  // All sizes are relative to the strip width W. A strip is 3 times taller than wide (like 2" × 6").
  function stripLayout(W) {
    const margin = W * 0.06;
    const gap = W * 0.035;
    const pw = W - margin * 2;
    const ph = pw / 1.5; // photos are 3:2 landscape
    const slots = [];
    for (let i = 0; i < SLOTS_PER_STRIP; i++) slots.push({ x: margin, y: margin + i * (ph + gap), w: pw, h: ph });
    const footerTop = margin + SLOTS_PER_STRIP * ph + (SLOTS_PER_STRIP - 1) * gap;
    return { W, H: W * 3, slots, footer: { y: footerTop, h: W * 3 - footerTop } };
  }

  // Where to draw a photo so it fills its spot, given its zoom and position.
  function photoPlacement(slot, img, t) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const s = Math.max(slot.w / iw, slot.h / ih) * t.zoom;
    const dw = iw * s, dh = ih * s;
    const hx = slot.w / 2 / dw, hy = slot.h / 2 / dh;
    const cx = clamp(t.cx, hx, 1 - hx);
    const cy = clamp(t.cy, hy, 1 - hy);
    return { x: slot.x + slot.w / 2 - cx * dw, y: slot.y + slot.h / 2 - cy * dh, w: dw, h: dh, cx, cy };
  }

  function textColor() {
    if (state.textColor !== 'auto') return COLORS.text[state.textColor];
    return state.bg === 'black' ? '#ffffff' : '#1d1a18';
  }

  function fontString(family, sizePx) {
    // "modern" entries already carry a weight and a placeholder size.
    if (family.includes('1em')) return family.replace('1em', `${sizePx}px`);
    return `${sizePx}px ${family}`;
  }

  // `bleed` (in the same units as W) extends the background past the strip's edges for printing.
  function drawStrip(ctx, W, strip, opts = {}) {
    const L = stripLayout(W);
    const dark = state.bg === 'black';
    const bleed = opts.bleed || 0;
    ctx.save();
    ctx.fillStyle = COLORS.bg[state.bg];
    ctx.fillRect(0, 0, L.W + bleed * 2, L.H + bleed * 2);
    ctx.translate(bleed, bleed);

    L.slots.forEach((slot, i) => {
      const t = strip.slots[i];
      const img = t.photoId && images.get(t.photoId);
      ctx.save();
      ctx.beginPath();
      ctx.rect(slot.x, slot.y, slot.w, slot.h);
      ctx.clip();
      if (img) {
        const p = photoPlacement(slot, img, t);
        ctx.drawImage(img, p.x, p.y, p.w, p.h);
      } else {
        ctx.fillStyle = dark ? '#2b2b2b' : '#ece6df';
        ctx.fillRect(slot.x, slot.y, slot.w, slot.h);
        if (opts.preview) {
          ctx.fillStyle = dark ? '#9a9a9a' : '#8a7f76';
          ctx.font = `${Math.round(W * 0.07)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(selectedSlot === i ? 'Tap a photo above' : '+ Empty', slot.x + slot.w / 2, slot.y + slot.h / 2);
        }
      }
      ctx.restore();
      if (opts.preview && selectedSlot === i) {
        ctx.lineWidth = Math.max(3, W * 0.015);
        ctx.strokeStyle = '#e0a100';
        ctx.strokeRect(slot.x + ctx.lineWidth / 2, slot.y + ctx.lineWidth / 2, slot.w - ctx.lineWidth, slot.h - ctx.lineWidth);
      }
    });

    // Name and date at the bottom.
    const font = FONTS[state.font] || FONTS.script;
    const maxText = W * 0.88;
    const name = state.name.trim();
    const date = formatDate(state.date, state.dateFormat);
    ctx.fillStyle = textColor();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = W / 2;
    const nameY = L.footer.y + L.footer.h * (date ? 0.4 : 0.5);
    const dateY = L.footer.y + L.footer.h * (name ? 0.76 : 0.5);
    if (name) {
      let size = W * font.nameSize;
      ctx.font = fontString(font.name, size);
      const width = ctx.measureText(name).width;
      if (width > maxText) {
        size *= maxText / width;
        ctx.font = fontString(font.name, size);
      }
      ctx.fillText(name, cx, nameY);
    }
    if (date) {
      let size = W * font.dateSize;
      ctx.font = fontString(font.date, size);
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${(size * 0.08).toFixed(2)}px`;
      const width = ctx.measureText(date).width;
      if (width > maxText) {
        size *= maxText / width;
        ctx.font = fontString(font.date, size);
      }
      ctx.fillText(date, cx, dateY);
    }
    ctx.restore();
  }

  // Place full-size 2" × 6" strips (plus their bleed) side by side, centered on the page.
  function pageLayout(paperKey) {
    const paper = PAPERS[paperKey] || PAPERS.letter;
    const cellW = STRIP_W + BLEED * 2;
    const cellH = STRIP_H + BLEED * 2;
    const fits = (space, size) => Math.floor((space + 0.01) / size);
    let best = null;
    for (const [pageW, pageH] of [[paper.h, paper.w], [paper.w, paper.h]]) {
      const cols = fits(pageW - PAGE_MARGIN * 2, cellW);
      const rows = fits(pageH - PAGE_MARGIN * 2, cellH);
      const count = Math.min(MAX_STRIPS, cols * rows);
      if (!best || count > best.count) best = { pageW, pageH, cols, count };
    }
    const { pageW, pageH, cols, count } = best;
    const usedCols = Math.min(count, cols);
    const usedRows = Math.ceil(count / cols);
    const left = (pageW - usedCols * cellW) / 2;
    const top = (pageH - usedRows * cellH) / 2;
    const cells = [];
    for (let i = 0; i < count; i++) {
      // x/y are the strip's trimmed top-left corner, measured from the page's top-left.
      cells.push({ x: left + (i % cols) * cellW + BLEED, y: top + Math.floor(i / cols) * cellH + BLEED });
    }
    return { pageW, pageH, stripW: STRIP_W, stripH: STRIP_H, bleed: BLEED, cells };
  }

  function stripCount() {
    return pageLayout(state.paper).cells.length;
  }

  // ---------- Preview ----------

  const canvas = $('preview');
  const ctx = canvas.getContext('2d');
  let previewW = 200;

  function sizePreview() {
    const wrap = canvas.parentElement;
    const maxW = Math.min(wrap.clientWidth - 8, 320);
    const maxH = Math.max(360, window.innerHeight * 0.72);
    previewW = Math.floor(Math.min(maxW, maxH / 3));
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = previewW + 'px';
    canvas.style.height = previewW * 3 + 'px';
    canvas.width = Math.round(previewW * dpr);
    canvas.height = Math.round(previewW * 3 * dpr);
    drawPreview();
  }

  function drawPreview() {
    const dpr = canvas.width / previewW;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, previewW, previewW * 3);
    drawStrip(ctx, previewW, stripAt(state.current), { preview: true });
  }

  function slotAtPoint(x, y) {
    const L = stripLayout(previewW);
    return L.slots.findIndex((s) => x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h);
  }

  function selectSlot(i) {
    selectedSlot = i;
    canvas.classList.toggle('editing', i !== null);
    $('slot-tools').hidden = i === null;
    $('tray').classList.toggle('picking', i !== null);
    const slot = i === null ? null : stripAt(state.current).slots[i];
    $('arrange-hint').textContent = i === null
      ? 'Tap a photo to move or zoom it.'
      : slot.photoId
        ? 'Drag to move the photo, pinch or use the buttons to zoom. Tap a photo above to swap it in.'
        : 'Tap one of your photos above to put it here.';
    drawPreview();
  }

  // Touch / mouse handling on the preview: tap to select, drag to pan, pinch to zoom.
  const pointers = new Map();
  let gesture = null;

  function localPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener('pointerdown', (e) => {
    const p = localPoint(e);
    pointers.set(e.pointerId, p);
    if (selectedSlot !== null) canvas.setPointerCapture(e.pointerId);
    const t = selectedSlot !== null ? stripAt(state.current).slots[selectedSlot] : null;
    if (pointers.size === 1) {
      gesture = { type: 'tap', start: p, last: p, moved: false };
    } else if (pointers.size === 2 && t && t.photoId) {
      const [a, b] = [...pointers.values()];
      gesture = { type: 'pinch', startDist: Math.hypot(a.x - b.x, a.y - b.y), startZoom: t.zoom };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    const p = localPoint(e);
    pointers.set(e.pointerId, p);
    const t = selectedSlot !== null ? stripAt(state.current).slots[selectedSlot] : null;

    if (gesture.type === 'pinch' && pointers.size === 2 && t) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      t.zoom = clamp(gesture.startZoom * dist / gesture.startDist, 1, MAX_ZOOM);
      normalize(t, selectedSlot);
      drawPreview();
      return;
    }
    if (gesture.type === 'tap' && Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) > 6) {
      gesture.moved = true;
    }
    if (gesture.moved && t && t.photoId && slotAtPoint(gesture.start.x, gesture.start.y) === selectedSlot) {
      const img = images.get(t.photoId);
      const slot = stripLayout(previewW).slots[selectedSlot];
      const place = photoPlacement(slot, img, t);
      t.cx = place.cx - (p.x - gesture.last.x) / place.w;
      t.cy = place.cy - (p.y - gesture.last.y) / place.h;
      normalize(t, selectedSlot);
      drawPreview();
    }
    gesture.last = p;
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (gesture && gesture.type === 'tap' && !gesture.moved && e.type === 'pointerup') {
      const hit = slotAtPoint(gesture.start.x, gesture.start.y);
      selectSlot(hit === -1 || hit === selectedSlot ? null : hit);
    }
    if (pointers.size === 0) {
      if (gesture && gesture.type !== 'tap' || (gesture && gesture.moved)) saveSoon();
      gesture = null;
    } else if (gesture && gesture.type === 'pinch') {
      // One finger lifted after a pinch: carry on as a drag from here.
      const p = [...pointers.values()][0];
      gesture = { type: 'tap', start: p, last: p, moved: true };
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // Keep the stored position inside the bounds so it never shows an empty edge.
  function normalize(t, slotIndex) {
    const img = t.photoId && images.get(t.photoId);
    if (!img) return;
    const p = photoPlacement(stripLayout(1).slots[slotIndex], img, t);
    t.cx = p.cx;
    t.cy = p.cy;
  }

  $('slot-tools').addEventListener('click', (e) => {
    const act = e.target.closest('button') && e.target.closest('button').dataset.act;
    if (!act || selectedSlot === null) return;
    const slots = stripAt(state.current).slots;
    const t = slots[selectedSlot];
    if (act === 'done') return selectSlot(null);
    if (act === 'up' || act === 'down') {
      const j = selectedSlot + (act === 'up' ? -1 : 1);
      if (j < 0 || j >= SLOTS_PER_STRIP) return;
      [slots[selectedSlot], slots[j]] = [slots[j], slots[selectedSlot]];
      selectSlot(j);
    } else if (act === 'zoom-in' || act === 'zoom-out') {
      t.zoom = clamp(t.zoom * (act === 'zoom-in' ? 1.2 : 1 / 1.2), 1, MAX_ZOOM);
      normalize(t, selectedSlot);
      drawPreview();
    } else if (act === 'clear') {
      slots[selectedSlot] = emptySlot();
      selectSlot(selectedSlot);
    }
    renderTray();
    saveSoon();
  });

  // ---------- Strip picker (when strips differ) ----------

  function renderStripPicker() {
    const picker = $('strip-picker');
    picker.hidden = state.same;
    $('copy-to-all').hidden = state.same;
    picker.innerHTML = '';
    if (state.same) return;
    for (let i = 0; i < stripCount(); i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `Strip ${i + 1}`;
      b.className = i === state.current ? 'active' : '';
      b.addEventListener('click', () => {
        state.current = i;
        selectSlot(null);
        renderStripPicker();
        saveSoon();
      });
      picker.appendChild(b);
    }
  }

  $('copy-to-all').addEventListener('click', () => {
    if (!confirm(`Copy strip ${state.current + 1} onto all the other strips? This replaces the photos on the others.`)) return;
    const src = JSON.stringify(state.strips[state.current]);
    state.strips = state.strips.map(() => JSON.parse(src));
    renderTray();
    saveSoon();
  });

  // ---------- Photos ----------

  function photoUseCount(id) {
    const strips = state.same ? [state.strips[0]] : state.strips;
    return strips.reduce((n, s) => n + s.slots.filter((t) => t.photoId === id).length, 0);
  }

  function renderTray() {
    const tray = $('tray');
    tray.innerHTML = '';
    for (const photo of state.photos) {
      const used = photoUseCount(photo.id);
      const el = document.createElement('div');
      el.className = 'thumb' + (used ? ' used' : '');
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.innerHTML = `<img alt="">${used ? `<span class="count">×${used}</span>` : ''}<button class="remove" type="button" aria-label="Remove photo">×</button>`;
      el.querySelector('img').src = thumbUrls.get(photo.id) || '';
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('remove')) return removePhoto(photo.id);
        placePhoto(photo.id);
      });
      tray.appendChild(el);
    }
    $('tray-hint').textContent = state.photos.length
      ? 'Tap a spot on the strip, then tap a photo here to put it there.'
      : 'New photos fill the empty spots in order.';
  }

  function placePhoto(id) {
    const strip = stripAt(state.current);
    let i = selectedSlot;
    if (i === null) i = strip.slots.findIndex((t) => !t.photoId);
    if (i === -1) {
      $('arrange-hint').textContent = 'All 4 spots are full. Tap a spot on the strip first, then tap the photo you want there.';
      return;
    }
    strip.slots[i] = { ...emptySlot(), photoId: id };
    selectSlot(selectedSlot === null ? null : i);
    renderTray();
    saveSoon();
  }

  async function removePhoto(id) {
    if (photoUseCount(id) && !confirm('Remove this photo? It will be taken off the strips too.')) return;
    state.photos = state.photos.filter((p) => p.id !== id);
    for (const strip of state.strips) {
      strip.slots = strip.slots.map((t) => (t.photoId === id ? emptySlot() : t));
    }
    images.delete(id);
    if (thumbUrls.has(id)) URL.revokeObjectURL(thumbUrls.get(id));
    thumbUrls.delete(id);
    await db.del('photo:' + id);
    renderTray();
    drawPreview();
    saveSoon();
  }

  // Shrink a picked photo, keep it, and drop it in the next empty spot.
  async function addFiles(files) {
    const status = $('tray-hint');
    let done = 0;
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      status.textContent = `Adding photo ${++done} of ${files.length}…`;
      try {
        const url = URL.createObjectURL(file);
        const src = await loadImage(url);
        URL.revokeObjectURL(url);
        const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(src.naturalWidth, src.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(src.naturalWidth * scale);
        c.height = Math.round(src.naturalHeight * scale);
        c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
        const blob = await canvasToBlob(c, 'image/jpeg', 0.9);
        const id = newId();
        await db.set('photo:' + id, blob);
        await registerPhoto(id, blob);
        state.photos.push({ id, w: c.width, h: c.height });
        fillNextEmpty(id);
      } catch (err) {
        console.error(err);
        alert(`Couldn't read "${file.name}". Try a JPG or PNG photo.`);
      }
    }
    renderTray();
    drawPreview();
    saveSoon();
  }

  async function registerPhoto(id, blob) {
    const url = URL.createObjectURL(blob);
    thumbUrls.set(id, url);
    images.set(id, await loadImage(url));
  }

  function fillNextEmpty(id) {
    const order = state.same ? [0] : [state.current, ...[...Array(stripCount()).keys()].filter((i) => i !== state.current)];
    for (const s of order) {
      const slot = state.strips[s].slots.findIndex((t) => !t.photoId);
      if (slot !== -1) {
        state.strips[s].slots[slot] = { ...emptySlot(), photoId: id };
        return;
      }
    }
  }

  $('file-input').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    await addFiles(files);
  });

  // ---------- Text and print settings ----------

  const fields = {
    name: 'name', date: 'date', 'date-format': 'dateFormat', font: 'font',
    bg: 'bg', 'text-color': 'textColor', paper: 'paper',
  };

  function syncForm() {
    for (const [id, key] of Object.entries(fields)) $(id).value = state[key];
    $('same').checked = state.same;
    $('cut-lines').checked = state.cutLines;
    updateSizeHint();
  }

  for (const [id, key] of Object.entries(fields)) {
    $(id).addEventListener('input', async () => {
      state[key] = $(id).value;
      if (key === 'font') await loadFonts();
      if (key === 'paper') {
        updateSizeHint();
        state.current = Math.min(state.current, stripCount() - 1);
        renderStripPicker();
      }
      drawPreview();
      saveSoon();
    });
  }

  $('same').addEventListener('change', () => {
    state.same = $('same').checked;
    if (!state.same) {
      // Start the other strips as copies of the first so nothing looks empty.
      const src = JSON.stringify(state.strips[0]);
      state.strips = state.strips.map((s, i) => (i === 0 || s.slots.some((t) => t.photoId) ? s : JSON.parse(src)));
    }
    state.current = 0;
    selectSlot(null);
    renderStripPicker();
    renderTray();
    saveSoon();
  });

  $('cut-lines').addEventListener('change', () => {
    state.cutLines = $('cut-lines').checked;
    saveSoon();
  });

  function updateSizeHint() {
    const n = stripCount();
    $('size-hint').textContent = `${n} classic 2" × 6" strips fit on one page, each with 1 mm of bleed. Print at "Actual size" (100%), not "Fit to page".`;
    $('same-label').textContent = `Use the same photos on all ${n} strips`;
  }

  async function loadFonts() {
    const f = FONTS[state.font] || FONTS.script;
    try {
      await Promise.all([document.fonts.load(fontString(f.name, 40)), document.fonts.load(fontString(f.date, 40))]);
    } catch (e) {
      console.warn('Font load failed', e);
    }
  }

  // ---------- PDF ----------

  async function makePdf() {
    const status = $('pdf-status');
    const button = $('make-pdf');
    const count = stripCount();
    const strips = Array.from({ length: state.same ? 1 : count }, (_, i) => stripAt(i));
    const empty = strips.reduce((n, s) => n + s.slots.filter((t) => !t.photoId).length, 0);
    if (empty && !confirm(`${empty} photo spot${empty === 1 ? ' is' : 's are'} still empty. Make the PDF anyway?`)) return;

    button.disabled = true;
    $('pdf-link').hidden = true;
    try {
      await loadFonts();
      const { PDFDocument } = window.PDFLib;
      const pdf = await PDFDocument.create();
      const L = pageLayout(state.paper);
      const page = pdf.addPage([L.pageW, L.pageH]);
      const pxW = Math.round(L.stripW / 72 * PRINT_DPI);
      const pxBleed = Math.round(L.bleed / 72 * PRINT_DPI);
      const c = document.createElement('canvas');
      c.width = pxW + pxBleed * 2;
      c.height = pxW * 3 + pxBleed * 2;
      const cctx = c.getContext('2d');
      const prevSelected = selectedSlot;
      selectedSlot = null;

      const unique = state.same ? 1 : L.cells.length;
      const embedded = [];
      for (let i = 0; i < unique; i++) {
        status.textContent = `Drawing strip ${i + 1} of ${unique}…`;
        await new Promise((r) => setTimeout(r, 0));
        cctx.setTransform(1, 0, 0, 1, 0, 0);
        drawStrip(cctx, pxW, stripAt(i), { bleed: pxBleed });
        const blob = await canvasToBlob(c, 'image/jpeg', 0.93);
        embedded.push(await pdf.embedJpg(await blob.arrayBuffer()));
      }
      selectedSlot = prevSelected;

      L.cells.forEach((cell, i) => {
        // PDF coordinates start at the bottom-left corner of the page; the image includes the bleed.
        page.drawImage(embedded[state.same ? 0 : i], {
          x: cell.x - L.bleed,
          y: L.pageH - cell.y - L.stripH - L.bleed,
          width: L.stripW + L.bleed * 2,
          height: L.stripH + L.bleed * 2,
        });
      });
      if (state.cutLines) drawCutLines(page, L);

      status.textContent = 'Saving…';
      const bytes = await pdf.save();
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const fileName = `photostrips-${(state.name || 'strips').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'strips'}${state.date ? '-' + state.date : ''}.pdf`;
      const link = $('pdf-link');
      link.href = url;
      link.download = fileName;
      link.hidden = false;
      link.click();
      status.textContent = 'Done! If the download didn\'t start, tap "Open PDF".';
    } catch (err) {
      console.error(err);
      status.textContent = 'Something went wrong making the PDF: ' + err.message;
    } finally {
      button.disabled = false;
      drawPreview();
    }
  }

  // Crop marks: black lines in the page margins lined up with every strip's cut edges, plus a
  // small crosshair on each strip corner (purple with a green dashed overlay, so it shows on
  // light or dark backgrounds) marking exactly where the cuts meet.
  function drawCutLines(page, L) {
    const { rgb } = window.PDFLib;
    const line = (x1, y1, x2, y2, opts = {}) => page.drawLine({
      start: { x: x1, y: L.pageH - y1 }, end: { x: x2, y: L.pageH - y2 }, thickness: 0.5, color: rgb(0, 0, 0), ...opts,
    });
    const arm = 72 / 25.4; // crosshair arms reach 1 mm from the corner
    const crosshair = (x, y) => {
      const styles = [
        { thickness: 0.78, color: rgb(0.32, 0, 0.82) },
        { thickness: 0.78, color: rgb(0.68, 1, 0.18), dashArray: [0.57, 0.71] },
      ];
      for (const style of styles) {
        line(x - arm, y, x + arm, y, style);
        line(x, y - arm, x, y + arm, style);
      }
    };
    const top = Math.min(...L.cells.map((c) => c.y)) - L.bleed;
    const bottom = Math.max(...L.cells.map((c) => c.y + L.stripH)) + L.bleed;
    const left = Math.min(...L.cells.map((c) => c.x)) - L.bleed;
    const right = Math.max(...L.cells.map((c) => c.x + L.stripW)) + L.bleed;
    const xs = new Set(), ys = new Set();
    for (const c of L.cells) {
      xs.add(c.x); xs.add(c.x + L.stripW);
      ys.add(c.y); ys.add(c.y + L.stripH);
    }
    for (const x of xs) {
      line(x, 0, x, top);
      line(x, bottom, x, L.pageH);
    }
    for (const y of ys) {
      line(0, y, left, y);
      line(right, y, L.pageW, y);
    }
    for (const c of L.cells) {
      for (const x of [c.x, c.x + L.stripW]) {
        for (const y of [c.y, c.y + L.stripH]) crosshair(x, y);
      }
    }
  }

  $('make-pdf').addEventListener('click', makePdf);

  $('start-over').addEventListener('click', async () => {
    if (!confirm('Start over? This removes all photos and text from this phone.')) return;
    await db.clear();
    for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
    images.clear();
    thumbUrls.clear();
    const paper = state.paper;
    state = defaultState();
    state.paper = paper;
    selectSlot(null);
    syncForm();
    renderStripPicker();
    renderTray();
    drawPreview();
    $('pdf-link').hidden = true;
    $('pdf-status').textContent = '';
  });

  // ---------- Start up ----------

  async function init() {
    let defaultPaper = 'letter';
    try {
      const res = await fetch('/api/config');
      if (res.ok) defaultPaper = (await res.json()).paperSize || 'letter';
    } catch (e) { /* use letter */ }

    const saved = await db.get('state');
    if (saved && Array.isArray(saved.strips)) {
      state = { ...defaultState(), ...saved };
      const kept = [];
      for (const photo of state.photos) {
        const blob = await db.get('photo:' + photo.id);
        if (!blob) continue;
        try {
          await registerPhoto(photo.id, blob);
          kept.push(photo);
        } catch (e) { /* skip unreadable photo */ }
      }
      state.photos = kept;
      for (const strip of state.strips) {
        strip.slots = strip.slots.map((t) => (t.photoId && !images.has(t.photoId) ? emptySlot() : t));
      }
    }
    if (!PAPERS[state.paper]) state.paper = defaultPaper;
    state.current = state.same ? 0 : clamp(state.current || 0, 0, stripCount() - 1);

    syncForm();
    renderStripPicker();
    renderTray();
    await loadFonts();
    sizePreview();
  }

  window.addEventListener('resize', sizePreview);
  init();
})();
