/* Page-area detection for scanned sheets.
 *
 * Two passes:
 *   1. extract(imageData)      per sheet: ink mask + normalised column profile
 *   2. analyze(features, mode) whole document: gutter, per-page text boxes and
 *                              a common frame shared by all left / right pages
 *
 * No DOM access; boxes are returned normalised to the sheet (0..1).
 */
(function (global) {
  'use strict';

  const BINS = 512;          // resolution of the document-wide column profile
  const PAD = 0.012;         // padding around the text frame, fraction of sheet height
  const TOLERANCE = 0.012;   // how far text may exceed the common frame before a sheet is flagged

  /* Otsu threshold. Returns the threshold and the distance between class means. */
  function otsu(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = -1, thr = 127, contrast = 0;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; contrast = mF - mB; }
    }
    return { thr, contrast };
  }

  /* Clears dark blobs connected to the image edge (scanner borders, binding shadow). */
  function removeEdgeBlobs(mask, W, H) {
    const stack = new Int32Array(W * H);
    let top = 0;
    const push = (i) => { if (mask[i]) { mask[i] = 0; stack[top++] = i; } };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (top > 0) {
      const i = stack[--top], x = i % W;
      if (x > 0) push(i - 1);
      if (x < W - 1) push(i + 1);
      if (i >= W) push(i - W);
      if (i < W * (H - 1)) push(i + W);
    }
  }

  function pack(mask) {
    const bits = new Uint8Array(Math.ceil(mask.length / 8));
    for (let i = 0; i < mask.length; i++) if (mask[i]) bits[i >> 3] |= 1 << (i & 7);
    return bits;
  }

  function unpack(bits, n) {
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = (bits[i >> 3] >> (i & 7)) & 1;
    return mask;
  }

  function colCounts(mask, W, x0, x1, y0, y1) {
    const c = new Uint32Array(x1 - x0);
    for (let y = y0; y < y1; y++) {
      const row = y * W;
      for (let x = x0; x < x1; x++) c[x - x0] += mask[row + x];
    }
    return c;
  }

  function rowCounts(mask, W, x0, x1, y0, y1) {
    const c = new Uint32Array(y1 - y0);
    for (let y = y0; y < y1; y++) {
      const row = y * W;
      let s = 0;
      for (let x = x0; x < x1; x++) s += mask[row + x];
      c[y - y0] = s;
    }
    return c;
  }

  /* Pass 1: reduce a rendered sheet to what the document pass needs. */
  function extract(img) {
    const W = img.width, H = img.height, d = img.data, n = W * H;
    const gray = new Uint8Array(n), hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const g = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
      gray[i] = g;
      hist[g]++;
    }
    const { thr, contrast } = otsu(hist, n);
    const mask = new Uint8Array(n);
    if (contrast >= 50) {
      for (let i = 0; i < n; i++) mask[i] = gray[i] <= thr ? 1 : 0;
      removeEdgeBlobs(mask, W, H);
    }
    const cols = colCounts(mask, W, 0, W, 0, H);
    const prof = new Float32Array(BINS);
    for (let x = 0; x < W; x++) prof[Math.min(BINS - 1, Math.floor(x * BINS / W))] += cols[x];
    const perBin = (W / BINS) * H;
    for (let b = 0; b < BINS; b++) prof[b] /= perBin;
    // Row profile, used when sheets are split top | bottom.
    const rows = rowCounts(mask, W, 0, W, 0, H);
    const profV = new Float32Array(BINS);
    for (let y = 0; y < H; y++) profV[Math.min(BINS - 1, Math.floor(y * BINS / H))] += rows[y];
    for (let b = 0; b < BINS; b++) profV[b] /= (H / BINS) * W;
    return { W, H, bits: pack(mask), prof, profV };
  }

  /* Swaps rows and columns: the result is H wide and W tall. */
  function transpose(mask, W, H) {
    const t = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) t[x * H + y] = mask[y * W + x];
    return t;
  }

  /* Tilt of the text inside box (normalised), in degrees clockwise; 0 when unsure.
   * Text lines are sharpest in the row histogram when sheared by their own slope. */
  function skew(mask, W, H, box) {
    const x0 = Math.floor(box.x0 * W), x1 = Math.ceil(box.x1 * W), y0 = Math.floor(box.y0 * H), y1 = Math.ceil(box.y1 * H);
    let ink = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) ink += mask[y * W + x];
    if (ink < 200) return 0;
    const stride = Math.ceil(ink / 30000), n = Math.floor(ink / stride);
    const px = new Float32Array(n), py = new Float32Array(n), cx = (x0 + x1) / 2;
    let seen = 0, k = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (mask[y * W + x] && seen++ % stride === 0 && k < n) { px[k] = x - cx; py[k] = y - y0; k++; }
      }
    }
    const margin = Math.ceil((x1 - x0) * 0.06) + 2, hist = new Uint32Array(y1 - y0 + 2 * margin);
    const sharpness = (deg) => {
      const t = Math.tan(deg * Math.PI / 180);
      hist.fill(0);
      for (let i = 0; i < k; i++) hist[Math.round(py[i] - px[i] * t) + margin]++;
      let s = 0;
      for (let i = 0; i < hist.length; i++) s += hist[i] * hist[i];
      return s;
    };
    const flat = sharpness(0);
    let best = 0, bestScore = flat;
    const search = (from, to, step) => {
      for (let a = from; a <= to + 1e-9; a += step) {
        const s = sharpness(a);
        if (s > bestScore) { bestScore = s; best = a; }
      }
    };
    search(-6, 6, 0.5);
    search(best - 0.45, best + 0.45, 0.05);
    return bestScore > flat * 1.05 && Math.abs(best) >= 0.1 ? Math.round(best * 100) / 100 : 0;
  }

  function percentile(values, p) {
    const s = Array.from(values).sort((a, b) => a - b);
    if (!s.length) return 0;
    return s[Math.round(p * (s.length - 1))];
  }

  /* Runs of consecutive indices in [from, to) satisfying test(i). */
  function runs(from, to, test) {
    const out = [];
    let start = -1;
    for (let i = from; i <= to; i++) {
      const ok = i < to && test(i);
      if (ok && start < 0) start = i;
      if (!ok && start >= 0) { out.push([start, i]); start = -1; }
    }
    return out;
  }

  /* Document-wide gutter position (0..1), or null when sheets hold a single page. */
  function findGutter(feats, mode) {
    if (mode === '1') return null;
    const wide = feats.filter((f) => f.W / f.H > 1.15);
    if (mode !== '2' && wide.length * 2 < feats.length) return null;
    const src = wide.length ? wide : feats;

    const agg = new Float32Array(BINS);
    for (const f of src) for (let b = 0; b < BINS; b++) agg[b] += f.prof[b] / src.length;
    const smooth = new Float32Array(BINS);
    for (let b = 0; b < BINS; b++) {
      let s = 0, c = 0;
      for (let k = -2; k <= 2; k++) if (b + k >= 0 && b + k < BINS) { s += agg[b + k]; c++; }
      smooth[b] = s / c;
    }

    const ref = percentile(smooth, 0.75);
    const lo = Math.floor(BINS * 0.3), hi = Math.ceil(BINS * 0.7);
    let best = null;
    if (ref > 0) {
      for (const r of runs(lo, hi, (b) => smooth[b] < ref * 0.15)) {
        if (!best || r[1] - r[0] > best[1] - best[0]) best = r;
      }
    }
    if (best && best[1] - best[0] >= 4) return (best[0] + best[1]) / 2 / BINS;

    // No clean white valley: fall back to the emptiest column near the centre.
    if (mode === '2' || percentile(src.map((f) => f.W / f.H), 0.5) > 1.25) {
      let min = Infinity, at = BINS / 2;
      for (let b = Math.floor(BINS * 0.4); b < Math.ceil(BINS * 0.6); b++) {
        if (smooth[b] < min) { min = smooth[b]; at = b; }
      }
      return (at + 0.5) / BINS;
    }
    return null;
  }

  /* Refines the document gutter on one sheet: centre of the nearest empty band. */
  function sheetGutter(mask, W, H, gutter) {
    const cols = colCounts(mask, W, 0, W, 0, H);
    const gx = Math.round(gutter * W), win = Math.round(W * 0.06);
    const limit = Math.max(1, H * 0.002);
    let best = null, bestDist = Infinity;
    for (const r of runs(Math.max(0, gx - win), Math.min(W, gx + win), (x) => cols[x] <= limit)) {
      const dist = gx < r[0] ? r[0] - gx : gx >= r[1] ? gx - r[1] + 1 : 0;
      if (dist < bestDist || (dist === bestDist && r[1] - r[0] > best[1] - best[0])) { best = r; bestDist = dist; }
    }
    return best ? (best[0] + best[1]) / 2 / W : gutter;
  }

  /* First-to-last extent of the runs where counts stay above thr, ignoring specks. */
  function activeSpan(counts, thr, minRun) {
    const kept = runs(0, counts.length, (i) => counts[i] >= thr).filter((r) => r[1] - r[0] >= minRun);
    return kept.length ? [kept[0][0], kept[kept.length - 1][1]] : null;
  }

  /* Bounding box of the text between columns x0 and x1, in pixels. */
  function contentBox(mask, W, H, x0, x1) {
    if (x1 - x0 < 8) return null;
    const minRun = Math.max(3, Math.round(Math.max(W, H) * 0.003));
    const xs = activeSpan(colCounts(mask, W, x0, x1, 0, H), Math.max(2, H * 0.003), minRun);
    if (!xs) return null;
    const ys = activeSpan(rowCounts(mask, W, x0 + xs[0], x0 + xs[1], 0, H), Math.max(2, (xs[1] - xs[0]) * 0.004), minRun);
    if (!ys) return null;
    const xs2 = activeSpan(colCounts(mask, W, x0, x1, ys[0], ys[1]), Math.max(2, (ys[1] - ys[0]) * 0.003), minRun) || xs;
    const box = { x0: (x0 + xs2[0]) / W, x1: (x0 + xs2[1]) / W, y0: ys[0] / H, y1: ys[1] / H };
    return (box.x1 - box.x0) * (box.y1 - box.y0) < 0.005 ? null : box;
  }

  /* Frame that holds the text of nearly every page in a slot; robust to a few odd sheets. */
  function consensus(boxes) {
    if (!boxes.length) return null;
    const p = boxes.length < 5 ? 0 : 0.15;
    return {
      x0: percentile(boxes.map((b) => b.x0), p),
      y0: percentile(boxes.map((b) => b.y0), p),
      x1: percentile(boxes.map((b) => b.x1), 1 - p),
      y1: percentile(boxes.map((b) => b.y1), 1 - p),
    };
  }

  function finalize(frame, own, minX, maxX, padX, padY) {
    let b = { x0: frame.x0 - padX, y0: frame.y0 - padY, x1: frame.x1 + padX, y1: frame.y1 + padY };
    let flag = null;
    if (!own) {
      flag = 'blank';
    } else if (own.x0 < b.x0 - TOLERANCE || own.y0 < b.y0 - TOLERANCE || own.x1 > b.x1 + TOLERANCE || own.y1 > b.y1 + TOLERANCE) {
      b = {
        x0: Math.min(b.x0, own.x0 - padX), y0: Math.min(b.y0, own.y0 - padY),
        x1: Math.max(b.x1, own.x1 + padX), y1: Math.max(b.y1, own.y1 + padY),
      };
      flag = 'review';
    }
    b.x0 = Math.max(minX, b.x0); b.x1 = Math.min(maxX, b.x1);
    b.y0 = Math.max(0, b.y0); b.y1 = Math.min(1, b.y1);
    return { box: { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 }, flag };
  }

  /* Pass 2. mode: 'auto' | '1' | '2' (left | right) | '2v' (top | bottom).
   * Top | bottom sheets are analysed transposed, so the same code handles both splits. */
  function analyze(feats, mode) {
    const vertical = mode === '2v';
    const forced = mode === '2' || vertical;
    const flip = (b) => ({ x0: b.y0, x1: b.y1, y0: b.x0, y1: b.x1 });
    const src = feats;
    feats = vertical ? src.map((f) => ({ W: f.H, H: f.W, prof: f.profV })) : src;

    const gutter = findGutter(feats, vertical ? '2' : mode);
    const sheets = feats.map((f, i) => {
      const twoUp = gutter !== null && (forced || f.W / f.H > 1.15);
      const original = unpack(src[i].bits, f.W * f.H);
      const mask = vertical ? transpose(original, src[i].W, src[i].H) : original;
      const s = { twoUp };
      if (twoUp) {
        s.gutter = sheetGutter(mask, f.W, f.H, gutter);
        const gx = Math.round(s.gutter * f.W);
        s.own = [contentBox(mask, f.W, f.H, 0, gx), contentBox(mask, f.W, f.H, gx, f.W)];
      } else {
        s.own = [contentBox(mask, f.W, f.H, 0, f.W)];
      }
      s.angles = s.own.map((b) => b ? skew(original, src[i].W, src[i].H, vertical ? flip(b) : b) : 0);
      return s;
    });

    const collect = (two, slot) => sheets.filter((s) => s.twoUp === two && s.own[slot]).map((s) => s.own[slot]);
    const frames = { S: consensus(collect(false, 0)), L: consensus(collect(true, 0)), R: consensus(collect(true, 1)) };

    // Left and right pages of a book share one frame size.
    if (frames.L && frames.R) {
      const y0 = Math.min(frames.L.y0, frames.R.y0), y1 = Math.max(frames.L.y1, frames.R.y1);
      const w = Math.max(frames.L.x1 - frames.L.x0, frames.R.x1 - frames.R.x0);
      for (const f of [frames.L, frames.R]) {
        const c = (f.x0 + f.x1) / 2;
        f.x0 = c - w / 2; f.x1 = c + w / 2; f.y0 = y0; f.y1 = y1;
      }
    }

    return sheets.map((s, i) => {
      const padY = PAD, padX = PAD * feats[i].H / feats[i].W;
      let pages;
      if (!s.twoUp) {
        const frame = frames.S || { x0: 0.03, y0: 0.03, x1: 0.97, y1: 0.97 };
        pages = [finalize(frame, s.own[0], 0, 1, padX, padY)];
      } else {
        const g = s.gutter;
        const left = frames.L || frames.R && { ...frames.R, x0: g - frames.R.x1 + g, x1: g - frames.R.x0 + g } || { x0: 0.03, y0: 0.03, x1: g - 0.02, y1: 0.97 };
        const right = frames.R || frames.L && { ...frames.L, x0: g + g - frames.L.x1, x1: g + g - frames.L.x0 } || { x0: g + 0.02, y0: 0.03, x1: 0.97, y1: 0.97 };
        pages = [finalize(left, s.own[0], 0, g, padX, padY), finalize(right, s.own[1], g, 1, padX, padY)];
      }
      pages.forEach((p, j) => {
        if (vertical) p.box = { x: p.box.y, y: p.box.x, w: p.box.h, h: p.box.w };
        p.angle = s.angles[j];
      });
      return { pages, split: s.twoUp ? (vertical ? 'v' : 'h') : null };
    });
  }

  global.Detect = { extract, analyze, otsu };
})(window);
