'use strict';

// Audio leveling: measure how loud each participant speaks and work out the
// OBS volume that brings everyone to the same level.
//
// OBS reports, for each audio input and about twenty times a second, the RMS
// "magnitude" and the sample "peak" after the volume fader, and the "input
// peak" before it. The fader setting is subtracted from the RMS to get a level
// that does not depend on where the fader happens to be, so measuring twice
// gives the same answer. This file is pure arithmetic; src/obs.js collects the
// frames and src/main.js applies the result.

const GATE_DB = -55; // frames quieter than this (before the fader) are silence, not speech
const MIN_SPEECH_FRAMES = 20; // about a second of speech; less is "no speech heard"
const PERCENTILE = 0.75; // the louder part of the speech, not the pauses between words
const MIN_VOLUME_DB = -30; // how far Calibrate will turn someone down
const MAX_VOLUME_DB = 20; // and up (OBS itself goes to 26)
const CLIP_DB = -1; // peaks above this are clipping

function toDb(x) {
  return x > 0 ? 20 * Math.log10(x) : -Infinity;
}

// A frame is one array per channel of [magnitude, peak, inputPeak], linear.
// The loudest channel stands for the input.
function frameLevels(frame) {
  let magnitude = 0;
  let inputPeak = 0;
  for (const channel of frame) {
    if (!Array.isArray(channel)) continue;
    magnitude = Math.max(magnitude, channel[0] || 0);
    inputPeak = Math.max(inputPeak, channel[2] || 0);
  }
  return { magnitudeDb: toDb(magnitude), inputPeakDb: toDb(inputPeak) };
}

function percentile(sortedAscending, p) {
  if (sortedAscending.length === 0) return -Infinity;
  const index = Math.min(sortedAscending.length - 1, Math.max(0, Math.round(p * (sortedAscending.length - 1))));
  return sortedAscending[index];
}

// What one input's frames say, given the fader it was measured at (dB).
// speechDb is the level before the fader; state is "ok", "silent" or "quiet".
function analyzeFrames(frames, faderDb) {
  const levels = [];
  let peakDb = -Infinity;
  for (const frame of frames) {
    const { magnitudeDb, inputPeakDb } = frameLevels(frame);
    if (!Number.isFinite(magnitudeDb)) continue;
    const preFader = magnitudeDb - faderDb;
    if (preFader > GATE_DB) {
      levels.push(preFader);
      peakDb = Math.max(peakDb, inputPeakDb);
    }
  }
  levels.sort((a, b) => a - b);
  if (levels.length < MIN_SPEECH_FRAMES) return { state: levels.length === 0 ? 'silent' : 'quiet', speechDb: null, peakDb: null, voicedFrames: levels.length };
  return { state: 'ok', speechDb: percentile(levels, PERCENTILE), peakDb, voicedFrames: levels.length };
}

// The volume that puts a person's speech at the target, held to a sane range.
function planVolume(speechDb, targetDb) {
  const wanted = targetDb - speechDb;
  const volumeDb = Math.min(MAX_VOLUME_DB, Math.max(MIN_VOLUME_DB, wanted));
  return { volumeDb: Math.round(volumeDb * 10) / 10, clamped: volumeDb !== wanted };
}

// Frames in, one finished result out. Does not touch OBS.
function levelResult(frames, faderDb, targetDb) {
  const heard = analyzeFrames(frames, faderDb);
  if (heard.state !== 'ok') return { ...heard, volumeDb: null, clamped: false, clipping: false };
  const plan = planVolume(heard.speechDb, targetDb);
  return {
    ...heard,
    speechDb: Math.round(heard.speechDb * 10) / 10,
    peakDb: Math.round(heard.peakDb * 10) / 10,
    volumeDb: plan.volumeDb,
    clamped: plan.clamped,
    clipping: heard.peakDb > CLIP_DB,
  };
}

// Measures a set of OBS inputs for `seconds` and returns a result for each; applying the volumes
// is the caller's business. `inputs` is a list of { key, input }, `input` being the OBS input name.
async function calibrateInputs(bridge, inputs, { seconds, targetDb }) {
  const faders = {};
  for (const { input } of inputs) faders[input] = (await bridge.getInputVolume(input)).db;
  const frames = await bridge.collectMeters(inputs.map((i) => i.input), seconds * 1000);
  return inputs.map(({ key, input }) => ({ key, input, faderDb: faders[input], ...levelResult(frames[input], faders[input], targetDb) }));
}

module.exports = { calibrateInputs, levelResult, analyzeFrames, planVolume, frameLevels, toDb, GATE_DB, MIN_SPEECH_FRAMES, MIN_VOLUME_DB, MAX_VOLUME_DB, CLIP_DB };
