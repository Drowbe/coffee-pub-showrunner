'use strict';
// How the picture is laid out, in one place so the recording and the preview on the recorder page can never disagree.
// Used by the recorder window (require) and by the control panel (a script tag).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.ShowrunnerLayout = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const CAM_WIDTH = { small: 0.18, medium: 0.26, large: 0.36 };
  const CENTER_WIDTH = { small: 0.3, medium: 0.45, large: 0.6 }; // in the 'center' layout the webcam is bigger // the webcam's width in a corner layout, as a share of the picture

  // Removes a backdrop of one colour (a green screen) from a picture: how far each pixel's colour (not its brightness) is from the key
  // colour decides how see-through it becomes, with a soft edge. Done on a reduced-size copy, since it touches every pixel.
  let keyCanvas = null; let keyPen = null;
  function keyed(cam, sx, sy, sw, sh, w, h, key) {
    const scale = Math.min(1, 960 / Math.max(w, 1));
    const pw = Math.max(2, Math.round(w * scale)); const ph = Math.max(2, Math.round(h * scale));
    if (!keyCanvas) { keyCanvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(pw, ph) : document.createElement('canvas'); }
    if (keyCanvas.width !== pw || keyCanvas.height !== ph) { keyCanvas.width = pw; keyCanvas.height = ph; keyPen = null; }
    if (!keyPen) keyPen = keyCanvas.getContext('2d', { willReadFrequently: true });
    keyPen.clearRect(0, 0, pw, ph);
    keyPen.drawImage(cam, sx, sy, sw, sh, 0, 0, pw, ph);
    const img = keyPen.getImageData(0, 0, pw, ph); const d = img.data;
    const hex = (key.color || '#00b140').replace('#', ''); const kr = parseInt(hex.slice(0, 2), 16); const kg = parseInt(hex.slice(2, 4), 16); const kb = parseInt(hex.slice(4, 6), 16);
    const chroma = (r, g, b) => [-0.169 * r - 0.331 * g + 0.5 * b, 0.5 * r - 0.419 * g - 0.081 * b]; // Cb and Cr
    const [kcb, kcr] = chroma(kr, kg, kb);
    const lo = (key.tolerance / 100) * 90; const hi = lo + (key.softness / 100) * 60 + 1; // distances in colour units
    const spill = kg >= kr && kg >= kb ? 1 : kb >= kr && kb >= kg ? 2 : 0; // which channel to calm at the edges
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]; const g = d[i + 1]; const b = d[i + 2];
      const [cb, cr] = chroma(r, g, b);
      const dist = Math.hypot(cb - kcb, cr - kcr);
      let a = (dist - lo) / (hi - lo); a = a < 0 ? 0 : a > 1 ? 1 : a;
      d[i + 3] = Math.round(a * 255);
      if (a > 0 && a < 1) { const cap = spill === 1 ? Math.max(r, b) : spill === 2 ? Math.max(r, g) : 255; if (spill === 1 && g > cap) d[i + 1] = cap; else if (spill === 2 && b > cap) d[i + 2] = cap; } // no green (or blue) fringe
    }
    keyPen.putImageData(img, 0, 0);
    return keyCanvas;
  }

  // Blurs everything except the person: the picture is drawn blurred, then the person (the picture cut out with the mask) on top.
  // `mask` is a canvas whose see-through-ness is 1 on the person and 0 elsewhere (from segment.js); until it exists, the picture is plain.
  let blurSet = null;
  function blurred(cam, sx, sy, sw, sh, w, h, strength, mask) {
    const scale = Math.min(1, 640 / Math.max(w, 1));
    const pw = Math.max(2, Math.round(w * scale)); const ph = Math.max(2, Math.round(h * scale));
    if (!blurSet || blurSet.pw !== pw || blurSet.ph !== ph) {
      const make = () => { const c = document.createElement('canvas'); c.width = pw; c.height = ph; return { c, p: c.getContext('2d') }; };
      blurSet = { pw, ph, a: make(), b: make(), person: make() };
    }
    const { a, b, person } = blurSet;
    a.p.drawImage(cam, sx, sy, sw, sh, 0, 0, pw, ph);
    if (!mask) return a.c;
    b.p.filter = `blur(${Math.max(1, Math.round((strength / 100) * 18 * (pw / 640)))}px)`;
    b.p.drawImage(a.c, 0, 0);
    b.p.filter = 'none';
    person.p.globalCompositeOperation = 'source-over'; person.p.clearRect(0, 0, pw, ph);
    person.p.drawImage(a.c, 0, 0);
    // the mask covers the whole camera picture, so the same part of it is used as the part of the picture that is shown
    const mx = mask.width / cam.videoWidth; const my = mask.height / cam.videoHeight;
    person.p.globalCompositeOperation = 'destination-in'; person.p.drawImage(mask, sx * mx, sy * my, sw * mx, sh * my, 0, 0, pw, ph); person.p.globalCompositeOperation = 'source-over';
    b.p.drawImage(person.c, 0, 0);
    return b.c;
  }

  // The webcam, filling a box (cropping the edges if the shapes differ), with rounded corners when it is a small box.
  function drawCamera(g, cam, x, y, w, h, round, flip, fit, fx) {
    if (!cam || !cam.videoWidth) return;
    if (fit) { // all of the picture, with bars if the shapes differ
      const f = Math.min(w / cam.videoWidth, h / cam.videoHeight); const fw = cam.videoWidth * f; const fh = cam.videoHeight * f;
      x += (w - fw) / 2; y += (h - fh) / 2; w = fw; h = fh;
    }
    const k = Math.max(w / cam.videoWidth, h / cam.videoHeight);
    const sw = w / k; const sh = h / k;
    const sx = (cam.videoWidth - sw) / 2; const sy = (cam.videoHeight - sh) / 2;
    const src = fx && fx.kind === 'key' ? keyed(cam, sx, sy, sw, sh, w, h, fx) : fx && fx.kind === 'blur' ? blurred(cam, sx, sy, sw, sh, w, h, fx.strength, fx.mask) : cam;
    const [ax, ay, aw, ah] = src === cam ? [sx, sy, sw, sh] : [0, 0, src.width, src.height];
    g.save();
    if (round && !(fx && fx.kind === 'key')) { g.beginPath(); g.roundRect(x, y, w, h, round); g.clip(); }
    if (flip) { g.translate(x + w, 0); g.scale(-1, 1); g.drawImage(src, ax, ay, aw, ah, 0, y, w, h); } // mirrored left to right
    else g.drawImage(src, ax, ay, aw, ah, x, y, w, h);
    g.restore();
  }

  const keyOf = (camera, mask) => {
    if (!camera) return null;
    if (camera.background === 'key') return { kind: 'key', color: camera.keyColor, tolerance: camera.keyTolerance, softness: camera.keySoftness };
    if (camera.background === 'blur') return { kind: 'blur', strength: camera.blur, mask };
    return null;
  };

  function rects(layout, W, H) {
    if (layout === 'cam') return [];
    if (layout === 'side') return [{ x: 0, y: 0, w: W / 2, h: H }, { x: W / 2, y: 0, w: W / 2, h: H }];
    return [{ x: 0, y: 0, w: W, h: H }];
  }

  // Draws the whole picture onto g: windows (each held in a canvas) fitted into their slots, then the webcam.
  function compose(g, W, H, { layout, camera, sources, camVideo, fit, camMask }) {
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    rects(layout, W, H).forEach((r, i) => {
      const s = sources[i];
      if (!s || !s.width || !s.height) return;
      const draw = (dx, dy, dw, dh, sx, sy, sw, sh) => (s.drawTo ? s.drawTo(g, dx, dy, dw, dh, sx, sy, sw, sh) : g.drawImage(s, sx, sy, sw, sh, dx, dy, dw, dh)); // a live screen capture draws its own cropped part
      if (fit === 'fill') { // fills the place, cropping the edges of the window that do not fit
        const k = Math.max(r.w / s.width, r.h / s.height);
        const sw = r.w / k; const sh = r.h / k;
        draw(r.x, r.y, r.w, r.h, (s.width - sw) / 2, (s.height - sh) / 2, sw, sh);
      } else { // all of the window inside the place, keeping its shape
        const k = Math.min(r.w / s.width, r.h / s.height);
        const w = s.width * k; const h = s.height * k;
        draw(r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h, 0, 0, s.width, s.height);
      }
    });
    if (layout === 'cam') drawCamera(g, camVideo, 0, 0, W, H, 0, camera.flip, fit !== 'fill', keyOf(camera, camMask));
    else if (layout === 'center' && camVideo && camVideo.videoWidth) {
      const w = Math.round(W * (CENTER_WIDTH[camera.size] || CENTER_WIDTH.medium));
      const h = Math.round(w * camVideo.videoHeight / camVideo.videoWidth);
      const x = Math.round(Math.min(W - w, Math.max(0, (camera.cx === undefined ? 0.5 : camera.cx) * W - w / 2)));
      const y = Math.round(Math.min(H - h, Math.max(0, (camera.cy === undefined ? 0.5 : camera.cy) * H - h / 2)));
      drawCamera(g, camVideo, x, y, w, h, Math.round(W * 0.012), camera.flip, false, keyOf(camera, camMask));
    } else if (layout === 'corner' && camVideo && camVideo.videoWidth) {
      const w = Math.round(W * (CAM_WIDTH[camera.size] || CAM_WIDTH.medium));
      const h = Math.round(w * camVideo.videoHeight / camVideo.videoWidth);
      const margin = Math.round(W * 0.02);
      const x = camera.corner.endsWith('l') ? margin : W - w - margin;
      const y = camera.corner.startsWith('t') ? margin : H - h - margin;
      drawCamera(g, camVideo, x, y, w, h, Math.round(W * 0.008), camera.flip, false, keyOf(camera, camMask));
    }
  }

  return { compose, CAM_WIDTH };
}));
