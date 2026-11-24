'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { renderScript, MAX_SCRIPT_BYTES } = require('./prompter');
const { app, BrowserWindow, WebContentsView, ipcMain, screen, shell, Menu, Tray, nativeImage, session, dialog, safeStorage, Notification, systemPreferences } = require('electron');
const backups = require('./backup');
const { calibrateInputs } = require('./leveling');
const { AutoLevelService } = require('./autolevel');
const { ConfigStore, LIMITS, REGION_LIMITS, DEFAULT_GROUP, AUTOMATIONS_ACTION_SCHEMA, STUDIO_ACTION_SCHEMA, SOURCE_SUFFIX, upgradeSourceName } = require('./config');
const { ObsBridge, parseWindowChoice } = require('./obs');
const { nameFromTemplate, defaultName } = require('./filename');
const { ObsBackend, BuiltInBackend, RecordingBackends } = require('./recording');
const { BuiltInRecorder } = require('./recorder');
const { TavernBridge } = require('./tavern');
const { AutomationsServer } = require('./automations');
const { YouTubeUploader } = require('./youtube');
const parkingGeometry = require('./parking');

// What people see: window titles, menus, notifications, the About panel.
const APP_NAME = 'Coffee Pub Showrunner';
// The name the app's saved data and encrypted passwords are filed under. The
// app was called Coffee Pub Studio before it was Coffee Pub Showrunner, and
// this stays as it was on purpose: the settings folder follows it, and so does
// the key the OBS, Tavern and YouTube passwords are encrypted with -- change
// it and every one of them is unreadable and has to be entered again.
const DATA_NAME = 'Coffee Pub Studio';

// Git revision recorded by scripts/write-build-info.js (absent in a bare checkout).
function readBuildInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8'));
  } catch (err) {
    return { commit: 'unknown', branch: '', dirty: false };
  }
}
const BUILD_INFO = readBuildInfo();
const APP_VERSION = require('../package.json').version;
const REVISION = `v${APP_VERSION} (${BUILD_INFO.commit}${BUILD_INFO.dirty ? '+' : ''})`;
// Storage partition of the default session group ("Main"); other groups get
// their own partition, see partitionFor().
const PARTITION = 'persist:coffeepub';
const DOCK_WIDTH = parkingGeometry.STRIP; // collapsed dock pill width
const DOCK_EXPANDED = 260; // expanded dock pill width
const BAR_HEIGHT = 28; // the app's own bar at the top of each window (cropped out in OBS)

// Session group -> storage partition. "Main" keeps the original partition so
// existing logins survive; other groups get their own.
function partitionFor(view) {
  const group = String(view.session || DEFAULT_GROUP);
  if (group === DEFAULT_GROUP) return PARTITION;
  const slug = group.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
  return `persist:group-${slug}`;
}

// Selector candidates to try in order: the text as typed, then, when it has
// no selector punctuation, the same words read as a list of class names
// ("secondary-bar-item secondary-bar-item-progressbar" -> ".secondary-bar-item.secondary-bar-item-progressbar").
function selectorCandidates(text) {
  if (typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];
  const candidates = [trimmed];
  if (!/[.#\[\]>:+~*,="']/.test(trimmed)) {
    candidates.push(
      trimmed
        .split(/\s+/)
        .map((c) => `.${c}`)
        .join(''),
    );
  }
  return candidates;
}

app.setName(DATA_NAME);

// Keep the view windows rendering at full rate even when they are not focused
// or are behind other windows. OBS captures whatever the window paints, so
// throttled rendering would show up as a stuttering source.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// Let Foundry play audio without a click first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Play audio from the app's own process rather than Chromium's audio helper
// process: macOS window capture (ScreenCaptureKit) attributes sound to the
// process that owns the captured window, so audio from a helper never
// reaches the OBS source.
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');

// The app was called "Coffee Pub Browser" before v0.1.8. On the first launch
// under the new name, carry the settings over from the old folder. The OBS
// password cannot come along: the keychain entry it was encrypted with is
// named after the app, so it has to be entered once more.
function migrateLegacyUserData() {
  const legacyDir = path.join(app.getPath('appData'), 'Coffee Pub Browser');
  const userData = app.getPath('userData');
  const target = path.join(userData, 'config.json');
  const source = path.join(legacyDir, 'config.json');
  try {
    if (fs.existsSync(target) || !fs.existsSync(source)) return;
    fs.mkdirSync(userData, { recursive: true });
    fs.copyFileSync(source, target);
    console.log(`Migrated settings from ${legacyDir}`);
  } catch (err) {
    console.warn('Could not migrate settings from the old app folder:', err.message);
  }
}
migrateLegacyUserData();

const configStore = new ConfigStore(path.join(app.getPath('userData'), 'config.json'));
// Whatever saves the settings (the control panel, the toolbar), the toolbar shows the new values straight away.
{ const save = configStore.save.bind(configStore); configStore.save = (next) => { const saved = save(next); setImmediate(() => { try { sendToolbarState(); scheduleWarm(); } catch (err) { /* toolbar not ready yet */ } }); return saved; }; }

// OBS sources this app made used to end in " (CP Studio)" and now end in
// " (CPS)". Everything that remembers one by name has to follow, or a source
// goes missing from the app's point of view: the window and region names, the
// published Tavern sources, the app windows, and any automation step that
// names one (Herald's "show the stats overlay" is exactly that). The config
// side is rewritten here, once, at launch; the renames themselves wait in
// source-renames.json until OBS is connected and are carried out by
// applyPendingSourceRenames, then forgotten.
const SOURCE_RENAMES_PATH = path.join(app.getPath('userData'), 'source-renames.json');
function readPendingSourceRenames() {
  try {
    const data = JSON.parse(fs.readFileSync(SOURCE_RENAMES_PATH, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (err) {
    return {};
  }
}
function writePendingSourceRenames(pending) {
  try {
    if (Object.keys(pending).length) fs.writeFileSync(SOURCE_RENAMES_PATH, JSON.stringify(pending));
    else fs.rmSync(SOURCE_RENAMES_PATH, { force: true });
  } catch (err) {
    // Worst case the rename is retried next launch -- never worth failing startup over.
  }
}
function migrateSourceNames() {
  const current = configStore.get();
  const renames = {};
  const fix = (name) => {
    const next = upgradeSourceName(name);
    if (next !== name) renames[name] = next;
    return next;
  };
  const next = {
    ...current,
    views: current.views.map((view) => ({
      ...view,
      windowSource: view.windowSource ? { ...view.windowSource, name: fix(view.windowSource.name) } : view.windowSource,
      regions: (view.regions || []).map((region) => (region.obsSource ? { ...region, obsSource: fix(region.obsSource) } : region)),
    })),
    appWindows: (current.appWindows || []).map((app) => ({ ...app, sourceName: fix(app.sourceName) })),
    tavern: {
      ...current.tavern,
      players: Object.fromEntries(
        Object.entries(current.tavern.players || {}).map(([key, entry]) => [
          key,
          { ...entry, source: fix(entry.source || ''), characterSource: fix(entry.characterSource || '') },
        ])
      ),
    },
  };
  if (!Object.keys(renames).length) return;
  // A step that names one of the renamed sources by exact name follows it.
  next.automations = {
    ...current.automations,
    ruleSets: current.automations.ruleSets.map((ruleSet) => ({
      ...ruleSet,
      steps: (ruleSet.steps || []).map((step) => (step.type === 'action' && typeof step.param === 'string' && renames[step.param] ? { ...step, param: renames[step.param] } : step)),
    })),
  };
  configStore.save(next);
  writePendingSourceRenames({ ...readPendingSourceRenames(), ...renames });
  console.log(`Renamed ${Object.keys(renames).length} saved source name(s) to the (CPS) ending.`);
}
migrateSourceNames();

/** @type {Map<string, BrowserWindow>} */
const viewWindows = new Map();
/** @type {Map<string, WebContentsView>} */
const pageViews = new Map();
let parking = false; // true while collapse/expand move windows programmatically

// Shown in a window that has no URL configured yet.
const PLACEHOLDER_URL =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>No URL</title></head>' +
    '<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#0E1A2B;color:#B9C3D3;font:16px -apple-system,Helvetica,Arial,sans-serif;text-align:center">' +
    '<div><div style="font-size:40px">&#9749;</div>No URL set for this window.<br>Enter one in the Control Panel (Cmd+0).</div>' +
    '</body></html>',
  );
/** @type {BrowserWindow | null} */
let controlWindow = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;
// Parked windows: id -> { x, y, thumb } to restore from the dock.
const parked = new Map();
let collapsed = false;
/** @type {BrowserWindow | null} */
let dockWindow = null;
/** @type {Map<number, BrowserWindow>} display id -> cover strip */
const coverStrips = new Map();
let dockExpanded = false;

// ---------------------------------------------------------------------------
// OBS password (kept out of config.json, encrypted with the OS keychain)
// ---------------------------------------------------------------------------

const OBS_SECRET_PATH = path.join(app.getPath('userData'), 'obs-secret.bin');
const TAVERN_SECRET_PATH = path.join(app.getPath('userData'), 'tavern-secret.bin');
const TAVERN_TRUST_PATH = path.join(app.getPath('userData'), 'tavern-trust.bin');

function readSecret(file) {
  try {
    const raw = fs.readFileSync(file);
    if (raw.length === 0) return '';
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(raw);
    return raw.toString('utf8');
  } catch (err) {
    return '';
  }
}

function writeSecret(file, secret) {
  const text = typeof secret === 'string' ? secret : '';
  if (!text) {
    fs.rmSync(file, { force: true });
    return;
  }
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8');
  fs.writeFileSync(file, data);
}

// Which recording was the last one, and which files have ever gone up to
// YouTube. Kept on disk because "what did I just record, and did it
// upload?" has to survive a restart -- an update installed between the
// session and its upload used to lose the file entirely. Not secret (a local
// path and a public video URL), so a plain file rather than the encrypted
// blob.
const RECORDINGS_PATH = path.join(app.getPath('userData'), 'recordings.json');
const RECORDINGS_UPLOAD_LIMIT = 100;
function loadRecordings() {
  try {
    const d = JSON.parse(fs.readFileSync(RECORDINGS_PATH, 'utf8'));
    return {
      last: d && d.last && typeof d.last.path === 'string' ? { path: d.last.path, recordedAt: Number(d.last.recordedAt) || 0 } : null,
      uploads: d && d.uploads && typeof d.uploads === 'object' ? d.uploads : {},
      // Recordings the person chose to deal with themselves (see
      // resolveUploadDecision) -- no longer "never uploaded".
      handled: d && d.handled && typeof d.handled === 'object' ? d.handled : {},
    };
  } catch (err) {
    return { last: null, uploads: {}, handled: {} };
  }
}
let recordings = loadRecordings();
function saveRecordings() {
  for (const key of ['uploads', 'handled']) {
    const map = recordings[key];
    const paths = Object.keys(map);
    if (paths.length > RECORDINGS_UPLOAD_LIMIT) {
      const when = (p) => (typeof map[p] === 'number' ? map[p] : (map[p] && map[p].at) || 0);
      paths.sort((a, b) => when(a) - when(b));
      for (const old of paths.slice(0, paths.length - RECORDINGS_UPLOAD_LIMIT)) delete map[old];
    }
  }
  try {
    fs.writeFileSync(RECORDINGS_PATH, JSON.stringify(recordings));
  } catch (err) {
    // Losing this only costs the "already uploaded" memory -- never worth failing a recording over.
  }
}
function noteRecording(filePath) {
  if (!filePath || (recordings.last && recordings.last.path === filePath)) return;
  recordings.last = { path: filePath, recordedAt: Date.now() };
  saveRecordings();
  broadcastStatus();
}
function noteUpload(filePath, { videoId, url }) {
  recordings.uploads[filePath] = { at: Date.now(), videoId, url };
  saveRecordings();
}

const readObsPassword = () => readSecret(OBS_SECRET_PATH);
const writeObsPassword = (password) => writeSecret(OBS_SECRET_PATH, password);

// The Tavern's "remember this device for 30 days" cookie from a two-step
// sign-in, keyed by server address and login so switching either forgets
// the old one rather than sending it somewhere it doesn't belong.
function tavernTrustKey(url, login) {
  return `${url}|${login}`;
}
function readTavernTrust() {
  try {
    return JSON.parse(readSecret(TAVERN_TRUST_PATH) || '{}');
  } catch (err) {
    return {};
  }
}
function getTavernTrustCookie(url, login) {
  return readTavernTrust()[tavernTrustKey(url, login)] || '';
}
function saveTavernTrustCookie(url, login, cookie) {
  const all = readTavernTrust();
  const key = tavernTrustKey(url, login);
  if (cookie) all[key] = cookie;
  else delete all[key];
  writeSecret(TAVERN_TRUST_PATH, JSON.stringify(all));
}

// ---------------------------------------------------------------------------
// Activity log (Connections card, Configuration tab) -- a shared, in-memory record
// of state transitions and errors from OBS, Tavern, and Automations, so
// troubleshooting a bad connection doesn't mean reading main-process console
// output. Not persisted -- resets on restart.
// ---------------------------------------------------------------------------
const ACTIVITY_LOG_LIMIT = 100;
let activityLog = []; // newest first: {at, source, event, level}

function logActivity(source, event, level = 'info') {
  activityLog.unshift({ at: Date.now(), source, event, level });
  // The recorder's lines are also kept in a file, so they survive a restart and can be sent along when a recording goes wrong.
  if (source === 'Recorder') { try { fs.appendFileSync(path.join(app.getPath('userData'), 'recorder.log'), `${new Date().toISOString()} ${event}\n`); } catch (err) { /* logging is best effort */ } }
  activityLog.length = Math.min(activityLog.length, ACTIVITY_LOG_LIMIT);
  broadcastStatus();
}

// OBS is only connected to (and only retried) when the profile records with OBS. The connection details are shared by every profile,
// so this is where the profile's choice of recorder switches it off.
const obs = new ObsBridge({
  getSettings: () => { const c = configStore.get(); return c.recording.backend === 'obs' ? c.obs : { ...c.obs, autoConnect: false }; },
  getPassword: readObsPassword,
});
obs.lastRecordingPath = recordings.last ? recordings.last.path : '';
obs.on('recording', noteRecording);
let lastObsState = null;
obs.on('status', (s) => {
  if (s.state !== lastObsState) {
    lastObsState = s.state;
    logActivity('OBS', s.message || s.state, s.state === 'error' ? 'error' : 'info');
    if (s.state !== 'connected') syncAutoLevel().catch(() => {});
  } else {
    broadcastStatus();
  }
});
obs.on('connected', () => {
  syncObs().catch(() => {});
  syncTavern().catch(() => {});
  syncAutoLevel().catch(() => {});
});

// Auto level: keeps the Chameleon participants near the target loudness while a session runs.
// It runs only while it is switched on for the profile, Chameleon is on and OBS is connected.
const autoLevel = new AutoLevelService({
  bridge: obs,
  getPeople: () => {
    const t = configStore.get().tavern;
    return Object.entries(t.players)
      .filter(([, entry]) => entry.player && entry.source)
      .map(([key, entry]) => {
        const user = tavern.party.find((u) => u.key === key);
        return { key, input: entry.source, label: user && user.displayName ? user.displayName : entry.source };
      });
  },
  getTargetDb: () => configStore.get().tavern.levelTargetDb,
  saveLevel: (key, volumeDb) => {
    const current = configStore.get();
    const entry = current.tavern.players[key];
    if (!entry) return;
    configStore.save({ ...current, tavern: { ...current.tavern, players: { ...current.tavern.players, [key]: { ...entry, levelDb: volumeDb } } } });
  },
});
autoLevel.on('change', () => broadcastStatus());
async function syncAutoLevel() {
  const t = configStore.get().tavern;
  const wanted = Boolean(t.enabled && t.autoLevel && obs.connected);
  if (wanted && !autoLevel.running) await autoLevel.start();
  else if (!wanted && autoLevel.running) await autoLevel.stop();
}

// ---------------------------------------------------------------------------
// YouTube (uploads a finished recording -- see uploadToYouTube in
// runAutomationAction, and src/youtube.js for why this is OAuth's device
// flow rather than a loopback redirect). clientSecret and the refresh token
// share one encrypted file, same keychain-backed pattern as the OBS/Tavern
// passwords above; clientId is not secret and lives in config.json like
// obs.host does.
// ---------------------------------------------------------------------------

const YOUTUBE_SECRET_PATH = path.join(app.getPath('userData'), 'youtube-secret.bin');

function readYoutubeSecret() {
  const raw = readSecret(YOUTUBE_SECRET_PATH);
  if (!raw) return { clientSecret: '', refreshToken: '' };
  try {
    const parsed = JSON.parse(raw);
    return {
      clientSecret: typeof parsed.clientSecret === 'string' ? parsed.clientSecret : '',
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : '',
      uploadSession: parsed.uploadSession && typeof parsed.uploadSession === 'object' ? parsed.uploadSession : undefined,
    };
  } catch (err) {
    return { clientSecret: '', refreshToken: '' };
  }
}

function writeYoutubeSecret(patch) {
  writeSecret(YOUTUBE_SECRET_PATH, JSON.stringify({ ...readYoutubeSecret(), ...patch }));
}

const youtube = new YouTubeUploader({
  getCredentials: () => {
    const { clientId } = configStore.get().youtube;
    const { clientSecret, refreshToken } = readYoutubeSecret();
    return { clientId, clientSecret, refreshToken };
  },
  saveRefreshToken: (refreshToken) => writeYoutubeSecret({ refreshToken }),
  // An in-flight upload's session URL is effectively a bearer capability
  // (whoever has it can push bytes into that upload), so it lives in the
  // same encrypted blob as the refresh token rather than a plain file.
  loadUploadSession: () => readYoutubeSecret().uploadSession || null,
  saveUploadSession: (uploadSession) => writeYoutubeSecret({ uploadSession: uploadSession || undefined }),
});
// Set only while a device-flow connect is in progress, so a control-panel
// reload mid-flow can still show the code the user needs to enter --
// cleared on success, failure, or starting a fresh connect.
let youtubeConnectState = null;
// True once Google has refused the saved refresh token (expired or revoked):
// a stored token that no longer works is not "connected", and showing it as
// such is what hid this until an upload failed with a bare "Bad Request".
// Cleared by a fresh connect, a disconnect, or an upload that works.
let youtubeConnectionExpired = false;
// Set when a session start was refused because the last recording never
// uploaded -- what makes the control panel show its upload / do-it-myself
// choice. Cleared by answering it or closing it (closing it leaves the
// recording pending, so the next start asks again).
let pendingUploadDecision = null; // { path, name }
// ruleSetId -> 0-100, only while that rule set's uploadToYouTube step is
// actively uploading -- lets the Automations tab show a live progress bar
// on the specific card doing the upload. See runYouTubeUpload.
const youtubeUploadProgress = new Map();
// The upload in flight, if any, whether or not a rule set started it -- the
// footer's progress readout (visible on every tab) reads this, where the
// per-rule-set map above only feeds the one card that's uploading.
let youtubeUploadActive = null; // { title, file, percent }

// ---------------------------------------------------------------------------
// Coffee Pub Tavern (the party's voice and video; each player an OBS source)
// ---------------------------------------------------------------------------

const tavern = new TavernBridge({
  getSettings: () => configStore.get().tavern,
  getPassword: () => readSecret(TAVERN_SECRET_PATH),
  getTrustCookie: getTavernTrustCookie,
  saveTrustCookie: saveTavernTrustCookie,
});
// What the last sync found in OBS, shown on the Tavern tab.
let tavernSync = { at: 0, inputs: [], created: [], updated: [], renamed: [], missing: [], note: '' };
let lastTavernState = null;
tavern.on('status', (s) => {
  if (s.state !== lastTavernState) {
    lastTavernState = s.state;
    logActivity('Chameleon', s.message || s.state, s.state === 'error' ? 'error' : 'info');
  } else {
    broadcastStatus();
  }
});
tavern.on('connected', () => syncTavern().catch(() => {}));
tavern.on('party', () => syncTavern().catch(() => {}));

function tavernSourceName(user, kind = 'player', n = 1) {
  const type = kind === 'character' ? 'Character' : 'Participant';
  const name = n > 1 ? `${user.displayName} ${n}` : user.displayName;
  return `${type}: ${name}${SOURCE_SUFFIX}`;
}

// A room's profile gates which source kinds it offers: 'roleplaying' (the
// default, for a room with no profile) offers both, 'participants' offers
// only the Participant source, 'characters' offers only the Character source.
// This is the same room the Tavern tab's picker is showing -- a purely
// manual choice, "this room is for this OBS session," never overridden by
// wherever the admin happens to be live -- everyone is a member of Lobby as
// well as their own room, so picking "the first room this user belongs to"
// would silently resolve to Lobby's profile instead of the room actually
// on screen.
function currentTavernRoom() {
  const t = configStore.get().tavern;
  return tavern.room(t.space || 'lobby');
}
function allowsPlayer(room) {
  return !room || room.profile !== 'characters';
}
function allowsCharacter(room) {
  return !room || room.profile !== 'participants';
}

// The Participant source: video, or the player image when the camera is off,
// with the talking border, overlay images and name plate as set on the
// Tavern. Audio always on and routed to the OBS mixer.
function tavernPlayerSource(user) {
  const t = configStore.get().tavern;
  return { url: tavern.viewUrl(user, { kind: 'player' }), width: t.playerWidth, height: t.playerHeight, audio: true };
}

// The Character source: the character image with talking and muted images on
// top; transparent until they talk or mute when there is no character image.
function tavernCharacterSource(user) {
  const t = configStore.get().tavern;
  return { url: tavern.viewUrl(user, { kind: 'character' }), width: t.characterWidth, height: t.characterHeight, audio: false };
}

// Make OBS match the published players: one Browser Source each, named after
// the player, pointed at their view link at the chosen size.
// Sources already hidden because their room stopped offering that kind, so
// syncTavern does not re-issue the same OBS visibility call every poll.
const gatedHidden = new Set();

// Carries out the renames migrateSourceNames queued, once OBS is there to do
// them: a source still under its old name is renamed; one already gone, or
// whose new name is taken, is simply dropped from the list. Both syncs call
// this first so neither mistakes a not-yet-renamed source for a missing one;
// the shared promise keeps them from racing each other.
let pendingRenamesRun = null;
function applyPendingSourceRenames() {
  if (pendingRenamesRun) return pendingRenamesRun;
  pendingRenamesRun = (async () => {
    try {
      const pending = readPendingSourceRenames();
      const oldNames = Object.keys(pending);
      if (!oldNames.length || !obs.connected) return;
      const names = await obs.allInputNames();
      for (const oldName of oldNames) {
        const newName = pending[oldName];
        try {
          if (names.has(oldName) && !names.has(newName)) {
            await obs.renameInput(oldName, newName);
            names.delete(oldName);
            names.add(newName);
            logActivity('OBS', `Renamed source "${oldName}" to "${newName}".`, 'info');
          }
          delete pending[oldName];
        } catch (err) {
          logActivity('OBS', `Could not rename source "${oldName}": ${err.message}`, 'error');
        }
      }
      writePendingSourceRenames(pending);
    } finally {
      pendingRenamesRun = null;
    }
  })();
  return pendingRenamesRun;
}

async function syncTavern() {
  await applyPendingSourceRenames().catch(() => {});
  const report = { at: Date.now(), inputs: [], created: [], updated: [], renamed: [], missing: [], hidden: [], note: '' };
  const t = configStore.get().tavern;
  const entries = Object.entries(t.players);
  if (!tavern.connected) {
    report.note = 'Not signed in to Chameleon.';
    tavernSync = report;
    broadcastStatus();
    return report;
  }
  if (!obs.connected) {
    report.note = 'OBS is not connected; sources are created when it is.';
    report.missing = entries.map(([, e]) => e.source);
    tavernSync = report;
    broadcastStatus();
    return report;
  }
  const inputs = await obs.browserInputs();
  report.inputs = inputs.map((i) => i.name);
  const players = { ...t.players };
  let changedConfig = false;
  const ourNames = () => new Set(Object.values(players).flatMap((p) => [p.source, p.characterSource].filter(Boolean)));
  // One OBS Browser Source: create it, re-point it, follow a rename.
  const ensure = async (key, field, kind, user, wanted) => {
    const entry = players[key];
    let name = entry[field];
    if (!name) return;
    const preferred = tavernSourceName(user, kind);
    if (name !== preferred && !inputs.some((i) => i.name === preferred) && !ourNames().has(preferred)) {
      if (inputs.some((i) => i.name === name)) {
        await obs.renameInput(name, preferred);
        report.renamed.push(`${name} -> ${preferred}`);
      }
      const input = inputs.find((i) => i.name === name);
      if (input) input.name = preferred;
      name = preferred;
      players[key] = { ...entry, [field]: name };
      changedConfig = true;
    }
    const existing = inputs.find((i) => i.name === name);
    if (!existing) {
      await obs.createBrowserInput(name, wanted);
      inputs.push({ name, ...wanted, rerouteAudio: wanted.audio });
      report.created.push(name);
      // A new participant gets the standard audio chain, if that is on. A failure
      // here must not stop the source from being created, so it is only logged.
      // ...and the volume Calibrate settled on for this person, if they have been calibrated.
      if (wanted.audio && entry.levelDb !== null && entry.levelDb !== undefined) {
        await obs.setInputVolumeDb(name, entry.levelDb).catch(() => {});
      }
      if (wanted.audio && t.audioFilters) {
        await obs.addLevelingFilters(name).catch((err) => logActivity('Chameleon', `Could not add audio filters to ${name}: ${err.message}`, 'error'));
      }
    } else if (existing.url !== wanted.url || existing.width !== wanted.width || existing.height !== wanted.height || existing.rerouteAudio !== wanted.audio) {
      await obs.setBrowserInput(name, wanted);
      Object.assign(existing, wanted, { rerouteAudio: wanted.audio });
      report.updated.push(name);
    }
  };
  // A room's profile may have changed since a source was published (or the
  // server may not have sent a profile at all before this existed): hide
  // whichever source the room no longer offers instead of maintaining it,
  // and re-show it (if its tick is still on) once the room allows it again.
  // The tick and the source name are left alone either way -- this is not
  // the user unpublishing, so nothing should look "removed" or lose its
  // OBS placement; Delete from OBS is the only thing that deletes it.
  const gateSource = async (key, kind, name, ticked, allowed) => {
    if (!name) return;
    if (!allowed) {
      if (gatedHidden.has(name)) return;
      await obs.setSourceVisible(name, false).catch(() => {});
      gatedHidden.add(name);
      report.hidden.push(`${name}: this room offers ${kind === 'character' ? 'Participant' : 'Character'} sources only`);
      return;
    }
    if (gatedHidden.delete(name) && ticked) await obs.setSourceVisible(name, true).catch(() => {});
  };
  const room = currentTavernRoom();
  for (const [key] of entries) {
    const user = tavern.party.find((u) => u.key === key);
    if (!user) continue; // deleted on the server; the card shows it
    const entry = players[key];
    await gateSource(key, 'player', entry.source, entry.player, allowsPlayer(room));
    await gateSource(key, 'character', entry.characterSource, entry.character, allowsCharacter(room));
    if (entry.source && allowsPlayer(room)) await ensure(key, 'source', 'player', user, tavernPlayerSource(user));
    if (entry.characterSource && allowsCharacter(room)) await ensure(key, 'characterSource', 'character', user, tavernCharacterSource(user));
  }
  // Two independent, separately-triggered mutes for someone who isn't part
  // of the current conversation right now -- checked per source, not just
  // per user, since a user's actual room and Enable Asides can each change
  // independently of the other. Neither hides or dims the source -- Tavern
  // owns everything visual now (its own page is what's actually on screen);
  // Studio only ever mutes.
  //
  // - Private Conversation (`ephemeral && private`): muted for as long as
  //   they're live in it. Unconditional -- a privacy guarantee, not a
  //   production preference, so it does not depend on Enable Asides and
  //   cannot be left accidentally off by an unrelated setting. What's
  //   actually shown for them while private is Tavern's call, per our
  //   agreement -- Studio no longer hides the source itself.
  // - Live, but in a different room than wherever the admin/GM currently
  //   is (`tavern.activeRoom`, only meaningful while an admin actually is
  //   online -- with none online there's no "current conversation" to be
  //   aside from, so nobody is treated as aside in that case, same bug in
  //   a new form otherwise): muted, since they're genuinely live elsewhere
  //   with real audio that would otherwise bleed into the stream. This is
  //   NOT the dropdown's manually-picked room (`room`, used only for
  //   Participant/Character gating above) -- when the GM steps into a
  //   pulled-aside room, THAT becomes the live conversation, and everyone
  //   else (including anyone left behind in the room the dropdown still
  //   shows) is who should mute, not the people the GM actually pulled
  //   aside. Only while Enable Asides is on, and only for someone actually
  //   elsewhere -- ordinary room navigation by the operator (the dropdown)
  //   must never mute anyone, that was the original bug.
  // Offline is deliberately NOT muted here -- there's no live audio track
  // from a source that isn't even in the Tavern call, so muting it would be
  // a no-op with nothing to suppress.
  const adminOnline = tavern.party.some((u) => u.role === 'admin' && u.online);
  {
    for (const [key, entry] of entries) {
      const user = tavern.party.find((u) => u.key === key);
      if (!user) continue;
      const stepRoom = user.online ? tavern.rooms.find((r) => r.id === user.online.room) : null;
      const inPrivateRoom = Boolean(stepRoom && stepRoom.ephemeral && stepRoom.private);
      const offline = !inPrivateRoom && !user.online;
      const steppedOutToAside = t.followAdmin && adminOnline && !inPrivateRoom && !offline && user.online.room !== tavern.activeRoom;
      const apply = async (name) => {
        // A source its room's profile doesn't offer is hidden entirely by
        // the gating pass above; leave that alone rather than layer a
        // second, unrelated reason for hiding it on top.
        if (!name || gatedHidden.has(name)) return;
        await obs.setInputMuted(name, steppedOutToAside || inPrivateRoom).catch(() => {});
        await obs.removeDimFilter(name).catch(() => {});
      };
      await apply(entry.source);
      await apply(entry.characterSource);
    }
  }
  if (changedConfig) {
    const current = configStore.get();
    configStore.save({ ...current, tavern: { ...current.tavern, players } });
  }
  report.inputs = inputs.map((i) => i.name);
  tavernSync = report;
  broadcastStatus();
  return report;
}

// A fresh source name: never take over a Browser Source that is not ours.
// The number that disambiguates a collision (two people sharing a display
// name, most likely) goes on the person's name, not after the "(CPS)"
// tail.
function freeSourceName(user, kind, players) {
  const ours = new Set(Object.values(players).flatMap((p) => [p.source, p.characterSource].filter(Boolean)));
  const taken = new Set(tavernSync.inputs.filter((inputName) => !ours.has(inputName)));
  let count = 1;
  let name = tavernSourceName(user, kind, count);
  while (taken.has(name)) name = tavernSourceName(user, kind, ++count);
  return name;
}

// A user's entry: which sources they get (the Participant and Character
// ticks) and the OBS source names while published. Untouched users default
// to Participant on and Character per the Configuration tab setting.
function playerEntry(tavernConfig, key) {
  const entry = tavernConfig.players[key];
  return {
    player: entry && entry.player !== undefined ? entry.player : true,
    character: entry && entry.character !== undefined ? entry.character : tavernConfig.characterWithPlayer,
    source: (entry && entry.source) || '',
    characterSource: (entry && entry.characterSource) || '',
  };
}

function isPublished(entry) {
  return Boolean(entry && (entry.source || entry.characterSource));
}

// Make a user's OBS sources match `wanted` ({ player, character }): create
// a source the first time it's ticked on, otherwise just show or hide the
// one it already has -- turning a tick off never deletes anything in OBS,
// so any placement, scale or filters set by hand there survive. Deleting a
// source is a separate, explicit action (Delete from OBS).
async function applyPublish(key, wanted) {
  const user = tavern.party.find((u) => u.key === key);
  if (!user) throw new Error('That user is not on Chameleon any more.');
  const current = configStore.get();
  const players = { ...current.tavern.players };
  const room = currentTavernRoom();
  if (wanted.player && !allowsPlayer(room)) throw new Error('This room offers Character sources only.');
  if (wanted.character && !allowsCharacter(room)) throw new Error('This room offers Participant sources only.');
  const entry = { ...playerEntry(current.tavern, key), ...wanted };
  if (entry.player && !entry.source) entry.source = freeSourceName(user, 'player', players);
  if (entry.character && !entry.characterSource) entry.characterSource = freeSourceName(user, 'character', players);
  players[key] = entry;
  configStore.save({ ...current, tavern: { ...current.tavern, players } });
  if (entry.source) await obs.setSourceVisible(entry.source, entry.player).catch(() => {});
  if (entry.characterSource) await obs.setSourceVisible(entry.characterSource, entry.character).catch(() => {});
  if (entry.player) gatedHidden.delete(entry.source);
  if (entry.character) gatedHidden.delete(entry.characterSource);
  await syncTavern();
  return players[key];
}

// Publish: the sources a user has ticked.
async function publishPlayer(key) {
  const entry = playerEntry(configStore.get().tavern, key);
  if (!entry.player && !entry.character) throw new Error('Tick Participant or Character first.');
  return applyPublish(key, { player: entry.player, character: entry.character });
}

// A tick changed: remembered always, applied at once when they are published.
async function setChoice(key, field, on) {
  if (field !== 'player' && field !== 'character') throw new Error('Unknown option.');
  const room = currentTavernRoom();
  if (on && field === 'player' && !allowsPlayer(room)) throw new Error('This room offers Character sources only.');
  if (on && field === 'character' && !allowsCharacter(room)) throw new Error('This room offers Participant sources only.');
  const current = configStore.get();
  const entry = playerEntry(current.tavern, key);
  if (isPublished(entry)) return applyPublish(key, { [field]: on });
  const players = { ...current.tavern.players, [key]: { ...entry, [field]: on } };
  configStore.save({ ...current, tavern: { ...current.tavern, players } });
  broadcastStatus();
  return players[key];
}

async function removeObsInput(name) {
  if (!name || !obs.connected) return;
  const inputs = await obs.browserInputs().catch(() => []);
  if (inputs.some((i) => i.name === name)) await obs.removeInput(name);
}

// Unpublish: remove the sources; the ticks stay as they were.
async function unpublishPlayer(key, removeFromObs = true) {
  const current = configStore.get();
  const players = { ...current.tavern.players };
  const entry = players[key];
  if (!entry) return;
  players[key] = { ...entry, source: '', characterSource: '' };
  configStore.save({ ...current, tavern: { ...current.tavern, players } });
  if (removeFromObs) {
    await removeObsInput(entry.source);
    await removeObsInput(entry.characterSource);
  }
  await syncTavern();
}

// ---------------------------------------------------------------------------
// Automations (Foundry modules, e.g. Herald, -> Studio -> OBS)
// ---------------------------------------------------------------------------

const automations = new AutomationsServer();
let lastAutomationsState = null;
automations.on('status', (s) => {
  if (s.state !== lastAutomationsState) {
    lastAutomationsState = s.state;
    logActivity('Automations', s.message || s.state, s.state === 'error' ? 'error' : 'info');
  } else {
    broadcastStatus();
  }
});
automations.on('event', (entry) => {
  logActivity('Automations', `Event received: ${entry.event}`, 'info');
  runAutomationRuleSets(entry).catch((err) => {
    console.warn(`[automations] rule set dispatch failed: ${err.message}`);
    logActivity('Automations', `Rule set dispatch failed: ${err.message}`, 'error');
  });
});

// The built-in recorder reads the pages of the windows the profile chose (the page inside each window, without its bar).
const builtInRecorder = new BuiltInRecorder({
  getSources: (ids) => ids.map((id) => pageViews.get(id)).filter((page) => page && !page.webContents.isDestroyed()).map((page) => page.webContents),
  // For screen capture: each chosen window's id for the system, and where its page sits inside the window (the bar and frame are cropped away).
  getCaptureInfo: (ids) => ids.map((id) => {
    const win = viewWindows.get(id); const page = pageViews.get(id);
    if (!win || win.isDestroyed() || !page) return null;
    const b = win.getBounds(); const c = win.getContentBounds(); const p = page.getBounds();
    return { sourceId: win.getMediaSourceId(), winW: b.width, winH: b.height, rect: { x: c.x - b.x + p.x, y: c.y - b.y + p.y, w: p.width, h: p.height } };
  }).filter(Boolean),
  folderFor: (folder) => folder || app.getPath('videos'),
  windowName: (id) => { const v = configStore.getView(id); return v ? (v.label || v.id) : id; },
  dataDir: app.getPath('userData'),
  markerFile: path.join(app.getPath('userData'), 'recording-in-progress.json'), // left behind only if the app closes mid-recording
  // The session filename format names the file, the same one OBS uses; blank falls back to "Showrunner <date> <time>".
  nameFor: () => {
    const format = configStore.get().session.filenameFormat;
    return format ? nameFromTemplate(formatSessionTemplate(format, undefined, undefined, sanitizeFilenameValue)) : defaultName();
  },
});
builtInRecorder.on('recording', noteRecording);
builtInRecorder.on('diag', (text) => logActivity('Recorder', text, 'error'));
const tapInfoSeen = new Set();
builtInRecorder.on('tapinfo', (senderId, text) => {
  const entry = [...pageViews.entries()].find(([, page]) => !page.webContents.isDestroyed() && page.webContents.id === senderId);
  const v = entry && configStore.getView(entry[0]);
  const key = `${senderId}:${text}`;
  if (tapInfoSeen.has(key)) return;
  tapInfoSeen.add(key);
  logActivity('Recorder', `${v ? (v.label || v.id) : 'A window'}: ${text}`, 'info');
});
let lastRecorderState = 'idle';
builtInRecorder.on('status', () => {
  const now = builtInRecorder.state;
  // The toolbar opens by itself when a recording starts (unless switched off on the recorder page), without taking focus.
  if (now === 'recording' && lastRecorderState !== 'recording' && lastRecorderState !== 'paused' && configStore.get().recording.toolbar.auto) openToolbar({ focus: false });
  if (now === 'idle' && lastRecorderState !== 'idle') scheduleWarm(); // ready again for the next recording
  lastRecorderState = now;
  broadcastStatus();
  sendToolbarState();
});
builtInRecorder.on('idle', (peaks) => {
  if (isAlive(controlWindow)) controlWindow.webContents.send('recording:idleLevels', peaks);
  if (isAlive(toolbarWindow)) toolbarWindow.webContents.send('toolbar:idle', peaks);
});
builtInRecorder.on('mask', (mask) => {
  if (isAlive(toolbarWindow)) toolbarWindow.webContents.send('toolbar:mask', mask);
  if (isAlive(controlWindow) && camPreviewOn) controlWindow.webContents.send('recording:mask', mask);
});
builtInRecorder.on('levels', (levels) => {
  if (isAlive(controlWindow)) controlWindow.webContents.send('recording:levels', levels);
  if (isAlive(toolbarWindow)) toolbarWindow.webContents.send('toolbar:levels', levels);
});
const recordingBackends = new RecordingBackends(
  [new ObsBackend(obs), new BuiltInBackend(builtInRecorder, () => configStore.get().recording)],
  () => configStore.get().recording.backend,
);

function requireObs() {
  if (!obs.connected) throw new Error('OBS is not connected.');
}

// Strips characters a resolved Data Field value could carry that a
// filesystem path can't -- most urgently "/" (a US-locale {sessionDate}
// reads "9/18/2026"; OBS writes that literally, and a "/" in a filename
// argument is a real directory separator, not text, so it silently created
// nested folders instead of one .mkv). Also covers the rest of Windows'
// reserved set (backslash, colon, the four others below) ahead of the
// Windows build, since a value born on macOS ends up in the same template.
// Control characters are dropped outright. Deliberately narrow: this only
// ever touches a *substituted* value (see formatSessionTemplate's
// `sanitizeValue`), never literal characters the user typed into the
// template itself.
function sanitizeFilenameValue(value) {
  return String(value)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\x00-\x1f]/g, '')
    .trim();
}

// Substitutes {title}/{campaign} (from eventData -- whatever triggered
// this, e.g. Herald's POST /event data; blank when there is none, such as
// a manual "Time it" run) into a user-configured template -- kept as their
// own fixed aliases since they read from eventData directly, not through
// resolveDataField's fallback-to-eventData branch (same outcome, just not
// routed through the key-lookup logic that only makes sense for a Data
// Field key).
// Any OTHER {name} in the template -- {sessionCampaign}, {sessionDaysLeft},
// {sessionTime}, anything resolveDataField (below) understands -- is
// resolved the same way a setText step's Data Field picker would: a pure
// read, never a mutation. Used by applySessionFilename; anything OBS's own
// %-style recording macros use is untouched, since this only ever replaces
// {..}-bracketed names.
// `sanitizeValue`, when given, runs on each *substituted* value only (not
// on the template's own literal characters) -- applySessionFilename passes
// one to strip filesystem-reserved characters a resolved value could carry
// (a locale date like "9/18/2026", or event data straight off the wire),
// since those would otherwise reach OBS's FilenameFormatting unsanitized
// and get split into real subdirectories on disk (a literal live bug: a
// missing Herald title defaulted to a placeholder and {sessionDate}'s
// slashes turned every recording into a three-level folder tree instead of
// one file). Every other caller (a setText step, a YouTube title/
// description) passes no sanitizer, since a "/" is perfectly legitimate
// there.
function formatSessionTemplate(template, eventData, chain, sanitizeValue) {
  const legacy = {
    title: eventData && typeof eventData.title === 'string' ? eventData.title : '',
    campaign: eventData && typeof eventData.campaign === 'string' ? eventData.campaign : '',
  };
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, key) => {
    const value = Object.prototype.hasOwnProperty.call(legacy, key) ? legacy[key] : resolveDataField(key, eventData, chain);
    return sanitizeValue ? sanitizeValue(value) : value;
  });
}

