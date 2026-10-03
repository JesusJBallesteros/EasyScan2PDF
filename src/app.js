/* EasyScan2PDF UI: load a scanned PDF, review the detected page areas, export. */
(function () {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const ANALYSIS_PX = 1400;   // longest side of the render used for detection
  const VIEW_PX = 1800;       // longest side of the editor render
  const THUMB_PX = 300;
  const PREVIEW_DPI = 100;
  const MIN_BOX = 0.03;       // smallest allowed area, fraction of the sheet
  const MM = 72 / 25.4;
  const FULL = { x: 0, y: 0, w: 1, h: 1 };
  const PAPER = { A4: [210, 297], A5: [148, 210], A3: [297, 420], B5: [176, 250], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };
  const PERSISTED = ['paper', 'cw', 'ch', 'orient', 'margin', 'scaling', 'mode', 'dpi', 'autoThr', 'thr', 'quality', 'deskew', 'order'];
  const IMAGE_DPI = 200;      // assumed resolution of scans opened as image files
  const DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const state = {
    pdf: null, baseName: '', nameEdited: false,
    feats: [], sheets: [],   // sheets[i] = { wPt, hPt, thumb, pages, auto }
    cur: 0, active: 0,
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
      const scale = pxW / (box.w * page.getViewport({ scale: 1 }).width);
      const viewport = page.getViewport({ scale });
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

  /* Converts a rendered canvas to greyscale or black & white in place. Returns the pixels for B/W. */
  function applyTone(canvas, s) {
    if (s.mode === 'color') return null;
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data, n = canvas.width * canvas.height, hist = new Uint32Array(256);
    for (let p = 0; p < n * 4; p += 4) {
      const g = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
      d[p] = d[p + 1] = d[p + 2] = g;
      hist[g]++;
    }
    if (s.mode === 'bw') {
      const thr = s.autoThr ? Detect.otsu(hist, n).thr : s.thr;
      for (let p = 0; p < n * 4; p += 4) d[p] = d[p + 1] = d[p + 2] = d[p] > thr ? 255 : 0;
    }
    ctx.putImageData(img, 0, 0);
    return s.mode === 'bw' ? img : null;
  }

  /* ---------- loading and analysis ---------- */

  function status(text) { $('status').textContent = text; }

  function setBusy(busy) {
    state.busy = busy;
    $('openBtn').disabled = busy;
    $('layoutSel').disabled = busy;
    $('exportBtn').disabled = busy || !state.sheets.length;
  }

  async function loadBytes(bytes, name) {
    if (state.busy) return;
    setBusy(true);
    status('Opening…');
    try {
      const pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
      if (state.pdf) state.pdf.destroy();
      state.pdf = pdf;
      state.baseName = name.replace(/\.(pdf|jpe?g|png)$/i, '');
      state.nameEdited = false;
      state.cur = state.active = 0;
      $('docName').textContent = name;
      await scan();
      $('empty').hidden = true;
      $('wrap').hidden = false;
      $('toolbar').hidden = false;
      applyAnalysis();
      updateSettingsUI();
    } catch (err) {
      status(err.name === 'PasswordException' ? 'This PDF is password protected.' : 'Could not open this file: ' + err.message);
    } finally {
      setBusy(false);
    }
  }

  /* Pass 1 over every sheet: detection features and thumbnails. */
  async function scan() {
    const n = state.pdf.numPages;
    state.feats = [];
    state.sheets = [];
    for (let i = 0; i < n; i++) {
      status(`Analysing sheet ${i + 1} of ${n}…`);
      const page = await state.pdf.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      const k = ANALYSIS_PX / Math.max(base.width, base.height);
      const canvas = await renderRegion(i, FULL, Math.round(base.width * k), Math.round(base.height * k));
      state.feats.push(Detect.extract(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)));
      const thumb = document.createElement('canvas');
      thumb.width = THUMB_PX;
      thumb.height = Math.round(THUMB_PX * base.height / base.width);
      thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
      state.sheets.push({ wPt: base.width, hPt: base.height, thumb, pages: [], auto: [] });
    }
  }

  const clonePages = (pages) => pages.map((p) => ({ ...p, box: { ...p.box } }));

  /* Pass 2: document-wide detection. Replaces all areas, including manual edits. */
  function applyAnalysis() {
    const result = Detect.analyze(state.feats, $('layoutSel').value);
    state.sheets.forEach((sheet, i) => {
      sheet.auto = result[i].pages.map((p) => ({ box: p.box, angle: p.angle, flag: p.flag, include: p.flag !== 'blank', manual: false }));
      sheet.autoSplit = result[i].split;
      sheet.pages = clonePages(sheet.auto);
      sheet.split = sheet.autoSplit;   // 'h' left | right, 'v' top | bottom, null single page
    });
    buildThumbs();
    showSheet(Math.min(state.cur, state.sheets.length - 1));
    updateSummary();
  }

  /* Included pages in reading order. */
  function outputList() {
    const list = [], rtl = $('order').value === 'rtl';
    state.sheets.forEach((sheet, i) => {
      const order = sheet.pages.map((p, j) => j);
      if (rtl && sheet.split === 'h') order.reverse();
      for (const j of order) if (sheet.pages[j].include) list.push({ i, j });
    });
    return list;
  }

  /* Tilt applied to a page: its detected or hand-set angle, unless straightening is off. */
  const angleOf = (page) => ($('deskew').checked ? page.angle || 0 : 0);

  function updateSummary() {
    const pages = outputList().length;
    const check = state.sheets.filter((s) => s.pages.some((p) => p.flag === 'review')).length;
    status(`${state.sheets.length} sheets → ${pages} pages` + (check ? ` · ${check} to check` : ''));
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
    dot.title = { review: 'Check this sheet', blank: 'Blank page', manual: 'Adjusted by hand', '': '' }[kind];
  }

  /* ---------- editor ---------- */

  let viewToken = 0;

  function showSheet(i) {
    if (!state.sheets.length) return;
    state.cur = clamp(i, 0, state.sheets.length - 1);
    const sheet = state.sheets[state.cur];
    state.active = Math.max(0, sheet.pages.findIndex((p) => p.include));

    [...$('thumbs').children].forEach((el, k) => el.classList.toggle('current', k === state.cur));
    $('thumbs').children[state.cur].scrollIntoView({ block: 'nearest' });

    // Show the thumbnail at once, then swap in the sharp render.
    const view = $('view'), token = ++viewToken, index = state.cur;
    view.width = sheet.thumb.width;
    view.height = sheet.thumb.height;
    view.getContext('2d').drawImage(sheet.thumb, 0, 0);
    const k = VIEW_PX / Math.max(sheet.wPt, sheet.hPt);
    renderRegion(index, FULL, Math.round(sheet.wPt * k), Math.round(sheet.hPt * k)).then((canvas) => {
      if (token !== viewToken) return;
      view.width = canvas.width;
      view.height = canvas.height;
      view.getContext('2d').drawImage(canvas, 0, 0);
    }, () => {});

    fitStage();
    refreshSheet();
  }

  function fitStage() {
    const sheet = state.sheets[state.cur];
    if (!sheet) return;
    const stage = $('stage'), aspect = sheet.wPt / sheet.hPt;
    // In the one-column layout the stage grows with the sheet instead of filling a fixed pane.
    const narrow = matchMedia('(max-width: 760px)').matches;
    const availW = stage.clientWidth - 40, availH = narrow ? innerHeight * 0.7 : stage.clientHeight - 40;
    const w = Math.max(50, Math.min(availW, availH * aspect));
    $('wrap').style.width = w + 'px';
    $('wrap').style.height = w / aspect + 'px';
  }

  /* Redraws everything that depends on the current sheet's areas. */
  function refreshSheet() {
    const sheet = state.sheets[state.cur];
    $('sheetLabel').textContent = `Sheet ${state.cur + 1} / ${state.sheets.length}`;
    $('prevBtn').disabled = state.cur === 0;
    $('nextBtn').disabled = state.cur === state.sheets.length - 1;
    $('oneBtn').classList.toggle('on', sheet.pages.length === 1);
    $('twoBtn').classList.toggle('on', sheet.pages.length === 2);
    $('flagNote').textContent = sheet.pages.some((p) => p.flag === 'review') ? 'Text found outside the common frame — check the areas'
      : sheet.pages.some((p) => p.flag === 'blank' && !p.include) ? 'Blank page skipped' : '';
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
      tag.title = 'Include this page in the output';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = p.include;
      check.addEventListener('change', () => { p.include = check.checked; state.active = j; refreshSheet(); });
      tag.append(check, p.include ? `Page ${number}` : 'Skipped');
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
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
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
  }

  function resetSheet() {
    const sheet = state.sheets[state.cur];
    sheet.pages = clonePages(sheet.auto);
    sheet.split = sheet.autoSplit;
    state.active = 0;
    refreshSheet();
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
  }

  /* Copies the current sheet's areas to every sheet; skipped pages stay skipped. */
  function applyToAll() {
    const src = state.sheets[state.cur];
    state.sheets.forEach((sheet, i) => {
      if (sheet === src) return;
      const same = sheet.pages.length === src.pages.length;
      sheet.pages = src.pages.map((p, j) => ({
        box: { ...p.box }, flag: null, manual: true,
        angle: same ? sheet.pages[j].angle : 0,   // tilt belongs to each scan, not to the area
        include: same ? sheet.pages[j].include : true,
      }));
      sheet.split = src.split;
      drawThumb(i);
    });
    refreshSheet();
  }

  /* ---------- output settings ---------- */

  function settings() {
    return {
      paper: $('paper').value, cw: +$('cw').value || 210, ch: +$('ch').value || 297,
      landscape: $('orient').value === 'landscape',
      margin: Math.max(0, +$('margin').value || 0),
      scaling: $('scaling').value, mode: $('mode').value, dpi: +$('dpi').value,
      autoThr: $('autoThr').checked, thr: +$('thr').value, quality: +$('quality').value / 100,
    };
  }

  function updateSettingsUI() {
    const s = settings();
    $('customRow').hidden = s.paper !== 'custom';
    $('bwRow').hidden = s.mode !== 'bw';
    $('qRow').hidden = s.mode === 'bw';
    $('thr').disabled = s.autoThr;
    $('thrOut').textContent = s.autoThr ? 'auto' : s.thr;
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
    for (const { i, j } of outputList()) {
      const sheet = state.sheets[i], box = sheet.pages[j].box;
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
    applyTone(canvas, s);

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
    $('previewInfo').textContent = (n < 0 ? 'Skipped page' : `Page ${n + 1} of ${list.length}`) + ` · scale ${Math.round(pl.scale * 100)}%`;
  }

  /* ---------- export ---------- */

  const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

  /* Builds the output document and returns its bytes. */
  async function buildPdf(s, onProgress) {
    const { PDFDocument, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = PDFLib;
    const doc = await PDFDocument.create();
    doc.setCreator('EasyScan2PDF');
    const g = geometry(s), list = outputList(), k = s.dpi / 72;

    for (let n = 0; n < list.length; n++) {
      if (state.cancel) throw new DOMException('Cancelled', 'AbortError');
      const sheet = state.sheets[list[n].i], page = sheet.pages[list[n].j];
      const pl = place(sheet, page, g);
      const pxW = Math.max(1, Math.round(pl.w * k)), pxH = Math.max(1, Math.round(pl.h * k));
      const canvas = await renderRegion(list[n].i, page.box, pxW, pxH, angleOf(page));
      const img = applyTone(canvas, s);
      const out = doc.addPage([g.PW, g.PH]);
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

  async function exportPdf() {
    if (state.busy || !outputList().length) return;
    let name = ($('outName').value.trim() || 'formatted').replace(/[\\/:*?"<>|]/g, '_');
    if (!/\.pdf$/i.test(name)) name += '.pdf';

    // Ask where to save first: the file picker needs the click that started the export.
    let handle = null;
    if (window.showSaveFilePicker) {
      try {
        handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }

    setBusy(true);
    state.cancel = false;
    $('cancelBtn').hidden = false;
    $('progress').hidden = false;
    $('progress').value = 0;
    try {
      const bytes = await buildPdf(settings(), (done, total) => {
        $('progress').value = done / total;
        status(`Creating page ${done} of ${total}…`);
      });
      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
      } else {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
      status(`Saved ${handle ? handle.name : name} · ${(bytes.length / 1048576).toFixed(1)} MB`);
    } catch (err) {
      status(err.name === 'AbortError' ? 'Export cancelled.' : 'Export failed: ' + err.message);
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
    if (!images.length) { if (files.length) status('Choose a PDF, or JPEG / PNG images.'); return; }
    if (state.busy) return;
    status('Reading images…');
    try {
      const doc = await PDFLib.PDFDocument.create(), k = 72 / IMAGE_DPI;
      for (const file of images) {
        const bytes = await file.arrayBuffer();
        const img = file.type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        doc.addPage([img.width * k, img.height * k]).drawImage(img, { x: 0, y: 0, width: img.width * k, height: img.height * k });
      }
      await loadBytes(await doc.save(), images.length === 1 ? images[0].name : 'scans');
    } catch (err) {
      status('Could not read these images: ' + err.message);
    }
  }

  $('openBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });

  window.addEventListener('dragover', (e) => { e.preventDefault(); $('stage').classList.add('drop'); });
  window.addEventListener('dragleave', () => $('stage').classList.remove('drop'));
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    $('stage').classList.remove('drop');
    openFiles(e.dataTransfer.files);
  });

  $('layoutSel').addEventListener('change', () => { if (state.feats.length) applyAnalysis(); });
  $('prevBtn').addEventListener('click', () => showSheet(state.cur - 1));
  $('nextBtn').addEventListener('click', () => showSheet(state.cur + 1));
  $('oneBtn').addEventListener('click', () => setSheetLayout(1));
  $('twoBtn').addEventListener('click', () => setSheetLayout(2));
  $('resetBtn').addEventListener('click', resetSheet);
  $('applyAllBtn').addEventListener('click', applyToAll);
  $('exportBtn').addEventListener('click', exportPdf);
  $('cancelBtn').addEventListener('click', () => { state.cancel = true; });
  $('outName').addEventListener('input', () => { state.nameEdited = true; });
  for (const id of PERSISTED) $(id).addEventListener('input', updateSettingsUI);
  for (const id of ['deskew', 'order']) $(id).addEventListener('input', () => { if (state.sheets.length) refreshSheet(); });
  $('angle').addEventListener('input', setAngle);

  window.addEventListener('keydown', (e) => {
    if (!state.sheets.length || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { showSheet(state.cur - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { showSheet(state.cur + 1); e.preventDefault(); }
  });

  new ResizeObserver(fitStage).observe($('stage'));

  /* ---------- installable app ---------- */

  // The service worker only caches the app's own files so it also works offline.
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

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

  restoreSettings();
  updateSettingsUI();

  // Entry points for scripted use and tests.
  window.EasyScan2PDF = { state, loadBytes, buildPdf, settings };
})();
