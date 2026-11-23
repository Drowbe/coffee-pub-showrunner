'use strict';
// How the picture is laid out, in one place so the recording and the preview on the recorder page can never disagree.
// Used by the recorder window (require) and by the control panel (a script tag).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.ShowrunnerLayout = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const CAM_WIDTH = { small: 0.18, medium: 0.26, large: 0.36 }; // the webcam's width in a corner layout, as a share of the picture

  // The webcam, filling a box (cropping the edges if the shapes differ), with rounded corners when it is a small box.
  function drawCamera(g, cam, x, y, w, h, round, flip, fit) {
    if (!cam || !cam.videoWidth) return;
    if (fit) { // all of the picture, with bars if the shapes differ
      const f = Math.min(w / cam.videoWidth, h / cam.videoHeight); const fw = cam.videoWidth * f; const fh = cam.videoHeight * f;
      x += (w - fw) / 2; y += (h - fh) / 2; w = fw; h = fh;
    }
    const k = Math.max(w / cam.videoWidth, h / cam.videoHeight);
    const sw = w / k; const sh = h / k;
    g.save();
    if (round) { g.beginPath(); g.roundRect(x, y, w, h, round); g.clip(); }
    if (flip) { g.translate(x + w, 0); g.scale(-1, 1); g.drawImage(cam, (cam.videoWidth - sw) / 2, (cam.videoHeight - sh) / 2, sw, sh, 0, y, w, h); } // mirrored left to right
    else g.drawImage(cam, (cam.videoWidth - sw) / 2, (cam.videoHeight - sh) / 2, sw, sh, x, y, w, h);
    g.restore();
  }

  function rects(layout, W, H) {
    if (layout === 'cam') return [];
    if (layout === 'side') return [{ x: 0, y: 0, w: W / 2, h: H }, { x: W / 2, y: 0, w: W / 2, h: H }];
    return [{ x: 0, y: 0, w: W, h: H }];
  }

  // Draws the whole picture onto g: windows (each held in a canvas) fitted into their slots, then the webcam.
  function compose(g, W, H, { layout, camera, sources, camVideo, fit }) {
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
    if (layout === 'cam') drawCamera(g, camVideo, 0, 0, W, H, 0, camera.flip, fit !== 'fill');
    else if (layout === 'corner' && camVideo && camVideo.videoWidth) {
      const w = Math.round(W * (CAM_WIDTH[camera.size] || CAM_WIDTH.medium));
      const h = Math.round(w * camVideo.videoHeight / camVideo.videoWidth);
      const margin = Math.round(W * 0.02);
      const x = camera.corner.endsWith('l') ? margin : W - w - margin;
      const y = camera.corner.startsWith('t') ? margin : H - h - margin;
      drawCamera(g, camVideo, x, y, w, h, Math.round(W * 0.008), camera.flip);
    }
  }

  return { compose, CAM_WIDTH };
}));