// Resolves one Data Field key to a string, in this order -- see
// plan-session-metadata-fields.md for the full design:
//   1. An evergreen field (today's date/time) -- computed fresh, no storage.
//   2. A user-created metadataFields entry, by key -- "text"/"number" as
//      you'd expect, plus "textNumber"/"numberText": a fixed text segment
//      glued to a number segment via a typed separator ("Chapter" + "5" ->
//      "Chapter 5"), the number segment optionally zero-padded.
//   3. Not a Studio-known key at all -- fall through to eventData[key]
//      (whatever the triggering event actually sent), the original and
//      only behavior before Studio had any fields of its own.
// A pure read, always -- bumping a Number (or a compound field's number
// segment) is its own explicit action (incrementMetadataField /
// decrementMetadataField, below), not something reading a value can also
// trigger as a side effect. That used to be a trailing "+1"/"-1" on the key
// itself; retired once it became clear that hiding a mutation inside a read
// meant the same field could get bumped twice if two different places both
// referenced its "+1" variant during what was conceptually one action (see
// the "Composing rule sets" note in architecture-automations.md).
function resolveDataField(key, eventData, chain = new Set()) {
  const now = new Date();
  if (key === 'sessionTime') return now.toLocaleTimeString();
  if (key === 'sessionDate') return now.toLocaleDateString();
  if (key === 'sessionDay') return now.toLocaleDateString(undefined, { weekday: 'long' });
  if (key === 'sessionMonth') return now.toLocaleDateString(undefined, { month: 'long' });
  if (key === 'sessionYear') return String(now.getFullYear());

  const field = configStore.get().metadataFields.find((f) => f.key === key);
  if (field) {
    if (field.type === 'textNumber' || field.type === 'numberText') {
      const numberText = field.padding ? String(field.number).padStart(field.padding, '0') : String(field.number);
      return field.type === 'textNumber' ? `${field.text}${field.separator}${numberText}` : `${numberText}${field.separator}${field.text}`;
    }
    if (field.type === 'checkbox') return field.value ? 'Yes' : 'No';
    // A Text field's value can itself contain {token} references (same
    // syntax as the Recording Filename format) -- expanded unconditionally,
    // not opt-in, since a literal value with no {..} in it passes through
    // this untouched anyway (there used to be a separate "Template" type
    // for this; it added a choice without adding a real capability, since
    // Text already had to support everything Template did). Tracks which
    // keys are already being expanded on this branch so a field that
    // references itself, directly or through another Text field, comes
    // back blank instead of recursing forever.
    // "prompt" is stored exactly like Text (see sanitizeMetadataField,
    // src/config.js) and gets the same {token} expansion when read -- the
    // only thing that makes it different is how it gets its value in the
    // first place (see checkAndApplyPrompts below), not how it reads back.
    if (field.type === 'text' || field.type === 'prompt') {
      if (chain.has(key)) return '';
      return formatSessionTemplate(String(field.value), eventData, new Set(chain).add(key));
    }
    // "number" gets the same optional zero-padding a Text+Number/
    // Number+Text field's own number segment already has -- otherwise
    // composing a plain Number into a Text field's {token} template (e.g.
    // "S{sessionSeasonCounter}") had no way to pad at all.
    if (field.type === 'number') return field.padding ? String(field.value).padStart(field.padding, '0') : String(field.value);
    return String(field.value);
  }

  return eventData && typeof eventData[key] === 'string' ? eventData[key] : '';
}

// What a setText step actually writes -- "where it goes" is `param`
// (the source name), this is "what it is", one of three kinds a user
// picks explicitly rather than one ambiguous free-text field:
//   - "literal": a fixed value, typed once, the same every run -- no
//     external caller involved, for a preset the user swaps in by hand
//     (a rule set is still the way to trigger it) or via Herald picking a
//     rule set from its own menu with no data needed at all.
//   - "file": a local text file, read fresh every run.
//   - "dataField": a Data Field key -- see resolveDataField above for the
//     full resolution order (Studio's own built-ins and metadata fields
//     first, the triggering event's own data as the fallback).
// `stepContext` is the whole step object for a rule-set-driven run
// (carrying whichever of value/filePath/dataField its valueType uses), or
// `undefined` for a direct `POST /api/automations/action` call or a "Time
// it" step -- undefined keeps the original convention of reading
// `eventData.text` literally, since a direct caller already fully
// controls what it sends and has no step config to consult.
function resolveTextValue(stepContext, eventData) {
  if (!stepContext) {
    return eventData && typeof eventData.text === 'string' ? eventData.text : '';
  }
  if (stepContext.valueType === 'file') {
    try {
      return fs.readFileSync(stepContext.filePath, 'utf8').trim();
    } catch (err) {
      throw new Error(`Could not read text file "${stepContext.filePath}": ${err.message}`);
    }
  }
  if (stepContext.valueType === 'dataField') {
    return resolveDataField(stepContext.dataField || 'text', eventData);
  }
  return stepContext.value || ''; // "literal", and the default for anything unrecognised
}

// setMetadataField's own value, same three-source shape as resolveTextValue
// just above (fixed/file/event-data-field) -- but for a direct
// `POST /api/automations/action` call (no stepContext), it reads
// `data.value` rather than `data.text`, since "the value to store in this
// field" reads more plainly than reusing setText's own key name for an
// unrelated action.
function resolveMetadataFieldValue(stepContext, eventData) {
  if (!stepContext) {
    return eventData && typeof eventData.value === 'string' ? eventData.value : '';
  }
  if (stepContext.valueType === 'file') {
    try {
      return fs.readFileSync(stepContext.filePath, 'utf8').trim();
    } catch (err) {
      throw new Error(`Could not read text file "${stepContext.filePath}": ${err.message}`);
    }
  }
  if (stepContext.valueType === 'dataField') {
    return resolveDataField(stepContext.dataField || 'value', eventData);
  }
  return stepContext.value || ''; // "literal", and the default for anything unrecognised
}

// Finds every "prompt"-type Metadata field a rule set's steps would touch if
// it ran right now, walking into any nested runRuleSet target the same way
// actually running the rule set would (cycle-guarded, same idea as
// runRuleSet's own `chain`) -- this is what lets GET /capabilities'
// per-rule-set `prompts` list (and the run-time gate below) be correct for
// a rule set like "Begin Session Recording" that never references
// sessionTitle directly, only through the "Set Session Info" rule set it
// calls via runRuleSet. A static, dry-run mirror of the same {token}/
// Text-field-composition walk resolveDataField/formatSessionTemplate do at
// read time -- it doesn't call them, since it needs to *find* prompt keys
// rather than produce a final string, but it follows the identical
// structure so it can't drift out of sync with what actually gets read.
function collectRequiredPrompts(ruleSet, allRuleSets, metadataFields, seenRuleSets = new Set(), out = new Set()) {
  if (seenRuleSets.has(ruleSet.id)) return out;
  const nextSeenRuleSets = new Set(seenRuleSets).add(ruleSet.id);

  const addKey = (key, fieldChain = new Set()) => {
    if (!key || fieldChain.has(key)) return;
    const field = metadataFields.find((f) => f.key === key);
    if (!field) return; // evergreen or unknown to Studio -- never a prompt
    if (field.type === 'prompt') {
      out.add(key);
      return;
    }
    if (field.type === 'text') addTemplate(String(field.value), new Set(fieldChain).add(key));
  };
  const addTemplate = (template, fieldChain = new Set()) => {
    for (const m of String(template || '').matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) addKey(m[1], fieldChain);
  };

  for (const step of ruleSet.steps) {
    if (step.type !== 'action') continue;
    if ((step.action === 'setText' || step.action === 'setVolume' || step.action === 'setMetadataField') && step.valueType === 'dataField') {
      addKey(step.dataField || (step.action === 'setMetadataField' ? 'value' : 'text'));
    } else if (step.action === 'applySessionFilename') {
      // The *current* filename template, same one applySessionFilename
      // itself would actually read at run time.
      const { filenameFormat } = configStore.get().session;
      if (filenameFormat) addTemplate(filenameFormat);
    } else if (step.action === 'uploadToYouTube') {
      for (const f of [step.titleField, step.descriptionField, step.categoryField, step.visibilityField]) addKey(f);
    } else if (step.action === 'runRuleSet' && step.param) {
      const target = allRuleSets.find((r) => r.id === step.param);
      if (target) collectRequiredPrompts(target, allRuleSets, metadataFields, nextSeenRuleSets, out);
    }
  }
  return out;
}

// A rule set that starts a recording, directly or through runRuleSet.
function ruleSetStartsRecording(ruleSet, allRuleSets, seen = new Set()) {
  if (seen.has(ruleSet.id)) return false;
  seen.add(ruleSet.id);
  for (const step of ruleSet.steps || []) {
    if (step.type !== 'action' || step.enabled === false) continue;
    if (step.action === 'startRecording') return true;
    if (step.action === 'runRuleSet' && step.param) {
      const target = allRuleSets.find((r) => r.id === step.param);
      if (target && ruleSetStartsRecording(target, allRuleSets, seen)) return true;
    }
  }
  return false;
}

// The enabled rule sets that upload a recording -- what "upload it now" runs.
function uploadRuleSets() {
  return configStore
    .get()
    .automations.ruleSets.filter((r) => r.enabled && (r.steps || []).some((s) => s.type === 'action' && s.enabled !== false && s.action === 'uploadToYouTube'));
}

