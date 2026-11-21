'use strict';
// A quick check of the recording backend interface (no test framework in this repo): node scripts/check-recording.js
const assert = require('assert');
const { ObsBackend, RecordingBackend, RecordingBackends, ACTION_NEEDS } = require('../src/recording');

const calls = [];
const bridge = { connected: true };
for (const name of ['startRecording', 'stopRecording', 'pauseRecording', 'resumeRecording', 'startStreaming', 'stopStreaming']) {
  bridge[name] = async () => { calls.push(name); return name; };
}

(async () => {
  const obs = new ObsBackend(bridge);
  const set = new RecordingBackends([obs]);

  // Every recording action reaches OBS through the active backend.
  for (const action of Object.keys(ACTION_NEEDS)) assert.strictEqual(await set.run(action), action);
  assert.deepStrictEqual(calls, Object.keys(ACTION_NEEDS));

  // Not connected: the plain message the old requireObs gave.
  bridge.connected = false;
  await assert.rejects(set.run('startRecording'), /OBS is not connected\./);
  bridge.connected = true;

  // Something that is not a recording action is refused rather than guessed at.
  await assert.rejects(set.run('sceneSwitch'), /not a recording action/);

  // A backend without a capability says so, whatever its state.
  const simple = new RecordingBackend({ id: 'simple', label: 'Built-in', capabilities: ['record'] });
  simple.startRecording = async () => 'ok';
  const only = new RecordingBackends([simple]);
  assert.strictEqual(await only.run('startRecording'), 'ok');
  await assert.rejects(only.run('startStreaming'), /Built-in cannot do this \(Start and stop a live stream\)/);
  await assert.rejects(only.run('pauseRecording'), /cannot do this/);

  // What the control panel is told.
  assert.deepStrictEqual(set.list()[0], { id: 'obs', label: 'OBS', ready: true, capabilities: ['record', 'pause', 'stream', 'scenes', 'sources', 'levels'] });
  console.log('recording backend checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
