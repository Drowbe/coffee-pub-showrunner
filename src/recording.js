'use strict';
// Recording backends: whatever actually records and streams. OBS is the only one today; a built-in recorder is planned
// (documentation/plans/plan-recording.md). Automation actions that record or stream go through the active backend instead of
// calling OBS directly, and each backend says what it can do so the rest of the app can offer only those steps.

// What a backend may be able to do. 'record' covers start and stop; the rest are separate so a simple backend can leave them out.
const CAPABILITIES = Object.freeze({
  record: 'Start and stop a recording',
  pause: 'Pause and resume a recording',
  stream: 'Start and stop a live stream',
  scenes: 'Switch scenes',
  sources: 'Show, hide and edit sources (text, mute, volume)',
  levels: 'Read audio levels and set volumes (Auto level)',
});

// The automation actions that need the backend, and the capability each one needs.
const ACTION_NEEDS = Object.freeze({
  startRecording: 'record',
  stopRecording: 'record',
  pauseRecording: 'pause',
  resumeRecording: 'pause',
  startStreaming: 'stream',
  stopStreaming: 'stream',
});

// The shape every backend has. `capabilities` lists the keys of CAPABILITIES it supports; calling an action it does not support
// throws a plain message rather than failing somewhere inside.
class RecordingBackend {
  constructor({ id, label, capabilities }) {
    this.id = id;
    this.label = label;
    this.capabilities = new Set(capabilities);
  }

  can(capability) { return this.capabilities.has(capability); }

  get ready() { return true; } // connected, or otherwise able to take a command right now

  notReadyMessage() { return `${this.label} is not ready.`; }

  async startRecording() { throw this.unsupported('record'); }

  async stopRecording() { throw this.unsupported('record'); }

  async pauseRecording() { throw this.unsupported('pause'); }

  async resumeRecording() { throw this.unsupported('pause'); }

  async startStreaming() { throw this.unsupported('stream'); }

  async stopStreaming() { throw this.unsupported('stream'); }

  unsupported(capability) { return new Error(`${this.label} cannot do this (${CAPABILITIES[capability] || capability}).`); }

  // What the control panel needs to know: which backend, and what it can do.
  describe() {
    return { id: this.id, label: this.label, ready: this.ready, capabilities: [...this.capabilities] };
  }
}

// OBS, through the bridge that already talks to it.
class ObsBackend extends RecordingBackend {
  constructor(bridge) {
    super({ id: 'obs', label: 'OBS', capabilities: ['record', 'pause', 'stream', 'scenes', 'sources', 'levels'] });
    this.bridge = bridge;
  }

  get ready() { return this.bridge.connected; }

  notReadyMessage() { return 'OBS is not connected.'; }

  startRecording() { return this.bridge.startRecording(); }

  stopRecording() { return this.bridge.stopRecording(); }

  pauseRecording() { return this.bridge.pauseRecording(); }

  resumeRecording() { return this.bridge.resumeRecording(); }

  startStreaming() { return this.bridge.startStreaming(); }

  stopStreaming() { return this.bridge.stopStreaming(); }
}

// The set of backends and which one is in use. Only OBS exists for now, so `active` is always it; the choice will come from the
// profile once there is a second backend to choose.
class RecordingBackends {
  constructor(backends) {
    this.backends = new Map(backends.map((b) => [b.id, b]));
    this.activeId = backends[0].id;
  }

  get active() { return this.backends.get(this.activeId); }

  list() { return [...this.backends.values()].map((b) => b.describe()); }

  // Runs one of the recording or streaming actions on the active backend. Throws a plain message when it is not ready or cannot.
  async run(action) {
    const needs = ACTION_NEEDS[action];
    if (!needs) throw new Error(`${action} is not a recording action.`);
    const backend = this.active;
    if (!backend.can(needs)) throw backend.unsupported(needs);
    if (!backend.ready) throw new Error(backend.notReadyMessage());
    return backend[action]();
  }
}

module.exports = { CAPABILITIES, ACTION_NEEDS, RecordingBackend, ObsBackend, RecordingBackends };