// The last recording, if it exists on disk and never reached YouTube and
// was never set aside by hand -- and only when uploading is actually
// something this setup does (YouTube on, with a rule set that uploads).
function pendingUpload() {
  if (!configStore.get().youtube.enabled) return null;
  const last = recordings.last;
  if (!last || recordings.uploads[last.path] || recordings.handled[last.path]) return null;
  if (!fs.existsSync(last.path)) return null;
  if (!uploadRuleSets().length) return null;
  return { path: last.path, name: path.basename(last.path) };
}

function raiseUploadDecision(pending) {
  const first = !pendingUploadDecision;
  pendingUploadDecision = { path: pending.path, name: pending.name };
  broadcastStatus();
  if (first) {
    logActivity('YouTube', `A new session was held back: the last recording was never uploaded (${pending.name}).`, 'info');
    if (Notification.isSupported()) {
      new Notification({ title: APP_NAME, body: `The last recording was never uploaded. Open ${APP_NAME} to upload it or set it aside, then start again.` }).show();
    }
  }
}

// The answer to that choice (youtube:resolveUpload). 'upload' runs the
// upload rule set through the same event path a real trigger takes, so its
// progress, success steps and failure notice all behave as usual.
function resolveUploadDecision(choice, clear) {
  const decision = pendingUploadDecision;
  if (choice === 'dismiss' || !decision) {
    pendingUploadDecision = null;
    broadcastStatus();
    return;
  }
  if (choice === 'upload') {
    const ruleSet = uploadRuleSets()[0];
    if (!ruleSet) throw new Error('No rule set uploads to YouTube.');
    const result = checkAndApplyPrompts(ruleSet.event, {});
    if (!result.ok) throw new Error(result.error);
    pendingUploadDecision = null;
    broadcastStatus();
    automations.recordEvent(ruleSet.event, {});
    return;
  }
  if (choice === 'manual') {
    recordings.handled[decision.path] = Date.now();
    saveRecordings();
    if (clear) {
      const current = configStore.get();
      const keys = new Set();
      for (const ruleSet of uploadRuleSets()) {
        for (const key of collectRequiredPrompts(ruleSet, current.automations.ruleSets, current.metadataFields)) keys.add(key);
      }
      configStore.save({
        ...current,
        metadataFields: current.metadataFields.map((f) => (f.type === 'prompt' && keys.has(f.key) ? { ...f, value: '' } : f)),
      });
    }
    pendingUploadDecision = null;
    logActivity('YouTube', `Left ${decision.name} for a manual upload${clear ? ' and cleared its title and description' : ''}.`, 'info');
    broadcastStatus();
  }
}

// Whether a Prompt field currently has no answer -- the one thing that
// actually makes it "required" right now, as opposed to merely "touched by
// this rule set's steps" (which is all collectRequiredPrompts itself knows).
// Shared by checkAndApplyPrompts (enforcement) and getRuleSets's own
// `prompts` annotation below (GET /capabilities, i.e. discovery) so the two
// can never drift apart the way they did live: capabilities kept listing a
// field as required after it had already been answered and persisted --
// checkAndApplyPrompts correctly let the run through regardless (it did its
// own blank check), but a caller like Herald, reasonably reading
// capabilities' `prompts` to decide whether to show a dialog, had no way to
// know the field didn't actually need asking again.
function isPromptFieldBlank(metadataFields, key) {
  const field = metadataFields.find((f) => f.key === key);
  return !(field && typeof field.value === 'string' && field.value);
}

// The enforcement half of collectRequiredPrompts: a rule set that touches a
// "prompt" field cannot run while that field is genuinely blank, without a
// fresh answer supplied in the exact same call that triggers it -- there is
// no other way for a prompt field to get a value at all (see
// METADATA_FIELD_TYPES's comment, src/config.js), so this is the only gate
// that matters, and it has to run before anything actually fires. Called
// synchronously from the automations.js /event handler (before the event is
// even recorded) and from the 'automations:testEvent' IPC handler below, so
// a missing answer means the request never dispatches anything at all --
// not "dispatches with a blank."
//
// "Genuinely blank" is the key word: a required field that already holds
// *any* value (from an earlier, different call) is satisfied without being
// re-supplied here. This was initially unconditional -- answer required
// every single call, no exceptions -- but that meant a title answered once
// at "Begin Session Recording" got demanded again at Stop, purely because
// "Upload to Youtube" also reads it (via a composed Text field referencing
// {sessionTitle}); the whole point of a Prompt field's persistence is
// defeated by re-asking for something already known. A supplied answer
// still always overwrites whatever's there, so "update this any time" (the
// original Herald use case for Description) keeps working exactly the same.
// What resets a field back to blank -- so the *next* recording is asked
// fresh instead of silently reusing this one's leftover answer forever --
// is clearMetadataField, a separate explicit action (see
// runAutomationAction below), not anything here.
function checkAndApplyPrompts(event, providedPrompts) {
  const current = configStore.get();
  const { ruleSets } = current.automations;
  const matched = ruleSets.filter((r) => r.enabled && r.event === event);
  // Starting a new session while the last recording never uploaded: hold the
  // start back and ask what to do with that one first. This runs before any
  // answers are applied, on purpose -- the new session's title would
  // otherwise overwrite the old one's before it could be uploaded.
  if (matched.some((r) => ruleSetStartsRecording(r, ruleSets))) {
    const pending = pendingUpload();
    if (pending) {
      raiseUploadDecision(pending);
      return {
        ok: false,
        error: `The last recording ("${pending.name}") was never uploaded to YouTube. Upload it or set it aside in ${APP_NAME}, then start again.`,
      };
    }
  }
  const required = new Set();
  for (const ruleSet of matched) {
    for (const key of collectRequiredPrompts(ruleSet, ruleSets, current.metadataFields)) required.add(key);
  }
  if (!required.size) return { ok: true };

  const provided = providedPrompts && typeof providedPrompts === 'object' ? providedPrompts : {};
  const isBlank = (key) => isPromptFieldBlank(current.metadataFields, key);
  const missing = [...required].filter((key) => !(typeof provided[key] === 'string' && provided[key]) && isBlank(key));
  if (missing.length) {
    const labels = missing.map((key) => (current.metadataFields.find((f) => f.key === key) || {}).label || key);
    return { ok: false, error: `Missing required prompt value(s): ${labels.join(', ')}` };
  }

  // Only writes what was actually supplied -- a required field already
  // satisfied by an existing value and not answered again here is left
  // exactly as it was, not overwritten with nothing.
  const toWrite = [...required].filter((key) => typeof provided[key] === 'string' && provided[key]);
  if (toWrite.length) {
    configStore.save({
      ...current,
      metadataFields: current.metadataFields.map((f) => (toWrite.includes(f.key) ? { ...f, value: provided[f.key] } : f)),
    });
    broadcastStatus();
  }
  return { ok: true };
}

// One step's action -> the OBS or Studio call it makes. `param` is the
// step's own value: a scene name for sceneSwitch, a source name for
// sourceShow/sourceHide/sourceToggle/setText and the audio actions, ignored otherwise.
// `eventData` is whatever triggered this (undefined for a manual "Time
// it" run or a direct action call with none given);
// `stepContext` (only read by setText, via resolveTextValue above) is the
// rule-set step itself, or undefined for a direct call. OBS actions need
// OBS connected; Studio actions (everything from wakeAudio down) work
// regardless -- none of them but syncObs and applySessionFilename touch
// OBS at all. `chain` is the set of rule-set ids already running further up
// this same call stack -- only ever non-empty when a `runRuleSet` step led
// here, threaded through so a cycle (A runs B runs A) is refused instead of
// recursing forever; a direct call (a step run from the UI, a "Time it"
// test, a bare `POST /action`) always starts with an empty one.
async function runAutomationAction(action, param, eventData, stepContext, chain = new Set(), ruleSetId) {
  switch (action) {
    case 'sceneSwitch':
      requireObs();
      if (!param) throw new Error('sceneSwitch needs a scene name.');
      return obs.switchToScene(param);
    case 'sourceShow':
      requireObs();
      if (!param) throw new Error('sourceShow needs a source name.');
      return obs.setSourceVisible(param, true);
    case 'sourceHide':
      requireObs();
      if (!param) throw new Error('sourceHide needs a source name.');
      return obs.setSourceVisible(param, false);
    case 'sourceToggle':
      requireObs();
      if (!param) throw new Error('sourceToggle needs a source name.');
      return obs.toggleSourceVisible(param);
    case 'setText': {
      requireObs();
      if (!param) throw new Error('setText needs a source name.');
      return obs.setInputText(param, resolveTextValue(stepContext, eventData));
    }
    case 'sourceMute':
      requireObs();
      if (!param) throw new Error('sourceMute needs a source name.');
      return obs.setInputMuted(param, true);
    case 'sourceUnmute':
      requireObs();
      if (!param) throw new Error('sourceUnmute needs a source name.');
      return obs.setInputMuted(param, false);
    case 'sourceToggleMute':
      requireObs();
      if (!param) throw new Error('sourceToggleMute needs a source name.');
      return obs.toggleInputMuted(param);
    case 'setVolume': {
      requireObs();
      if (!param) throw new Error('setVolume needs a source name.');
      const raw = String(resolveTextValue(stepContext, eventData)).trim();
      const db = Number.parseFloat(raw);
      if (!Number.isFinite(db)) throw new Error(`setVolume needs a level in dB, such as -6 (got "${raw}").`);
      return obs.setInputVolumeDb(param, db);
    }
    case 'startRecording': case 'pauseRecording': case 'resumeRecording': case 'stopRecording':
    case 'startStreaming': case 'stopStreaming':
      return recordingBackends.run(action); // the active backend (OBS today): see src/recording.js
    case 'prompterPlay': case 'prompterPause': case 'prompterToggle': case 'prompterFaster': case 'prompterSlower':
    case 'prompterNext': case 'prompterPrev': case 'prompterTop': {
      if (!prompterOpen() || !prompterPage || prompterPage.webContents.isDestroyed()) {
        throw new Error('The teleprompter window is not open.');
      }
      const command = { prompterPlay: 'start', prompterPause: 'pause', prompterToggle: 'play', prompterFaster: 'faster',
        prompterSlower: 'slower', prompterNext: 'next', prompterPrev: 'prev', prompterTop: 'top' }[action];
      prompterPage.webContents.send('prompter:command', command);
      return;
    }
    case 'prompterLoadScript': {
      if (!param) throw new Error('prompterLoadScript needs a script file.');
      if (prompterIsEditing) throw new Error('The teleprompter is being edited; finish editing before loading another script.');
      const startUp = configStore.get().teleprompter.script;
      // "Start Up" goes back to the script the profile opens with.
      if (/^start[\s-]?up$/i.test(param.trim())) {
        if (!startUp) throw new Error('This profile has no Start Up script.');
        useScript(startUp);
        prompterStatus('Back to the Start Up script');
        return;
      }
      const current = prompterT().script;
      const file = path.isAbsolute(param) ? param : path.resolve(current ? path.dirname(current) : app.getPath('documents'), param);
      let stat;
      try { stat = await fs.promises.stat(file); } catch (err) { throw new Error(`Cannot find the script ${file}`); }
      if (!stat.isFile()) throw new Error(`${file} is not a file.`);
      if (stat.size > MAX_SCRIPT_BYTES) throw new Error('That script is larger than 2 MB.');
      useScript(file);
      prompterStatus(`Loaded script: ${path.basename(file)}`);
      return;
    }
    case 'wakeAudio':
      for (const id of viewWindows.keys()) {
        if (wakeAudio(id)) wakeWhenReady(id, 5000);
      }
      return;
    case 'startAll':
      return openAllViews();
    case 'stopAll':
      return closeAllViews();
    case 'dockAll':
      return collapseViews();
    case 'undockAll':
      return expandViews();
    case 'syncObs':
      requireObs();
      return syncObs();
    case 'applySessionFilename': {
      requireObs();
      const { filenameFormat } = configStore.get().session;
      if (!filenameFormat) throw new Error('Set a filename format on the Automations tab first.');
      return obs.setFilenameFormat(formatSessionTemplate(filenameFormat, eventData, undefined, sanitizeFilenameValue));
    }
    case 'runRuleSet': {
      if (!param) throw new Error('runRuleSet needs a rule set to run.');
      const { ruleSets } = configStore.get().automations;
      const target = ruleSets.find((r) => r.id === param);
      if (!target) throw new Error(`Rule set not found: ${param}`);
      if (chain.has(target.id)) {
        throw new Error(`"${target.name || target.id}" is already running earlier in this same chain -- refusing to loop.`);
      }
      return runRuleSet(target, eventData, new Set([...chain, target.id]));
    }
    case 'incrementMetadataField':
    case 'decrementMetadataField': {
      if (!param) throw new Error(`${action} needs a Metadata field.`);
      const delta = action === 'incrementMetadataField' ? 1 : -1;
      const current = configStore.get();
      const field = current.metadataFields.find((f) => f.key === param);
      if (!field) throw new Error(`Metadata field not found: ${param}`);
      let patch;
      if (field.type === 'number') patch = { value: Number(field.value) + delta };
      else if (field.type === 'textNumber' || field.type === 'numberText') patch = { number: field.number + delta };
      else throw new Error(`"${field.label}" isn't a Number field -- nothing to ${delta > 0 ? 'increment' : 'decrement'}.`);
      configStore.save({ ...current, metadataFields: current.metadataFields.map((f) => (f.key === param ? { ...f, ...patch } : f)) });
      broadcastStatus();
      return;
    }
    // Writes an explicit value into a Text-type Metadata field's stored
    // `value` -- the persistence increment/decrement give Number fields,
    // generalized to an explicit set rather than +/-1. This is what lets a
    // value survive between two separate calls (a title set before
    // recording starts, read minutes later when the filename is applied; a
    // description updated at any point, read later still when a YouTube
    // upload step runs) -- something no other action did before this one,
    // since setText writes an OBS text *source*, not Studio's own stored
    // state. Scoped to "text" only, deliberately: a Number/textNumber/
    // numberText field already has an explicit action that owns it
    // (increment/decrement), and a checkbox field's only sensible values
    // are boolean, not a string one of this action's own three sources
    // would produce.
    case 'setMetadataField': {
      if (!param) throw new Error('setMetadataField needs a Metadata field.');
      const current = configStore.get();
      const field = current.metadataFields.find((f) => f.key === param);
      if (!field) throw new Error(`Metadata field not found: ${param}`);
      if (field.type !== 'text') throw new Error(`"${field.label}" isn't a Text field -- nothing to set.`);
      const value = resolveMetadataFieldValue(stepContext, eventData);
      configStore.save({ ...current, metadataFields: current.metadataFields.map((f) => (f.key === param ? { ...f, value } : f)) });
      broadcastStatus();
      return;
    }
    // Resets a "prompt" field back to blank -- the other half of blank-
    // check semantics in checkAndApplyPrompts above. Answering a Prompt
    // field no longer forces a re-answer on every later touch, which means
    // something has to put it back to blank when its episode/session is
    // actually over, or the same answer would silently satisfy every
    // future run forever. Placed as a step wherever that "this is over"
    // moment actually is (the end of an Upload to Youtube run, say) --
    // Studio has no notion of "episode over" on its own, so this has to be
    // deliberate, not automatic. Scoped to "prompt" only, same reasoning
    // setMetadataField is scoped to "text" only: a plain Text field can
    // already be set to '' through that action, so a separate action here
    // would be redundant for it.
    case 'clearMetadataField': {
      if (!param) throw new Error('clearMetadataField needs a Metadata field.');
      const current = configStore.get();
      const field = current.metadataFields.find((f) => f.key === param);
      if (!field) throw new Error(`Metadata field not found: ${param}`);
      if (field.type !== 'prompt') throw new Error(`"${field.label}" isn't a Prompt field -- nothing to clear back to blank.`);
      configStore.save({ ...current, metadataFields: current.metadataFields.map((f) => (f.key === param ? { ...f, value: '' } : f)) });
      broadcastStatus();
      return;
    }
    case 'uploadToYouTube':
      return runYouTubeUpload(stepContext || {}, eventData, ruleSetId);
    // A real OS notification (Notification Center on macOS, the Action
    // Center on Windows) -- not just something inside Studio's own window,
    // since the whole point is reaching someone who isn't looking at
    // Studio at all right now (a failed YouTube upload that needs a human
    // to go handle manually, the natural pairing with runIf's "onFailure",
    // though nothing here requires that pairing). `param` is the message,
    // {token}-expanded the same way a filename template or a Text Metadata
    // field's value already is, so a step can say something like "Upload
    // failed for {sessionTitle}". Also pushes the in-app toast (a second,
    // more immediate layer for whoever happens to already be looking at
    // Studio's panel right now) and always logs to the Connections
    // activity feed, so nothing is lost even if the OS notification itself
    // is denied, silenced, or missed -- see Notification.isSupported()
    // below; on a fresh install macOS may need the user to grant Studio
    // notification permission once, same as any other app.
    case 'showToast': {
      if (!param) throw new Error('showToast needs a message.');
      const message = formatSessionTemplate(param, eventData);
      if (Notification.isSupported()) {
        new Notification({ title: APP_NAME, body: message }).show();
      }
      if (controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.webContents.send('toast', message);
      }
      logActivity('Automations', `Notification: ${message}`, 'error');
      return;
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// uploadToYouTube's own logic, kept out of the switch above -- it needs
// five named step fields (titleField/descriptionField/categoryField/
// madeForKidsField/visibilityField), not the single param/dataField shape
// every other action uses, and a genuinely multi-step body (find the file,
// resolve each field, upload). No playlist support -- see "Playlist
// support" in architecture-automations.md for why.
//
// madeForKidsField alone is strict: it must point at a real "checkbox"
// Metadata field, or this throws rather than guessing a default -- a COPPA
// declaration is consequential enough that silently defaulting it on a
// stale or missing field reference would hide a real configuration mistake
// instead of surfacing it (same reasoning incrementMetadataField uses for a
// field that isn't Number-shaped). visibilityField is strict in a
// different way: it's a plain Data Field like Title/Description (any
// Metadata field, any evergreen), but if it resolves to something at all,
// that something must be exactly "private"/"unlisted"/"public" -- whether
// a recording becomes publicly visible is exactly the kind of mistake a
// typo shouldn't quietly get wrong. categoryField has no such check: it's
// permissive like Description, since YouTube's category list is large and
// there is no small, meaningful set to validate against.
// ruleSetId (the rule set this step is running as part of, threaded down
// from runRuleSet/runAutomationAction) is optional -- only used to key
// youtubeUploadProgress so the Automations tab can show a progress bar on
// the specific card that's uploading; a direct "Time it" test run passes
// none, and the upload still works, just without a progress bar to update.
async function runYouTubeUpload(step, eventData, ruleSetId) {
  const y = configStore.get().youtube;
  if (!y.enabled) throw new Error('YouTube upload is off -- enable it on the Automations tab first.');

  const filePath = step.filePath || (recordings.last && recordings.last.path) || obs.lastRecordingPath;
  if (!filePath) throw new Error('No recording to upload -- record something first, or set a file on this step.');
  if (!fs.existsSync(filePath)) throw new Error(`Recording file not found: ${filePath}`);
  // Only the *default* file is guarded: running "upload the last recording"
  // twice would quietly publish a duplicate, while setting a file on the
  // step is a deliberate choice that is allowed to repeat one.
  const priorUpload = recordings.uploads[filePath];
  if (priorUpload && !step.filePath) {
    throw new Error(
      `This recording was already uploaded to YouTube (${priorUpload.url}, ${new Date(priorUpload.at).toLocaleString()}). To upload it again, set the file on the step.`
    );
  }
  if (priorUpload) logActivity('YouTube', `Note: this file was already uploaded earlier: ${priorUpload.url}`, 'info');

  const title = resolveDataField(step.titleField || '', eventData);
  if (!title) throw new Error('uploadToYouTube needs a Title field that resolves to something.');
  const description = step.descriptionField ? resolveDataField(step.descriptionField, eventData) : '';

  const fields = configStore.get().metadataFields;
  const madeForKidsField = fields.find((f) => f.key === step.madeForKidsField);
  if (!madeForKidsField || madeForKidsField.type !== 'checkbox') {
    throw new Error('uploadToYouTube needs a checkbox-type Metadata field wired to "Made for kids".');
  }
  // Checked = yes, made for kids -- direct, matching the field's own label
  // and the API's own field name, not inverted. (Used to be a "Not made
  // for kids" field with the opposite polarity: checked meant NOT for
  // kids, which read as a double negative once you had to reason about
  // what an unchecked box actually meant -- "made for kids" checked=yes is
  // the plainer question to answer.)
  const selfDeclaredMadeForKids = Boolean(madeForKidsField.value);

  let privacyStatus = y.privacyStatus;
  if (step.visibilityField) {
    const resolved = resolveDataField(step.visibilityField, eventData).trim().toLowerCase();
    if (resolved) {
      if (!['private', 'unlisted', 'public'].includes(resolved)) {
        throw new Error(`uploadToYouTube's Visibility field resolved to "${resolved}", not "private", "unlisted", or "public".`);
      }
      privacyStatus = resolved;
    }
  }

  let categoryId = y.categoryId;
  if (step.categoryField) {
    const resolved = resolveDataField(step.categoryField, eventData).trim();
    if (resolved) categoryId = resolved;
  }

  logActivity('YouTube', `Upload started: "${title}" (${privacyStatus})`, 'info');
  let lastLoggedPercent = -1;
  youtubeUploadActive = { title, file: path.basename(filePath), percent: 0 };
  if (ruleSetId) youtubeUploadProgress.set(ruleSetId, 0);
  broadcastStatus();
  const signal = ruleSetId && ruleSetRunState.get(ruleSetId) ? ruleSetRunState.get(ruleSetId).abort.signal : undefined;
  try {
    const { videoId, url, resumed } = await youtube.uploadVideo(
      filePath,
      { title: title.slice(0, 100), description, categoryId, privacyStatus, selfDeclaredMadeForKids },
      (fraction) => {
        const percent = Math.floor(fraction * 100);
        youtubeUploadActive = { title, file: path.basename(filePath), percent };
        if (ruleSetId) youtubeUploadProgress.set(ruleSetId, percent);
        broadcastStatus();
        if (percent >= lastLoggedPercent + 10) {
          lastLoggedPercent = percent;
          logActivity('YouTube', `Upload progress: ${percent}%`, 'info');
        }
      },
      signal
    );
    youtubeConnectionExpired = false;
    noteUpload(filePath, { videoId, url });
    logActivity('YouTube', `Upload complete${resumed ? ' (resumed an earlier interrupted upload)' : ''}: ${url}`, 'info');
    return { videoId, url };
  } catch (err) {
    if (err && err.reconnectNeeded) {
      youtubeConnectionExpired = true;
      broadcastStatus();
    }
    if (err && err.message === 'Upload cancelled.') {
      logActivity('YouTube', 'Upload cancelled -- the next run of the same file resumes from where it stopped.', 'info');
    }
    throw err;
  } finally {
    youtubeUploadActive = null;
    if (ruleSetId) youtubeUploadProgress.delete(ruleSetId);
    broadcastStatus();
  }
}

// A rule set's numbered sequence, grouped into stages: a plain (non-`and`)
// action step, or a delay step, starts a new stage; a following `and`
// action step joins the current stage instead of starting its own. An
// action stage runs every step in it at once; a delay stage just waits.
// `runIf` (src/config.js) comes from whichever step actually opened the
// stage -- a joining `and` step's own runIf is never consulted, since the
// whole stage runs or doesn't run together (see runRuleSet's gate below).
function stagesFor(steps) {
  const stages = [];
  for (const step of steps) {
    // Skipped as if it weren't in the sequence at all -- not "run it but do
    // nothing" -- so an AND step right after a disabled one groups with
    // whichever enabled step actually precedes it.
    if (step.enabled === false) continue;
    if (step.type === 'delay') {
      // id kept (unlike the rest of a delay stage's shape) so runRuleSet
      // can report it as the active step while waiting -- a Wait row
      // benefits from the same "this is what's happening right now"
      // highlight an action step gets.
      stages.push({ kind: 'delay', seconds: step.seconds, id: step.id });
      continue;
    }
    if (step.and && stages.length && stages[stages.length - 1].kind === 'action') {
      stages[stages.length - 1].steps.push(step);
    } else {
      stages.push({ kind: 'action', steps: [step], runIf: step.runIf || 'always' });
    }
  }
  return stages;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Whether a rule set is currently mid-run, and the means to stop it early
// (the Automations tab's Run/Stop toggle). Keyed by rule set id, ref-counted
// rather than a boolean since the same rule set can genuinely be running
// more than once at a time -- a real trigger firing again while a manual
// "Run Automation" of the same rule set is still going, or (nested) two
// different callers both invoking it via the `runRuleSet` Studio action.
// `cancelled` is shared by every concurrent run of that id, so Stop halts
// all of them, not just whichever one the button happened to start.
const ruleSetRunState = new Map();

function beginRuleSetRun(id) {
  let state = ruleSetRunState.get(id);
  if (!state) {
    state = { count: 0, cancelled: false, activeStepIds: [], abort: new AbortController() };
    ruleSetRunState.set(id, state);
  }
  state.count += 1;
  broadcastStatus();
  return state;
}

function endRuleSetRun(id) {
  const state = ruleSetRunState.get(id);
  if (!state) return;
  state.count -= 1;
  if (state.count <= 0) ruleSetRunState.delete(id);
  broadcastStatus();
}

function cancelRuleSetRun(id) {
  const state = ruleSetRunState.get(id);
  if (!state) return;
  state.cancelled = true;
  // Also aborts anything mid-flight that takes a signal (today: a YouTube
  // upload's fetch calls) -- a stage already dispatched no longer has to
  // run to completion.
  state.abort.abort();
}

// A delay that gives up early once `state.cancelled` is set, checked every
// 200ms rather than only after the full wait -- so Stop takes effect
// within a fraction of a second even mid-delay, not only between stages.
async function sleepCancellable(ms, state) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (state.cancelled) return;
    await sleep(Math.min(200, end - Date.now()));
  }
}

// Runs a rule set's stages in order. OBS never tells Studio a scene "is
// done" -- there is no such event on the WebSocket API -- so delays are
// plain timers Studio keeps itself, not a wait for OBS to confirm anything.
// One step failing (OBS not connected, a scene that doesn't exist) does not
// stop the rest of its stage or the stages after it. `chain` defaults to
// just this rule set's own id -- the normal case, a fresh top-level run;
// `runAutomationAction`'s `runRuleSet` case passes a larger one down when
// this run is itself nested inside another.
//
// Stop (cancelRuleSetRun) prevents any stage that hasn't started from
// starting, and aborts a YouTube upload that's mid-flight (it takes the
// run's AbortSignal). Other stage actions -- OBS calls already dispatched --
// still run to completion; they're single quick calls with nothing worth
// aborting, and a step failing doesn't roll back the ones before it either.
async function runRuleSet(ruleSet, eventData, chain = new Set([ruleSet.id])) {
  const state = beginRuleSetRun(ruleSet.id);
  const runName = ruleSet.name || ruleSet.event || 'rule set';
  const runToken = ++prompterRunToken;
  const stageList = stagesFor(ruleSet.steps);
  let anyFailed = false;
  let lastDid = ''; // what the last action stage did, shown beside a wait
  let doneText = `Ran rule set: ${runName}`;
  prompterRunUpdate(runToken, runName, '');
  // Tracks whether the last action stage that actually ran had every step
  // succeed, or at least one fail -- what an "On Success"/"On Failure"
  // stage checks itself against. Starts 'success' (vacuously: nothing has
  // failed yet) so a gated stage early in the sequence doesn't spuriously
  // skip for lack of anything to check. A delay stage, or a stage skipped
  // by its own gate, leaves this untouched -- "previous" always means the
  // last stage that actually *ran*, not merely the one before it in the
  // list, so a chain of several gated stages can all key off one real
  // outcome further back.
  let lastOutcome = 'success';
  try {
    for (const stage of stageList) {
      if (state.cancelled) break;
      if (stage.kind === 'action' && stage.runIf && stage.runIf !== 'always') {
        const wantsSuccess = stage.runIf === 'onSuccess';
        if ((wantsSuccess && lastOutcome !== 'success') || (!wantsSuccess && lastOutcome !== 'failure')) {
          const label = wantsSuccess ? 'On Success' : 'On Failure';
          logActivity(
            'Automations',
            `Rule set "${ruleSet.name}" skipped a step (${label}) -- the previous step ${lastOutcome === 'success' ? 'succeeded' : 'failed'}.`,
            'info'
          );
          continue;
        }
      }
      // Whichever step(s) this stage covers -- an AND-grouped action stage
      // highlights all of them at once, since they really are running
      // together, not one after another.
      state.activeStepIds = stage.kind === 'delay' ? [stage.id] : stage.steps.map((s) => s.id);
      prompterRunUpdate(runToken, runName, stage.kind === 'delay' ? `${lastDid ? `${lastDid}, ` : ''}paused ${stage.seconds}s` : `step ${stageList.indexOf(stage) + 1} of ${stageList.length}`);
      broadcastStatus();
      if (stage.kind === 'delay') {
        // Count down on the teleprompter's bar, once a second.
        const endsAt = Date.now() + stage.seconds * 1000;
        const ticker = setInterval(() => {
          const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
          prompterRunUpdate(runToken, runName, `${lastDid ? `${lastDid}, ` : ''}paused, ${left}s left`);
        }, 1000);
        try { await sleepCancellable(stage.seconds * 1000, state); } finally { clearInterval(ticker); }
        continue;
      }
      let stageFailed = false;
      await Promise.all(
        stage.steps.map((step) =>
          runAutomationAction(step.action, step.param, eventData, step, chain, ruleSet.id).catch((err) => {
            stageFailed = true;
            anyFailed = true;
            const message = `Rule set "${ruleSet.name}" step -> ${step.action} failed: ${err.message}`;
            console.warn(`[automations] ${message}`);
            logActivity('Automations', message, 'error');
          })
        )
      );
      lastOutcome = stageFailed ? 'failure' : 'success';
      lastDid = stage.steps.map(describeStep).join(' and ');
    }
    if (state.cancelled) doneText = `Stopped rule set: ${runName}`;
    else if (anyFailed) doneText = `Rule set "${runName}" had a failed step`;
  } finally {
    prompterRunEnd(runToken, doneText, anyFailed && !state.cancelled);
    state.activeStepIds = [];
    endRuleSetRun(ruleSet.id);
  }
}

// Every enabled rule set whose `event` matches the incoming one runs, each
// independently -- one rule set's sequence does not wait for another's, and
// a rule set that matches again while already mid-sequence just runs a
// second, overlapping time (OBS actions are idempotent, so overlap is
// harmless). Both runs share the same ruleSetRunState entry (see
// runRuleSet) -- Stop halts every concurrent run of that id at once, not
// just whichever one the Automations tab's button happened to start.
async function runAutomationRuleSets(entry) {
  const { ruleSets } = configStore.get().automations;
  const matched = ruleSets.filter((r) => r.enabled && r.event === entry.event);
  for (const ruleSet of matched) {
    runRuleSet(ruleSet, entry.data).catch((err) => {
      const message = `Rule set "${ruleSet.name}" failed: ${err.message}`;
      console.warn(`[automations] ${message}`);
      logActivity('Automations', message, 'error');
    });
  }
}

// Starts or stops the HTTPS server to match current settings -- called at
// launch and again whenever Automations settings are saved, so toggling
// Enable or editing the port/token takes effect immediately.
async function syncAutomationsServer() {
  const a = configStore.get().automations;
  if (a.enabled) {
    await automations.start({
      port: a.port,
      getToken: () => configStore.get().automations.token,
      // Annotated with `prompts` here (rather than automations.js computing
      // it) since collectRequiredPrompts and configStore both live on this
      // side -- automations.js just passes each rule set's own `prompts`
      // straight through to GET /capabilities. Filtered through
      // isPromptFieldBlank -- a field collectRequiredPrompts found this rule
      // set touches but that already holds a value is NOT included, same as
      // checkAndApplyPrompts's own enforcement already treats it. Without
      // this, capabilities kept advertising a field as required forever
      // after it was first answered, even though firing the event with no
      // answer for it would have succeeded anyway -- a caller reasonably
      // trusting `prompts` to decide whether to show a dialog had no way to
      // know that.
      getRuleSets: () => {
        const { ruleSets } = configStore.get().automations;
        const { metadataFields } = configStore.get();
        return ruleSets.map((r) => ({
          ...r,
          prompts: [...collectRequiredPrompts(r, ruleSets, metadataFields)]
            .filter((key) => isPromptFieldBlank(metadataFields, key))
            .map((key) => ({
              key,
              label: (metadataFields.find((f) => f.key === key) || {}).label || key,
            })),
        }));
      },
      actions: [...AUTOMATIONS_ACTION_SCHEMA, ...STUDIO_ACTION_SCHEMA],
      runAction: (action, param, data) => runAutomationAction(action, param, data),
      checkPrompts: (event, prompts) => checkAndApplyPrompts(event, prompts),
      getScenes: () => (obs.connected ? obs.listScenes() : Promise.resolve([])),
      getSources: () => (obs.connected ? obs.listSourceNames() : Promise.resolve([])),
      getMetadataFields: () => configStore.get().metadataFields,
      getObsStatus: () => {
        const o = obs.status();
        return {
          obsConnected: o.state === 'connected',
          recording: o.outputs.recording,
          recordingPaused: o.outputs.recordingPaused,
          streaming: o.outputs.streaming,
          scene: o.outputs.scene,
        };
      },
      certDir: app.getPath('userData'),
    });
  } else {
    await automations.stop();
  }
}

// Compares actual DER bytes, not a fingerprint string -- Electron's
// Certificate.fingerprint format isn't documented precisely enough (which
// hash, what encoding) to trust a string match on, where getting it wrong
// either trusts nothing (silent, hard to notice) or -- far worse -- trusts
// something it shouldn't. Parsing both to X509Certificate and comparing
// .raw sidesteps the question entirely.
function trustsOwnAutomationsCert(certificate) {
  try {
    const theirs = new crypto.X509Certificate(certificate.data);
    const ours = new crypto.X509Certificate(automations.certPem);
    return Buffer.compare(theirs.raw, ours.raw) === 0;
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAlive(win) {
  return Boolean(win) && !win.isDestroyed();
}

function displaySummary(display) {
  return {
    id: display.id,
    label: display.label || `Display ${display.id}`,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    primary: display.id === screen.getPrimaryDisplay().id,
  };
}

// A user gesture for the page, so its audio may start: a middle-button
// click in the middle of the page (Foundry does nothing with the middle
// button, and a click is what its audio gate waits for), plus an F16 key
// press, which means nothing to the page either.
function wakeAudio(id) {
  const wc = pageOf(id);
  const win = viewWindows.get(id);
  if (!wc || wc.isDestroyed() || !isAlive(win)) return false;
  try {
    const [width, height] = pageSize(win);
    const x = Math.round(width / 2);
    const y = Math.round(height / 2);
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'middle', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'middle', clickCount: 1 });
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'F16' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'F16' });
    return true;
  } catch (err) {
    console.warn(`[${id}] wake audio: ${err.message}`);
    return false;
  }
}

