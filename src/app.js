/* EasyScan2PDF UI: load a scanned PDF, review the detected page areas, export. */
(function () {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const ANALYSIS_PX = 1400;   // longest side of the render used for detection
  const VIEW_PX = 1800;       // longest side of the editor render at 100% zoom
  const VIEW_MAX_PX = 5000;
  const THUMB_PX = 300;
  const PREVIEW_DPI = 100;
  const MIN_BOX = 0.03;       // smallest allowed area, fraction of the sheet
  const MAX_ZOOM = 6;
  const HISTORY = 60;         // undo steps kept
  const MM = 72 / 25.4;
  const FULL = { x: 0, y: 0, w: 1, h: 1 };
  const PAPER = { A4: [210, 297], A5: [148, 210], A3: [297, 420], B5: [176, 250], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };
  const PERSISTED = ['paper', 'cw', 'ch', 'orient', 'margin', 'scaling', 'mode', 'dpi', 'autoThr', 'thr', 'quality', 'deskew', 'clean', 'order'];
  const IMAGE_DPI = 200;      // assumed resolution of scans opened as image files
  const DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  const $ = (id) => document.getElementById(id);
  const t = I18n.t;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const state = {
    pdf: null, baseName: '', nameEdited: false,
    feats: [],
    sheets: [],        // { rot, wPt, hPt, thumb, pages, auto, split, autoSplit }
    order: null,       // output order as page keys once the user rearranged it; null = natural
    blankSeq: 0,       // counter for the keys of inserted blank pages
    cur: 0, active: 0, zoom: 1,
    busy: false, cancel: false,
  };

  /* ---------- rendering ---------- */

  // pdf.js renders are serialised so analysis, editor, preview and export never overlap.
  let chain = Promise.resolve();
  function queued(fn) {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  }

  /* Renders the part of a sheet covered by box (normalised) into a new pxW x pxH canvas.
   * angle is the tilt of the area in degrees clockwise; the content is turned back level. */
  function renderRegion(index, box, pxW, pxH, angle = 0) {
    return queued(async () => {
      const page = await state.pdf.getPage(index + 1);
      const rotation = (page.rotate + state.sheets[index].rot) % 360;
      const scale = pxW / (box.w * page.getViewport({ scale: 1, rotation }).width);
      const viewport = page.getViewport({ scale, rotation });
      const canvas = document.createElement('canvas');
      canvas.width = pxW;
      canvas.height = pxH;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, pxW, pxH);
      // Rotate about the centre of the area, which lands on the centre of the canvas.
      const r = -angle * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
      const cx = (box.x + box.w / 2) * viewport.width, cy = (box.y + box.h / 2) * viewport.height;
      // 'print' intent renders without requestAnimationFrame, so work continues in a background tab.
      await page.render({
        canvasContext: ctx, viewport, intent: 'print',
        transform: [cos, sin, -sin, cos, pxW / 2 - (cos * cx - sin * cy), pxH / 2 - (sin * cx + cos * cy)],
      }).promise;
      page.cleanup();
      return canvas;
    });
  }

  /* Applies the colour mode and clean-up to a rendered canvas in place; pxPerPt is its
   * resolution in pixels per point of the scanned sheet. Returns the pixels for B/W. */
  function applyTone(canvas, s, pxPerPt) {
    if (s.mode === 'color' && !s.clean) return null;
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // Specks: marks up to a quarter of a millimetre across with half a millimetre of clear paper around.
    const speck = Math.max(2, Math.round((0.7 * pxPerPt) ** 2)), gap = Math.max(2, Math.round(1.4 * pxPerPt));
    Clean.process(img, { mode: s.mode, autoThr: s.autoThr, thr: s.thr, clean: s.clean, speck, gap });
    ctx.putImageData(img, 0, 0);
    return s.mode === 'bw' ? img : null;
  }

  /* ---------- loading and analysis ---------- */

  function status(text) { $('status').textContent = text; }

  function setBusy(busy) {
    state.busy = busy;
    for (const id of ['openBtn', 'layoutSel', 'rotateSel', 'updateBtn']) $(id).disabled = busy;
    $('exportBtn').disabled = busy || !state.sheets.length;
    updateHistoryButtons();
  }

  async function loadBytes(bytes, name) {
    if (state.busy) return;
    setBusy(true);
    status(t('opening'));
    try {
      const pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
      if (state.pdf) state.pdf.destroy();
      state.pdf = pdf;
      state.baseName = name.replace(/\.(pdf|jpe?g|png)$/i, '');
      state.nameEdited = false;
      state.cur = state.active = 0;
      state.zoom = 1;
      $('range').value = '';
      $('docName').textContent = name;
      await scan();
      $('empty').hidden = true;
      $('wrap').hidden = false;
      $('toolbar').hidden = false;
      history.length = 0;
      historyAt = -1;
      applyAnalysis();
      updateSettingsUI();
    } catch (err) {
      status(err.name === 'PasswordException' ? t('passwordProtected') : t('cannotOpen', { msg: err.message }));
    } finally {
      setBusy(false);
    }
  }

  /* Renders one sheet for detection: its features, thumbnail and size in its current rotation. */
  async function scanSheet(i) {
    const sheet = state.sheets[i];
    const page = await state.pdf.getPage(i + 1);
    const base = page.getViewport({ scale: 1, rotation: (page.rotate + sheet.rot) % 360 });
    sheet.wPt = base.width;
    sheet.hPt = base.height;
    const k = ANALYSIS_PX / Math.max(base.width, base.height);
    const canvas = await renderRegion(i, FULL, Math.round(base.width * k), Math.round(base.height * k));
    state.feats[i] = Detect.extract(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height));
    sheet.thumb = document.createElement('canvas');
    sheet.thumb.width = THUMB_PX;
    sheet.thumb.height = Math.round(THUMB_PX * base.height / base.width);
    sheet.thumb.getContext('2d').drawImage(canvas, 0, 0, sheet.thumb.width, sheet.thumb.height);
  }

  /* Pass 1 over every sheet. Sheets scanned sideways are turned upright here. */
  async function scan() {
    const n = state.pdf.numPages;
    state.feats = [];
    state.sheets = [];
    state.order = null;
    for (let i = 0; i < n; i++) {
      status(t('analysing', { i: i + 1, n }));
      state.sheets[i] = { rot: 0, wPt: 0, hPt: 0, thumb: null, pages: [], auto: [], split: null, autoSplit: null };
      await scanSheet(i);
      const turn = Detect.sideways(state.feats[i]);
      if (turn) {
        state.sheets[i].rot = turn;
        await scanSheet(i);
      }
    }
  }

  const clonePages = (pages) => pages.map((p) => ({ ...p, box: { ...p.box } }));

  /* Stores the detected areas of the given sheets. */
  function assignAnalysis(result, indices) {
    for (const i of indices) {
      const sheet = state.sheets[i];
      sheet.auto = result[i].pages.map((p) => ({ box: p.box, angle: p.angle, flag: p.flag, include: p.flag !== 'blank', manual: false }));
      sheet.autoSplit = result[i].split;
      sheet.pages = clonePages(sheet.auto);
      sheet.split = sheet.autoSplit;   // 'h' left | right, 'v' top | bottom, null single page
    }
  }

  /* Pass 2: document-wide detection. Replaces all areas, including manual edits. */
  function applyAnalysis() {
    assignAnalysis(Detect.analyze(state.feats, $('layoutSel').value), state.sheets.map((s, i) => i));
    state.order = null;
    buildThumbs();
    showSheet(Math.min(state.cur, state.sheets.length - 1));
    commit();
  }

  /* Turns sheets by a multiple of 90° and detects their areas again. value: 'this:90', 'all:180', … */
  async function rotateSheets(value) {
    if (!value || state.busy || !state.sheets.length) return;
    const [scope, deg] = value.split(':');
    const targets = scope === 'all' ? state.sheets.map((s, i) => i) : [state.cur];
    setBusy(true);
    status(t('rotating'));
    try {
      for (const i of targets) {
        state.sheets[i].rot = (state.sheets[i].rot + Number(deg)) % 360;
        await scanSheet(i);
      }
      assignAnalysis(Detect.analyze(state.feats, $('layoutSel').value), targets);
    } finally {
      setBusy(false);
    }
    buildThumbs();
    showSheet(state.cur);
    commit();
  }

  /* ---------- output order ---------- */

  const keyOf = (i, j) => i + ':' + j;

  /* Included pages in reading order, before any rearranging by the user. */
  function naturalList() {
    const list = [], rtl = $('order').value === 'rtl';
    state.sheets.forEach((sheet, i) => {
      const order = sheet.pages.map((p, j) => j);
      if (rtl && sheet.split === 'h') order.reverse();
      for (const j of order) if (sheet.pages[j].include) list.push({ i, j, key: keyOf(i, j) });
    });
    return list;
  }

  /* Pages of the output document, in order. Entries are { i, j, key } or { blank, key }. */
  function outputList() {
    const natural = naturalList();
    if (!state.order) return natural;
    const left = new Map(natural.map((o) => [o.key, o]));
    const list = [];
    for (const key of state.order) {
      if (key[0] === 'b') list.push({ blank: true, key });
      else if (left.has(key)) { list.push(left.get(key)); left.delete(key); }
    }
    // Pages that appeared since the order was set go right after the page that precedes them naturally.
    natural.forEach((o, n) => {
      if (!left.has(o.key)) return;
      let at = 0;
      for (let m = n - 1; m >= 0; m--) {
        const found = list.findIndex((x) => x.key === natural[m].key);
        if (found >= 0) { at = found + 1; break; }
      }
      list.splice(at, 0, o);
    });
    return list;
  }

  /* Tilt applied to a page: its detected or hand-set angle, unless straightening is off. */
  const angleOf = (page) => ($('deskew').checked ? page.angle || 0 : 0);

  function updateSummary() {
    const pages = outputList().length;
    const check = state.sheets.filter((s) => s.pages.some((p) => p.flag === 'review')).length;
    status(t('summary', { sheets: state.sheets.length, pages }) + (check ? t('toCheck', { n: check }) : ''));
  }

  /* ---------- undo / redo ---------- */

  const history = [];
  let historyAt = -1, lastKey = '', lastTime = 0;

  const snapshot = () => JSON.stringify({
    sheets: state.sheets.map((s) => ({ rot: s.rot, split: s.split, autoSplit: s.autoSplit, pages: s.pages, auto: s.auto })),
    order: state.order, blankSeq: state.blankSeq,
  });

  /* Records the current areas as an undo step. Rapid repeats of the same kind
   * (key), such as holding an arrow key, collapse into one step. */
  function commit(key = '') {
    const snap = snapshot(), now = Date.now();
    if (snap === history[historyAt]) return;
    if (key && key === lastKey && now - lastTime < 1000 && historyAt > 0) {
      history[historyAt] = snap;
    } else {
      history.length = historyAt + 1;
      history.push(snap);
      if (history.length > HISTORY) history.shift();
      historyAt = history.length - 1;
    }
    lastKey = key;
    lastTime = now;
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    $('undoBtn').disabled = state.busy || historyAt <= 0;
    $('redoBtn').disabled = state.busy || historyAt >= history.length - 1;
  }

  async function travel(step) {
    const to = historyAt + step;
    if (state.busy || to < 0 || to >= history.length) return;
    historyAt = to;
    lastKey = '';
    const data = JSON.parse(history[to]);
    setBusy(true);
    try {
      for (let i = 0; i < state.sheets.length; i++) {
        const sheet = state.sheets[i], saved = data.sheets[i];
        if (sheet.rot !== saved.rot) { sheet.rot = saved.rot; await scanSheet(i); }
        Object.assign(sheet, { split: saved.split, autoSplit: saved.autoSplit, pages: saved.pages, auto: saved.auto });
      }
      state.order = data.order;
      state.blankSeq = data.blankSeq;
    } finally {
      setBusy(false);
    }
    buildThumbs();
    showSheet(state.cur, true);
    if ($('organiser').open) renderOrganiser();
  }

  /* ---------- thumbnails ---------- */

  function buildThumbs() {
    const host = $('thumbs');
    host.textContent = '';
    state.sheets.forEach((sheet, i) => {
      const el = document.createElement('div');
      el.className = 'thumb';
      const canvas = document.createElement('canvas');
      canvas.width = sheet.thumb.width;
      canvas.height = sheet.thumb.height;
      const dot = document.createElement('span');
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = i + 1;
      el.append(canvas, dot, num);
      el.addEventListener('click', () => showSheet(i));
      host.append(el);
      drawThumb(i);
    });
  }

  function drawThumb(i) {
    const sheet = state.sheets[i], el = $('thumbs').children[i];
    const canvas = el.firstChild, ctx = canvas.getContext('2d');
    ctx.drawImage(sheet.thumb, 0, 0);
    ctx.lineWidth = 3;
    for (const p of sheet.pages) {
      ctx.setLineDash(p.include ? [] : [6, 5]);
      ctx.strokeStyle = !p.include ? '#8b93a1' : p.flag === 'review' ? '#ea580c' : '#1f6feb';
      ctx.strokeRect(p.box.x * canvas.width, p.box.y * canvas.height, p.box.w * canvas.width, p.box.h * canvas.height);
    }
    const kind = sheet.pages.some((p) => p.flag === 'review') ? 'review'
      : sheet.pages.some((p) => p.flag === 'blank') ? 'blank'
      : sheet.pages.some((p) => p.manual) ? 'manual' : '';
    const dot = el.children[1];
    dot.className = kind ? 'dot ' + kind : '';
    dot.title = { review: t('dotReview'), blank: t('dotBlank'), manual: t('dotManual'), '': '' }[kind];
  }

  /* ---------- editor ---------- */

  let viewToken = 0, viewTimer = 0;

  /* keepActive: stay on the selected page instead of jumping to the first included one. */
  function showSheet(i, keepActive = false) {
    if (!state.sheets.length) return;
    state.cur = clamp(i, 0, state.sheets.length - 1);
    const sheet = state.sheets[state.cur];
    if (!keepActive || state.active >= sheet.pages.length) state.active = Math.max(0, sheet.pages.findIndex((p) => p.include));

    [...$('thumbs').children].forEach((el, k) => el.classList.toggle('current', k === state.cur));
    $('thumbs').children[state.cur].scrollIntoView({ block: 'nearest', inline: 'nearest' });

    // Show the thumbnail at once, then swap in the sharp render.
    const view = $('view');
    view.width = sheet.thumb.width;
    view.height = sheet.thumb.height;
    view.getContext('2d').drawImage(sheet.thumb, 0, 0);
    renderView();

    fitStage();
    refreshSheet();
  }

  /* Sharp render of the current sheet, finer when zoomed in. */
  function renderView() {
    const sheet = state.sheets[state.cur], token = ++viewToken;
    const k = clamp(VIEW_PX * state.zoom, VIEW_PX, VIEW_MAX_PX) / Math.max(sheet.wPt, sheet.hPt);
    renderRegion(state.cur, FULL, Math.round(sheet.wPt * k), Math.round(sheet.hPt * k)).then((canvas) => {
      if (token !== viewToken) return;
      const view = $('view');
      view.width = canvas.width;
      view.height = canvas.height;
      view.getContext('2d').drawImage(canvas, 0, 0);
    }, () => {});
  }

  function fitStage() {
    const sheet = state.sheets[state.cur];
    if (!sheet) return;
    const stage = $('stage'), aspect = sheet.wPt / sheet.hPt;
    // In the one-column layout the stage grows with the sheet instead of filling a fixed pane.
    const narrow = matchMedia('(max-width: 760px)').matches;
    const availW = stage.offsetWidth - 40, availH = narrow ? innerHeight * 0.7 : stage.offsetHeight - 40;
    const w = Math.max(50, Math.min(availW, availH * aspect)) * state.zoom;
    $('wrap').style.width = w + 'px';
    $('wrap').style.height = w / aspect + 'px';
    $('zoomBtn').textContent = Math.round(state.zoom * 100) + '%';
    $('zoomOutBtn').disabled = state.zoom <= 1;
    $('zoomInBtn').disabled = state.zoom >= MAX_ZOOM;
  }

  /* Zooms the sheet, keeping the point under (clientX, clientY) in place when given. */
  function setZoom(zoom, clientX, clientY) {
    if (!state.sheets.length) return;
    const stage = $('stage'), wrap = $('wrap'), before = wrap.getBoundingClientRect();
    const box = stage.getBoundingClientRect();
    const px = clientX === undefined ? box.left + box.width / 2 : clientX;
    const py = clientY === undefined ? box.top + box.height / 2 : clientY;
    const fx = (px - before.left) / before.width, fy = (py - before.top) / before.height;
    state.zoom = clamp(zoom, 1, MAX_ZOOM);
    fitStage();
    const after = wrap.getBoundingClientRect();
    stage.scrollLeft += after.left + fx * after.width - px;
    stage.scrollTop += after.top + fy * after.height - py;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(renderView, 250);
  }

  /* Redraws everything that depends on the current sheet's areas. */
  function refreshSheet() {
    const sheet = state.sheets[state.cur];
    $('sheetLabel').textContent = t('sheetOf', { i: state.cur + 1, n: state.sheets.length });
    $('prevBtn').disabled = state.cur === 0;
    $('nextBtn').disabled = state.cur === state.sheets.length - 1;
    $('oneBtn').classList.toggle('on', sheet.pages.length === 1);
    $('twoBtn').classList.toggle('on', sheet.pages.length === 2);
    $('flagNote').textContent = sheet.pages.some((p) => p.flag === 'review') ? t('flagReview')
      : sheet.pages.some((p) => p.flag === 'blank' && !p.include) ? t('flagBlank') : '';
    const active = sheet.pages[state.active];
    $('angle').value = active ? (active.angle || 0).toFixed(1) : '0.0';
    $('angle').disabled = !active || !$('deskew').checked;
    buildBoxes();
    drawThumb(state.cur);
    updateSummary();
    schedulePreview();
  }

  function placeBox(el, page) {
    const b = page.box;
    el.style.left = b.x * 100 + '%';
    el.style.top = b.y * 100 + '%';
    el.style.width = b.w * 100 + '%';
    el.style.height = b.h * 100 + '%';
    el.style.transform = `rotate(${angleOf(page)}deg)`;
  }

  function buildBoxes() {
    const overlay = $('overlay'), sheet = state.sheets[state.cur];
    const list = outputList();
    overlay.textContent = '';
    sheet.pages.forEach((p, j) => {
      const el = document.createElement('div');
      el.className = 'box' + (j === state.active ? ' active' : '') + (p.include ? '' : ' excluded') + (p.include && p.flag === 'review' ? ' review' : '');
      placeBox(el, p);
      const number = list.findIndex((o) => o.i === state.cur && o.j === j) + 1;

      const tag = document.createElement('label');
      tag.className = 'tag';
      tag.title = t('includeTitle');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = p.include;
      check.addEventListener('change', () => { p.include = check.checked; state.active = j; refreshSheet(); commit(); });
      tag.append(check, p.include ? t('page', { n: number }) : t('skipped'));
      el.append(tag);

      for (const dir of DIRS) {
        const h = document.createElement('div');
        h.className = 'handle ' + dir;
        h.dataset.dir = dir;
        el.append(h);
      }
      el.addEventListener('pointerdown', (e) => startDrag(e, j, el));
      overlay.append(el);
    });
  }

  function startDrag(e, j, el) {
    if (e.target.closest('.tag') || e.button !== 0) return;
    e.preventDefault();
    const page = state.sheets[state.cur].pages[j];
    const dir = e.target.dataset.dir || 'move';
    const rect = $('overlay').getBoundingClientRect();
    const b0 = { ...page.box }, sx = e.clientX, sy = e.clientY;
    let moved = false;

    const move = (ev) => {
      const dx = (ev.clientX - sx) / rect.width, dy = (ev.clientY - sy) / rect.height;
      let x0 = b0.x, y0 = b0.y, x1 = b0.x + b0.w, y1 = b0.y + b0.h;
      if (dir === 'move') {
        x0 = clamp(b0.x + dx, 0, 1 - b0.w); x1 = x0 + b0.w;
        y0 = clamp(b0.y + dy, 0, 1 - b0.h); y1 = y0 + b0.h;
      } else {
        if (dir.includes('w')) x0 = clamp(x0 + dx, 0, x1 - MIN_BOX);
        if (dir.includes('e')) x1 = clamp(x1 + dx, x0 + MIN_BOX, 1);
        if (dir.includes('n')) y0 = clamp(y0 + dy, 0, y1 - MIN_BOX);
        if (dir.includes('s')) y1 = clamp(y1 + dy, y0 + MIN_BOX, 1);
      }
      page.box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      placeBox(el, page);
      moved = true;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      state.active = j;
      if (moved) { page.manual = true; page.flag = null; }
      refreshSheet();
      commit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* Arrow keys: moves the selected area by (dx, dy), or resizes it from its right / bottom edge. */
  function nudge(dx, dy, resize) {
    const sheet = state.sheets[state.cur], page = sheet && sheet.pages[state.active];
    if (!page) return;
    const b = page.box;
    if (resize) {
      b.w = clamp(b.w + dx, MIN_BOX, 1 - b.x);
      b.h = clamp(b.h + dy, MIN_BOX, 1 - b.y);
    } else {
      b.x = clamp(b.x + dx, 0, 1 - b.w);
      b.y = clamp(b.y + dy, 0, 1 - b.h);
    }
    page.manual = true;
    if (page.flag === 'review') page.flag = null;
    refreshSheet();
    commit('nudge');
  }

  function setSheetLayout(count) {
    const sheet = state.sheets[state.cur];
    if (!sheet || sheet.pages.length === count) return;
    const angle = sheet.pages.reduce((sum, p) => sum + (p.angle || 0), 0) / sheet.pages.length;
    let boxes;
    if (count === 1) {
      const [a, b] = sheet.pages.map((p) => p.box);
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      boxes = [{ x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }];
      sheet.split = null;
    } else {
      const b = sheet.pages[0].box;
      sheet.split = $('layoutSel').value === '2v' ? 'v' : 'h';
      boxes = sheet.split === 'v'
        ? [{ ...b, h: b.h / 2 }, { ...b, y: b.y + b.h / 2, h: b.h / 2 }]
        : [{ ...b, w: b.w / 2 }, { ...b, x: b.x + b.w / 2, w: b.w / 2 }];
    }
    sheet.pages = boxes.map((box) => ({ box, angle, flag: null, include: true, manual: true }));
    state.active = 0;
    refreshSheet();
    commit();
  }

  function resetSheet() {
    const sheet = state.sheets[state.cur];
    sheet.pages = clonePages(sheet.auto);
    sheet.split = sheet.autoSplit;
    state.active = 0;
    refreshSheet();
    commit();
  }

  /* Hand-set tilt of the selected page. */
  function setAngle() {
    const sheet = state.sheets[state.cur], page = sheet && sheet.pages[state.active];
    if (!page) return;
    page.angle = clamp(+$('angle').value || 0, -15, 15);
    page.manual = true;
    placeBox($('overlay').children[state.active], page);
    drawThumb(state.cur);
    schedulePreview();
    commit('angle');
  }

  /* Copies the current sheet's areas to other sheets; skipped pages stay skipped.
   * scope: 'all' | 'after' (this sheet onwards) | 'left' | 'right' (one side of every two-page sheet). */
  function applyAreas(scope) {
    const src = state.sheets[state.cur];
    if (!src || !scope) return;
    const side = scope === 'left' ? 0 : scope === 'right' ? 1 : -1;
    if (side >= 0 && src.pages.length !== 2) { $('flagNote').textContent = t('needTwoPages'); return; }
    state.sheets.forEach((sheet, i) => {
      if (sheet === src || (scope === 'after' && i < state.cur)) return;
      if (side >= 0) {
        if (sheet.pages.length !== 2 || sheet.split !== src.split) return;
        const page = sheet.pages[side];
        page.box = { ...src.pages[side].box };
        page.manual = true;
        if (page.flag === 'review') page.flag = null;
      } else {
        const same = sheet.pages.length === src.pages.length;
        sheet.pages = src.pages.map((p, j) => ({
          box: { ...p.box }, flag: null, manual: true,
          angle: same ? sheet.pages[j].angle : 0,   // tilt belongs to each scan, not to the area
          include: same ? sheet.pages[j].include : true,
        }));
        sheet.split = src.split;
      }
      drawThumb(i);
    });
    refreshSheet();
    commit();
  }

  /* ---------- page organiser ---------- */

  /* Stores a rearranged output list; back to automatic when it matches the natural order. */
  function setOrder(list) {
    const keys = list.map((o) => o.key), natural = naturalList().map((o) => o.key);
    state.order = keys.length === natural.length && keys.every((k, n) => k === natural[n]) ? null : keys;
    renderOrganiser();
    refreshSheet();
    commit();
  }

  function renderOrganiser() {
    const grid = $('orgGrid'), list = outputList();
    const rtl = document.documentElement.dir === 'rtl';
    grid.textContent = '';
    list.forEach((o, n) => {
      const tile = document.createElement('div');
      tile.className = 'tile' + (o.blank ? ' blank' : '');
      tile.draggable = true;

      const canvas = document.createElement('canvas');
      canvas.width = 120;
      if (o.blank) {
        canvas.height = 170;
      } else {
        const sheet = state.sheets[o.i], b = sheet.pages[o.j].box, th = sheet.thumb;
        canvas.height = Math.round(120 * (b.h * sheet.hPt) / (b.w * sheet.wPt));
        canvas.getContext('2d').drawImage(th, b.x * th.width, b.y * th.height, b.w * th.width, b.h * th.height, 0, 0, canvas.width, canvas.height);
      }
      const label = document.createElement('span');
      label.className = 'num';
      label.textContent = (n + 1) + (o.blank ? ' · ' + t('blank') : '');

      const tools = document.createElement('div');
      tools.className = 'tools';
      const button = (text, title, disabled, action) => {
        const b = document.createElement('button');
        b.textContent = text;
        b.title = title;
        b.disabled = disabled;
        b.addEventListener('click', action);
        tools.append(b);
      };
      const moveTo = (to) => { const next = list.slice(); next.splice(to, 0, next.splice(n, 1)[0]); setOrder(next); };
      button(rtl ? '▶' : '◀', t('moveEarlier'), n === 0, () => moveTo(n - 1));
      button(rtl ? '◀' : '▶', t('moveLater'), n === list.length - 1, () => moveTo(n + 1));
      button('＋', t('insertBlank'), false, () => {
        const next = list.slice();
        next.splice(n + 1, 0, { blank: true, key: 'b' + (++state.blankSeq) });
        setOrder(next);
      });
      button('✕', t('removePage'), false, () => {
        if (!o.blank) { state.sheets[o.i].pages[o.j].include = false; drawThumb(o.i); }
        setOrder(list.filter((x) => x !== o));
      });

      tile.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(n)); e.dataTransfer.effectAllowed = 'move'; });
      tile.addEventListener('dragover', (e) => { e.preventDefault(); tile.classList.add('over'); });
      tile.addEventListener('dragleave', () => tile.classList.remove('over'));
      tile.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const from = Number(e.dataTransfer.getData('text/plain'));
        if (Number.isInteger(from) && from !== n) { const next = list.slice(); next.splice(n, 0, next.splice(from, 1)[0]); setOrder(next); }
      });
      tile.append(canvas, label, tools);
      grid.append(tile);
    });
  }

  /* ---------- output settings ---------- */

  function settings() {
    return {
      paper: $('paper').value, cw: +$('cw').value || 210, ch: +$('ch').value || 297,
      landscape: $('orient').value === 'landscape',
      margin: Math.max(0, +$('margin').value || 0),
      scaling: $('scaling').value, mode: $('mode').value, dpi: +$('dpi').value,
      autoThr: $('autoThr').checked, thr: +$('thr').value, quality: +$('quality').value / 100,
      clean: $('clean').checked,
    };
  }

  function updateSettingsUI() {
    const s = settings();
    $('customRow').hidden = s.paper !== 'custom';
    $('bwRow').hidden = s.mode !== 'bw';
    $('qRow').hidden = s.mode === 'bw';
    $('thr').disabled = s.autoThr;
    $('thrOut').textContent = s.autoThr ? t('auto') : s.thr;
    $('qOut').textContent = $('quality').value;
    if (!state.nameEdited && state.baseName) {
      $('outName').value = `${state.baseName}_${s.paper === 'custom' ? 'formatted' : s.paper}.pdf`;
    }
    try {
      const saved = {};
      for (const id of PERSISTED) saved[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value;
      localStorage.setItem('easyscan2pdf-settings', JSON.stringify(saved));
    } catch (e) { /* storage unavailable: settings just don't persist */ }
    schedulePreview();
  }

  function restoreSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('easyscan2pdf-settings') || '{}');
      for (const id of PERSISTED) {
        if (!(id in saved)) continue;
        if ($(id).type === 'checkbox') $(id).checked = !!saved[id]; else $(id).value = saved[id];
      }
    } catch (e) { /* ignore unreadable settings */ }
  }

  /* Output page geometry in points, plus the scale shared by all pages. */
  function geometry(s) {
    const [a, b] = s.paper === 'custom' ? [s.cw, s.ch] : PAPER[s.paper];
    const PW = (s.landscape ? Math.max(a, b) : Math.min(a, b)) * MM;
    const PH = (s.landscape ? Math.min(a, b) : Math.max(a, b)) * MM;
    const m = Math.min(s.margin * MM, Math.min(PW, PH) * 0.45);
    const availW = PW - 2 * m, availH = PH - 2 * m;
    let maxW = 1, maxH = 1;
    for (const o of naturalList()) {
      const sheet = state.sheets[o.i], box = sheet.pages[o.j].box;
      maxW = Math.max(maxW, box.w * sheet.wPt);
      maxH = Math.max(maxH, box.h * sheet.hPt);
    }
    return { PW, PH, m, availW, availH, common: Math.min(availW / maxW, availH / maxH), scaling: s.scaling };
  }

  /* Where a page lands on the output sheet (points, origin top-left). */
  function place(sheet, page, g) {
    const cw = page.box.w * sheet.wPt, ch = page.box.h * sheet.hPt;
    const fit = Math.min(g.availW / cw, g.availH / ch);
    const scale = g.scaling === 'each' ? fit : Math.min(fit, g.scaling === 'original' ? 1 : g.common);
    const w = cw * scale, h = ch * scale;
    return { x: (g.PW - w) / 2, y: (g.PH - h) / 2, w, h, scale };
  }

  /* Page numbers typed as "1-10, 15" -> zero-based indices; all pages when empty; null when not understood. */
  function parseRange(text, total) {
    const clean = text.replace(/\s*[-–]\s*/g, '-').trim();
    if (!clean) return Array.from({ length: total }, (v, n) => n);
    const out = [];
    for (const part of clean.split(/[,;\s]+/).filter(Boolean)) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(part);
      if (!m) return null;
      const a = Number(m[1]), b = Math.min(total, m[2] ? Number(m[2]) : a);
      if (a < 1 || a > total || b < a) return null;
      for (let n = a; n <= b; n++) out.push(n - 1);
    }
    return out;
  }

  /* ---------- preview ---------- */

  let previewTimer = 0, previewToken = 0;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 150);
  }

  async function renderPreview() {
    const sheet = state.sheets[state.cur], page = sheet && sheet.pages[state.active];
    if (!page) return;
    const token = ++previewToken, s = settings(), g = geometry(s), k = PREVIEW_DPI / 72;
    const pl = place(sheet, page, g);
    let canvas;
    try {
      canvas = await renderRegion(state.cur, page.box, Math.max(1, Math.round(pl.w * k)), Math.max(1, Math.round(pl.h * k)), angleOf(page));
    } catch (e) { return; }
    if (token !== previewToken) return;
    applyTone(canvas, s, k * pl.scale);

    const out = $('preview'), ctx = out.getContext('2d');
    out.width = Math.round(g.PW * k);
    out.height = Math.round(g.PH * k);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, Math.round(pl.x * k), Math.round(pl.y * k));
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(31, 111, 235, .45)';
    ctx.strokeRect(g.m * k, g.m * k, g.availW * k, g.availH * k);

    const list = outputList(), n = list.findIndex((o) => o.i === state.cur && o.j === state.active);
    $('previewInfo').textContent = (n < 0 ? t('previewSkipped') : t('previewPage', { n: n + 1, total: list.length }))
      + ' · ' + t('scale', { pct: Math.round(pl.scale * 100) });
  }

  /* ---------- export ---------- */

  const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

  /* Builds a document from the given output pages (all of them by default) and returns its bytes. */
  async function buildPdf(s, onProgress, list = outputList()) {
    const { PDFDocument, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = PDFLib;
    const doc = await PDFDocument.create();
    doc.setCreator('EasyScan2PDF');
    const g = geometry(s), k = s.dpi / 72;

    for (let n = 0; n < list.length; n++) {
      if (state.cancel) throw new DOMException('Cancelled', 'AbortError');
      const out = doc.addPage([g.PW, g.PH]);
      if (list[n].blank) { onProgress(n + 1, list.length); continue; }
      const sheet = state.sheets[list[n].i], page = sheet.pages[list[n].j];
      const pl = place(sheet, page, g);
      const pxW = Math.max(1, Math.round(pl.w * k)), pxH = Math.max(1, Math.round(pl.h * k));
      const canvas = await renderRegion(list[n].i, page.box, pxW, pxH, angleOf(page));
      const img = applyTone(canvas, s, k * pl.scale);
      const y = g.PH - pl.y - pl.h;   // PDF origin is bottom-left

      if (img) {
        // Black & white: 1 bit per pixel, far smaller than JPEG and sharper for text.
        const rowBytes = (pxW + 7) >> 3, bits = new Uint8Array(rowBytes * pxH), d = img.data;
        for (let py = 0; py < pxH; py++) {
          for (let px = 0; px < pxW; px++) {
            if (d[(py * pxW + px) * 4]) bits[py * rowBytes + (px >> 3)] |= 0x80 >> (px & 7);
          }
        }
        const stream = doc.context.flateStream(bits, {
          Type: 'XObject', Subtype: 'Image', Width: pxW, Height: pxH, ColorSpace: 'DeviceGray', BitsPerComponent: 1,
        });
        const name = out.node.newXObject('Im', doc.context.register(stream));
        out.pushOperators(pushGraphicsState(), concatTransformationMatrix(pl.w, 0, 0, pl.h, pl.x, y), drawObject(name), popGraphicsState());
      } else {
        const blob = await toBlob(canvas, 'image/jpeg', s.quality);
        const jpg = await doc.embedJpg(await blob.arrayBuffer());
        out.drawImage(jpg, { x: pl.x, y, width: pl.w, height: pl.h });
      }
      canvas.width = canvas.height = 0;
      onProgress(n + 1, list.length);
    }
    return doc.save();
  }

  function download(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function writeTo(handle, bytes) {
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
  }

  async function exportPdf() {
    if (state.busy) return;
    const all = outputList(), picked = parseRange($('range').value, all.length);
    if (!picked) { status(t('badRange')); return; }
    const list = picked.map((n) => all[n]);
    if (!list.length) return;

    let name = ($('outName').value.trim() || 'formatted').replace(/[\\/:*?"<>|]/g, '_');
    if (!/\.pdf$/i.test(name)) name += '.pdf';

    // One file, or several of a fixed number of pages.
    const per = Math.max(0, Math.floor(+$('splitN').value || 0));
    const parts = [];
    if (per > 0 && list.length > per) for (let k = 0; k < list.length; k += per) parts.push(list.slice(k, k + per));
    else parts.push(list);
    const digits = String(parts.length).length;
    const names = parts.length === 1 ? [name]
      : parts.map((p, k) => `${name.replace(/\.pdf$/i, '')}_${String(k + 1).padStart(digits, '0')}.pdf`);

    // Ask where to save first: the pickers need the click that started the export.
    let file = null, folder = null;
    try {
      if (parts.length > 1 && window.showDirectoryPicker) folder = await window.showDirectoryPicker({ mode: 'readwrite' });
      else if (parts.length === 1 && window.showSaveFilePicker) {
        file = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
    }

    setBusy(true);
    state.cancel = false;
    $('cancelBtn').hidden = false;
    $('progress').hidden = false;
    $('progress').value = 0;
    try {
      const s = settings();
      let done = 0, size = 0;
      for (let k = 0; k < parts.length; k++) {
        const bytes = await buildPdf(s, (n) => {
          $('progress').value = (done + n) / list.length;
          status(t('creating', { i: done + n, n: list.length }));
        }, parts[k]);
        done += parts[k].length;
        size += bytes.length;
        if (folder) await writeTo(await folder.getFileHandle(names[k], { create: true }), bytes);
        else if (file) await writeTo(file, bytes);
        else download(bytes, names[k]);
      }
      const mb = (size / 1048576).toFixed(1);
      status(parts.length === 1 ? t('saved', { name: file ? file.name : name, mb }) : t('savedParts', { n: parts.length, mb }));
    } catch (err) {
      status(err.name === 'AbortError' ? t('cancelled') : t('exportFailed', { msg: err.message }));
    } finally {
      $('cancelBtn').hidden = true;
      $('progress').hidden = true;
      setBusy(false);
    }
  }

  /* ---------- wiring ---------- */

  /* Opens a PDF, or a set of JPEG / PNG scans (one sheet per image, in name order). */
  async function openFiles(fileList) {
    const files = [...fileList];
    const pdf = files.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (pdf) return loadBytes(new Uint8Array(await pdf.arrayBuffer()), pdf.name);

    const images = files.filter((f) => /^image\/(jpeg|png)$/.test(f.type))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!images.length) { if (files.length) status(t('chooseFiles')); return; }
    if (state.busy) return;
    status(t('readingImages'));
    try {
      const doc = await PDFLib.PDFDocument.create(), k = 72 / IMAGE_DPI;
      for (const file of images) {
        const bytes = await file.arrayBuffer();
        const img = file.type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        doc.addPage([img.width * k, img.height * k]).drawImage(img, { x: 0, y: 0, width: img.width * k, height: img.height * k });
      }
      await loadBytes(await doc.save(), images.length === 1 ? images[0].name : 'scans');
    } catch (err) {
      status(t('cannotReadImages', { msg: err.message }));
    }
  }

  $('openBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });

  // File drops only: dragging tiles inside the page organiser is not a file drop.
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); $('stage').classList.add('drop'); } });
  window.addEventListener('dragleave', () => $('stage').classList.remove('drop'));
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    $('stage').classList.remove('drop');
    openFiles(e.dataTransfer.files);
  });

  /* A <select> used as a menu: runs the action, then shows its caption again. */
  const menu = (id, action) => $(id).addEventListener('change', () => { const value = $(id).value; $(id).value = ''; action(value); });

  $('layoutSel').addEventListener('change', () => { if (state.feats.length) applyAnalysis(); });
  $('prevBtn').addEventListener('click', () => showSheet(state.cur - 1));
  $('nextBtn').addEventListener('click', () => showSheet(state.cur + 1));
  $('oneBtn').addEventListener('click', () => setSheetLayout(1));
  $('twoBtn').addEventListener('click', () => setSheetLayout(2));
  $('resetBtn').addEventListener('click', resetSheet);
  menu('applySel', applyAreas);
  menu('rotateSel', rotateSheets);
  $('undoBtn').addEventListener('click', () => travel(-1));
  $('redoBtn').addEventListener('click', () => travel(1));
  $('zoomOutBtn').addEventListener('click', () => setZoom(state.zoom / 1.25));
  $('zoomInBtn').addEventListener('click', () => setZoom(state.zoom * 1.25));
  $('zoomBtn').addEventListener('click', () => setZoom(1));
  $('stage').addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !state.sheets.length) return;
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
  }, { passive: false });
  $('organiseBtn').addEventListener('click', () => { if (state.sheets.length) { renderOrganiser(); $('organiser').showModal(); } });
  $('orgClose').addEventListener('click', () => $('organiser').close());
  $('orgReset').addEventListener('click', () => setOrder(naturalList()));
  $('exportBtn').addEventListener('click', exportPdf);
  $('cancelBtn').addEventListener('click', () => { state.cancel = true; });
  $('outName').addEventListener('input', () => { state.nameEdited = true; });
  for (const id of PERSISTED) $(id).addEventListener('input', updateSettingsUI);
  for (const id of ['deskew', 'order']) $(id).addEventListener('input', () => { if (state.sheets.length) refreshSheet(); });
  $('angle').addEventListener('input', setAngle);

  window.addEventListener('keydown', (e) => {
    if (!state.sheets.length || $('organiser').open || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (mod && e.key.toLowerCase() === 'z') travel(e.shiftKey ? 1 : -1);
    else if (mod && e.key.toLowerCase() === 'y') travel(1);
    else if (e.key === 'PageUp') showSheet(state.cur - 1);
    else if (e.key === 'PageDown') showSheet(state.cur + 1);
    else if (arrows[e.key]) {
      // 0.1% of the sheet per press, 1% with Shift; Alt resizes instead of moving.
      const step = e.shiftKey ? 0.01 : 0.001;
      nudge(arrows[e.key][0] * step, arrows[e.key][1] * step, e.altKey);
    }
    else if (!mod && (e.key === '+' || e.key === '=')) setZoom(state.zoom * 1.25);
    else if (!mod && e.key === '-') setZoom(state.zoom / 1.25);
    else if (!mod && e.key === '0') setZoom(1);
    else return;
    e.preventDefault();
  });

  new ResizeObserver(fitStage).observe($('stage'));

  /* ---------- installable app and updates ---------- */

  $('version').textContent = `v${APP_VERSION.number} · ${APP_VERSION.date}`;

  // The service worker only caches the app's own files so it also works offline.
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }

  /* Fetches the newest app files and reloads. Without a service worker (page opened
   * straight from disk) a reload is all there is to do. */
  async function forceUpdate() {
    if (state.sheets.length && !confirm(t('updateConfirm'))) return;
    status(t('updating'));
    $('updateBtn').disabled = true;
    try {
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      if (reg) {
        await reg.update().catch(() => {});
        const pending = reg.installing || reg.waiting;
        if (pending) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 10000);
            pending.addEventListener('statechange', () => {
              if (pending.state === 'activated' || pending.state === 'redundant') { clearTimeout(timer); resolve(); }
            });
          });
        }
        if (reg.active) {
          await new Promise((resolve) => {
            const channel = new MessageChannel(), timer = setTimeout(resolve, 20000);
            channel.port1.onmessage = () => { clearTimeout(timer); resolve(); };
            reg.active.postMessage({ type: 'refresh' }, [channel.port2]);
          });
        }
      }
    } catch (e) { /* reload anyway */ }
    location.reload();
  }
  $('updateBtn').addEventListener('click', forceUpdate);

  let installEvent = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    $('installBtn').hidden = false;
  });
  window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; });
  $('installBtn').addEventListener('click', () => {
    if (installEvent) installEvent.prompt();
    installEvent = null;
    $('installBtn').hidden = true;
  });

  // "Open with EasyScan2PDF" from the file manager, once installed.
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (params.files && params.files.length) openFiles(await Promise.all(params.files.map((h) => h.getFile())));
    });
  }

  /* ---------- language and theme ---------- */

  function saveUi() {
    try {
      localStorage.setItem('easyscan2pdf-ui', JSON.stringify({ lang: $('lang').value, theme: $('theme').value }));
    } catch (e) { /* storage unavailable */ }
  }

  function setLanguage(code) {
    I18n.set(code);
    $('lang').value = I18n.lang;
    for (const option of $('dpi').options) option.textContent = t('dpi', { n: option.value });
    // "Previous" points towards the start of the line, which is the right in right-to-left languages.
    const rtl = document.documentElement.dir === 'rtl';
    $('prevBtn').textContent = rtl ? '▶' : '◀';
    $('nextBtn').textContent = rtl ? '◀' : '▶';
    updateSettingsUI();
    if (state.sheets.length) {
      state.sheets.forEach((sheet, i) => drawThumb(i));
      refreshSheet();
    } else {
      status('');
    }
  }

  function setTheme(theme) {
    $('theme').value = theme;
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }

  for (const [code, name] of Object.entries(I18n.names)) $('lang').add(new Option(name, code));
  $('lang').addEventListener('change', () => { setLanguage($('lang').value); saveUi(); });
  $('theme').addEventListener('change', () => { setTheme($('theme').value); saveUi(); });

  let ui = {};
  try { ui = JSON.parse(localStorage.getItem('easyscan2pdf-ui') || '{}'); } catch (e) { /* use defaults */ }

  restoreSettings();
  setTheme(['light', 'dark'].includes(ui.theme) ? ui.theme : 'auto');
  setLanguage(ui.lang || I18n.preferred());
  updateHistoryButtons();

  // Entry points for scripted use and tests.
  window.EasyScan2PDF = { state, loadBytes, buildPdf, settings, outputList };
})();
