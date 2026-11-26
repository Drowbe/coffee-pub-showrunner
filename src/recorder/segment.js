'use strict';
// Finds the person in a webcam picture (MediaPipe's selfie segmentation, running on the processor, not the graphics chip, so it does not
// compete with a busy game for it). Loaded only when a background blur is wanted. See src/vendor/mediapipe/NOTICE.md.
const path = require('path');
const { pathToFileURL } = require('url');

const base = path.join(__dirname, '..', 'vendor', 'mediapipe');
let segmenter = null; let loading = null;

function load() {
  if (segmenter) return Promise.resolve(segmenter);
  if (loading) return loading;
  loading = (async () => {
    const vision = require(path.join(base, 'vision_bundle.cjs'));
    const fileset = await vision.FilesetResolver.forVisionTasks(pathToFileURL(path.join(base, 'wasm')).href);
    segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: pathToFileURL(path.join(base, 'selfie_segmenter.tflite')).href, delegate: 'CPU' },
      runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false,
    });
    return segmenter;
  })().catch((err) => { loading = null; throw err; });
  return loading;
}

// A mask for the picture in `source` (a video or canvas): a Float32Array of 0 (background) to 1 (person), with its width and height.
function segment(source, timestampMs) {
  if (!segmenter) return null;
  const result = segmenter.segmentForVideo(source, timestampMs);
  const mask = result.confidenceMasks && result.confidenceMasks[0];
  if (!mask) { result.close(); return null; }
  const out = { data: Float32Array.from(mask.getAsFloat32Array()), width: mask.width, height: mask.height };
  result.close();
  return out;
}

module.exports = { load, segment };