// What the page says about itself: whether it is Foundry, whether Foundry
// has finished loading, and whether its audio is still locked behind a
// first gesture. null when the page cannot be asked.
async function pageAudioState(wc) {
  try {
    // Foundry declares `game` with let, so it is a global binding but not a
    // window property; look it up by name in the page's own scope.
    return await wc.executeJavaScript(
      '(() => { const g = typeof game !== "undefined" ? game : window.game; if (!g || typeof g !== "object") return { foundry: false };' +
        ' return { foundry: true, ready: g.ready === true, locked: g.audio && typeof g.audio.locked === "boolean" ? g.audio.locked : null }; })()',
      true,
    );
  } catch (err) {
    return null;
  }
}

// Wake the page's audio: wait the delay set on the Configuration tab (Foundry
// ignores clicks until it has finished setting up, which the page does not
// announce reliably), click, then keep clicking every few seconds while
// Foundry still reports its audio locked. Gives up after three minutes.
const wakeTimers = new Map();
function stopWake(id) {
  clearTimeout(wakeTimers.get(id));
  wakeTimers.delete(id);
}
function wakeWhenReady(id, delayMs) {
  if (delayMs === undefined) {
    const view = configStore.getView(id);
    delayMs = ((view && view.wakeDelay) || 30) * 1000;
  }
  stopWake(id);
  const started = Date.now();
  let clicks = 0;
  const tick = async () => {
    wakeTimers.delete(id);
    const wc = pageOf(id);
    if (!wc || wc.isDestroyed() || Date.now() - started > delayMs + 180000) return;
    wakeAudio(id);
    clicks += 1;
    const state = await pageAudioState(wc);
    if (!state || !state.foundry || state.locked !== true || clicks >= 30) return; // not Foundry, unlocked, or enough tries
    wakeTimers.set(id, setTimeout(tick, 5000));
  };
  wakeTimers.set(id, setTimeout(tick, delayMs));
}

function viewStatus(view) {
  const win = viewWindows.get(view.id);
  if (!isAlive(win)) {
    return { id: view.id, open: false };
  }
  const [width, height] = pageSize(win);
  const [x, y] = win.getPosition();
  const display = screen.getDisplayMatching(win.getBounds());
  const wc = pageOf(view.id);
  return {
    id: view.id,
    open: true,
    title: win.getTitle(),
    x,
    y,
    width,
    height,
    captureWidth: Math.round(width * display.scaleFactor),
    captureHeight: Math.round(height * display.scaleFactor),
    scaleFactor: display.scaleFactor,
    displayId: display.id,
    displayLabel: displaySummary(display).label,
    url: wc ? wc.getURL() : '',
    loading: wc ? wc.isLoading() : false,
    muted: wc ? wc.isAudioMuted() : false,
    audible: wc ? wc.isCurrentlyAudible() : false,
    barHeight: BAR_HEIGHT,
    cropTop: Math.round(BAR_HEIGHT * display.scaleFactor),
  };
}

function fullStatus() {
  return {
    views: configStore.get().views.map(viewStatus),
    prompter: { open: prompterOpen(), script: prompterT().script, startUp: configStore.get().teleprompter.script },
    displays: screen.getAllDisplays().map(displaySummary),
    config: configStore.get(),
    obs: { ...obs.status(), hasPassword: readObsPassword() !== '' },
    recording: { active: recordingBackends.active.id, backends: recordingBackends.list(), builtIn: { ...builtInRecorder.status(), toolbarOpen: isAlive(toolbarWindow) } },
    tavern: { ...tavern.status(), hasPassword: readSecret(TAVERN_SECRET_PATH) !== '', sync: tavernSync },
    automations: {
      ...automations.status(),
      runningRuleSetIds: [...ruleSetRunState.keys()],
      activeStepIds: Object.fromEntries([...ruleSetRunState.entries()].map(([id, s]) => [id, s.activeStepIds || []])),
      youtubeUploadProgress: Object.fromEntries(youtubeUploadProgress),
    },
    appWindows: Object.fromEntries(
      configStore.get().appWindows.map((a) => [a.id, { found: Boolean(appWindowResolved[`app:${a.id}`]), matched: appWindowMatched[`app:${a.id}`] || '', inObs: obs.status().inputs.includes(a.sourceName) }])
    ),
    youtube: { connected: readYoutubeSecret().refreshToken !== '' && !youtubeConnectionExpired, expired: youtubeConnectionExpired, uploading: youtubeUploadActive, pendingDecision: pendingUploadDecision, lastRecording: recordings.last ? { name: path.basename(recordings.last.path), uploaded: recordings.uploads[recordings.last.path] ? { url: recordings.uploads[recordings.last.path].url, at: recordings.uploads[recordings.last.path].at } : null } : null, hasClientSecret: readYoutubeSecret().clientSecret !== '', connecting: youtubeConnectState },
    activity: activityLog,
    autoLevel: autoLevel.status(),
    collapsed,
    parkedIds: [...parked.keys()],
  };
}

function broadcastStatus() {
  if (isAlive(controlWindow)) {
    controlWindow.webContents.send('status', fullStatus());
  }
  refreshTrayMenu();
  sendDockState();
}

function getView(id) {
  const view = configStore.getView(id);
  if (!view) throw new Error(`Unknown view: ${id}`);
  return view;
}

// ---------------------------------------------------------------------------
// View windows (the things OBS captures)
// ---------------------------------------------------------------------------

function windowTitle(view) {
  return `${APP_NAME} - ${view.label}`;
}

// How OBS on Windows names a window: "Title:Class:Executable", with '#' and
// ':' inside each part escaped (the same encoding OBS itself uses). Every
// Electron window's class is Chrome_WidgetWin_1 and the executable is this
// app's own. This is only the fallback for a window OBS has not listed yet
// (creating the first source) -- once OBS's own window list is available,
// the value it returns is what gets used.
function windowsCaptureString(win) {
  const encode = (part) => String(part).replace(/#/g, '#22').replace(/:/g, '#3A');
  return `${encode(win.getTitle())}:Chrome_WidgetWin_1:${encode(path.basename(process.execPath))}`;
}

// The identifier OBS captures an open, visible view window by -- the system
// window ID on macOS (changes on every launch), a Title:Class:Executable
// string on Windows -- or null when the window is not on screen yet: OBS
// cannot start a working capture of a window that is not shown.
function systemWindowId(win) {
  if (!isAlive(win) || !win.isVisible()) return null;
  if (process.platform === 'win32') return windowsCaptureString(win);
  const match = /^window:(\d+):/.exec(win.getMediaSourceId() || '');
  return match ? Number.parseInt(match[1], 10) : null;
}

// The Foundry page's webContents for a view, or null when not open.
function pageOf(id) {
  const view = pageViews.get(id);
  return view && !view.webContents.isDestroyed() ? view.webContents : null;
}

// Size of the page area (window content minus the bar), in points.
function pageSize(win) {
  const [w, h] = win.getContentSize();
  return [w, Math.max(1, h - BAR_HEIGHT)];
}

function scaleFactorOf(win) {
  return screen.getDisplayMatching(win.getBounds()).scaleFactor;
}

// Crop/Pad values (captured pixels) that remove the bar from a window capture.
function barCrop(win) {
  if (!isAlive(win)) return null;
  return { left: 0, top: Math.round(BAR_HEIGHT * scaleFactorOf(win)), right: 0, bottom: 0 };
}

function layoutPage(id) {
  const win = viewWindows.get(id);
  const view = pageViews.get(id);
  if (!isAlive(win) || !view) return;
  const [w, h] = pageSize(win);
  view.setBounds({ x: 0, y: BAR_HEIGHT, width: w, height: h });
}

function sendBarState(id) {
  const win = viewWindows.get(id);
  const view = configStore.getView(id);
  if (!isAlive(win) || !view || win.webContents.isDestroyed()) return;
  const [x, y] = win.getPosition();
  const [width, height] = pageSize(win);
  win.webContents.send('bar:state', { id, label: view.label, x, y, width, height });
}

// Measure a page element inside a view: { x, y, width, height } in page
// points, or null when the element is not found.
async function measureSelector(wc, rawSelector) {
  const candidates = selectorCandidates(rawSelector);
  if (!wc || wc.isDestroyed() || !candidates.length) return null;
  const code = `(() => {
    let el = null;
    for (const sel of ${JSON.stringify(candidates)}) {
      try { el = document.querySelector(sel); } catch (err) { el = null; }
      if (el) break;
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  })()`;
  try {
    const rect = await wc.executeJavaScript(code, true);
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    return {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
  } catch (err) {
    return null;
  }
}

// Crop/Pad values (captured pixels) that isolate a region of a view's page.
// The region is in page points; the bar above the page is cropped away too.
function cropFor(win, region) {
  if (!isAlive(win)) return null;
  const [w, h] = pageSize(win);
  const sf = scaleFactorOf(win);
  const x = Math.min(region.x, w);
  const y = Math.min(region.y, h);
  const width = Math.max(1, Math.min(region.width, w - x));
  const height = Math.max(1, Math.min(region.height, h - y));
  return {
    left: Math.round(x * sf),
    top: Math.round((BAR_HEIGHT + y) * sf),
    right: Math.round((w - x - width) * sf),
    bottom: Math.round((h - y - height) * sf),
  };
}

// Re-measure selector regions of an open view and save any changes.
async function refreshRegions(view) {
  const wc = pageOf(view.id);
  if (!wc) return view.regions;
  let changed = false;
  const regions = [];
  for (const region of view.regions) {
    if (region.mode !== 'selector') {
      regions.push(region);
      continue;
    }
    const rect = await measureSelector(wc, region.selector);
    if (rect && (rect.x !== region.x || rect.y !== region.y || rect.width !== region.width || rect.height !== region.height)) {
      regions.push({ ...region, ...rect });
      changed = true;
    } else {
      regions.push(region);
    }
  }
  if (changed) configStore.updateView(view.id, { regions });
  return regions;
}

// The OBS source names a window maintains: the whole-window source while it
// is switched on. Regions carry their own.
function windowSources(view) {
  return view.windowSource.enabled && view.windowSource.name ? [view.windowSource.name] : [];
}

// Point every linked OBS source at the current windows and keep region
// crops current. An OBS source found capturing a window whose own source is
// missing is adopted as that source, so a capture made by hand in OBS is
// re-pointed automatically from then on.
let obsSyncTimer = null;
// Views whose windows appeared since the last sync: their captures get restarted.
const freshlyShown = new Set();
// view id ("app:<id>") -> the window ID the last sync matched, or null when
// that app's window wasn't open. Drives the "found / not open" indicator on
// the App windows card.
let appWindowResolved = {};
// Same keys -> the OBS label of the window matched, for showing which one.
let appWindowMatched = {};
async function syncObs() {
  if (!obs.connected) return null;
  await applyPendingSourceRenames().catch(() => {});
  const force = new Set(freshlyShown);
  freshlyShown.clear();
  const views = [];
  const { retinaDouble } = configStore.get();
  for (const view of configStore.get().views) {
    const win = viewWindows.get(view.id);
    const regions = await refreshRegions(view);
    // On a Retina display the capture has sf times the pixels of the window;
    // unless the user wants that, the sources are scaled back down in OBS.
    const sf = isAlive(win) ? scaleFactorOf(win) : 1;
    views.push({
      id: view.id,
      title: windowTitle(view),
      windowId: systemWindowId(win),
      scale: sf === 1 ? null : retinaDouble ? 1 : 1 / sf,
      sources: windowSources(view),
      allRegionSources: view.regions.map((r) => r.obsSource).filter(Boolean),
      crop: barCrop(win),
      muted: Boolean(view.muted),
      regions: regions.filter((r) => r.enabled).map((r) => ({ name: r.name, obsSource: r.obsSource, crop: cropFor(win, r) })),
    });
  }
  for (const app of configStore.get().appWindows) {
    views.push({
      id: `app:${app.id}`,
      match: { app: app.matchApp, title: app.matchTitle, label: app.windowLabel },
      title: '',
      windowId: null,
      scale: null,
      sources: [app.sourceName],
      regions: [],
      crop: app.crop,
      showCursor: app.showCursor,
      // muted deliberately absent -- not our window, not our call (see syncViews).
    });
  }
  const report = await obs.syncViews(views, force);
  appWindowResolved = report.resolved || {};
  appWindowMatched = report.matchedLabels || {};
  // A routine sync doesn't change connection *state*, so the 'status'
  // listener's own logActivity call (state-change only, to avoid spam on
  // every poll) never sees this -- log it here instead, and only when there
  // was actually something to report, same reasoning: a no-op sync (the
  // common case, firing on every view/region edit via obsSyncTimer) would
  // otherwise flood the Connections activity log on every keystroke-level
  // change.
  const bits = [];
  if (report.pointed.length) bits.push(`re-pointed ${report.pointed.join(', ')}`);
  if (report.restarted.length) bits.push(`restarted capture of ${report.restarted.join(', ')}`);
  if (report.cropped.length) bits.push(`cropped ${report.cropped.join(', ')}`);
  if (report.detected.length) bits.push(`linked ${report.detected.map((d) => d.input).join(', ')}`);
  if (report.missing.length) bits.push(`missing in OBS: ${report.missing.join(', ')}`);
  if (bits.length) logActivity('OBS', `Synced sources: ${bits.join('; ')}.`, 'info');
  const known = new Set(obs.status().inputs);
  let adopted = false;
  for (const { id, input } of report.detected) {
    const view = configStore.getView(id);
    if (!view || !view.windowSource.enabled || known.has(view.windowSource.name)) continue;
    configStore.updateView(id, { windowSource: { ...view.windowSource, name: input } });
    adopted = true;
  }
  // A second pass points and crops what was just adopted; it adopts nothing
  // more since the names are known now.
  if (adopted) return syncObs();
  broadcastStatus();
  return report;
}

// Brings the OBS connection in line with the profile's recorder: dropped (and no longer retried) when it records without OBS,
// and reconnected, if auto-connect is on, when it records with OBS.
async function syncObsConnection() {
  const c = configStore.get();
  if (c.recording.backend !== 'obs') {
    if (obs.state !== 'disconnected') await obs.stop().catch(() => {});
  } else if (c.obs.autoConnect && !obs.connected) {
    obs.connect().catch(() => {});
  }
}

function scheduleObsSync() {
  clearTimeout(obsSyncTimer);
  obsSyncTimer = setTimeout(() => syncObs().catch((err) => console.warn(`[obs] sync failed: ${err.message}`)), 800);
}

function createViewWindow(view) {
  const existing = viewWindows.get(view.id);
  if (isAlive(existing)) {
    existing.show();
    return existing;
  }

  const options = {
    title: windowTitle(view),
    width: view.width,
    height: view.height + BAR_HEIGHT,
    useContentSize: true,
    // Borderless: the window is the app's bar plus the page, nothing else.
    frame: false,
    roundedCorners: false,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0E1A2B',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'bar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  };
  if (Number.isInteger(view.x) && Number.isInteger(view.y)) {
    options.x = view.x;
    options.y = view.y;
  }

  const win = new BrowserWindow(options);
  viewWindows.set(view.id, win);

  // The bar is the window's own page; Foundry renders in a child view below it.
  win.loadFile(path.join(__dirname, 'bar', 'index.html'));
  win.webContents.on('did-finish-load', () => sendBarState(view.id));
  // Keep our stable title so the window is easy to find in OBS.
  win.on('page-title-updated', (event) => event.preventDefault());

  configureSession(partitionFor(view));
  const page = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'recorder', 'tap-preload.js'), // a copy of the page's sound for the built-in recorder; idle otherwise
      partition: partitionFor(view),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  pageViews.set(view.id, page);
  win.contentView.addChildView(page);
  page.setBackgroundColor('#000000');
  layoutPage(view.id);
  const wc = page.webContents;

  const showView = () => {
    if (!isAlive(win) || win.isVisible()) return;
    win.show();
    freshlyShown.add(view.id);
    broadcastStatus();
    scheduleObsSync();
  };

  // Anything Foundry tries to open in a new window goes to the default browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('did-finish-load', broadcastStatus);
  // Browsers keep a page silent until the user interacts with it, and
  // Foundry waits for that first gesture before starting its audio. The
  // page reports "loaded" long before Foundry has finished setting up (a
  // scene can take half a minute), and Foundry ignores clicks until then,
  // so the wake waits for Foundry to say it is ready.
  wc.on('did-finish-load', () => {
    const current = configStore.getView(view.id);
    if (!current || !current.wakeAudio) return;
    wakeWhenReady(view.id);
  });
  wc.on('did-start-loading', () => stopWake(view.id));
  wc.on('audio-state-changed', broadcastStatus);
  wc.on('did-start-loading', broadcastStatus);
  wc.on('did-stop-loading', broadcastStatus);
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 is ERR_ABORTED, e.g. a redirect.
    console.warn(`[${view.id}] Failed to load ${url}: ${description} (${code})`);
    broadcastStatus();
  });
  wc.on('render-process-gone', (_event, details) => {
    console.warn(`[${view.id}] Renderer gone (${details.reason}), reloading.`);
    if (!wc.isDestroyed()) wc.reload();
  });
  wc.setAudioMuted(Boolean(view.muted));

  win.on('move', () => sendBarState(view.id));
  win.on('moved', () => {
    if (!isAlive(win) || parking) return;
    if (parked.has(view.id)) {
      // Dragged out of its parking spot: no longer collapsed.
      parked.delete(view.id);
      if (parked.size === 0) collapsed = false;
      buildMenu();
    }
    const [x, y] = win.getPosition();
    configStore.updateView(view.id, { x, y });
    broadcastStatus();
  });
  win.on('resize', () => {
    layoutPage(view.id);
    sendBarState(view.id);
    broadcastStatus();
    scheduleObsSync();
  });
  win.on('closed', () => {
    stopWake(view.id);
    viewWindows.delete(view.id);
    pageViews.delete(view.id);
    parked.delete(view.id);
    collapsed = parked.size > 0;
    if (!wc.isDestroyed()) wc.close();
    broadcastStatus();
  });

  win.once('ready-to-show', showView);
  // Safety net: never leave a window invisible if the bar page stalls.
  setTimeout(showView, 5000);

  wc.loadURL(view.url || PLACEHOLDER_URL);
  broadcastStatus();
  return win;
}

