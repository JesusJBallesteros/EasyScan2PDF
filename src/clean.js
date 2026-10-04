/* Page image processing: greyscale / black & white conversion and scan clean-up.
 *
 * Clean-up does three things:
 *   - evens out the paper: the local paper brightness is estimated on a coarse
 *     grid and divided out, which removes yellowing, uneven lighting and the
 *     shadow near the binding;
 *   - pushes the paper to pure white and the ink towards black;
 *   - removes specks: isolated dark blobs of a few pixels.
 *
 * No DOM access; works on ImageData in place.
 */
(function (global) {
  'use strict';

  const WHITE = 232;        // normalised brightness that becomes pure white
  const PAPER_FLOOR = 0.6;  // grid cells darker than this share of the paper level are pictures, not paper

  function percentile(hist, total, p) {
    const target = total * p;
    let sum = 0;
    for (let v = 0; v < 256; v++) { sum += hist[v]; if (sum >= target) return v; }
    return 255;
  }

  /* Paper brightness on a coarse grid, one map per channel (channel -1 = luminance). */
  function background(d, W, H, channels) {
    const cell = Math.max(8, Math.round(Math.min(W, H) / 40));
    const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell), cells = gw * gh;
    const step = Math.max(1, Math.floor(cell / 12));
    const maps = channels.map(() => new Float32Array(cells));
    const hists = channels.map(() => new Uint32Array(256));
    const inkHist = new Uint32Array(256);
    let inkTotal = 0;

    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        for (const h of hists) h.fill(0);
        let count = 0;
        const yEnd = Math.min(H, (gy + 1) * cell), xEnd = Math.min(W, (gx + 1) * cell);
        for (let y = gy * cell; y < yEnd; y += step) {
          for (let x = gx * cell; x < xEnd; x += step) {
            const p = (y * W + x) * 4;
            const l = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
            for (let c = 0; c < channels.length; c++) hists[c][channels[c] < 0 ? l : d[p + channels[c]]]++;
            inkHist[l]++;
            count++;
          }
        }
        inkTotal += count;
        for (let c = 0; c < channels.length; c++) maps[c][gy * gw + gx] = percentile(hists[c], count, 0.85);
      }
    }

    // Cells much darker than the typical paper are pictures or solid ink: take
    // their paper level from the neighbours instead.
    const level = new Float32Array(cells);
    for (let i = 0; i < cells; i++) { for (const m of maps) level[i] += m[i] / maps.length; }
    const paper = Array.from(level).sort((a, b) => a - b)[cells >> 1];
    if (paper < 40) return null;   // dark page: nothing sensible to normalise against
    const valid = new Uint8Array(cells);
    for (let i = 0; i < cells; i++) valid[i] = level[i] >= paper * PAPER_FLOOR ? 1 : 0;
    for (let pass = 0, missing = true; missing && pass < gw + gh; pass++) {
      missing = false;
      const filled = [];
      for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
          const i = gy * gw + gx;
          if (valid[i]) continue;
          const sum = maps.map(() => 0);
          let k = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = gx + dx, ny = gy + dy;
              if (nx < 0 || ny < 0 || nx >= gw || ny >= gh || !valid[ny * gw + nx]) continue;
              maps.forEach((m, c) => { sum[c] += m[ny * gw + nx]; });
              k++;
            }
          }
          if (k) filled.push([i, sum.map((s) => s / k)]); else missing = true;
        }
      }
      for (const [i, values] of filled) { maps.forEach((m, c) => { m[i] = values[c]; }); valid[i] = 1; }
    }

    // Smooth, so the correction has no visible grid.
    const smooth = maps.map((m) => {
      const out = new Float32Array(cells);
      for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
          let s = 0, k = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = gx + dx, ny = gy + dy;
              if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
              s += m[ny * gw + nx];
              k++;
            }
          }
          out[gy * gw + gx] = Math.max(1, s / k);
        }
      }
      return out;
    });
    return { cell, gw, gh, maps: smooth, ink: percentile(inkHist, inkTotal, 0.02) };
  }

  /* Grid position of pixel coordinate v: lower cell index and blend weight towards the next. */
  function gridPos(v, cell, count) {
    const f = (v + 0.5) / cell - 0.5;
    let i = Math.floor(f), t = f - i;
    if (i < 0) { i = 0; t = 0; }
    if (i >= count - 1) { i = count - 1; t = 0; }
    return [i, t];
  }

  /* Whitens dark blobs of at most maxArea pixels that have no other ink within gap pixels. */
  function despeckle(d, W, H, limit, maxArea, gap, edge) {
    const dark = (i) => d[i * 4 + 1] < limit;
    const blob = new Int32Array(maxArea + 2);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!dark(i)) continue;
        // A dark neighbour already visited belongs to a blob that was kept, so this one is part of it.
        if ((x > 0 && dark(i - 1)) || (y > 0 && (dark(i - W) || (x > 0 && dark(i - W - 1)) || (x < W - 1 && dark(i - W + 1))))) continue;
        let size = 1;
        blob[0] = i;
        grow: for (let k = 0; k < size; k++) {
          const jx = blob[k] % W, jy = (blob[k] - jx) / W;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = jx + dx, ny = jy + dy;
              if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const nb = ny * W + nx;
              if (!dark(nb)) continue;
              let seen = false;
              for (let m = 0; m < size; m++) if (blob[m] === nb) { seen = true; break; }
              if (seen) continue;
              blob[size++] = nb;
              if (size > maxArea) break grow;
            }
          }
        }
        if (size > maxArea) continue;
        // Small marks close to other ink are accents, dots and punctuation: keep them.
        let x0 = W, x1 = 0, y0 = H, y1 = 0;
        for (let k = 0; k < size; k++) {
          const jx = blob[k] % W, jy = (blob[k] - jx) / W;
          if (jx < x0) x0 = jx;
          if (jx > x1) x1 = jx;
          if (jy < y0) y0 = jy;
          if (jy > y1) y1 = jy;
        }
        let around = 0;
        for (let ny = Math.max(0, y0 - gap); ny <= Math.min(H - 1, y1 + gap) && around <= size; ny++) {
          for (let nx = Math.max(0, x0 - gap); nx <= Math.min(W - 1, x1 + gap); nx++) around += dark(ny * W + nx) ? 1 : 0;
        }
        if (around > size) continue;
        // Erase the speck together with its soft edge.
        for (let k = 0; k < size; k++) {
          const jx = blob[k] % W, jy = (blob[k] - jx) / W;
          for (let dy = -edge; dy <= edge; dy++) {
            for (let dx = -edge; dx <= edge; dx++) {
              const nx = jx + dx, ny = jy + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const p = (ny * W + nx) * 4;
              d[p] = d[p + 1] = d[p + 2] = 255;
            }
          }
        }
      }
    }
  }

  /* Converts img in place.
   * o: { mode: 'color' | 'gray' | 'bw', autoThr, thr, clean,
   *      speck (largest speck, pixels), gap (clear space a speck needs around it, pixels) } */
  function process(img, o) {
    const d = img.data, W = img.width, H = img.height, n = W * H;
    const color = o.mode === 'color';
    if (color && !o.clean) return;

    const channels = color ? [0, 1, 2] : [-1];
    const bg = o.clean ? background(d, W, H, channels) : null;
    if (color && !bg) return;
    let lut = null, col = null, wgt = null, rows = null;
    if (bg) {
      const black = Math.min(bg.ink, 100) * 0.6;
      lut = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) lut[v] = (v - black) * 255 / (WHITE - black);
      col = new Int32Array(W);
      wgt = new Float32Array(W);
      for (let x = 0; x < W; x++) [col[x], wgt[x]] = gridPos(x, bg.cell, bg.gw);
      rows = bg.maps.map(() => new Float32Array(bg.gw));
    }

    const hist = new Uint32Array(256);
    for (let y = 0; y < H; y++) {
      if (bg) {
        const [gy, ty] = gridPos(y, bg.cell, bg.gh), next = Math.min(gy + 1, bg.gh - 1);
        bg.maps.forEach((m, c) => {
          for (let gx = 0; gx < bg.gw; gx++) rows[c][gx] = m[gy * bg.gw + gx] + (m[next * bg.gw + gx] - m[gy * bg.gw + gx]) * ty;
        });
      }
      for (let x = 0, p = y * W * 4; x < W; x++, p += 4) {
        if (color) {
          for (let c = 0; c < 3; c++) {
            const r = rows[c], i = col[x];
            const paper = r[i] + (r[Math.min(i + 1, bg.gw - 1)] - r[i]) * wgt[x];
            d[p + c] = lut[Math.min(255, d[p + c] * 255 / paper) | 0];
          }
        } else {
          let g = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
          if (bg) {
            const r = rows[0], i = col[x];
            const paper = r[i] + (r[Math.min(i + 1, bg.gw - 1)] - r[i]) * wgt[x];
            g = lut[Math.min(255, g * 255 / paper) | 0];
          }
          d[p] = d[p + 1] = d[p + 2] = g;
          hist[g]++;
        }
      }
    }

    if (o.mode === 'bw') {
      const thr = o.autoThr ? Detect.otsu(hist, n).thr : o.thr;
      for (let p = 0; p < n * 4; p += 4) d[p] = d[p + 1] = d[p + 2] = d[p] > thr ? 255 : 0;
    }
    if (o.clean && o.speck > 0) despeckle(d, W, H, o.mode === 'bw' ? 128 : 180, o.speck, o.gap, o.mode === 'bw' ? 1 : 2);
  }

  global.Clean = { process };
})(window);
