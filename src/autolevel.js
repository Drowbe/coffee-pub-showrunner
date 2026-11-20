'use strict';

// Auto level: keeps every Chameleon participant near the target loudness while
// the session runs, so someone who joins late, or whose microphone changes from
// one game to the next, is brought in line without pressing Calibrate.
//
// It watches OBS's level meters, and every couple of seconds nudges a person's
// OBS volume toward the target, using only the moments they are speaking. It is
// deliberately slow and small: at most a few dB per step, nothing for people who
// are not talking, and nothing at all for a minute after you move a fader
// yourself, so it never fights you.
//
// The service does not know about Electron or the config file; the caller gives
// it the people to watch and a way to remember a level.

const EventEmitter = require('events');
const { frameLevels, percentile, planVolume } = require('./leveling');

const DEFAULTS = {
  tickMs: 2000, // how often volumes are reconsidered
  refreshMs: 10000, // how often the list of people (and the faders) is re-read
  windowMs: 8000, // how much recent speech each decision looks at
  holdMs: 60000, // how long to leave a person alone after their fader is moved by hand
  saveMs: 20000, // how often changed levels are written down
  gateDb: -48, // frames quieter than this (before the fader) are not speech; stricter than Calibrate's
  minVoicedFrames: 25, // about a second and a quarter of speech in the window before acting
  deadbandDb: 1.5, // closer to the target than this is left alone
  smallStepDb: 1, // the most a normal correction moves in one step
  bigStepDb: 3, // the most a correction moves when the person is far off
  bigDiffDb: 6, // "far off" means more than this
};

class AutoLevelService extends EventEmitter {
  // bridge: the ObsBridge. getPeople(): [{ key, input, label }]. getTargetDb(): number.
  // saveLevel(key, volumeDb): remembers a person's level.
  constructor({ bridge, getPeople, getTargetDb, saveLevel, options = {} }) {
    super();
    this.bridge = bridge;
    this.getPeople = getPeople;
    this.getTargetDb = getTargetDb;
    this.saveLevel = saveLevel;
    this.opt = { ...DEFAULTS, ...options };
    this.people = new Map(); // input name -> { key, label, fader, expected, levels, holdUntil, dirty }
    this.running = false;
    this.paused = false;
    this.lastChange = '';
    this.lastSave = 0;
    this.stopWatching = null;
    this.timers = [];
  }

  status() {
    return { running: this.running, watching: this.people.size, last: this.lastChange };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    await this.refresh();
    this.stopWatching = await this.bridge.watchMeters((data) => this.onMeters(data));
    this.timers.push(setInterval(() => this.tick().catch(() => {}), this.opt.tickMs));
    this.timers.push(setInterval(() => this.refresh().catch(() => {}), this.opt.refreshMs));
    this.emit('change');
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.stopWatching) await this.stopWatching().catch(() => {});
    this.stopWatching = null;
    this.flush(true);
    this.people.clear();
    this.emit('change');
  }

  // Calibrate sets volumes itself, so auto level steps aside while it runs and starts fresh after.
  pause() {
    this.paused = true;
  }

  async resume() {
    this.people.clear();
    this.paused = false;
    if (this.running) await this.refresh();
  }

  // Re-reads who to watch: the participants that have a source in OBS, and where each fader is.
  async refresh() {
    if (!this.bridge.connected) return;
    const inObs = new Set((await this.bridge.browserInputs()).map((i) => i.name));
    const wanted = new Map(this.getPeople().filter((p) => inObs.has(p.input)).map((p) => [p.input, p]));
    for (const input of [...this.people.keys()]) if (!wanted.has(input)) this.people.delete(input);
    for (const [input, person] of wanted) {
      const known = this.people.get(input);
      const fader = (await this.bridge.getInputVolume(input)).db;
      if (!known) {
        this.people.set(input, { key: person.key, label: person.label || input, fader, expected: fader, levels: [], holdUntil: 0, dirty: false });
      } else {
        known.label = person.label || input;
        known.key = person.key;
      }
    }
    this.emit('change');
  }

  onMeters(data) {
    const now = Date.now();
    for (const meter of data.inputs) {
      const person = this.people.get(meter.inputName);
      if (!person || !meter.inputLevelsMul.length) continue;
      const { magnitudeDb } = frameLevels(meter.inputLevelsMul);
      if (!Number.isFinite(magnitudeDb)) continue;
      const preFader = magnitudeDb - person.fader;
      if (preFader > this.opt.gateDb) person.levels.push({ t: now, db: preFader });
    }
  }

  // The new volume for someone, or null to leave them alone.
  decide(person, actualDb, now) {
    const o = this.opt;
    const recent = person.levels.filter((l) => l.t >= now - o.windowMs);
    person.levels = recent;
    if (recent.length < o.minVoicedFrames) return null;
    const speech = percentile(recent.map((l) => l.db).sort((a, b) => a - b), 0.75);
    const desired = planVolume(speech, this.getTargetDb()).volumeDb;
    const diff = desired - actualDb;
    if (Math.abs(diff) < o.deadbandDb) return null;
    const limit = Math.abs(diff) > o.bigDiffDb ? o.bigStepDb : o.smallStepDb;
    const step = Math.max(-limit, Math.min(limit, diff));
    return Math.round((actualDb + step) * 10) / 10;
  }

  async tick() {
    if (!this.running || this.paused || !this.bridge.connected) return;
    const now = Date.now();
    for (const [input, person] of this.people) {
      // Read the fader each time: if it is not where we left it, a person moved it, so leave it be for a while.
      let actual;
      try {
        actual = (await this.bridge.getInputVolume(input)).db;
      } catch (err) {
        continue;
      }
      if (Math.abs(actual - person.expected) > 0.6) {
        person.holdUntil = now + this.opt.holdMs;
        person.expected = actual;
        person.fader = actual;
        person.levels = [];
        continue;
      }
      if (now < person.holdUntil) continue;
      const next = this.decide(person, actual, now);
      if (next === null) continue;
      try {
        await this.bridge.setInputVolumeDb(input, next);
      } catch (err) {
        continue;
      }
      person.fader = next;
      person.expected = next;
      person.dirty = true;
      this.lastChange = `${person.label} ${next > actual ? '+' : ''}${Math.round((next - actual) * 10) / 10} dB`;
      this.emit('adjusted', { key: person.key, input, label: person.label, fromDb: actual, volumeDb: next });
    }
    this.flush(false);
    this.emit('change');
  }

  // Writes changed levels down, not on every nudge.
  flush(force) {
    const now = Date.now();
    if (!force && now - this.lastSave < this.opt.saveMs) return;
    let any = false;
    for (const person of this.people.values()) {
      if (!person.dirty) continue;
      this.saveLevel(person.key, person.fader);
      person.dirty = false;
      any = true;
    }
    if (any || force) this.lastSave = now;
  }
}

module.exports = { AutoLevelService, DEFAULTS };