// Push the saved size/position/mute into an already-open window.
function applyViewSettings(view) {
  const win = viewWindows.get(view.id);
  if (!isAlive(win)) return;
  if (win.getTitle() !== windowTitle(view)) win.setTitle(windowTitle(view));
  const [w, h] = pageSize(win);
  if (w !== view.width || h !== view.height) {
    win.setContentSize(view.width, view.height + BAR_HEIGHT);
  }
  if (Number.isInteger(view.x) && Number.isInteger(view.y) && !parked.has(view.id)) {
    const [x, y] = win.getPosition();
    if (x !== view.x || y !== view.y) win.setPosition(view.x, view.y);
  }
  sendBarState(view.id);
  const wc = pageOf(view.id);
  if (!wc) return;
  wc.setAudioMuted(Boolean(view.muted));
  const target = view.url || PLACEHOLDER_URL;
  const current = wc.getURL();
  const currentIsPlaceholder = current.startsWith('data:');
  if (view.url ? currentIsPlaceholder || current !== view.url : !currentIsPlaceholder) {
    wc.loadURL(target);
  }
}

// Resize the page area from the bar (arrow keys), keeping the top-left corner.
function resizePage(id, dw, dh) {
  const win = viewWindows.get(id);
  if (!isAlive(win)) return;
  const clamp = (n) => Math.min(LIMITS.maxSize, Math.max(LIMITS.minSize, n));
  const [w, h] = pageSize(win);
  const width = clamp(w + dw);
  const height = clamp(h + dh);
  if (width === w && height === h) return;
  win.setContentSize(width, height + BAR_HEIGHT);
  configStore.updateView(id, { width, height });
  broadcastStatus();
}

function closeView(id) {
  const win = viewWindows.get(id);
  if (isAlive(win)) win.close();
}

// Close a window and open it again (a window that is stopped is simply started).
async function restartView(id) {
  const view = getView(id);
  if (!view || !view.url) return;
  const win = viewWindows.get(id);
  if (isAlive(win)) {
    await new Promise((resolve) => {
      win.once('closed', resolve);
      win.close();
    });
    await new Promise((resolve) => setTimeout(resolve, 80)); // let the closed window's own clean-up finish first
  }
  createViewWindow(getView(id));
}

async function restartAllViews() {
  for (const v of configStore.get().views.filter((x) => x.url)) await restartView(v.id);
}

function reloadView(id) {
  const wc = pageOf(id);
  if (wc) wc.reloadIgnoringCache();
}

// View id for a BrowserWindow (a view window or null for the control panel).
function viewIdOf(win) {
  for (const [id, w] of viewWindows) if (w === win) return id;
  return null;
}

// Centre the window on the display it is currently on and bring it forward.
function resetView(id) {
  const view = getView(id);
  const win = viewWindows.get(id);
  if (!isAlive(win)) return;
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const x = Math.round(area.x + (area.width - view.width) / 2);
  const y = Math.round(area.y + (area.height - view.height - BAR_HEIGHT) / 2);
  parked.delete(id);
  configStore.updateView(id, { x, y });
  applyViewSettings(getView(id));
  win.show();
  win.focus();
  win.moveTop();
  broadcastStatus();
}

function resolveDisplay(displayId) {
  const all = screen.getAllDisplays();
  return all.find((d) => d.id === displayId) || screen.getPrimaryDisplay();
}

// Lay the windows out left to right from the top-left of the display,
// wrapping to a new row when the next one would not fit. A parked window
// isn't actually moved by this (applyViewSettings skips repositioning
// anything parked, so it would silently record a new x/y that never takes
// visual effect) -- undock everything first so the arrange is real.
function arrangeViews(displayId) {
  if (parked.size > 0) expandViews();
  const display = resolveDisplay(displayId);
  const area = display.workArea;
  let x = area.x;
  let y = area.y;
  let rowHeight = 0;
  for (const view of configStore.get().views) {
    if (x > area.x && x + view.width > area.x + area.width) {
      x = area.x;
      y += rowHeight;
      rowHeight = 0;
    }
    configStore.updateView(view.id, { x, y });
    x += view.width;
    rowHeight = Math.max(rowHeight, view.height + BAR_HEIGHT);
  }
  configStore.get().views.forEach(applyViewSettings);
  broadcastStatus();
}

function addView() {
  const view = configStore.addView();
  if (!view) throw new Error(`At most ${LIMITS.maxViews} windows.`);
  buildMenu();
  broadcastStatus();
  return view;
}

