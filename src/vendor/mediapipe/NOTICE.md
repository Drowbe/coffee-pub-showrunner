# MediaPipe (background blur)

Showrunner's webcam background blur uses Google's MediaPipe Tasks Vision and its selfie segmentation model, both under the
Apache License, Version 2.0 (see `LICENSE-Apache-2.0.txt` in this folder).

| File | What it is | Where it came from |
| --- | --- | --- |
| `vision_bundle.cjs` | MediaPipe Tasks Vision, JavaScript | npm package `@mediapipe/tasks-vision` 1.2.3 (license: Apache-2.0) |
| `wasm/vision_wasm_internal.js`, `wasm/vision_wasm_internal.wasm` | MediaPipe's runtime (WebAssembly) | same package |
| `selfie_segmenter.tflite` | The selfie segmentation model (256 x 256, float16), 249,537 bytes | `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite` |

The model card ("MediaPipe Selfie Segmentation", Google, May 6, 2021, `https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf`)
states: "LICENSED UNDER: Apache License, Version 2.0". The card lists augmented reality and video conferencing as its intended uses,
and surveillance and identity recognition as out of scope; Showrunner uses it only to blur or replace the background behind a webcam.

The files are unmodified copies. The Apache 2.0 licence requires keeping this notice and the licence text with them.