function removeView(id) {
  closeView(id);
  const removed = configStore.removeView(id);
  if (!removed) throw new Error('The last window cannot be removed.');
  parked.delete(id);
  buildMenu();
  broadcastStatus();
  return configStore.get();
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

// Closes the windows of the profile being left, makes another profile active and
// brings its setup up: its windows, Session fields, automation rules and
// Chameleon settings. The OBS and YouTube connections are global and stay as
// they are.
let switchingProfile = false;
async function switchProfile(id) {
  if (switchingProfile) throw new Error('Already switching profiles.');
  if (id === configStore.get().activeProfile) return configStore.get();
  switchingProfile = true;
  try {
    closeAllViews();
    closePrompter();
    const deadline = Date.now() + 5000;
    while (viewWindows.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    parked.clear();
    const saved = configStore.switchProfile(id);
    // The new profile's OBS profile and scene collection, if it has them switched on. A failure here is
    // logged and does not stop the switch.
    if (saved.obsPins && saved.obsPins.enabled) await applyObsPins(saved.obsPins);
    if (tavern.connected && !saved.tavern.enabled) await tavern.disconnect().catch(() => {});
    if (saved.tavern.enabled && saved.tavern.autoConnect && !tavern.connected && saved.tavern.url) await tavern.connect().catch(() => {});
    await syncAutomationsServer();
    openLaunchViews();
    { const rc = configStore.get().recording; if (rc.backend === 'builtin' && rc.toolbar.atStart) openToolbar({ focus: false }); }
    if (configStore.get().teleprompter.enabled) openPrompter();
    setupTray();
    setupDock();
    buildMenu();
    syncObsConnection().catch(() => {});
    scheduleObsSync();
    syncTavern().catch(() => {});
    syncAutoLevel().catch(() => {});
    logActivity('Studio', `Switched to the profile "${saved.profiles.find((s) => s.id === saved.activeProfile).name}".`, 'info');
    broadcastStatus();
    return configStore.get();
  } finally {
    switchingProfile = false;
  }
}

// What switching OBS to a profile's pins would change, given what OBS is on now.
// null when the profile does not switch OBS; { note } when it cannot be planned.
async function planObsPins(pins) {
  if (!pins || !pins.enabled || (!pins.profile && !pins.collection)) return null;
  if (!obs.connected) return { changes: [], note: 'OBS is not connected, so OBS is left as it is.' };
  const [p, c] = await Promise.all([obs.listProfiles(), obs.listSceneCollections()]);
  const changes = [];
  if (pins.profile && pins.profile !== p.current) changes.push({ kind: 'OBS profile', from: p.current, to: pins.profile, exists: p.profiles.includes(pins.profile) });
  if (pins.collection && pins.collection !== c.current) changes.push({ kind: 'Scene collection', from: c.current, to: pins.collection, exists: c.collections.includes(pins.collection) });
  return { changes, note: '' };
}

function describeObsPlan(plan) {
  if (!plan) return '';
  if (plan.note) return plan.note;
  return plan.changes.map((c) => `${c.kind}: ${c.from} \u2192 ${c.to}${c.exists ? '' : ' (OBS has no such name)'}`).join('\n');
}

// OBS itself allows a profile or collection change mid-recording, but that would swap the scenes
// and output settings of a session in progress, so Showrunner refuses; say so before anything
// else is touched.
function assertObsCanSwitch(plan) {
  if (plan && plan.changes.length && obs.outputActive) {
    throw new Error('OBS is recording or streaming. Showrunner will not switch its profile or scene collection mid-session; stop first.');
  }
}

// Switches OBS to a profile's pins. The profile first, then the scene collection, each on its own,
// so a failure on one is reported without hiding the other. Never throws.
async function applyObsPins(pins) {
  const plan = await planObsPins(pins);
  const result = { applied: [], failed: [], note: plan ? plan.note : '' };
  if (!plan || !plan.changes.length) return result;
  for (const change of plan.changes) {
    try {
      if (!change.exists) throw new Error(`OBS has no ${change.kind === 'OBS profile' ? 'profile' : 'scene collection'} called "${change.to}".`);
      if (change.kind === 'OBS profile') await obs.setProfile(change.to);
      else await obs.setSceneCollection(change.to);
      result.applied.push(`${change.kind}: ${change.to}`);
      logActivity('OBS', `Switched ${change.kind === 'OBS profile' ? 'the OBS profile' : 'the scene collection'} to "${change.to}".`, 'info');
    } catch (err) {
      result.failed.push(`${change.kind}: ${err.message}`);
      logActivity('OBS', `Could not switch ${change.kind === 'OBS profile' ? 'the OBS profile' : 'the scene collection'} to "${change.to}": ${err.message}`, 'error');
    }
  }
  return result;
}

// Asks before leaving a profile that has windows open, since they close.
async function confirmLeaveProfile(targetName, obsPlan) {
  const obsText = describeObsPlan(obsPlan);
  if (viewWindows.size === 0 && !(obsPlan && obsPlan.changes.length)) return true;
  const { response } = await dialog.showMessageBox(controlWindow, {
    type: 'question',
    buttons: ['Cancel', 'Switch'],
    defaultId: 1,
    cancelId: 0,
    message: `Switch to ${targetName}?`,
    detail: [
      viewWindows.size > 0 ? 'The windows of the current profile close, and the new profile starts its own.' : '',
      obsText ? `OBS will switch:\n${obsText}` : 'OBS sources stay in OBS.',
    ].filter(Boolean).join('\n\n'),
  });
  return response === 1;
}

function profileName(id) {
  const profile = configStore.get().profiles.find((s) => s.id === id);
  return profile ? profile.name : id;
}

// ---------------------------------------------------------------------------
// Parking (the edge dock)
// ---------------------------------------------------------------------------

function dockDisplay() {
  const wanted = configStore.get().arrangeDisplayId;
  return screen.getAllDisplays().find((d) => d.id === wanted) || screen.getPrimaryDisplay();
}

// The edge a display parks toward: an edge with no display beyond it, so a
// parked window never spills onto another monitor (which would change its
// scale factor and therefore its captured size).
function parkingEdgeFor(display) {
  return parkingGeometry.parkingEdge(display, screen.getAllDisplays(), configStore.get().dock.side);
}

// Where a window goes when parked: hanging off its display's parking edge,
// keeping DOCK_WIDTH points on screen so OBS keeps capturing it.
function parkedPosition(win) {
  const display = screen.getDisplayMatching(win.getBounds());
  const [w, h] = win.getContentSize();
  const [x, y] = win.getPosition();
  return parkingGeometry.parkedPosition(parkingEdgeFor(display), display.workArea, x, y, w, h, configStore.get().dock.overlap);
}

async function parkView(id) {
  const win = viewWindows.get(id);
  if (!isAlive(win) || parked.has(id)) return;
  let thumb = '';
  const wc = pageOf(id);
  if (wc) {
    try {
      const image = await wc.capturePage();
      thumb = image.resize({ width: 220 }).toDataURL();
    } catch (err) {
      thumb = '';
    }
  }
  if (!isAlive(win)) return;
  const [x, y] = win.getPosition();
  const displayId = screen.getDisplayMatching(win.getBounds()).id;
  parked.set(id, { x, y, thumb, displayId });
  parking = true;
  const target = parkedPosition(win);
  win.setPosition(target.x, target.y);
  setTimeout(() => {
    parking = false;
  }, 300);
  collapsed = parked.size > 0;
  buildMenu();
  layoutDock();
  broadcastStatus();
}

function restoreView(id) {
  const entry = parked.get(id);
  const win = viewWindows.get(id);
  if (!entry) return;
  parked.delete(id);
  if (isAlive(win)) {
    parking = true;
    win.setPosition(entry.x, entry.y);
    win.moveTop();
    setTimeout(() => {
      parking = false;
    }, 300);
  }
  collapsed = parked.size > 0;
  buildMenu();
  layoutDock();
  broadcastStatus();
}

async function collapseViews() {
  for (const id of viewWindows.keys()) await parkView(id);
}

function expandViews() {
  for (const id of [...parked.keys()]) restoreView(id);
}

// --- Dock window and cover strips ---

// The dock pill is sized to its contents and centred on the display edge.
// The dock window always has the expanded size and is click-through while
// the pill is collapsed; the pill itself grows and shrinks inside it with a
// CSS transition, so hovering never resizes a window.
function dockSize(expanded) {
  const n = configStore.get().views.length;
  if (!expanded) return { width: DOCK_WIDTH, height: 92 + n * 16 };
  return { width: DOCK_EXPANDED, height: 200 + n * 182 + (configStore.get().recording.backend === 'builtin' ? 90 : 0) }; // the recording buttons add rows
}

function dockBounds(display) {
  return parkingGeometry.pillBounds(configStore.get().dock.side, display.workArea, dockSize(true));
}

function edgeWindowOptions(extra) {
  return {
    frame: false,
    roundedCorners: false,
    hasShadow: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    ...extra,
  };
}

function dockState() {
  return {
    side: configStore.get().dock.side,
    collapsed: dockSize(false),
    obsConnected: obs.connected,
    outputs: obs.status().outputs,
    recorder: configStore.get().recording.backend === 'builtin' ? { state: builtInRecorder.state, seconds: builtInRecorder.seconds(), toolbarOpen: isAlive(toolbarWindow) } : null, // the Showrunner Recorder, when the profile uses it
    windows: configStore.get().views.map((view) => {
      const win = viewWindows.get(view.id);
      const open = isAlive(win);
      const entry = parked.get(view.id);
      const [width, height] = open ? pageSize(win) : [view.width, view.height];
      const edge = open ? parkingEdgeFor(screen.getDisplayMatching(win.getBounds())) : null;
      return {
        id: view.id,
        label: view.label,
        open,
        parked: Boolean(entry),
        thumb: entry ? entry.thumb : '',
        width,
        height,
        edge,
        sources: windowSources(view),
      };
    }),
  };
}

function sendDockState() {
  if (isAlive(dockWindow) && !dockWindow.webContents.isDestroyed()) dockWindow.webContents.send('dock:state', dockState());
}

// Thin cover strips hide the parked slivers along the edge each display
// parks toward, only while something is parked there.
function layoutDock() {
  if (!isAlive(dockWindow)) return;
  dockWindow.setBounds(dockBounds(dockDisplay()), false);

  const overlap = configStore.get().dock.overlap;
  const parkedOn = new Set([...parked.values()].map((p) => p.displayId));
  const wanted = new Map();
  for (const d of screen.getAllDisplays()) {
    if (!parkedOn.has(d.id) || overlap <= 0) continue; // fully off screen needs no cover
    wanted.set(d.id, parkingGeometry.stripBounds(parkingEdgeFor(d), d.workArea, overlap));
  }
  for (const [id, strip] of coverStrips) {
    if (!wanted.has(id)) {
      if (isAlive(strip)) strip.destroy();
      coverStrips.delete(id);
    }
  }
  for (const [id, bounds] of wanted) {
    let strip = coverStrips.get(id);
    if (!isAlive(strip)) {
      strip = new BrowserWindow(edgeWindowOptions({ focusable: false, ...bounds }));
      strip.setAlwaysOnTop(true, 'floating');
      strip.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      strip.loadURL('data:text/html,<body style="margin:0;height:100vh;background:%23120d0a"></body>');
      coverStrips.set(id, strip);
    }
    strip.setBounds(bounds, false);
    strip.showInactive();
  }
}

function setupDock() {
  const { enabled } = configStore.get().dock;
  if (!enabled) {
    if (isAlive(dockWindow)) dockWindow.destroy();
    dockWindow = null;
    for (const strip of coverStrips.values()) if (isAlive(strip)) strip.destroy();
    coverStrips.clear();
    return;
  }
  if (!isAlive(dockWindow)) {
    dockWindow = new BrowserWindow(
      edgeWindowOptions({
        title: `${APP_NAME} Dock`,
        ...dockBounds(dockDisplay()),
        webPreferences: {
          preload: path.join(__dirname, 'dock-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          spellcheck: false,
        },
      }),
    );
    dockWindow.setAlwaysOnTop(true, 'floating');
    dockWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Click-through until the pointer reaches the pill; the page still sees
    // the pointer move so it knows when that happens.
    dockWindow.setIgnoreMouseEvents(true, { forward: true });
    dockWindow.on('page-title-updated', (event) => event.preventDefault());
    dockWindow.loadFile(path.join(__dirname, 'dock', 'index.html'));
    dockWindow.webContents.on('did-finish-load', sendDockState);
    dockWindow.once('ready-to-show', () => {
      if (isAlive(dockWindow)) dockWindow.showInactive();
    });
    dockWindow.on('closed', () => {
      dockWindow = null;
    });
  }
  layoutDock();
}

// Start every window that has a URL. The per-window "start on launch" flag
// only applies to app launch (see openLaunchViews below).
function openAllViews() {
  configStore
    .get()
    .views.filter((v) => v.url)
    .forEach((v) => createViewWindow(v));
}

// Start every window ticked Start on launch; those ticked Dock on launch
// slide into the dock once their page has loaded.
function openLaunchViews() {
  for (const v of configStore.get().views.filter((v) => v.enabled && v.url)) {
    createViewWindow(v);
    if (!v.dockOnLaunch) continue;
    const wc = pageOf(v.id);
    if (!wc) continue;
    let done = false;
    const dock = () => {
      if (done) return;
      done = true;
      parkView(v.id).catch(() => {});
    };
    wc.once('did-finish-load', () => setTimeout(dock, 1500)); // a moment for the page to paint its thumbnail
    setTimeout(dock, 20000); // a page that never finishes loading still docks
  }
}

// ---------------------------------------------------------------------------
// Teleprompter: one window per profile, for the presenter. It looks like the capture windows (the
// same borderless window and bar) but is not one: it is not in the views, never an OBS source, and
// not in the dock or Start All. See documentation/plans/plan-teleprompter.md.
// ---------------------------------------------------------------------------

let prompterWindow = null;
let prompterPage = null;
let prompterSessionScript = ''; // a script loaded for now by Automations or the chooser; '' means the Start Up script
let prompterIsEditing = false; // the page says so: a script cannot be swapped under an open editor
let prompterWatch = null; // { script, watcher, timer }

const prompterOpen = () => isAlive(prompterWindow);

function prompterSettings(t) {
  return { speed: t.speed, fontSize: t.fontSize, lineHeight: t.lineHeight, textWidth: t.textWidth, mirror: t.mirror };
}

// The teleprompter settings with the script it is showing now: the Start Up script unless one was loaded for now.
function prompterT() {
  const t = configStore.get().teleprompter;
  return prompterSessionScript ? { ...t, script: prompterSessionScript } : t;
}

// The profile's scripts: the ones it can show, in the order they were added. Anything shown or chosen joins the list; the
// first one in becomes the Start Up script if there is none.
function rememberScript(file) {
  if (!file) return;
  const t = configStore.get().teleprompter;
  const scripts = (t.scripts || []).includes(file) ? t.scripts : [...(t.scripts || []), file].slice(-30);
  saveTeleprompter({ scripts, ...(t.script ? {} : { script: file }) });
}

// Show a script for now (the Start Up script is untouched, and is what opens next time).
function useScript(file) {
  const startUp = configStore.get().teleprompter.script;
  prompterSessionScript = file && file !== startUp ? file : '';
  rememberScript(file);
  broadcastStatus();
  syncPrompter(true);
}

async function prompterContent(t) {
  if (!t.script) return { html: '', error: '' };
  try {
    const stat = await fs.promises.stat(t.script);
    if (stat.size > MAX_SCRIPT_BYTES) return { html: '', error: 'That file is larger than 2 MB, which is too big for a script.' };
    const text = await fs.promises.readFile(t.script, 'utf8');
    const { html } = await renderScript(text);
    return { html, name: path.basename(t.script), error: '' };
  } catch (err) {
    return { html: '', error: `${err.code === 'ENOENT' ? 'Cannot find' : 'Cannot read'} ${t.script}` };
  }
}

// A line for the teleprompter's status bar. `hold` keeps it up (it is what is happening now) until a later message
// with `release` replaces it; without either it shows for a few seconds. See status() in src/teleprompter/teleprompter.js.
function prompterStatus(text, error, flags = {}) {
  if (!prompterOpen() || !prompterPage || prompterPage.webContents.isDestroyed()) return;
  prompterPage.webContents.send('prompter:status', { text: String(text).slice(0, 120), error: Boolean(error), hold: Boolean(flags.hold), release: Boolean(flags.release) });
}

// The rule sets running right now, so the presenter can tell (their screen is this window, not Showrunner's): the
// bar says "Running: Title Sequence · step 2 of 3" for as long as it runs, and a wait shows as "waiting 5s".
const prompterRuns = new Map(); // run token -> what to say about it
let prompterRunToken = 0;
function prompterRunsLine() {
  const lines = [...prompterRuns.values()];
  return lines.length === 1 ? `Running: ${lines[0]}` : `Running: ${lines.join(' + ')}`;
}
function prompterRunUpdate(token, name, detail) {
  prompterRuns.set(token, detail ? `${name} \u00b7 ${detail}` : name);
  prompterStatus(prompterRunsLine(), false, { hold: true });
}
// A short, plain description of what a step did, for the status line.
function describeStep(step) {
  const p = step.param ? ` ${step.param}` : '';
  const known = {
    sceneSwitch: `switched to${p}`, sourceShow: `showed${p}`, sourceHide: `hid${p}`, sourceToggle: `toggled${p}`,
    setText: `set text on${p}`, sourceMute: `muted${p}`, sourceUnmute: `unmuted${p}`, setVolume: `set volume of${p}`,
    startRecording: 'started recording', stopRecording: 'stopped recording', pauseRecording: 'paused recording',
    resumeRecording: 'resumed recording', startStreaming: 'started streaming', stopStreaming: 'stopped streaming',
    showToast: 'sent a notification', runRuleSet: 'ran another rule set',
  };
  return known[step.action] || String(step.action || 'ran a step');
}

function prompterRunEnd(token, doneText, failed) {
  prompterRuns.delete(token);
  if (prompterRuns.size) prompterStatus(prompterRunsLine(), false, { hold: true });
  else prompterStatus(doneText, failed, { release: true });
}

function stopPrompterWatch() {
  if (!prompterWatch) return;
  clearTimeout(prompterWatch.timer);
  try { prompterWatch.watcher.close(); } catch (err) { /* already closed */ }
  prompterWatch = null;
}

// Watches the script's folder, not the file, so an editor that saves by replacing the file is still seen.
function watchPrompter(t) {
  if (prompterWatch && prompterWatch.script === t.script) return;
  stopPrompterWatch();
  if (!t.script) return;
  try {
    const base = path.basename(t.script);
    const entry = { script: t.script, timer: null, watcher: null };
    entry.watcher = fs.watch(path.dirname(t.script), (_event, name) => {
      if (name && name !== base) return;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(async () => {
        if (prompterPage && !prompterPage.webContents.isDestroyed()) {
          prompterPage.webContents.send('prompter:content', await prompterContent(prompterT()));
        }
      }, 200);
    });
    entry.watcher.on('error', () => stopPrompterWatch());
    prompterWatch = entry;
  } catch (err) {
    console.warn(`[teleprompter] Cannot watch ${t.script}: ${err.message}`);
  }
}

async function pushPrompter(fresh) {
  if (!prompterPage || prompterPage.webContents.isDestroyed()) return;
  const t = prompterT();
  watchPrompter(t);
  const content = await prompterContent(t);
  prompterPage.webContents.send('prompter:content', fresh ? { ...content, fresh: true } : content);
  prompterPage.webContents.send('prompter:settings', prompterSettings(t));
}

function layoutPrompter() {
  if (!prompterOpen() || !prompterPage) return;
  const [w, h] = pageSize(prompterWindow);
  prompterPage.setBounds({ x: 0, y: BAR_HEIGHT, width: w, height: h });
}

function sendPrompterBar() {
  if (!prompterOpen() || prompterWindow.webContents.isDestroyed()) return;
  const [x, y] = prompterWindow.getPosition();
  const [width, height] = pageSize(prompterWindow);
  prompterWindow.webContents.send('bar:state', { id: 'teleprompter', label: 'Teleprompter', x, y, width, height, prompter: true });
}

// The bar's arrow keys, same as a capture window: 1px, 10px with Shift.
function resizePrompter(dw, dh) {
  if (!prompterOpen()) return;
  const clamp = (n) => Math.min(LIMITS.maxSize, Math.max(LIMITS.minSize, n));
  const [w, h] = pageSize(prompterWindow);
  const width = clamp(w + dw);
  const height = clamp(h + dh);
  if (width === w && height === h) return;
  prompterWindow.setContentSize(width, height + BAR_HEIGHT);
  saveTeleprompter({ width, height });
}

function saveTeleprompter(patch) {
  const current = configStore.get();
  configStore.save({ ...current, teleprompter: { ...current.teleprompter, ...patch } });
  broadcastStatus();
}

function openPrompter() {
  if (prompterOpen()) {
    prompterWindow.show();
    return prompterWindow;
  }
  const t = configStore.get().teleprompter;
  const options = {
    title: `${APP_NAME} - Teleprompter`,
    width: t.width,
    height: t.height + BAR_HEIGHT,
    useContentSize: true,
    frame: false,
    roundedCorners: false,
    hasShadow: false,
    // Unlike a capture window, which has a fixed size for OBS, the presenter drags this to fit.
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0B0F16',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'bar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  };
  if (Number.isInteger(t.x) && Number.isInteger(t.y)) {
    options.x = t.x;
    options.y = t.y;
  }
  const win = new BrowserWindow(options);
  prompterWindow = win;
  win.loadFile(path.join(__dirname, 'bar', 'index.html'));
  win.webContents.on('did-finish-load', sendPrompterBar);
  win.on('page-title-updated', (event) => event.preventDefault());

  const page = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'teleprompter-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  prompterPage = page;
  win.contentView.addChildView(page);
  page.setBackgroundColor('#0B0F16');
  layoutPrompter();
  page.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  page.webContents.on('will-navigate', (event) => event.preventDefault());

  let sizeTimer = null;
  win.on('move', sendPrompterBar);
  win.on('moved', () => {
    if (!isAlive(win)) return;
    const [x, y] = win.getPosition();
    saveTeleprompter({ x, y });
  });
  win.on('resize', () => {
    layoutPrompter();
    sendPrompterBar();
    // Dragging an edge keeps the new size.
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      if (!isAlive(win)) return;
      const [width, height] = pageSize(win);
      const current = configStore.get().teleprompter;
      if (current.width !== width || current.height !== height) saveTeleprompter({ width, height });
    }, 300);
  });
  win.on('closed', () => {
    clearTimeout(sizeTimer);
    stopPrompterWatch();
    if (prompterWindow === win) {
      prompterWindow = null;
      prompterPage = null;
      prompterIsEditing = false;
      prompterSessionScript = '';
    }
    if (!page.webContents.isDestroyed()) page.webContents.close();
    broadcastStatus();
  });
  const show = () => { if (isAlive(win) && !win.isVisible()) { win.show(); broadcastStatus(); } };
  win.once('ready-to-show', show);
  setTimeout(show, 5000);

  page.webContents.loadFile(path.join(__dirname, 'teleprompter', 'index.html'));
  broadcastStatus();
  return win;
}

// Settings saved from the control panel: resize the open window to match and hand the page the new values.
function syncPrompter(fresh) {
  if (!prompterOpen()) return;
  const t = configStore.get().teleprompter;
  const [w, h] = pageSize(prompterWindow);
  if (w !== t.width || h !== t.height) prompterWindow.setContentSize(t.width, t.height + BAR_HEIGHT);
  pushPrompter(fresh).catch(() => {});
}

function closePrompter() {
  if (prompterOpen()) prompterWindow.close();
}

function closeAllViews() {
  for (const win of viewWindows.values()) {
    if (isAlive(win)) win.close();
  }
}

// ---------------------------------------------------------------------------
// Control panel window
// ---------------------------------------------------------------------------

function createControlWindow() {
  if (isAlive(controlWindow)) {
    controlWindow.show();
    controlWindow.focus();
    return controlWindow;
  }
  // Open where it was last left, as long as that spot is still on a display.
  const remembered = configStore.get().panel;
  const onScreen = remembered && screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return remembered.x < a.x + a.width - 80 && remembered.x + remembered.width > a.x + 80 && remembered.y >= a.y - 20 && remembered.y < a.y + a.height - 80;
  });
  const placement = onScreen ? remembered : { width: 1040, height: 780 };
  controlWindow = new BrowserWindow({
    title: `${APP_NAME} - Control Panel - ${REVISION}`,
    ...placement,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0E1A2B',
    // The native title bar was its own separate, system-colored strip above
    // the app's own dark .topbar (which already has -webkit-app-region:
    // drag set up for exactly this); hiddenInset keeps the traffic lights
    // but folds the bar itself into the page's own background.
    titleBarStyle: 'hiddenInset',
    // Centre the traffic lights on the header row (the row is 34px tall with
    // 12px padding, so the middle is y=29): at the default spot they sat near the top with
    // an empty gap beneath them, beside the logo. macOS only; ignored elsewhere.
    trafficLightPosition: { x: 20, y: 23 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required', // the microphone meter on the recorder page starts without a click
      spellcheck: false,
    },
  });
  controlWindow.loadFile(path.join(__dirname, 'control', 'index.html'));
  controlWindow.once('ready-to-show', () => controlWindow.show());
  // Closing the panel hides it; the app keeps running so OBS keeps its sources.
  controlWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      controlWindow.hide();
    }
  });
  // Remember size and position, a moment after the last move or resize.
  let panelTimer = null;
  const rememberPanel = () => {
    clearTimeout(panelTimer);
    panelTimer = setTimeout(() => {
      if (!isAlive(controlWindow) || controlWindow.isMinimized()) return;
      const current = configStore.get();
      configStore.save({ ...current, panel: controlWindow.getBounds() });
    }, 400);
  };
  controlWindow.on('move', rememberPanel);
  controlWindow.on('resize', rememberPanel);
  controlWindow.on('closed', () => {
    clearTimeout(panelTimer);
    controlWindow = null;
  });
  return controlWindow;
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function buildMenu() {
  const views = configStore.get().views;
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `About ${APP_NAME}` },
        { type: 'separator' },
        {
          label: 'Control Panel',
          accelerator: 'CmdOrCtrl+0',
          click: () => createControlWindow(),
        },
        { type: 'separator' },
        ...(process.platform === 'darwin' ? [{ role: 'hide', label: `Hide ${APP_NAME}` }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }] : []),
        { role: 'quit', label: `Quit ${APP_NAME}` },
      ],
    },
    {
      // Copy/paste must work for typing the Foundry password.
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Views',
      submenu: [
        ...views.map((view, index) => ({
          label: `Open ${view.label}`,
          accelerator: `CmdOrCtrl+${index + 1}`,
          click: () => createViewWindow(getView(view.id)),
        })),
        { type: 'separator' },
        ...views.map((view, index) => ({
          label: `Reload ${view.label}`,
          accelerator: `CmdOrCtrl+Shift+${index + 1}`,
          click: () => reloadView(view.id),
        })),
        { type: 'separator' },
        { label: 'Open All', click: () => openAllViews() },
        { label: 'Close All', click: () => closeAllViews() },
        { type: 'separator' },
        {
          label: collapsed ? 'Undock Windows' : 'Dock Windows',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => (collapsed ? expandViews() : collapseViews()),
        },
        { type: 'separator' },
        {
          label: 'Reload Focused Window',
          accelerator: 'CmdOrCtrl+R',
          click: (_item, win) => {
            if (!isAlive(win)) return;
            const id = viewIdOf(win);
            if (id) reloadView(id);
            else win.webContents.reload();
          },
        },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'Alt+CmdOrCtrl+I',
          click: (_item, win) => {
            if (!isAlive(win)) return;
            const id = viewIdOf(win);
            const wc = id ? pageOf(id) : win.webContents;
            if (wc) wc.toggleDevTools();
          },
        },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Menu bar icon (optional)
// ---------------------------------------------------------------------------

function trayMenuTemplate() {
  const views = configStore.get().views;
  return [
    { label: `${APP_NAME} ${REVISION}`, enabled: false },
    { type: 'separator' },
    { label: 'Show Control Panel', click: () => createControlWindow() },
    { type: 'separator' },
    ...recordingMenuItems(),
    ...views.map((view) => {
      const open = isAlive(viewWindows.get(view.id));
      return {
        label: `${open ? 'Stop' : 'Start'} ${view.label}`,
        enabled: open || Boolean(view.url),
        click: () => (open ? closeView(view.id) : createViewWindow(getView(view.id))),
      };
    }),
    { label: 'Start All', click: () => openAllViews() },
    { label: 'Stop All', click: () => closeAllViews() },
    { type: 'separator' },
    {
      label: 'Wake Audio',
      enabled: viewWindows.size > 0,
      click: () => {
        for (const id of viewWindows.keys()) {
          if (wakeAudio(id)) wakeWhenReady(id, 5000);
        }
        setTimeout(broadcastStatus, 800);
      },
    },
    { label: 'Auto Arrange on Display', click: () => arrangeViews(configStore.get().arrangeDisplayId) },
    { type: 'separator' },
    {
      label: collapsed ? 'Undock Windows' : 'Dock Windows',
      enabled: viewWindows.size > 0,
      click: () => (collapsed ? expandViews() : collapseViews()),
    },
    {
      label: 'Sync OBS Sources',
      enabled: obs.connected,
      click: () => syncObs().catch(() => {}),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ];
}

// Recording from the menu bar: start or stop, pause or resume, and show or hide the toolbar (the Showrunner Recorder only).
function recordingMenuItems() {
  if (configStore.get().recording.backend !== 'builtin') return [];
  const st = builtInRecorder.status();
  const live = st.state === 'recording' || st.state === 'paused';
  const busy = st.state === 'starting' || st.state === 'stopping';
  const time = `${Math.floor(st.seconds / 60)}:${String(st.seconds % 60).padStart(2, '0')}`;
  const run = (action) => () => { recordingBackends.run(action).catch((err) => logActivity('Recorder', err.message, 'error')); };
  return [
    { label: live ? `Stop Recording (${time})` : busy ? 'Recording...' : 'Start Recording', enabled: !busy, click: run(live ? 'stopRecording' : 'startRecording') },
    ...(live ? [{ label: st.state === 'paused' ? 'Resume Recording' : 'Pause Recording', click: run(st.state === 'paused' ? 'resumeRecording' : 'pauseRecording') }] : []),
    { label: isAlive(toolbarWindow) ? 'Hide Recording Toolbar' : 'Show Recording Toolbar', click: () => toggleToolbar() },
    { type: 'separator' },
  ];
}

// While recording, the menu bar icon is a red disc with the time (orange when paused); otherwise it is the usual icon.
let trayIcons = { normal: null };
function recordingDot(color) {
  const size = 44; const buf = Buffer.alloc(size * size * 4);
  const [r, g, b] = color; const c = (size - 1) / 2; const rad = size * 0.36;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const d = Math.hypot(x - c, y - c); const a = Math.max(0, Math.min(1, rad + 0.5 - d));
    const i = (y * size + x) * 4; buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = Math.round(a * 255); // BGRA
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}
function updateTrayRecording() {
  if (!tray || tray.isDestroyed()) return;
  const st = builtInRecorder.status();
  const live = configStore.get().recording.backend === 'builtin' && (st.state === 'recording' || st.state === 'paused');
  if (!trayIcons.rec) { trayIcons.rec = recordingDot([229, 72, 77]); trayIcons.paused = recordingDot([230, 162, 60]); }
  const starting = configStore.get().recording.backend === 'builtin' && st.state === 'starting';
  tray.setImage(live ? (st.state === 'paused' ? trayIcons.paused : trayIcons.rec) : starting ? trayIcons.paused : trayIcons.normal);
  if (process.platform === 'darwin' && starting) tray.setTitle(' starting...');
  else if (process.platform === 'darwin') tray.setTitle(live ? ` ${Math.floor(st.seconds / 60)}:${String(st.seconds % 60).padStart(2, '0')}${st.state === 'paused' ? ' paused' : ''}` : '');
  tray.setToolTip(live ? `${APP_NAME} - ${st.state === 'paused' ? 'paused' : 'recording'}` : APP_NAME);
}

function refreshTrayMenu() {
  updateTrayRecording();
  if (tray && !tray.isDestroyed()) tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
}

function setupTray() {
  const { menuBarIcon, hideDockIcon } = configStore.get();
  if (menuBarIcon && !tray) {
    // A template image -- macOS renders it as a plain black/white
    // silhouette from its alpha channel alone, auto-tinting it to match
    // the menu bar's own light/dark state, the same as every other native
    // menu bar icon. Tried a real colored icon here briefly; reverted --
    // a fixed color stood out against the monochrome icons everyone else's
    // menu bar extras use, rather than reading as "a normal part of the
    // menu bar." `@2x` is picked up automatically by nativeImage from the
    // file alongside this one.
    // Windows/Linux have no template images: use the white mark (the
    // @1.5x/@2x/@3x files beside trayWin.png are picked up by scale factor).
    const icon = process.platform === 'darwin'
      ? nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'))
      : nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayWin.png'));
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    tray = new Tray(icon);
    trayIcons = { normal: icon };
    tray.setToolTip(APP_NAME);
    tray.on('double-click', () => createControlWindow());
    refreshTrayMenu();
  } else if (!menuBarIcon && tray) {
    tray.destroy();
    tray = null;
  }
  if (process.platform === 'darwin' && app.dock) {
    if (menuBarIcon && hideDockIcon) app.dock.hide();
    else app.dock.show();
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Live preview and meters. The toolbar shows a small live copy of the picture (each chosen window; the toolbar adds the webcam and
// lays it out with the same code the recorder uses). The meters watch how loud each window is, for the toolbar and for the recorder
// page while it is open. While recording, the pictures come from the recorder's own captures.
// ---------------------------------------------------------------------------
let previewTimer = null;
let previewBusy = false;
let previewLast = [0, 0];
let feedControl = false; // the recorder page is open
let camPreviewOn = false; // its webcam preview is showing

function sendPreviewFrame(index, image) {
  if (!isAlive(toolbarWindow)) return;
  const small = image.resize({ width: 480 });
  const { width, height } = small.getSize();
  if (width && height) toolbarWindow.webContents.send('toolbar:frame', { i: index, w: width, h: height, buf: small.toBitmap() });
}

// Decides what to watch from who is looking: pictures only for a toolbar showing its preview, loudness for the toolbar or the page.
function updateFeed() {
  clearInterval(previewTimer); previewTimer = null;
  const cfg = configStore.get().recording;
  const toolbarOpen = isAlive(toolbarWindow);
  builtInRecorder.monitor(feedControl || toolbarOpen ? cfg.sources : null);
  if (!(toolbarOpen && cfg.toolbar.preview)) return;
  previewTimer = setInterval(async () => {
    if (builtInRecorder.active) return;
    if (previewBusy) return;
    previewBusy = true;
    try {
      const sourceIds = configStore.get().recording.sources;
      builtInRecorder.monitor(sourceIds); // follows a change of window
      const sources = builtInRecorder.getSources(sourceIds);
      await Promise.all(sources.map(async (wc, i) => { try { sendPreviewFrame(i, await wc.capturePage()); } catch (err) { /* closing or reloading */ } }));
    } finally { previewBusy = false; }
  }, 250);
}
ipcMain.on('recording:previewFeed', (_event, on) => { feedControl = Boolean(on); updateFeed(); });
ipcMain.on('recording:camPreview', (_event, on) => { camPreviewOn = Boolean(on); scheduleWarm(); });
builtInRecorder.on('composite', (picture) => { if (isAlive(toolbarWindow)) toolbarWindow.webContents.send('toolbar:composite', picture); });

// ---------------------------------------------------------------------------
// Recording toolbar: a small window that floats above everything with record, pause, stop, the time, and a level and mute for each
// sound source. It is its own window, so it is never part of a recording (the recorder reads only the windows it was told to).
// ---------------------------------------------------------------------------
let toolbarWindow = null;
let toolbarAudioTimer = null;

function toolbarState() {
  const cfg = configStore.get();
  const r = cfg.recording;
  const label = (id) => { const v = cfg.views.find((x) => x.id === id); return v ? (v.label || v.id) : ''; };
  return { ...builtInRecorder.status(), layout: r.layout, fit: r.fit, camera: r.camera, preview: r.toolbar.preview, hidePreviewOnRecord: r.toolbar.hidePreviewOnRecord, names: [label(r.sources[0]), label(r.sources[1])], audio: r.audio };
}

// While the toolbar is open the recorder is kept ready (its window, microphone and webcam), so Record starts at once. It is made ready
// again a moment after any setting changes, and let go when the toolbar closes.
let warmTimer = null;
function scheduleWarm() {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    const r = configStore.get().recording;
    if ((isAlive(toolbarWindow) || camPreviewOn || r.toolbar.keepReady) && r.backend === 'builtin') builtInRecorder.warm({ layout: r.layout, camera: r.camera, audio: r.audio });
    else builtInRecorder.unwarm();
  }, 700);
}

function sendToolbarState() {
  if (isAlive(toolbarWindow)) toolbarWindow.webContents.send('toolbar:state', toolbarState());
}

// Saves a change to the recording settings the way the control panel does, without touching anything else.
function saveRecordingPatch(patch) {
  const cur = configStore.get();
  configStore.save({ ...cur, recording: { ...cur.recording, ...patch } });
  broadcastStatus();
}

function openToolbar({ focus = true } = {}) {
  if (isAlive(toolbarWindow)) { if (focus) toolbarWindow.show(); else toolbarWindow.showInactive(); return; }
  const t = configStore.get().recording.toolbar;
  const options = {
    title: `${APP_NAME} - Recording`,
    width: 480, height: 150, useContentSize: true,
    frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: true, backgroundColor: '#0E1A2B', show: false,
    webPreferences: { preload: path.join(__dirname, 'toolbar-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  };
  if (t.x !== null && t.y !== null && screen.getAllDisplays().some((d) => t.x >= d.bounds.x && t.x < d.bounds.x + d.bounds.width && t.y >= d.bounds.y && t.y < d.bounds.y + d.bounds.height)) {
    options.x = t.x; options.y = t.y;
  }
  const win = new BrowserWindow(options);
  toolbarWindow = win;
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'toolbar', 'index.html'));
  win.once('ready-to-show', () => { if (focus) win.show(); else win.showInactive(); });
  win.on('page-title-updated', (event) => event.preventDefault());
  win.on('moved', () => {
    if (!isAlive(win)) return;
    const [x, y] = win.getPosition();
    saveRecordingPatch({ toolbar: { ...configStore.get().recording.toolbar, x, y } });
  });
  win.on('closed', () => { if (toolbarWindow === win) toolbarWindow = null; updateFeed(); scheduleWarm(); broadcastStatus(); });
  updateFeed();
  scheduleWarm();
  broadcastStatus();
}

// One button to show or hide the toolbar (the control panel and the menu bar icon both use it).
function toggleToolbar() {
  if (isAlive(toolbarWindow)) toolbarWindow.close(); else openToolbar();
}

function registerToolbarIpc() {
  ipcMain.handle('toolbar:init', () => toolbarState());
  ipcMain.handle('toolbar:action', async (_event, name) => {
    const action = { start: 'startRecording', stop: 'stopRecording', pause: 'pauseRecording', resume: 'resumeRecording' }[name];
    if (!action) return { error: 'Unknown action.' };
    try { await recordingBackends.run(action); return {}; } catch (err) { return { error: err.message }; }
  });
  // Levels apply at once; saving to disk waits until the slider rests.
  ipcMain.on('toolbar:setAudio', (_event, audio) => {
    builtInRecorder.setAudio(audio);
    clearTimeout(toolbarAudioTimer);
    toolbarAudioTimer = setTimeout(() => saveRecordingPatch({ audio }), 400);
  });
  ipcMain.on('toolbar:size', (_event, height) => {
    if (isAlive(toolbarWindow) && Number.isFinite(height) && height > 40 && height < 600) toolbarWindow.setContentSize(480, Math.round(height));
  });
  ipcMain.handle('toolbar:reveal', () => { const f = builtInRecorder.file; if (f && fs.existsSync(f)) shell.showItemInFolder(f); });
  ipcMain.on('toolbar:close', () => { if (isAlive(toolbarWindow)) toolbarWindow.close(); });
  ipcMain.handle('toolbar:show', () => { toggleToolbar(); });
  ipcMain.on('toolbar:setPreview', (_event, on) => { saveRecordingPatch({ toolbar: { ...configStore.get().recording.toolbar, preview: Boolean(on) } }); updateFeed(); sendToolbarState(); });
}

let calibrating = false;

async function askMediaAccess(kind) {
  if (process.platform !== 'darwin') return 'granted';
  const status = systemPreferences.getMediaAccessStatus(kind);
  if (status === 'not-determined') return (await systemPreferences.askForMediaAccess(kind)) ? 'granted' : 'denied';
  return status;
}

function registerIpc() {
  ipcMain.handle('config:get', () => configStore.get());
  // The recorder's levels and mutes, applied at once while recording (the saved settings follow with the next save).
  ipcMain.handle('recording:setAudio', (_event, audio) => { builtInRecorder.setAudio(audio); });
  // Lets the person allow the microphone from the Recorder page before the first recording.
  ipcMain.handle('recording:askMicrophone', () => askMediaAccess('microphone'));
  ipcMain.handle('recording:askCamera', () => askMediaAccess('camera'));
  ipcMain.handle('recording:reveal', (_event, file) => { const f = file || builtInRecorder.file || (builtInRecorder.interrupted && builtInRecorder.interrupted.file); if (f && fs.existsSync(f)) shell.showItemInFolder(f); });
  ipcMain.handle('activity:clear', () => { activityLog = []; try { fs.writeFileSync(path.join(app.getPath('userData'), 'recorder.log'), ''); } catch (err) { /* nothing to clear */ } broadcastStatus(); });
  ipcMain.handle('recording:openPrivacy', (_event, kind) => shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${kind === 'camera' ? 'Camera' : 'Microphone'}`));
  ipcMain.handle('config:save', (_event, next) => {
    // The window source has its own channel (windowSource:set) that also
    // renames the source in OBS; a stale copy from the panel must not undo that.
    const current = configStore.get();
    const input = next && typeof next === 'object' ? next : {};
    const views = Array.isArray(input.views)
      ? input.views.map((v) => {
          const stored = v && typeof v === 'object' ? current.views.find((c) => c.id === v.id) : null;
          return stored ? { ...v, windowSource: stored.windowSource } : v;
        })
      : input.views;
    const saved = configStore.save({ ...input, views });
    saved.views.forEach(applyViewSettings);
    syncPrompter();
    setupTray();
    setupDock();
    buildMenu();
    syncObsConnection().catch(() => {});
    scheduleObsSync();
    updateFeed();
    broadcastStatus();
    return saved;
  });
  // --- Backups ---
  ipcMain.handle('backups:list', () => backups.list(app.getPath('userData')));
  ipcMain.handle('backups:create', () => {
    const created = backups.create(app.getPath('userData'), 'manual');
    if (!created) throw new Error('There are no settings to back up yet.');
    logActivity('Studio', 'Backed up the settings.', 'info');
    return backups.list(app.getPath('userData'));
  });
  ipcMain.handle('backups:reveal', () => {
    const dir = backups.backupsDir(app.getPath('userData'));
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });
  ipcMain.handle('backups:restore', async (_event, id) => {
    const target = backups.list(app.getPath('userData')).find((b) => b.id === id);
    if (!target) throw new Error('That backup no longer exists.');
    const when = target.created ? new Date(target.created).toLocaleString() : target.id;
    const { response } = await dialog.showMessageBox(controlWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Restore and restart'],
      defaultId: 0,
      cancelId: 0,
      message: `Restore the backup from ${when}?`,
      detail: 'This replaces your current settings with the ones in that backup, then restarts Showrunner. Your current settings are backed up first, so you can undo this from the same list.',
    });
    if (response !== 1) return null;
    backups.restore(app.getPath('userData'), id);
    // exit() rather than quit(): closing windows would save the settings now
    // in memory over the ones just restored.
    app.relaunch();
    app.exit(0);
    return true;
  });

  ipcMain.handle('config:reset', () => {
    const saved = configStore.save({});
    saved.views.forEach(applyViewSettings);
    syncPrompter();
    setupTray();
    setupDock();
    buildMenu();
    scheduleObsSync();
    broadcastStatus();
    return saved;
  });
  ipcMain.handle('profiles:switch', async (_event, id) => {
    const target = String(id);
    if (target === configStore.get().activeProfile) return configStore.get();
    const targetProfile = configStore.get().profiles.find((p) => p.id === target);
    const obsPlan = await planObsPins(targetProfile && targetProfile.obsPins);
    assertObsCanSwitch(obsPlan);
    if (!(await confirmLeaveProfile(profileName(target), obsPlan))) return null;
    return switchProfile(target);
  });
  ipcMain.handle('profiles:create', async (_event, name) => {
    const nextName = typeof name === 'string' ? name : '';
    if (viewWindows.size > 0) {
      const label = nextName.trim() || 'the new profile';
      if (!(await confirmLeaveProfile(label))) return null;
    }
    const id = configStore.createProfile(nextName);
    return switchProfile(id);
  });
  ipcMain.handle('profiles:duplicate', async (_event, id) => {
    const copyId = configStore.duplicateProfile(String(id));
    buildMenu();
    broadcastStatus();
    return { id: copyId, config: configStore.get() };
  });
  // The OBS profile and scene collection this OBS has, for the OBS page's pickers.
  ipcMain.handle('obs:pinChoices', async () => {
    if (!obs.connected) return { connected: false, profiles: [], currentProfile: '', collections: [], currentCollection: '' };
    const [p, c] = await Promise.all([obs.listProfiles(), obs.listSceneCollections()]);
    return { connected: true, profiles: p.profiles, currentProfile: p.current, collections: c.collections, currentCollection: c.current };
  });
  ipcMain.handle('obs:setPins', (_event, pins) => {
    const current = configStore.get();
    const saved = configStore.save({ ...current, obsPins: pins });
    broadcastStatus();
    return saved.obsPins;
  });
  // Switch OBS to the names in the OBS page's pickers now, whether or not the profile's switch is on.
  ipcMain.handle('obs:applyPins', async () => {
    const pins = { ...configStore.get().obsPins, enabled: true };
    if (!pins.profile && !pins.collection) throw new Error('Pick an OBS profile or a scene collection first.');
    const plan = await planObsPins(pins);
    if (plan && plan.note) throw new Error(plan.note);
    if (!plan || plan.changes.length === 0) return { applied: [], failed: [], note: 'OBS is already on those.' };
    assertObsCanSwitch(plan);
    const { response } = await dialog.showMessageBox(controlWindow, {
      type: 'question',
      buttons: ['Cancel', 'Switch OBS'],
      defaultId: 1,
      cancelId: 0,
      message: 'Switch OBS now?',
      detail: `OBS will switch:\n${describeObsPlan(plan)}\n\nShowrunner then re-syncs its sources into the scene collection.`,
    });
    if (response !== 1) return null;
    const result = await applyObsPins(pins);
    scheduleObsSync();
    return result;
  });
  ipcMain.handle('profiles:setIntegration', (_event, id, key, enabled) => {
    configStore.setProfileIntegration(String(id), String(key), Boolean(enabled));
    broadcastStatus();
    return configStore.get();
  });
  ipcMain.handle('profiles:rename', (_event, id, name) => {
    configStore.renameProfile(String(id), typeof name === 'string' ? name : '');
    broadcastStatus();
    return configStore.get();
  });
  ipcMain.handle('profiles:delete', async (_event, id) => {
    const target = String(id);
    const current = configStore.get();
    const doomed = current.profiles.find((s) => s.id === target);
    if (!doomed) throw new Error(`Unknown profile: ${target}`);
    if (current.profiles.length <= 1) throw new Error('The last profile cannot be deleted.');
    const { response } = await dialog.showMessageBox(controlWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      message: `Delete the profile "${doomed.name}"?`,
      detail: 'Its windows, Session fields and automation rules are removed from Showrunner. Sources already in OBS stay there. This cannot be undone.',
    });
    if (response !== 1) return null;
    if (target === current.activeProfile) await switchProfile(current.profiles.find((s) => s.id !== target).id);
    configStore.deleteProfile(target);
    broadcastStatus();
    return configStore.get();
  });
  ipcMain.handle('views:add', () => addView());
  ipcMain.handle('prompter:toggle', () => {
    if (prompterOpen()) closePrompter();
    else openPrompter();
    return prompterOpen();
  });
  // Add a script file to this profile's list (the first one added is the Start Up script). Used by the Teleprompter page's
  // Add script and by the Browse button of a load-a-script step; it returns the file so the step can use it.
  ipcMain.handle('prompter:addScript', async () => {
    const t = prompterT();
    const { canceled, filePaths } = await dialog.showOpenDialog(controlWindow, {
      title: 'Add a script',
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
      defaultPath: t.script ? path.dirname(t.script) : undefined,
    });
    if (canceled || !filePaths[0]) return { config: configStore.get(), path: '' };
    rememberScript(filePaths[0]);
    broadcastStatus();
    syncPrompter();
    return { config: configStore.get(), path: filePaths[0] };
  });
  ipcMain.handle('prompter:init', async (event) => {
    if (!prompterPage || event.sender !== prompterPage.webContents) return { content: { html: '', error: '' }, settings: {} };
    const t = prompterT();
    watchPrompter(t);
    return { content: await prompterContent(t), settings: prompterSettings(t) };
  });
  // The script editor in the teleprompter window (src/teleprompter/edit.js): read the file and save it back.
  ipcMain.handle('prompter:readScript', async () => {
    const t = prompterT();
    if (!t.script) return { text: '', path: '', error: '' };
    try {
      const stat = await fs.promises.stat(t.script);
      if (stat.size > MAX_SCRIPT_BYTES) return { text: '', error: 'That file is larger than 2 MB, which is too big for a script.' };
      return { text: await fs.promises.readFile(t.script, 'utf8'), path: t.script, error: '' };
    } catch (err) {
      return { text: '', error: `${err.code === 'ENOENT' ? 'Cannot find' : 'Cannot read'} ${t.script}` };
    }
  });
  ipcMain.handle('prompter:writeScript', async (_event, text) => {
    const t = prompterT();
    if (!t.script) return { ok: false, error: 'Choose or create a script file first.' };
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_SCRIPT_BYTES) return { ok: false, error: 'The script is larger than 2 MB.' };
    try {
      await fs.promises.writeFile(t.script, text, 'utf8');
      return { ok: true, error: '' };
    } catch (err) {
      return { ok: false, error: `Cannot save ${t.script}: ${err.message}` };
    }
  });
  // Save the text in the editor to a file the person picks, and make that the profile's script. Used for a script that has
  // no file yet and for Save as.
  ipcMain.handle('prompter:saveAs', async (event, text, options) => {
    if (!prompterPage || event.sender !== prompterPage.webContents) return { ok: false, canceled: true, error: '' };
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_SCRIPT_BYTES) return { ok: false, canceled: false, error: 'The script is larger than 2 MB.' };
    const t = prompterT();
    const { canceled, filePath } = await dialog.showSaveDialog(prompterWindow, {
      title: 'Save script',
      // A new script is never offered the current script's name; Save as of the current one is.
      defaultPath: options && options.fresh
        ? path.join(t.script ? path.dirname(t.script) : app.getPath('documents'), 'untitled.md')
        : t.script || path.join(app.getPath('documents'), 'script.md'),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true, error: '' };
    try {
      await fs.promises.writeFile(filePath, text, 'utf8');
    } catch (err) {
      return { ok: false, canceled: false, error: `Cannot save ${filePath}: ${err.message}` };
    }
    // With a script loaded for now, the copy is what is showing; otherwise it is the Start Up script, as before.
    if (prompterSessionScript) prompterSessionScript = filePath;
    else saveTeleprompter({ script: filePath });
    rememberScript(filePath);
    syncPrompter();
    return { ok: true, canceled: false, path: filePath, error: '' };
  });
  ipcMain.handle('prompter:newScript', async () => {
    const t = prompterT();
    const { canceled, filePath } = await dialog.showSaveDialog(controlWindow, {
      title: 'New script',
      defaultPath: path.join(t.script ? path.dirname(t.script) : app.getPath('documents'), 'script.md'),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (canceled || !filePath) return configStore.get();
    try {
      await fs.promises.writeFile(filePath, '# Opening\n\nWrite what you will say here.\n\n<!-- cue: Example cue -->\n\n## Next part\n\n', { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err; // an existing file is opened, never overwritten
    }
    rememberScript(filePath);
    // A new script is for writing: show it now if the teleprompter is open.
    if (prompterOpen()) useScript(filePath);
    else broadcastStatus();
    return configStore.get();
  });
  // The scripts this profile has used, and which is the Start Up script and which is showing.
  ipcMain.handle('prompter:scripts', (event) => {
    if (!prompterPage || event.sender !== prompterPage.webContents) return { startUp: '', current: '', scripts: [] };
    const t = configStore.get().teleprompter;
    return { startUp: t.script, current: prompterT().script, scripts: t.scripts || [] };
  });
  // Show a known script for now. From the window's own File menu while editing it is allowed (the editor reloads itself);
  // from the control panel it is not, so a script is never swapped under an open editor.
  ipcMain.handle('prompter:useScript', async (event, file) => {
    const fromWindow = Boolean(prompterPage) && event.sender === prompterPage.webContents;
    if (!fromWindow && prompterIsEditing) return { ok: false, error: 'The teleprompter is being edited; finish editing first.' };
    const t = configStore.get().teleprompter;
    if (typeof file !== 'string' || (file !== t.script && !(t.scripts || []).includes(file))) return { ok: false, error: 'That script is not in this profile\'s list.' };
    try { await fs.promises.access(file); } catch (err) { return { ok: false, error: `Cannot find ${file}` }; }
    useScript(file);
    prompterStatus(`Showing ${path.basename(file)}`);
    return { ok: true, error: '' };
  });
  ipcMain.handle('prompter:setStartUp', (_event, file) => {
    const t = configStore.get().teleprompter;
    if (typeof file !== 'string' || (file !== t.script && !(t.scripts || []).includes(file))) return configStore.get();
    saveTeleprompter({ script: file });
    if (prompterSessionScript === file) prompterSessionScript = '';
    broadcastStatus();
    return configStore.get();
  });
  // The order of the list is only for the person reading it; nothing else uses it.
  ipcMain.handle('prompter:moveScript', (_event, file, direction) => {
    const t = configStore.get().teleprompter;
    const list = t.script && !(t.scripts || []).includes(t.script) ? [t.script, ...(t.scripts || [])] : [...(t.scripts || [])];
    const from = list.indexOf(file);
    const to = from + (direction < 0 ? -1 : 1);
    if (from < 0 || to < 0 || to >= list.length) return configStore.get();
    [list[from], list[to]] = [list[to], list[from]];
    saveTeleprompter({ scripts: list });
    broadcastStatus();
    return configStore.get();
  });
  ipcMain.handle('prompter:removeScript', (_event, file) => {
    const t = configStore.get().teleprompter;
    const scripts = (t.scripts || []).filter((f) => f !== file);
    // Removing the Start Up script hands that job to the next one in the list.
    const patch = { scripts };
    if (file === t.script) patch.script = scripts[0] || '';
    saveTeleprompter(patch);
    if (prompterSessionScript === file) prompterSessionScript = '';
    broadcastStatus();
    syncPrompter(true);
    return configStore.get();
  });
  // The Automations page's list of the script's cues and headings, in reading order, each with the event it fires.
  ipcMain.handle('prompter:cues', async () => {
    const t = prompterT();
    if (!t.script) return { script: '', cues: [], error: '' };
    try {
      const stat = await fs.promises.stat(t.script);
      if (stat.size > MAX_SCRIPT_BYTES) return { script: t.script, cues: [], error: 'That file is larger than 2 MB.' };
      const { cues } = await renderScript(await fs.promises.readFile(t.script, 'utf8'));
      return { script: t.script, cues, error: '' };
    } catch (err) {
      return { script: t.script, cues: [], error: `${err.code === 'ENOENT' ? 'Cannot find' : 'Cannot read'} ${t.script}` };
    }
  });
  // The Events panel in the teleprompter window: which events already have a rule set, making one, and opening it in the
  // control panel. The rule set itself (its steps) is built on the Automations page.
  const openRuleSet = (id) => {
    const window_ = createControlWindow();
    const send = () => { if (!window_.webContents.isDestroyed()) window_.webContents.send('open-rule-set', id); };
    if (window_.webContents.isLoading()) window_.webContents.once('did-finish-load', send);
    else send();
  };
  ipcMain.handle('prompter:ruleStatus', (event) => {
    if (!prompterPage || event.sender !== prompterPage.webContents) return {};
    const byEvent = {};
    for (const r of configStore.get().automations.ruleSets || []) {
      if (!r.event) continue;
      (byEvent[r.event] = byEvent[r.event] || []).push({ id: r.id, name: r.name });
    }
    return byEvent;
  });
  ipcMain.handle('prompter:createRule', (event, eventName, label) => {
    if (!prompterPage || event.sender !== prompterPage.webContents) return { ok: false };
    const name = typeof eventName === 'string' ? eventName.trim() : '';
    if (!name.startsWith('teleprompter:') || name.length > 60) return { ok: false };
    const current = configStore.get();
    const existing = (current.automations.ruleSets || []).find((r) => r.event === name);
    let id = existing && existing.id;
    if (!id) {
      id = `ruleset${Date.now().toString(36)}`;
      const ruleSet = { id, name: String(label || name).trim().slice(0, 60), group: 'Teleprompter', enabled: true, event: name, steps: [] };
      configStore.save({ ...current, automations: { ...current.automations, ruleSets: [...(current.automations.ruleSets || []), ruleSet] } });
      broadcastStatus();
    }
    openRuleSet(id);
    return { ok: true, id };
  });
  ipcMain.handle('prompter:openRule', (event, id) => {
    if (!prompterPage || event.sender !== prompterPage.webContents) return { ok: false };
    openRuleSet(String(id || ''));
    return { ok: true };
  });
  // The reading line reached a cue or a heading: tell Automations, exactly as if a module had.
  ipcMain.on('prompter:editing', (event, on) => {
    if (!prompterPage || event.sender !== prompterPage.webContents) return;
    prompterIsEditing = Boolean(on);
  });
  ipcMain.on('prompter:cue', (event, cue) => {
    if (!prompterPage || event.sender !== prompterPage.webContents) return;
    if (!cue || typeof cue.event !== 'string' || !cue.event.startsWith('teleprompter:')) return;
    automations.recordEvent(cue.event.slice(0, 60), { cue: String(cue.label || '').slice(0, 80), kind: cue.kind === 'heading' ? 'heading' : cue.kind === 'hold' ? 'hold' : 'cue' });
  });
  // Speed, text size and mirroring changed from the page's own controls or keys.
  ipcMain.on('prompter:save', (event, patch) => {
    if (!prompterPage || event.sender !== prompterPage.webContents || !patch || typeof patch !== 'object') return;
    const allowed = {};
    for (const key of ['speed', 'fontSize', 'lineHeight', 'textWidth', 'mirror']) if (patch[key] !== undefined) allowed[key] = patch[key];
    saveTeleprompter(allowed);
  });
  ipcMain.handle('views:remove', (_event, id) => removeView(id));
  ipcMain.handle('views:collapse', () => collapseViews());
  ipcMain.handle('views:expand', () => expandViews());
  ipcMain.handle('views:park', (_event, id) => parkView(id));
  ipcMain.handle('views:restore', (_event, id) => restoreView(id));

  ipcMain.on('dock:hover', (_event, expanded) => {
    dockExpanded = Boolean(expanded);
    if (isAlive(dockWindow)) dockWindow.setIgnoreMouseEvents(!dockExpanded, { forward: true });
  });
  ipcMain.on('dock:toggle', (_event, id) => {
    if (!configStore.getView(id)) return;
    if (parked.has(id)) restoreView(id);
    else if (isAlive(viewWindows.get(id))) parkView(id);
    else createViewWindow(getView(id));
  });
  ipcMain.on('dock:parkAll', () => collapseViews());
  ipcMain.on('dock:restoreAll', () => expandViews());
  ipcMain.on('dock:action', (_event, name) => {
    if (name === 'startAll') openAllViews();
    else if (name === 'stopAll') closeAllViews();
    else if (name === 'sync') syncObs().catch(() => {});
    else if (name === 'panel') createControlWindow();
    else if (name === 'recToggle' || name === 'recPause') {
      const live = ['recording', 'paused'].includes(builtInRecorder.state);
      const action = name === 'recToggle' ? (live ? 'stopRecording' : 'startRecording') : (builtInRecorder.state === 'paused' ? 'resumeRecording' : 'pauseRecording');
      recordingBackends.run(action).catch((err) => logActivity('Recorder', err.message, 'error'));
    } else if (name === 'toolbar') toggleToolbar();
    else if (name === 'wakeAudio') {
      for (const id of viewWindows.keys()) {
        if (wakeAudio(id)) wakeWhenReady(id, 5000);
      }
      setTimeout(broadcastStatus, 800);
    } else if (name === 'arrange') arrangeViews(configStore.get().arrangeDisplayId);
  });

  // --- OBS ---
  ipcMain.handle('obs:setSettings', async (_event, settings) => {
    const current = configStore.get();
    configStore.save({ ...current, obs: { ...current.obs, ...settings } });
    // Turning auto-connect on while offline connects right away.
    if (configStore.get().obs.autoConnect && !obs.connected) await obs.connect().catch(() => {});
    broadcastStatus();
    return fullStatus().obs;
  });
  ipcMain.handle('obs:setPassword', async (_event, password) => {
    writeObsPassword(password);
    broadcastStatus();
    return fullStatus().obs;
  });
  ipcMain.handle('obs:connect', async () => {
    await obs.connect();
    return fullStatus().obs;
  });
  ipcMain.handle('obs:disconnect', async () => {
    await obs.disconnect();
    return fullStatus().obs;
  });
  ipcMain.handle('obs:sync', () => syncObs());
  ipcMain.handle('obs:listScenes', () => obs.listScenes());
  ipcMain.handle('obs:listSources', () => obs.listSourceNames());
  ipcMain.handle('obs:setScene', (_event, sceneName) => obs.setCurrentScene(sceneName));
  ipcMain.handle('recording:chooseFolder', async () => {
    const result = await dialog.showOpenDialog(controlWindow && !controlWindow.isDestroyed() ? controlWindow : undefined, { properties: ['openDirectory', 'createDirectory'], defaultPath: configStore.get().recording.folder || app.getPath('videos') });
    return result.canceled || !result.filePaths[0] ? '' : result.filePaths[0];
  });
  ipcMain.handle('obs:startRecording', () => recordingBackends.run('startRecording'));
  ipcMain.handle('obs:pauseRecording', () => recordingBackends.run('pauseRecording'));
  ipcMain.handle('obs:resumeRecording', () => recordingBackends.run('resumeRecording'));
  ipcMain.handle('obs:stopRecording', () => recordingBackends.run('stopRecording'));
  ipcMain.handle('obs:startStreaming', () => recordingBackends.run('startStreaming'));
  ipcMain.handle('obs:stopStreaming', () => recordingBackends.run('stopStreaming'));
  // --- The whole window as an OBS source ---
  // Saves the switch and the name. Switching off hides the source in OBS
  // and stops maintaining it; renaming while the source exists in OBS renames
  // it there too, so the capture and its crop filter carry over.
  ipcMain.handle('windowSource:set', async (_event, id, patch) => {
    const view = getView(id);
    const src = patch && typeof patch === 'object' ? patch : {};
    const previous = view.windowSource;
    const next = {
      enabled: src.enabled === undefined ? previous.enabled : Boolean(src.enabled),
      name: typeof src.name === 'string' && src.name.trim() ? src.name.trim().slice(0, 200) : previous.name,
    };
    const inOtherUse = configStore
      .get()
      .views.some((v) => (v.id !== id && v.windowSource.name === next.name) || v.regions.some((r) => r.obsSource === next.name));
    if (next.name !== previous.name && inOtherUse) throw new Error(`"${next.name}" is already used by another window or region.`);
    const saved = configStore.updateView(id, { windowSource: next }).views.find((v) => v.id === id).windowSource;
    if (obs.connected) {
      const inputs = obs.status().inputs;
      if (saved.name !== previous.name && inputs.includes(previous.name) && !inputs.includes(saved.name)) {
        await obs.renameInput(previous.name, saved.name).catch((err) => console.warn(`[obs] rename: ${err.message}`));
        await obs.refreshInputs().catch(() => {});
      }
      if (saved.enabled !== previous.enabled && obs.status().inputs.includes(saved.name)) {
        await obs.setSourceVisible(saved.name, saved.enabled).catch((err) => console.warn(`[obs] visibility: ${err.message}`));
      }
    }
    scheduleObsSync();
    broadcastStatus();
    return saved;
  });
  // Creates the window's source in OBS under its name. A source that already
  // exists with that name (made by hand in OBS) is simply taken over.
  ipcMain.handle('windowSource:add', async (_event, id) => {
    const view = getView(id);
    const { name } = view.windowSource;
    const win = viewWindows.get(id);
    const windowId = systemWindowId(win);
    if (!windowId) throw new Error('Start the window first so OBS can capture it.');
    if (!obs.status().inputs.includes(name)) await obs.createInput(name, windowId);
    await obs.ensureCropFilter(name, barCrop(win));
    if (!view.windowSource.enabled) configStore.updateView(id, { windowSource: { ...view.windowSource, enabled: true } });
    scheduleObsSync();
    broadcastStatus();
    return name;
  });
  // --- App windows (other applications' windows captured into OBS) ---
  // OBS's own list of capturable windows, for the picker. Needs OBS
  // connected AND at least one existing window-capture source to read the
  // list from (OBS only exposes it through an existing input).
  ipcMain.handle('appWindows:list', async () => {
    if (!obs.connected) throw new Error('Connect to OBS first -- its window list is where this comes from.');
    const choices = await obs.windowChoices({ createProbe: true });
    if (!choices.length) {
      throw new Error(`OBS returned no windows. This needs at least one ${obs.backend.label} source to exist already -- add any window source first, then refresh.`);
    }
    return choices
      .filter((c) => typeof c.itemName === 'string' && c.itemName.trim())
      .map((c) => ({ label: c.itemName, ...parseWindowChoice(c.itemName) }));
  });
  // Creates the app window's source in OBS pointed at whichever window its
  // match rule finds right now. A source already existing under that name
  // (made by hand) is taken over, same as a web window's.
  ipcMain.handle('appWindows:add', async (_event, id) => {
    const app = configStore.get().appWindows.find((a) => a.id === id);
    if (!app) throw new Error('Unknown app window.');
    if (!obs.connected) throw new Error('Connect to OBS first.');
    if (!app.matchApp && !app.matchTitle) throw new Error('Pick a window (or fill in the app/title match) first.');
    const windowId = await obs.findAppWindowId({ app: app.matchApp, title: app.matchTitle, label: app.windowLabel });
    if (!windowId) throw new Error(`No open window matches "${[app.matchApp, app.matchTitle].filter(Boolean).join(' / ')}" -- open it, then try again.`);
    if (!obs.status().inputs.includes(app.sourceName)) await obs.createInput(app.sourceName, windowId, { showCursor: app.showCursor });
    scheduleObsSync();
    broadcastStatus();
    return app.sourceName;
  });
  // Renames the app window's OBS source (and the saved name) -- refuses a
  // name another window, region or app window already owns.
  ipcMain.handle('appWindows:rename', async (_event, id, name) => {
    const current = configStore.get();
    const app = current.appWindows.find((a) => a.id === id);
    if (!app) throw new Error('Unknown app window.');
    const next = typeof name === 'string' ? name.trim().slice(0, 200) : '';
    if (!next) throw new Error('A source name is required.');
    const taken =
      current.views.some((v) => v.windowSource.name === next || v.regions.some((r) => r.obsSource === next)) ||
      current.appWindows.some((a) => a.id !== id && a.sourceName === next);
    if (taken) throw new Error(`"${next}" is already used by another window, region or app window.`);
    const saved = configStore.save({ ...current, appWindows: current.appWindows.map((a) => (a.id === id ? { ...a, sourceName: next } : a)) });
    if (obs.connected) {
      const inputs = obs.status().inputs;
      if (inputs.includes(app.sourceName) && !inputs.includes(next)) {
        await obs.renameInput(app.sourceName, next).catch((err) => console.warn(`[obs] rename: ${err.message}`));
        await obs.refreshInputs().catch(() => {});
      }
    }
    scheduleObsSync();
    broadcastStatus();
    return saved.appWindows;
  });
  // --- Tavern ---
  ipcMain.handle('tavern:setSettings', async (_event, settings) => {
    const current = configStore.get();
    const previous = current.tavern;
    const saved = configStore.save({ ...current, tavern: { ...previous, ...settings } });
    const next = saved.tavern;
    if (tavern.connected && (!next.enabled || next.url !== previous.url || next.login !== previous.login)) {
      await tavern.disconnect();
    }
    if (next.enabled && next.autoConnect && !tavern.connected && next.url) await tavern.connect().catch(() => {});
    // Size changes reach every published source.
    await syncTavern().catch(() => {});
    await syncAutoLevel().catch(() => {});
    broadcastStatus();
    return fullStatus().tavern;
  });
  ipcMain.handle('tavern:setPassword', async (_event, password) => {
    writeSecret(TAVERN_SECRET_PATH, password);
    if (tavern.connected) await tavern.disconnect();
    const t = configStore.get().tavern;
    if (t.enabled && t.autoConnect) await tavern.connect().catch(() => {});
    broadcastStatus();
    return fullStatus().tavern;
  });
  ipcMain.handle('tavern:connect', async () => {
    await tavern.connect();
    return fullStatus().tavern;
  });
  ipcMain.handle('tavern:disconnect', async () => {
    await tavern.disconnect();
    return fullStatus().tavern;
  });
  ipcMain.handle('tavern:verifyMfa', async (_event, code) => {
    await tavern.verifyCode(String(code || ''));
    return fullStatus().tavern;
  });
  ipcMain.handle('tavern:cancelMfa', () => {
    tavern.cancelMfa();
    return fullStatus().tavern;
  });
  ipcMain.handle('tavern:sync', () => syncTavern());
  ipcMain.handle('tavern:publishAll', async () => {
    for (const user of tavern.membersOf(configStore.get().tavern.space)) {
      const entry = playerEntry(configStore.get().tavern, user.key);
      if (!isPublished(entry) && (entry.player || entry.character)) await publishPlayer(user.key);
    }
    return fullStatus().tavern;
  });
  ipcMain.handle('tavern:unpublishAll', async (_event, removeFromObs) => {
    for (const key of Object.keys(configStore.get().tavern.players)) await unpublishPlayer(key, removeFromObs !== false);
    return fullStatus().tavern;
  });
  // Hide/Show all: the room's current members only (like Publish all), and
  // visibility-only -- unlike Publish/Unpublish all, nothing is created or
  // deleted, so a broken source elsewhere is never touched by mistake.
  ipcMain.handle('tavern:hideAll', async () => {
    for (const user of tavern.membersOf(configStore.get().tavern.space)) {
      const entry = playerEntry(configStore.get().tavern, user.key);
      const wanted = {};
      if (entry.player) wanted.player = false;
      if (entry.character) wanted.character = false;
      if (Object.keys(wanted).length) await applyPublish(user.key, wanted).catch(() => {});
    }
    return fullStatus().tavern;
  });
  ipcMain.handle('tavern:showAll', async () => {
    for (const user of tavern.membersOf(configStore.get().tavern.space)) {
      const entry = playerEntry(configStore.get().tavern, user.key);
      const wanted = {};
      if (entry.source && !entry.player) wanted.player = true;
      if (entry.characterSource && !entry.character) wanted.character = true;
      if (Object.keys(wanted).length) await applyPublish(user.key, wanted).catch(() => {});
    }
    return fullStatus().tavern;
  });
  // Adds the standard audio chain to every participant source that already exists
  // in OBS, skipping any filter kind a source already has.
  ipcMain.handle('tavern:addAudioFilters', async () => {
    if (!obs.connected) throw new Error('OBS is not connected.');
    const names = Object.values(configStore.get().tavern.players).map((p) => p.source).filter(Boolean);
    const inputs = new Set((await obs.browserInputs()).map((i) => i.name));
    let sources = 0;
    let filters = 0;
    for (const name of names) {
      if (!inputs.has(name)) continue;
      const added = await obs.addLevelingFilters(name);
      if (added.length) sources += 1;
      filters += added.length;
    }
    logActivity('Chameleon', filters ? `Added ${filters} audio filter${filters === 1 ? '' : 's'} to ${sources} participant source${sources === 1 ? '' : 's'}.` : 'Every participant source already has the audio filters.', 'info');
    return { sources, filters };
  });
  // Listens to the Participant sources for a few seconds while everyone talks, then sets each
  // person's OBS volume so they all land at the target level and remembers it with the person.
  ipcMain.handle('tavern:calibrate', async (_event, options) => {
    if (calibrating) throw new Error('A calibration is already running.');
    if (!obs.connected) throw new Error('OBS is not connected.');
    const opts = options && typeof options === 'object' ? options : {};
    const seconds = Math.min(60, Math.max(5, Math.round(Number(opts.seconds)) || 10));
    const target = Math.min(-6, Math.max(-40, Number.isFinite(Number(opts.targetDb)) ? Number(opts.targetDb) : -20));
    const current = configStore.get();
    const inObs = new Set((await obs.browserInputs()).map((i) => i.name));
    const people = Object.entries(current.tavern.players)
      .filter(([, entry]) => entry.player && entry.source && inObs.has(entry.source))
      .map(([key, entry]) => ({ key, input: entry.source }));
    if (!people.length) throw new Error('There are no Participant sources in OBS yet. Add the players to OBS on this page first.');
    calibrating = true;
    autoLevel.pause();
    try {
      const results = await calibrateInputs(obs, people, { seconds, targetDb: target });
      const fresh = configStore.get();
      const players = { ...fresh.tavern.players };
      for (const r of results) {
        if (r.volumeDb === null) continue;
        await obs.setInputVolumeDb(r.input, r.volumeDb);
        players[r.key] = { ...players[r.key], levelDb: r.volumeDb };
      }
      configStore.save({ ...fresh, tavern: { ...fresh.tavern, players, levelTargetDb: target } });
      const labelFor = (r) => {
        const user = tavern.party.find((u) => u.key === r.key);
        return user ? user.displayName || r.input : r.input;
      };
      const out = results.map((r) => ({ ...r, label: labelFor(r) }));
      const done = out.filter((r) => r.volumeDb !== null).length;
      logActivity('Chameleon', `Calibrated ${done} of ${out.length} participant${out.length === 1 ? '' : 's'} to ${target} dB.`, 'info');
      broadcastStatus();
      return { seconds, targetDb: target, results: out };
    } finally {
      calibrating = false;
      await autoLevel.resume().catch(() => {});
    }
  });
  ipcMain.handle('tavern:setChoice', (_event, key, field, on) => setChoice(String(key), String(field), Boolean(on)));
  ipcMain.handle('tavern:viewUrl', (_event, key, kind) => {
    const user = tavern.party.find((u) => u.key === key);
    if (!user) throw new Error('Unknown user.');
    return kind === 'character' ? tavernCharacterSource(user).url : tavernPlayerSource(user).url;
  });
  ipcMain.handle('tavern:openManage', () => {
    const { url } = configStore.get().tavern;
    if (url) shell.openExternal(`${url}/admin`);
  });
  // --- Automations ---
  ipcMain.handle('automations:setSettings', async (_event, settings) => {
    const current = configStore.get();
    configStore.save({ ...current, automations: { ...current.automations, ...settings } });
    await syncAutomationsServer();
    broadcastStatus();
    return fullStatus().automations;
  });
  // Feeds a synthetic event through the exact same recordEvent() a real
  // Herald POST uses, so the automations.on('event', ...) listener runs the
  // same rule-matching path -- lets the tab be exercised end to end without
  // Foundry or Herald in the loop. Fire-and-forget, same as a real call:
  // rule failures are logged, not thrown back at the caller. `prompts` gets
  // the exact same synchronous gate the real HTTP endpoint does
  // (checkAndApplyPrompts) -- Studio's own Run Automation button is not a
  // side door around a rule set's prompt requirements, and the renderer
  // (buildStepRow's Run Automation click handler) already collects answers
  // before calling this, same as it already collects test data for an
  // externally-registered field.
  ipcMain.handle('automations:testEvent', (_event, eventName, data, prompts) => {
    const event = typeof eventName === 'string' ? eventName.trim().slice(0, 60) : '';
    if (!event) throw new Error('Enter an event name.');
    const result = checkAndApplyPrompts(event, prompts && typeof prompts === 'object' ? prompts : {});
    if (!result.ok) throw new Error(result.error);
    automations.recordEvent(event, data && typeof data === 'object' ? data : {});
    return fullStatus().automations;
  });
  // The Automations tab's Run/Stop toggle, once a rule set is already
  // running -- see cancelRuleSetRun. A no-op, not an error, if the rule set
  // isn't actually running (a stop click racing the run's own natural end).
  ipcMain.handle('automations:cancelRuleSet', (_event, id) => {
    cancelRuleSetRun(String(id || ''));
    return fullStatus().automations;
  });
  // Runs one stage's worth of steps on demand (the Automations tab's own
  // "Time it" button, which fires a delay step's preceding action so the
  // user can watch it happen and measure how long the delay should
  // actually be). The exact same runAutomationAction a real rule set uses;
  // errors are thrown back to the caller here, unlike a real trigger, since
  // there is a person at the control panel waiting to see whether it worked.
  ipcMain.handle('automations:runSteps', async (_event, steps) => {
    const list = Array.isArray(steps) ? steps : [];
    // No real triggering event during a manual test -- a timed setText
    // step set to "literal" or "file" still runs correctly (neither needs
    // one), only "dataField" reads blank, since there is genuinely no
    // live data to pull from outside a real trigger.
    await Promise.all(list.map((s) => runAutomationAction(s && s.action, s && s.param, undefined, s)));
  });
  // A setText step's "File" value type: browse for the local text file
  // Studio will re-read every time that step runs. Returns the picked
  // path, or null if the user cancelled.
  ipcMain.handle('automations:pickTextFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(controlWindow, {
      title: 'Choose a text file',
      properties: ['openFile'],
      filters: [
        { name: 'Text files', extensions: ['txt', 'md', 'log'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return canceled || !filePaths.length ? null : filePaths[0];
  });
  // --- YouTube ---
  ipcMain.handle('youtube:setSettings', async (_event, settings) => {
    const current = configStore.get();
    configStore.save({ ...current, youtube: { ...current.youtube, ...settings } });
    broadcastStatus();
    return fullStatus().youtube;
  });
  ipcMain.handle('youtube:setClientSecret', (_event, secret) => {
    writeYoutubeSecret({ clientSecret: typeof secret === 'string' ? secret : '' });
    broadcastStatus();
    return fullStatus().youtube;
  });
  // Step 1 of the device flow: request a code, hand it straight back so the
  // renderer can show "go to <url>, enter <code>" immediately. Step 2 (the
  // poll) runs in the background, not awaited here -- a person approving on
  // their phone might take a while, and this IPC call isn't meant to hang
  // open for it.
  ipcMain.handle('youtube:connect', async () => {
    const { deviceCode, userCode, verificationUrl, interval, expiresIn } = await youtube.requestDeviceCode();
    youtubeConnectState = { userCode, verificationUrl, expiresAt: Date.now() + expiresIn * 1000 };
    broadcastStatus();
    youtube
      .pollForToken({ deviceCode, interval, expiresIn })
      .then(() => {
        youtubeConnectState = null;
        youtubeConnectionExpired = false;
        logActivity('YouTube', 'Connected.', 'info');
      })
      .catch((err) => {
        youtubeConnectState = null;
        logActivity('YouTube', `Connect failed: ${err.message}`, 'error');
      });
    return fullStatus().youtube;
  });
  ipcMain.handle('youtube:resolveUpload', (_event, choice, clear) => {
    resolveUploadDecision(String(choice || ''), Boolean(clear));
    return fullStatus().youtube;
  });
  ipcMain.handle('youtube:disconnect', () => {
    youtube.disconnect();
    writeYoutubeSecret({ refreshToken: '' });
    youtubeConnectState = null;
    youtubeConnectionExpired = false;
    broadcastStatus();
    return fullStatus().youtube;
  });
  // Reuses the exact same dialog as a setText step's "File" value type --
  // this is the uploadToYouTube step's optional file override.
  ipcMain.handle('youtube:pickVideoFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(controlWindow, {
      title: 'Choose a video file',
      properties: ['openFile'],
      filters: [
        { name: 'Video files', extensions: ['mp4', 'mov', 'mkv', 'flv', 'avi', 'webm'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return canceled || !filePaths.length ? null : filePaths[0];
  });
  // Fixed Google Cloud Console URLs, not accepting anything from the
  // renderer -- one handler per setup step (API Library, OAuth consent
  // screen, Credentials) rather than one generic "open any URL" handler, so
  // there's nothing here for a compromised renderer to redirect elsewhere.
  ipcMain.handle('youtube:openApiLibrary', () => {
    shell.openExternal('https://console.cloud.google.com/apis/library/youtube.googleapis.com');
  });
  ipcMain.handle('youtube:openConsentScreen', () => {
    shell.openExternal('https://console.cloud.google.com/apis/credentials/consent');
  });
  ipcMain.handle('youtube:openCredentials', () => {
    shell.openExternal('https://console.cloud.google.com/apis/credentials');
  });
  // The device-flow approval URL Google itself returned for the connect
  // currently in progress (youtubeConnectState, set by 'youtube:connect'
  // above) -- read from server-side state, not a URL the renderer passes
  // in, so there's nothing to validate: this only ever opens whatever
  // Google's own device-code response said, for the connect Studio itself
  // just started.
  ipcMain.handle('youtube:openVerificationUrl', () => {
    if (!youtubeConnectState) return { ok: false };
    shell.openExternal(youtubeConnectState.verificationUrl);
    return { ok: true };
  });
  // --- Regions ---
  ipcMain.handle('view:snapshot', async (_event, id) => {
    const win = viewWindows.get(id);
    const wc = pageOf(id);
    if (!isAlive(win) || !win.isVisible() || !wc) throw new Error('Start the window first.');
    const [width, height] = pageSize(win);
    const image = await wc.capturePage();
    return { dataUrl: image.toJPEG(80).length ? `data:image/jpeg;base64,${image.toJPEG(80).toString('base64')}` : image.toDataURL(), width, height };
  });
  ipcMain.handle('view:measure', async (_event, id, selector) => {
    const wc = pageOf(id);
    if (!wc) throw new Error('Start the window first.');
    return measureSelector(wc, selector);
  });
  ipcMain.handle('regions:save', async (_event, id, region) => {
    getView(id);
    const input = region && typeof region === 'object' ? { ...region } : {};
    const saved = configStore.saveRegion(id, input);
    scheduleObsSync();
    broadcastStatus();
    return saved;
  });
  ipcMain.handle('regions:setEnabled', async (_event, id, regionId, enabled) => {
    const region = configStore.getRegion(id, regionId);
    if (!region) throw new Error('Unknown region.');
    const saved = configStore.saveRegion(id, { ...region, enabled: Boolean(enabled) });
    if (obs.connected && saved.obsSource && obs.status().inputs.includes(saved.obsSource)) {
      await obs.setSourceVisible(saved.obsSource, Boolean(enabled)).catch((err) => console.warn(`[obs] visibility: ${err.message}`));
    }
    scheduleObsSync();
    broadcastStatus();
    return saved;
  });
  // Deletes a source from OBS. A region forgets the name so the next Add
  // picks a fresh one; a window keeps its name so Add to OBS re-creates it.
  // A Tavern source forgets its name too, and its tick turns off -- unlike
  // a window's name, Tavern's is auto-assigned, and syncTavern recreates
  // any source whose name is still on file, so leaving it in place would
  // just bring the deleted input right back on the next sync.
  ipcMain.handle('obs:removeSource', async (_event, inputName) => {
    if (typeof inputName !== 'string' || !inputName) return;
    // status().inputs only ever lists screen_capture inputs (windows and
    // regions); a Tavern source is a browser_source, so that check always
    // missed it and this deleted nothing in OBS while still forgetting the
    // name -- allInputNames() is kind-agnostic.
    if ((await obs.allInputNames()).has(inputName)) await obs.removeInput(inputName);
    for (const view of configStore.get().views) {
      const regions = view.regions.map((r) => (r.obsSource === inputName ? { ...r, obsSource: '' } : r));
      if (regions.some((r, i) => r !== view.regions[i])) configStore.updateView(view.id, { regions });
    }
    const current = configStore.get();
    const players = { ...current.tavern.players };
    let changed = false;
    for (const [key, entry] of Object.entries(players)) {
      if (entry.source === inputName) {
        players[key] = { ...entry, source: '', player: false };
        changed = true;
      } else if (entry.characterSource === inputName) {
        players[key] = { ...entry, characterSource: '', character: false };
        changed = true;
      }
    }
    if (changed) configStore.save({ ...current, tavern: { ...current.tavern, players } });
    broadcastStatus();
  });
  ipcMain.handle('regions:remove', (_event, id, regionId) => {
    configStore.removeRegion(id, regionId);
    broadcastStatus();
  });
  ipcMain.handle('regions:limits', () => REGION_LIMITS);
  // What OBS and Studio each see for window capture, as text to paste: the
  // check for the Windows backend (and a useful thing to attach to any "my
  // window source points at the wrong window" report).
  ipcMain.handle('obs:captureReport', async () => {
    const report = await obs.captureReport();
    report.studio = {
      platform: process.platform,
      executable: path.basename(process.execPath),
      views: configStore.get().views.map((view) => {
        const win = viewWindows.get(view.id);
        return {
          label: view.label,
          title: windowTitle(view),
          open: isAlive(win),
          captureValue: systemWindowId(win),
          displayScaleFactor: isAlive(win) ? scaleFactorOf(win) : null,
          sources: windowSources(view),
        };
      }),
    };
    return JSON.stringify(report, null, 2);
  });
  ipcMain.handle('obs:createRegionSource', async (_event, id, regionId) => {
    const view = getView(id);
    const region = configStore.getRegion(id, regionId);
    if (!region) throw new Error('Unknown region.');
    const win = viewWindows.get(id);
    const windowId = systemWindowId(win);
    if (!windowId) throw new Error('Start the window first so OBS can capture it.');
    const taken = new Set(obs.status().inputs);
    // The number that disambiguates a collision goes on the region's own
    // name, not the window's (the window>region pair is what has to be
    // unique, and the region name is the more specific of the two).
    const regionSourceName = (n) => `Region: ${view.label}>${region.name}${n > 1 ? ` ${n}` : ''}${SOURCE_SUFFIX}`;
    let name = region.obsSource;
    if (!name) {
      let n = 1;
      name = regionSourceName(n);
      while (taken.has(name)) name = regionSourceName(++n);
    } else if (taken.has(name)) {
      throw new Error(`"${name}" already exists in OBS.`);
    }
    await obs.createInput(name, windowId);
    await obs.ensureCropFilter(name, cropFor(win, region));
    await obs.setInputMuted(name, Boolean(view.muted)).catch(() => {});
    configStore.saveRegion(id, { ...region, obsSource: name });
    broadcastStatus();
    return name;
  });

  ipcMain.on('bar:resize', (event, dw, dh) => {
    if (BrowserWindow.fromWebContents(event.sender) === prompterWindow) {
      if (Number.isInteger(dw) && Number.isInteger(dh)) resizePrompter(dw, dh);
      return;
    }
    const id = viewIdOf(BrowserWindow.fromWebContents(event.sender));
    if (id && Number.isInteger(dw) && Number.isInteger(dh)) resizePage(id, dw, dh);
  });
  ipcMain.on('bar:focusPage', (event) => {
    if (BrowserWindow.fromWebContents(event.sender) === prompterWindow) {
      if (prompterPage && !prompterPage.webContents.isDestroyed()) prompterPage.webContents.focus();
      return;
    }
    const id = viewIdOf(BrowserWindow.fromWebContents(event.sender));
    const wc = id ? pageOf(id) : null;
    if (wc) wc.focus();
  });
  ipcMain.on('bar:reload', (event) => {
    if (BrowserWindow.fromWebContents(event.sender) === prompterWindow) {
      if (prompterPage && !prompterPage.webContents.isDestroyed()) prompterPage.webContents.reloadIgnoringCache();
      return;
    }
    const id = viewIdOf(BrowserWindow.fromWebContents(event.sender));
    if (id) reloadView(id);
  });
  ipcMain.on('bar:wakeAudio', (event) => {
    const id = viewIdOf(BrowserWindow.fromWebContents(event.sender));
    if (!id) return;
    if (wakeAudio(id)) wakeWhenReady(id, 5000);
    setTimeout(broadcastStatus, 800);
  });
  ipcMain.on('bar:devTools', (event) => {
    if (BrowserWindow.fromWebContents(event.sender) === prompterWindow) {
      if (prompterPage && !prompterPage.webContents.isDestroyed()) prompterPage.webContents.toggleDevTools();
      return;
    }
    const id = viewIdOf(BrowserWindow.fromWebContents(event.sender));
    const wc = id ? pageOf(id) : null;
    if (wc) wc.toggleDevTools();
  });
  ipcMain.handle('config:reveal', () => shell.showItemInFolder(configStore.filePath));
  ipcMain.handle('status:get', () => fullStatus());
  ipcMain.handle('displays:get', () => screen.getAllDisplays().map(displaySummary));
  ipcMain.handle('app:info', () => ({
    name: APP_NAME,
    limits: LIMITS,
    version: APP_VERSION,
    revision: REVISION,
    build: BUILD_INFO,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    configPath: configStore.filePath,
  }));

  ipcMain.handle('view:open', (_event, id) => {
    createViewWindow(getView(id));
    return viewStatus(getView(id));
  });
  ipcMain.handle('view:close', (_event, id) => closeView(id));
  ipcMain.handle('view:reload', (_event, id) => reloadView(id));
  ipcMain.handle('view:restart', (_event, id) => restartView(id));
  ipcMain.handle('views:restartAll', () => restartAllViews());
  // Hide the control panel only; every window keeps running, so OBS keeps its sources. (Hiding the whole app would hide
  // them too, and OBS cannot capture a hidden window.)
  ipcMain.handle('app:hidePanel', () => { if (isAlive(controlWindow)) controlWindow.hide(); });
  ipcMain.handle('view:reset', (_event, id) => resetView(id));
  ipcMain.handle('view:devtools', (_event, id) => {
    const wc = pageOf(id);
    if (wc) wc.toggleDevTools();
  });
  ipcMain.handle('view:wakeAudio', (_event, id) => {
    if (!wakeAudio(id)) throw new Error('Start the window first.');
    wakeWhenReady(id, 5000); // and keep at it while Foundry says it is still locked
    setTimeout(broadcastStatus, 800);
  });
  ipcMain.handle('views:arrange', (_event, displayId) => arrangeViews(displayId));
  ipcMain.handle('views:openAll', () => openAllViews());
  ipcMain.handle('views:closeAll', () => closeAllViews());
  ipcMain.handle('app:quit', () => app.quit());

  ipcMain.handle('session:clear', async () => {
    const { response } = await dialog.showMessageBox(controlWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Sign Out'],
      defaultId: 1,
      cancelId: 0,
      message: 'Sign out of Foundry?',
      detail: 'This clears cookies and site data for both windows. You will need to log in again.',
    });
    if (response !== 1) return false;
    const partitions = new Set([PARTITION, ...configStore.get().views.map(partitionFor)]);
    for (const partition of partitions) {
      const ses = session.fromPartition(partition);
      await ses.clearStorageData();
      await ses.clearCache();
    }
    for (const id of viewWindows.keys()) reloadView(id);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Session permissions
// ---------------------------------------------------------------------------

const configuredPartitions = new Set();
function configureSession(partition = PARTITION) {
  if (configuredPartitions.has(partition)) return;
  configuredPartitions.add(partition);
  const ses = session.fromPartition(partition);
  const allowed = new Set(['media', 'notifications', 'fullscreen', 'pointerLock', 'clipboard-read', 'clipboard-sanitized-write']);
  const configuredOrigins = () =>
    new Set(
      configStore.get().views.map((v) => {
        try {
          return new URL(v.url).origin;
        } catch (err) {
          return null;
        }
      }),
    );
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    let origin = null;
    try {
      origin = new URL(details.requestingUrl || webContents.getURL()).origin;
    } catch (err) {
      origin = null;
    }
    callback(allowed.has(permission) && configuredOrigins().has(origin));
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => createControlWindow());

  app.whenReady().then(() => {
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      credits: 'Two fixed-size Chromium windows for capturing FoundryVTT in OBS.',
    });
    configureSession();
    registerIpc();
    registerToolbarIpc();
    buildMenu();
    setupTray();
    setupDock();
    createControlWindow();
    // If the app closed in the middle of a recording last time, say where the file is (it is still playable).
    const interrupted = builtInRecorder.takeInterrupted();
    if (interrupted) {
      const message = `Showrunner closed while it was recording. The recording so far was kept: ${path.basename(interrupted.file)}`;
      if (Notification.isSupported()) new Notification({ title: APP_NAME, body: message }).show();
      logActivity('Recorder', message, 'error');
      setTimeout(() => { if (isAlive(controlWindow)) controlWindow.webContents.send('toast', message); broadcastStatus(); }, 3000);
    }
    openLaunchViews();
    { const rc = configStore.get().recording; if (rc.backend === 'builtin' && rc.toolbar.atStart) openToolbar({ focus: false }); }
    scheduleWarm();
    if (configStore.get().teleprompter.enabled) openPrompter();
    obs.start().catch(() => {});
    tavern.start().catch(() => {});
    syncAutomationsServer().catch(() => {});

    const onDisplays = () => {
      layoutDock();
      broadcastStatus();
    };
    screen.on('display-added', onDisplays);
    screen.on('display-removed', onDisplays);
    screen.on('display-metrics-changed', onDisplays);
  });

  // The cameraman client Herald talks about is very likely the Stream
  // window itself -- an Electron webContents running inside this app, on
  // this Mac, not a separate browser someone can manually click through a
  // cert warning in (there's no such warning UI for a fetch() call that
  // isn't a top-level navigation; it just fails). Since Studio generated
  // this exact certificate, it can vouch for it here -- checked by the
  // actual DER bytes, not the fingerprint string (whose format isn't
  // documented precisely enough to trust matching on), and only while the
  // Automations server we generated it for is actually the one running.
  // Every other certificate error (Tavern, Foundry itself, anything real)
  // still gets Electron's normal validation; this never widens beyond the
  // one certificate this app made for itself.
  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    if (automations.listening && trustsOwnAutomationsCert(certificate)) {
      event.preventDefault();
      callback(true);
      return;
    }
    callback(false);
  });
  app.on('activate', () => createControlWindow());
  let quitStopping = false;
  app.on('before-quit', (event) => {
    // Quitting in the middle of a recording finishes the file first, so it closes properly rather than being cut off.
    if (builtInRecorder.active && !quitStopping) {
      event.preventDefault();
      quitStopping = true;
      builtInRecorder.stop().catch(() => {}).finally(() => app.quit());
      return;
    }
    quitting = true;
    autoLevel.stop().catch(() => {});
    obs.stop().catch(() => {});
    tavern.stop().catch(() => {});
    automations.stop().catch(() => {});
  });
  // Standard macOS behaviour: the app stays alive in the Dock with no windows.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
