'use strict';

// Persistent configuration for Coffee Pub Studio.
// Stored as JSON in Electron's per-user data directory, e.g.
// ~/Library/Application Support/Coffee Pub Studio/config.json

const fs = require('fs');
const path = require('path');
const backup = require('./backup');

// Version 14 stores a list of profiles (see the profile helpers above
// ConfigStore); everything outside a profile is global. Version 13 called
// them shows. Files from version 12 and earlier become one profile. Version 12 reads only the current field names: the old ones (obsSources,
// openOnLaunch, obs.enabled, the pre-0.1.9 Tavern names) are no longer
// migrated.
const CONFIG_VERSION = 15;

// Session groups: windows with the same group name share cookies and storage.
const DEFAULT_GROUP = 'Main';

const LIMITS = {
  minSize: 100,
  maxSize: 7680,
  minViews: 0,
  maxViews: 5,
};

// The tail on every OBS source name this app makes. It was " (CP Studio)"
// before the app became Coffee Pub Showrunner; the short form is the same
// for both names, and old names are carried over (see upgradeSourceName).
const SOURCE_SUFFIX = ' (CPS)';
const LEGACY_SOURCE_SUFFIX = ' (CP Studio)';

// A saved source name with the old tail swapped for the current one; any
// other name comes back unchanged.
function upgradeSourceName(name) {
  const text = typeof name === 'string' ? name : '';
  return text.endsWith(LEGACY_SOURCE_SUFFIX) ? text.slice(0, -LEGACY_SOURCE_SUFFIX.length) + SOURCE_SUFFIX : text;
}

// The OBS source name a window gets unless the user picks another. Every
// source this app creates -- windows, regions, Tavern sources -- follows
// the same "Type: Name (CPS)" shape, so OBS's own source pickers
// (which sort by kind, not by who added something) group everything this
// app made under its own type, and the "(CPS)" tail still answers
// "what put this here" once you're looking at one.
function defaultSourceName(label) {
  return `Window: ${label}${SOURCE_SUFFIX}`;
}

// A window belonging to some other application (a game, Discord, a
// browser someone else runs), captured into OBS by Studio but not owned by
// it -- see sanitizeAppWindows.
function defaultAppSourceName(label) {
  return `App: ${label}${SOURCE_SUFFIX}`;
}

// A fresh window: no URL, a generic label and size. Nothing here assumes
// Foundry, or any particular site -- this app wraps any web page in a
// fixed-size, OBS-capturable window, and is optimized for FoundryVTT
// without being exclusive to it. The user names and points each window at
// whatever they're actually running.
function defaultView(index) {
  const label = `Window ${index + 1}`;
  return {
    id: `window${index + 1}`,
    label,
    url: '',
    width: 1280,
    height: 720,
    x: null,
    y: null,
    muted: true,
    enabled: true,
    dockOnLaunch: false,
    wakeAudio: true,
    wakeDelay: 30, // seconds after the page loads before its audio is woken
    session: DEFAULT_GROUP,
    windowSource: { enabled: true, name: defaultSourceName(label) },
    regions: [],
  };
}

// A free-form session GROUP name (windows sharing cookies/storage); empty
// means the default group. Named distinctly from the season/episode
// sanitizeSession below -- a second `function sanitizeSession` declared
// later in this same module would silently win at every call site,
// including this one's, above it in the file (a real bug caught live: it
// had been overwriting every view's group name with a season/episode
// object on each save).
function sanitizeSessionGroup(value) {
  if (value === undefined || value === null) return DEFAULT_GROUP;
  const text = String(value).trim().slice(0, 40);
  return text || DEFAULT_GROUP;
}

const REGION_LIMITS = { maxRegions: 12, maxSelector: 300 };

// A region is a named rectangle inside a window, in window points. In
// selector mode the rectangle is re-measured from the page element.
function sanitizeRegion(input, index, taken) {
  const src = input && typeof input === 'object' ? input : {};
  let id = sanitizeId(src.id, `region${index + 1}`);
  let n = 2;
  while (taken.has(id)) id = `region${index + 1}-${n++}`;
  taken.add(id);
  const positive = (v, fallback) => Math.max(0, toInt(v, fallback));
  return {
    id,
    name: typeof src.name === 'string' && src.name.trim() ? src.name.trim().slice(0, 40) : `Region ${index + 1}`,
    mode: src.mode === 'selector' ? 'selector' : 'rect',
    selector: typeof src.selector === 'string' ? src.selector.trim().slice(0, REGION_LIMITS.maxSelector) : '',
    x: positive(src.x, 0),
    y: positive(src.y, 0),
    width: Math.max(1, toInt(src.width, 100)),
    height: Math.max(1, toInt(src.height, 100)),
    obsSource: typeof src.obsSource === 'string' ? src.obsSource.trim().slice(0, 200) : '',
    enabled: src.enabled === undefined ? true : Boolean(src.enabled),
  };
}

function sanitizeRegions(value) {
  if (!Array.isArray(value)) return [];
  const taken = new Set();
  return value.slice(0, REGION_LIMITS.maxRegions).map((r, i) => sanitizeRegion(r, i, taken));
}

function defaultDock() {
  // overlap: points of a docked window left on screen (0 = fully off screen).
  return { enabled: true, side: 'right', overlap: 6 };
}

function sanitizeDock(input) {
  const d = defaultDock();
  const src = input && typeof input === 'object' ? input : {};
  return {
    enabled: src.enabled === undefined ? d.enabled : Boolean(src.enabled),
    side: src.side === 'left' ? 'left' : 'right',
    overlap: clamp(toInt(src.overlap, d.overlap), 0, 36),
  };
}

function defaultObs() {
  return { autoConnect: false, host: '127.0.0.1', port: 4455 };
}

// YouTube: uploads a finished recording via the Data API v3's resumable
// upload endpoint, triggered by the `uploadToYouTube` Studio action (see
// STUDIO_ACTION_SCHEMA below) -- never automatic on its own, same reasoning
// as every other Studio action here. Auth is OAuth 2.0's device flow (no
// loopback redirect server, no port to configure -- see src/youtube.js);
// `clientId` is not secret and lives here in plain config, same as
// `obs.host`. `clientSecret` and the refresh token are not: encrypted at
// rest via safeStorage, same pattern as the OBS/Tavern passwords (see
// YOUTUBE_SECRET_PATH, src/main.js), never sent to the renderer.
// `privacyStatus` defaults to "private" deliberately -- publishing a
// recording is a decision for a human to make on YouTube itself, not
// something this app should default to doing for you.
function defaultYoutube() {
  return {
    enabled: false,
    clientId: '',
    privacyStatus: 'private',
    categoryId: '20', // Gaming
  };
}

function sanitizeYoutube(input) {
  const d = defaultYoutube();
  const src = input && typeof input === 'object' ? input : {};
  return {
    enabled: src.enabled === undefined ? d.enabled : Boolean(src.enabled),
    clientId: typeof src.clientId === 'string' ? src.clientId.trim().slice(0, 200) : d.clientId,
    privacyStatus: ['private', 'unlisted', 'public'].includes(src.privacyStatus) ? src.privacyStatus : d.privacyStatus,
    categoryId: typeof src.categoryId === 'string' && /^\d{1,3}$/.test(src.categoryId) ? src.categoryId : d.categoryId,
  };
}

// Automations: a small HTTP server Foundry modules (starting with Herald)
// call to report events (e.g. "combat has started"), which can then run a
// rule set here -- a named, numbered sequence of OBS/Studio actions and
// delays. Foundry typically runs on a different machine than Studio, so
// this listens on the LAN, not just localhost -- the token is the only
// thing standing between that port and anyone else on the network, so the
// server refuses to start without one.
//
// Two kinds of action, both always available, same as each other -- OBS
// actions (AUTOMATIONS_ACTIONS) and Studio actions (STUDIO_ACTIONS, which
// reach into Studio itself: wake a window's audio, start/stop/dock every
// window, re-sync OBS, apply the session filename) used to differ here, an
// opt-in per-Studio-action toggle nobody could find a reason to justify:
// it gated a rule set's own steps -- your own automations needing your own
// permission to use your own actions -- and, separately, external callers
// were already behind the token below, the same as every OBS action always
// was. Removed entirely; the token is the one gate, for both kinds alike.
//
// Both are grouped (`group`) so a caller like Herald can build a menu --
// "Controls > Start Recording", "Scenes > Combat" -- instead of one flat
// list; GET /api/automations/capabilities returns both together.
const AUTOMATIONS_LIMITS = {
  maxRuleSets: 40,
  maxStepsPerRuleSet: 20,
  maxNameLen: 60,
  maxGroupLen: 40,
  maxEventLen: 60,
  maxParamLen: 200,
  maxDelaySeconds: 3600,
};
const AUTOMATIONS_ACTIONS = [
  'sceneSwitch', 'sourceShow', 'sourceHide', 'sourceToggle', 'setText',
  'sourceMute', 'sourceUnmute', 'sourceToggleMute', 'setVolume',
  'startRecording', 'pauseRecording', 'resumeRecording', 'stopRecording',
  'startStreaming', 'stopStreaming',
];
// What each action means, what its `param` is for (and what kind of thing
// the param is -- 'scene'/'source' so a picker can be shown instead of a
// free-text field), and which menu group it belongs in. The authoritative
// copy: GET /api/automations/capabilities (main.js) reads this directly so
// a caller can discover Studio's action vocabulary instead of hardcoding
// it; src/control/control.js keeps its own renderer-side copy for the
// Automations UI (kept in sync by hand, same reasoning as TAVERN_KINDS
// there), since it can't require this file directly across the preload
// boundary.
const AUTOMATIONS_ACTION_SCHEMA = [
  { action: 'sceneSwitch', param: 'scene name', paramType: 'scene', group: 'Scenes' },
  { action: 'sourceShow', param: 'source name', paramType: 'source', group: 'Sources' },
  { action: 'sourceHide', param: 'source name', paramType: 'source', group: 'Sources' },
  { action: 'sourceToggle', param: 'source name', paramType: 'source', group: 'Sources' },
  { action: 'setText', param: 'source name', paramType: 'source', group: 'Sources' },
  // Audio: `param` names an OBS audio source. setVolume also needs a level in
  // dB (OBS accepts -100 to 26; 0 is unchanged), read the way setText reads its
  // text: a typed value, a file, or a Data Field.
  { action: 'sourceMute', param: 'source name', paramType: 'source', group: 'Audio' },
  { action: 'sourceUnmute', param: 'source name', paramType: 'source', group: 'Audio' },
  { action: 'sourceToggleMute', param: 'source name', paramType: 'source', group: 'Audio' },
  { action: 'setVolume', param: 'source name', paramType: 'source', group: 'Audio' },
  { action: 'startRecording', param: null, paramType: 'none', group: 'Controls' },
  { action: 'pauseRecording', param: null, paramType: 'none', group: 'Controls' },
  { action: 'resumeRecording', param: null, paramType: 'none', group: 'Controls' },
  { action: 'stopRecording', param: null, paramType: 'none', group: 'Controls' },
  { action: 'startStreaming', param: null, paramType: 'none', group: 'Controls' },
  { action: 'stopStreaming', param: null, paramType: 'none', group: 'Controls' },
];
// Studio actions: same shape, plus a `label` (there's no single-word verb
// for most of these the way there is for the OBS actions). Always available,
// same as AUTOMATIONS_ACTIONS -- see the note above.
const STUDIO_ACTIONS = [
  'wakeAudio', 'startAll', 'stopAll', 'dockAll', 'undockAll', 'syncObs',
  'applySessionFilename', 'runRuleSet', 'incrementMetadataField', 'decrementMetadataField',
  'setMetadataField', 'clearMetadataField', 'showToast', 'uploadToYouTube',
  'prompterPlay', 'prompterPause', 'prompterToggle', 'prompterFaster', 'prompterSlower',
  'prompterNext', 'prompterPrev', 'prompterTop', 'prompterLoadScript',
];
const STUDIO_ACTION_SCHEMA = [
  { action: 'wakeAudio', label: 'Wake audio (every open window)', param: null, paramType: 'none', group: 'Studio Control' },
  { action: 'startAll', label: 'Start all windows', param: null, paramType: 'none', group: 'Studio Control' },
  { action: 'stopAll', label: 'Stop all windows', param: null, paramType: 'none', group: 'Studio Control' },
  { action: 'dockAll', label: 'Dock all windows', param: null, paramType: 'none', group: 'Studio Control' },
  { action: 'undockAll', label: 'Undock all windows', param: null, paramType: 'none', group: 'Studio Control' },
  { action: 'syncObs', label: 'Sync OBS', param: null, paramType: 'none', group: 'Studio Control' },
  { action: 'applySessionFilename', label: 'Apply the session filename format to OBS', param: null, paramType: 'none', group: 'Studio Control' },
  // param is the target rule set's id, not its name (names aren't required
  // unique; ids are) -- runAutomationAction (main.js) resolves it and
  // refuses a cycle (this rule set already running further up the same
  // call chain) rather than hanging or blowing the stack.
  { action: 'runRuleSet', label: 'Run rule set', param: 'rule set id', paramType: 'ruleSet', group: 'Studio Control' },
  // param is a Metadata field's key (a Number field, or a Text+Number/
  // Number+Text field's number segment) -- the intent-driven replacement
  // for a trailing "+1"/"-1" on a Data Field key, which used to hide this
  // same mutation inside a read (see resolveDataField, src/main.js).
  { action: 'incrementMetadataField', label: 'Increment a Metadata field', param: 'field key', paramType: 'metadataField', group: 'Studio Control' },
  { action: 'decrementMetadataField', label: 'Decrement a Metadata field', param: 'field key', paramType: 'metadataField', group: 'Studio Control' },
  // param is a Text-type Metadata field's key; the value to store comes
  // from `data.value` on a direct POST /api/automations/action call (see
  // resolveMetadataFieldValue, src/main.js), or from the step's own
  // fixed/file/Data-Field choice when run from a rule set, same three
  // sources setText's own step editor already offers.
  { action: 'setMetadataField', label: 'Set a Metadata field', param: 'field key', paramType: 'metadataField', group: 'Studio Control' },
  // param is a "prompt"-type Metadata field's key -- resets it back to
  // blank, so a later run that requires it (checkAndApplyPrompts,
  // src/main.js) is asked fresh instead of silently reusing whatever
  // answered it last. Placed wherever a prompted value's own episode/
  // session is actually over -- Studio has no notion of that on its own.
  { action: 'clearMetadataField', label: 'Clear a Prompt field back to blank', param: 'field key', paramType: 'metadataField', group: 'Studio Control' },
  // param is free text, not a picker -- a message expanded through the
  // same {token} composition applySessionFilename's template gets
  // (formatSessionTemplate, src/main.js), sent as a real OS notification
  // (Notification.isSupported(), src/main.js) so it reaches someone who
  // isn't looking at Studio at all, plus an in-app toast as a second,
  // more immediate layer for whoever already is. paramType "text" gets a
  // plain input in the step editor rather than the dropdown every other
  // paramType renders (see buildStepRow, src/control/control.js).
  { action: 'showToast', label: 'Send a notification', param: 'message', paramType: 'text', group: 'Studio Control' },
  // No single `param` -- five named slots instead (titleField/
  // descriptionField/categoryField/madeForKidsField/visibilityField, each a
  // Metadata field key; madeForKidsField must point at a "checkbox" field
  // specifically -- see the comment on runYouTubeUpload, src/main.js, for
  // why that one alone is strict), plus the same `filePath` a setText
  // step's "File" valueType already uses (empty = the most recent OBS
  // recording). See runAutomationAction's 'uploadToYouTube' case, src/main.js.
  { action: 'uploadToYouTube', label: 'Upload the recording to YouTube', param: null, paramType: 'youtubeUpload', group: 'Studio Control' },
  // The teleprompter's reading controls, for a rule set or an outside caller. They need the
  // teleprompter window open (src/main.js sends the command to its page) and take no param.
  { action: 'prompterPlay', label: 'Teleprompter: start scrolling', param: null, paramType: 'none', group: 'Teleprompter' },
  { action: 'prompterPause', label: 'Teleprompter: pause scrolling', param: null, paramType: 'none', group: 'Teleprompter' },
  { action: 'prompterToggle', label: 'Teleprompter: play or pause', param: null, paramType: 'none', group: 'Teleprompter' },
  { action: 'prompterFaster', label: 'Teleprompter: scroll faster', param: null, paramType: 'none', group: 'Teleprompter' },
  { action: 'prompterSlower', label: 'Teleprompter: scroll slower', param: null, paramType: 'none', group: 'Teleprompter' },
  { action: 'prompterNext', label: 'Teleprompter: next heading', param: null, paramType: 'none', group: 'Teleprompter' },
  { action: 'prompterPrev', label: 'Teleprompter: previous heading', param: null, paramType: 'none', group: 'Teleprompter' },
  { action: 'prompterTop', label: 'Teleprompter: back to the top', param: null, paramType: 'none', group: 'Teleprompter' },
  // param is a script file: a full path, or a name next to the script already loaded. It becomes the profile's script,
  // exactly as if chosen on the Teleprompter page, and the window starts it from the top.
  { action: 'prompterLoadScript', label: 'Teleprompter: load a script', param: 'script file', paramType: 'scriptFile', group: 'Teleprompter' },
];

function defaultAutomations() {
  return { enabled: false, port: 9500, token: '', ruleSets: [] };
}

// One step in a rule set's numbered sequence: either an action (an OBS
// action or a Studio action, both always allowed) or a
// delay. `and: true` on an action step means "run together with the step
// before it" instead of waiting for it -- consecutive `and` action steps
// form one numbered stage that fires at once; a plain (non-`and`) step, or
// a delay, starts a new stage. Delay steps can't be `and` -- there's
// nothing to run alongside a wait, and the first step in a rule set can't
// be `and` either, since there is no step before it to join.
function sanitizeAutomationStep(input, index, allowedActions, taken) {
  const src = input && typeof input === 'object' ? input : {};
  let id = sanitizeId(src.id, `step${index + 1}`);
  let n = 2;
  while (taken.has(id)) id = `step${index + 1}-${n++}`;
  taken.add(id);
  // A disabled step is skipped entirely at run time (stagesFor, src/main.js)
  // -- as if it weren't in the sequence at all, not "run it but do nothing"
  // -- so someone can turn a step off for a session without losing its
  // configuration the way deleting and later recreating it would.
  const enabled = src.enabled === undefined ? true : Boolean(src.enabled);
  if (src.type === 'delay') {
    return {
      id,
      type: 'delay',
      seconds: clamp(toInt(src.seconds, 1), 1, AUTOMATIONS_LIMITS.maxDelaySeconds),
      and: false,
      enabled,
    };
  }
  const action = allowedActions.includes(src.action) ? src.action : allowedActions[0];
  return {
    id,
    type: 'action',
    action,
    param: typeof src.param === 'string' ? src.param.trim().slice(0, AUTOMATIONS_LIMITS.maxParamLen) : '',
    and: Boolean(src.and),
    // Gates whether this step's whole stage runs at all, based on whether
    // the *previous* stage's steps all succeeded or any of them failed --
    // "always" (the default) is today's unconditional behavior. Only
    // meaningful on a step that starts a new stage (and: false); a step
    // joining the current stage via `and` has no distinct "previous" of
    // its own to check, so the step editor hides this control whenever
    // `and` is on. See stagesFor/runRuleSet, src/main.js, for how the
    // preceding outcome is tracked and threaded through delay/skipped
    // stages unchanged.
    runIf: ['always', 'onSuccess', 'onFailure'].includes(src.runIf) ? src.runIf : 'always',
    enabled,
    // Only meaningful for setText -- "where it goes" is `param` above;
    // these four are "what it is", one of three kinds a user picks
    // explicitly rather than there being one ambiguous free-text field
    // that's sometimes a literal value and sometimes a lookup key:
    //   - "literal": `value`, typed once, always the same when this step
    //     runs -- a fixed text preset, no external caller involved at all.
    //   - "file": `filePath`, a local text file Studio reads fresh every
    //     time this step runs.
    //   - "dataField": `dataField`, a key into the triggering event's own
    //     `data` -- picked from whatever fields a connected module has
    //     actually registered (POST /api/automations/fields), not typed
    //     blind against an undocumented contract.
    valueType: ['literal', 'file', 'dataField'].includes(src.valueType) ? src.valueType : 'literal',
    value: typeof src.value === 'string' ? src.value.slice(0, 500) : '',
    // filePath doubles as uploadToYouTube's optional file override (empty
    // there means "the most recent OBS recording") -- same field, same
    // meaning ("a path on disk"), no reason for a second one.
    filePath: typeof src.filePath === 'string' ? src.filePath.trim().slice(0, 500) : '',
    dataField: typeof src.dataField === 'string' ? src.dataField.trim().slice(0, 60) : '',
    // uploadToYouTube only -- each a Metadata field key. See its schema
    // entry above and runAutomationAction's case, src/main.js.
    titleField: typeof src.titleField === 'string' ? src.titleField.trim().slice(0, 60) : '',
    descriptionField: typeof src.descriptionField === 'string' ? src.descriptionField.trim().slice(0, 60) : '',
    categoryField: typeof src.categoryField === 'string' ? src.categoryField.trim().slice(0, 60) : '',
    madeForKidsField: typeof src.madeForKidsField === 'string' ? src.madeForKidsField.trim().slice(0, 60) : '',
    visibilityField: typeof src.visibilityField === 'string' ? src.visibilityField.trim().slice(0, 60) : '',
  };
}

function sanitizeRuleSet(input, index, taken, allowedActions) {
  const src = input && typeof input === 'object' ? input : {};
  let id = sanitizeId(src.id, `ruleset${index + 1}`);
  let n = 2;
  while (taken.has(id)) id = `ruleset${index + 1}-${n++}`;
  taken.add(id);
  const stepTaken = new Set();
  const steps = (Array.isArray(src.steps) ? src.steps : [])
    .slice(0, AUTOMATIONS_LIMITS.maxStepsPerRuleSet)
    .map((s, i) => sanitizeAutomationStep(s, i, allowedActions, stepTaken));
  if (steps[0]) steps[0].and = false;
  return {
    id,
    name: typeof src.name === 'string' ? src.name.trim().slice(0, AUTOMATIONS_LIMITS.maxNameLen) : '',
    group: typeof src.group === 'string' ? src.group.trim().slice(0, AUTOMATIONS_LIMITS.maxGroupLen) : '',
    enabled: src.enabled === undefined ? true : Boolean(src.enabled),
    event: typeof src.event === 'string' ? src.event.trim().slice(0, AUTOMATIONS_LIMITS.maxEventLen) : '',
    steps,
  };
}

function sanitizeAutomations(input) {
  const d = defaultAutomations();
  const src = input && typeof input === 'object' ? input : {};
  const allowedActions = [...AUTOMATIONS_ACTIONS, ...STUDIO_ACTIONS];
  const taken = new Set();
  // A config saved before rule sets existed only has the old flat `rules`
  // shape ({id, event, action, param} each, one action per event). Migrate
  // each into an equivalent one-step rule set rather than silently
  // discarding real configured automations the first time this runs
  // against an old config -- `ruleSets` wins if both are somehow present.
  const rawRuleSets = Array.isArray(src.ruleSets)
    ? src.ruleSets
    : Array.isArray(src.rules)
      ? src.rules.map((r) => ({
          id: r && r.id,
          name: (r && r.event) || '',
          group: '',
          enabled: true,
          event: r && r.event,
          steps: [{ type: 'action', action: r && r.action, param: r && r.param, and: false }],
        }))
      : [];
  // No filter on event/steps here -- a rule set the user is still filling
  // in (named but no event yet, or no steps yet) stays exactly like an
  // incomplete region does: harmless (it never matches anything and never
  // runs anything) rather than silently deleted the moment any one field
  // is edited before every field is.
  const ruleSets = rawRuleSets
    .slice(0, AUTOMATIONS_LIMITS.maxRuleSets)
    .map((r, i) => sanitizeRuleSet(r, i, taken, allowedActions));
  return {
    enabled: src.enabled === undefined ? d.enabled : Boolean(src.enabled),
    port: clamp(toInt(src.port, d.port), 1024, 65535),
    token: typeof src.token === 'string' ? src.token.trim().slice(0, 200) : d.token,
    ruleSets,
  };
}

// Coffee Pub Tavern: the voice and video server for the people at the table.
// Each published user gets a Participant source (video, or their player
// image when the camera is off) and optionally a Character source (their
// character image with talking and muted images on top).
function defaultTavern() {
  return {
    enabled: false, url: '', login: '', autoConnect: true,
    playerWidth: 640, playerHeight: 360, lockRatio: true,
    characterWidth: 256, characterHeight: 256, characterWithPlayer: false,
    autoLevel: false, // keep every participant near levelTargetDb while the session runs (src/autolevel.js)
    levelTargetDb: -20, // Calibrate and Auto level: the speech level every participant is brought to, in dB
    audioFilters: true, // add the standard noise suppression / compressor / limiter chain to each new participant source
    space: 'lobby', // Chameleon space whose members Chameleon tab shows and OBS sources gate on
    followAdmin: true, // "Enable Asides": mute anyone live in a different space than `space` above
    players: {},
  };
}

function sanitizeTavern(input) {
  const d = defaultTavern();
  const src = input && typeof input === 'object' ? input : {};
  const players = {};
  if (src.players && typeof src.players === 'object') {
    for (const [key, value] of Object.entries(src.players)) {
      if (!/^[a-z0-9]{4,16}$/.test(key) || !value || typeof value !== 'object') continue;
      const entry = {
        source: typeof value.source === 'string' ? value.source.trim().slice(0, 200) : '',
        characterSource: typeof value.characterSource === 'string' ? value.characterSource.trim().slice(0, 200) : '',
        // The Participant and Character ticks
        player: value.player === undefined ? true : Boolean(value.player),
        character: value.character === undefined ? Boolean(value.characterSource) : Boolean(value.character),
        // The OBS volume Calibrate settled on for this person's Participant source, in dB; null until calibrated.
        levelDb: value.levelDb !== null && value.levelDb !== undefined && Number.isFinite(Number(value.levelDb)) ? clamp(Number(value.levelDb), -100, 26) : null,
      };
      const touched = value.player !== undefined || value.character !== undefined;
      if (entry.source || entry.characterSource || touched || entry.levelDb !== null) players[key] = entry;
    }
  }
  return {
    enabled: src.enabled === undefined ? d.enabled : Boolean(src.enabled),
    url: sanitizeUrl(src.url).replace(/\/+$/, ''),
    login: typeof src.login === 'string' ? src.login.trim().slice(0, 40) : d.login,
    autoConnect: src.autoConnect === undefined ? d.autoConnect : Boolean(src.autoConnect),
    playerWidth: clamp(toInt(src.playerWidth, d.playerWidth), 64, 3840),
    playerHeight: clamp(toInt(src.playerHeight, d.playerHeight), 64, 2160),
    lockRatio: src.lockRatio === undefined ? d.lockRatio : Boolean(src.lockRatio),
    characterWidth: clamp(toInt(src.characterWidth, d.characterWidth), 32, 3840),
    characterHeight: clamp(toInt(src.characterHeight, d.characterHeight), 32, 2160),
    characterWithPlayer: src.characterWithPlayer === undefined ? d.characterWithPlayer : Boolean(src.characterWithPlayer),
    audioFilters: src.audioFilters === undefined ? d.audioFilters : Boolean(src.audioFilters),
    autoLevel: src.autoLevel === undefined ? d.autoLevel : Boolean(src.autoLevel),
    levelTargetDb: clamp(Number.isFinite(Number(src.levelTargetDb)) && src.levelTargetDb !== null ? Number(src.levelTargetDb) : d.levelTargetDb, -40, -6),
    // Reads the new `space` key; an existing config.json still has `room`
    // from before this rename, so fall back to that rather than silently
    // resetting everyone's chosen room/space to Lobby on upgrade.
    space: typeof src.space === 'string' && /^[a-z0-9_-]{1,40}$/i.test(src.space)
      ? src.space
      : typeof src.room === 'string' && /^[a-z0-9_-]{1,40}$/i.test(src.room)
      ? src.room
      : 'lobby',
    followAdmin: src.followAdmin === undefined ? d.followAdmin : Boolean(src.followAdmin),
    players,
  };
}

// A template Studio writes into OBS's own recording Filename Formatting
// setting instead of it being hand-typed before every session -- see
// applySessionFilename in src/main.js. Season/episode numbering used to
// live here too (a dedicated Studio-tracked pair with their own card),
// retired once Metadata fields could do the same job without a second,
// parallel system -- confirmed unused in practice ("too confusing") before
// removal.
// Which OBS profile and scene collection a profile switches OBS to when it is
// switched to. Off by default; each name can be left empty to leave that part
// of OBS alone. The names are whatever OBS calls them.
function defaultObsPins() {
  return { enabled: false, profile: '', collection: '' };
}

function sanitizeObsPins(input) {
  const d = defaultObsPins();
  const src = input && typeof input === 'object' ? input : {};
  const name = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
  return {
    enabled: src.enabled === undefined ? d.enabled : Boolean(src.enabled),
    profile: name(src.profile),
    collection: name(src.collection),
  };
}

function defaultSession() {
  return {
    filenameFormat: '',
  };
}

function sanitizeSession(input) {
  const d = defaultSession();
  const src = input && typeof input === 'object' ? input : {};
  return {
    filenameFormat: typeof src.filenameFormat === 'string' ? src.filenameFormat.slice(0, 300) : d.filenameFormat,
  };
}

const METADATA_FIELD_LIMITS = { maxFields: 50, maxLabelLen: 60, maxKeyLen: 60, maxValueLen: 500, maxSeparatorLen: 20 };
// "Prompt" is Text-shaped in storage (see sanitizeMetadataField's fallthrough
// below) but has no other way to get a value: it is never editable on the
// Session tab and setMetadataField refuses it (Text only) -- the only write
// path is answering the prompt as part of running whatever rule set actually
// needs it. See collectRequiredPrompts/checkAndApplyPrompts (src/main.js).
const METADATA_FIELD_TYPES = ['text', 'number', 'textNumber', 'numberText', 'checkbox', 'prompt'];
const METADATA_PADDING_OPTIONS = [0, 2, 3, 4];

// Data Field keys Studio itself resolves specially (src/main.js's
// resolveDataField) -- today's date/time. A user-created metadata field's
// generated key can never collide with one of these (see
// uniqueMetadataKey), and a connected module registering one of these
// exact keys has its field shadowed by Studio's own, not rejected -- see
// api-automations.md's "Reserved keys" note.
const RESERVED_FIELD_KEYS = ['sessionTime', 'sessionDate', 'sessionDay', 'sessionMonth', 'sessionYear'];

function sanitizeMetadataField(input) {
  const src = input && typeof input === 'object' ? input : {};
  const type = METADATA_FIELD_TYPES.includes(src.type) ? src.type : 'text';
  const label = typeof src.label === 'string' ? src.label.trim().slice(0, METADATA_FIELD_LIMITS.maxLabelLen) : '';
  const key = typeof src.key === 'string' ? src.key.trim().slice(0, METADATA_FIELD_LIMITS.maxKeyLen) : '';
  const id = sanitizeId(src.id, `field${Date.now().toString(36)}`);

  // "Text + Number"/"Number + Text": a fixed text segment glued to a
  // number segment (which alone is Increment/Decrement-capable, same as a
  // plain Number field's value) via a typed separator and an optional
  // zero-pad width -- covers "Chapter 5"/"5 Days Left" without needing a
  // real {..} template engine. Order, separator, and padding are all fixed
  // at creation, same reasoning as the key: delete and recreate rather than
  // edit in place.
  if (type === 'textNumber' || type === 'numberText') {
    return {
      id,
      label,
      key,
      type,
      text: typeof src.text === 'string' ? src.text.slice(0, METADATA_FIELD_LIMITS.maxValueLen) : '',
      separator: typeof src.separator === 'string' ? src.separator.slice(0, METADATA_FIELD_LIMITS.maxSeparatorLen) : '',
      number: Number.isFinite(Number(src.number)) ? Number(src.number) : 0,
      padding: METADATA_PADDING_OPTIONS.includes(Number(src.padding)) ? Number(src.padding) : 0,
    };
  }

  // "Checkbox": a plain boolean -- added for the YouTube upload action's
  // "made for kids" flag, which needs a real true/false a rule-set step can
  // point at, not a string a human has to
  // type consistently ("true"/"yes"/"1"...) for something this consequential.
  if (type === 'checkbox') return { id, label, key, type, value: Boolean(src.value) };

  // "Number": a plain counter, with an optional zero-padding width -- the
  // same METADATA_PADDING_OPTIONS a Text+Number/Number+Text field's own
  // number segment already offers. Added after a real gap surfaced live: a
  // plain Number composed into a Text field's {token} template had no way
  // to pad at all ("S{sessionSeasonCounter}" -> "S3", not "S03"), where
  // splitting season/episode into a raw counter plus a separately-composed
  // display string (instead of one textNumber field, which always had
  // padding) lost it. resolveDataField (src/main.js) applies this the same
  // way it already applies a compound field's own padding.
  if (type === 'number') {
    return {
      id,
      label,
      key,
      type,
      value: Number.isFinite(Number(src.value)) ? Number(src.value) : 0,
      padding: METADATA_PADDING_OPTIONS.includes(Number(src.padding)) ? Number(src.padding) : 0,
    };
  }

  // "Text"/"Prompt": stored as a plain string, but resolveDataField
  // (src/main.js) expands any {token} it contains before returning it --
  // the same syntax and resolution the Recording Filename format already
  // uses, and a no-op for a value with no {..} in it. (This used to be a
  // separate "Template" type; merged into Text since it never had a use no
  // Text field could also have -- see the "Text became template-aware"
  // note in architecture-automations.md.)
  const value = typeof src.value === 'string' ? src.value.slice(0, METADATA_FIELD_LIMITS.maxValueLen) : '';
  return { id, label, key, type, value };
}

// Drops anything with no label/key (never legitimately created that way --
// see the "New" flow in control.js) and de-duplicates by key, first one
// wins, since the key is what a rule-set step's Data Field picker actually
// points at. Does NOT re-generate a key from a label; that only happens
// once, client-side, when a field is first created (see uniqueMetadataKey)
// -- the key freezes at creation by design, so a sanitizer re-deriving it
// from the (possibly since-changed) label would be a second, silent way
// for it to change out from under a rule set already pointing at it.
function sanitizeMetadataFields(input) {
  const list = Array.isArray(input) ? input : [];
  const seenKeys = new Set();
  const out = [];
  for (const raw of list) {
    if (out.length >= METADATA_FIELD_LIMITS.maxFields) break;
    const field = sanitizeMetadataField(raw);
    if (!field.label || !field.key || seenKeys.has(field.key)) continue;
    seenKeys.add(field.key);
    out.push(field);
  }
  return out;
}

const APP_WINDOW_LIMITS = { maxWindows: 20, maxLabelLen: 40, maxMatchLen: 100 };

// Windows of OTHER applications, captured into OBS and kept pointed at as
// the app reopens (window IDs change every launch, so a saved ID would go
// stale). Studio doesn't own these windows -- it can't open, move, dock or
// mute them -- so this is deliberately not a "view": it's just a saved way
// to find the window again (matchApp/matchTitle, compared as
// case-insensitive substrings against OBS's own window list) plus the name
// of the OBS source Studio manages for it.
function sanitizeAppCrop(input) {
  const c = input && typeof input === 'object' ? input : {};
  const edge = (v) => clamp(toInt(v, 0), 0, 10000);
  return { left: edge(c.left), top: edge(c.top), right: edge(c.right), bottom: edge(c.bottom) };
}

function sanitizeAppWindow(input, index) {
  const src = input && typeof input === 'object' ? input : {};
  const label = typeof src.label === 'string' && src.label.trim() ? src.label.trim().slice(0, APP_WINDOW_LIMITS.maxLabelLen) : `App ${index + 1}`;
  const text = (v) => (typeof v === 'string' ? v.trim().slice(0, APP_WINDOW_LIMITS.maxMatchLen) : '');
  const rawName = typeof src.sourceName === 'string' ? src.sourceName.trim().slice(0, 200) : '';
  return {
    id: sanitizeId(src.id, `app${index + 1}`),
    label,
    matchApp: text(src.matchApp),
    matchTitle: text(src.matchTitle),
    // The exact label of the window that was picked from the list, tried
    // before the looser app/title match (see findAppWindowChoice, obs.js).
    windowLabel: typeof src.windowLabel === 'string' ? src.windowLabel.slice(0, 300) : '',
    // Trimmed off each edge of the captured window, in captured pixels (twice
    // the point size on a Retina display) -- e.g. a top value to drop the
    // title bar. OBS has no "hide title bar" option; a crop is the only way.
    crop: sanitizeAppCrop(src.crop),
    showCursor: Boolean(src.showCursor),
    sourceName: rawName || defaultAppSourceName(label),
  };
}

function sanitizeAppWindows(input) {
  const list = Array.isArray(input) ? input : [];
  const seenIds = new Set();
  const seenNames = new Set();
  const out = [];
  for (const raw of list) {
    if (out.length >= APP_WINDOW_LIMITS.maxWindows) break;
    const w = sanitizeAppWindow(raw, out.length);
    let id = w.id;
    let n = 2;
    while (seenIds.has(id)) id = `${w.id}-${n++}`;
    seenIds.add(id);
    // Two app windows can't share one OBS source -- the second would fight
    // the first over where it points.
    if (seenNames.has(w.sourceName)) continue;
    seenNames.add(w.sourceName);
    out.push({ ...w, id });
  }
  return out;
}

// Where the control panel was last left; null lets Electron place it.
function sanitizePanel(input) {
  if (!input || typeof input !== 'object') return null;
  const x = toInt(input.x, null);
  const y = toInt(input.y, null);
  const width = toInt(input.width, null);
  const height = toInt(input.height, null);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width: clamp(width, 720, 7680), height: clamp(height, 560, 4320) };
}

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    panel: null,
    menuBarIcon: true,
    hideDockIcon: false,
    // On a Retina display OBS captures twice the pixels; false scales the
    // app's sources by half in OBS so they land at the configured size.
    retinaDouble: false,
    arrangeDisplayId: null,
    dock: defaultDock(),
    obs: defaultObs(),
    tavern: defaultTavern(),
    automations: defaultAutomations(),
    session: defaultSession(),
    obsPins: defaultObsPins(),
    teleprompter: defaultTeleprompter(),
    recording: defaultRecording(),
    // No metadata fields on a fresh install -- created by hand via "New" on
    // the Session tab's Metadata card.
    metadataFields: [],
    appWindows: [],
    // No windows on a fresh install -- the user adds and points each one at
    // whatever they're actually running via the "+" tab.
    views: [],
  };
}

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// Returns a normalised http(s) URL, or '' when the value is empty or invalid.
function sanitizeUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString();
  } catch (err) {
    return '';
  }
}

function sanitizeId(value, fallback) {
  return typeof value === 'string' && /^[a-z0-9_-]{1,40}$/i.test(value) ? value : fallback;
}

function sanitizeView(input, index) {
  const fallback = defaultView(index);
  const src = input && typeof input === 'object' ? input : {};
  const x = src.x === null || src.x === undefined || src.x === '' ? null : toInt(src.x, null);
  const y = src.y === null || src.y === undefined || src.y === '' ? null : toInt(src.y, null);
  const label = typeof src.label === 'string' && src.label.trim() ? src.label.trim().slice(0, 40) : fallback.label;
  return {
    id: sanitizeId(src.id, fallback.id),
    label,
    url: src.url === undefined ? fallback.url : sanitizeUrl(src.url),
    width: clamp(toInt(src.width, fallback.width), LIMITS.minSize, LIMITS.maxSize),
    height: clamp(toInt(src.height, fallback.height), LIMITS.minSize, LIMITS.maxSize),
    x,
    y,
    muted: src.muted === undefined ? fallback.muted : Boolean(src.muted),
    enabled: src.enabled === undefined ? fallback.enabled : Boolean(src.enabled),
    dockOnLaunch: src.dockOnLaunch === undefined ? fallback.dockOnLaunch : Boolean(src.dockOnLaunch),
    wakeAudio: src.wakeAudio === undefined ? fallback.wakeAudio : Boolean(src.wakeAudio),
    wakeDelay: clamp(toInt(src.wakeDelay, fallback.wakeDelay), 10, 300),
    session: sanitizeSessionGroup(src.session),
    windowSource: sanitizeWindowSource(src.windowSource, label, fallback),
    regions: sanitizeRegions(src.regions),
  };
}

// The whole window as one OBS source: an on/off switch and the source name.
function sanitizeWindowSource(input, label, fallback) {
  const ws = input && typeof input === 'object' ? input : null;
  const enabled = ws && ws.enabled !== undefined ? Boolean(ws.enabled) : fallback.windowSource.enabled;
  const raw = ws && typeof ws.name === 'string' ? ws.name : '';
  const name = raw.trim().slice(0, 200) || defaultSourceName(label);
  return { enabled, name };
}

// The teleprompter: one per profile, its own window (not a capture window, so it is not one of the
// views and never becomes an OBS source). Shows a Markdown script for the presenter.
const PROMPTER_LIMITS = { speed: [5, 400], fontSize: [16, 200], lineHeight: [1, 3], textWidth: [30, 100], scripts: 30, size: [LIMITS.minSize, LIMITS.maxSize] };

function defaultTeleprompter() {
  return {
    enabled: false, // open it when the app (or the profile) starts
    script: '', // the Start Up script: the Markdown file the window opens with
    scripts: [], // the scripts this profile can show, in the order they were added; `script` above is one of them
    speed: 60, // pixels per second when auto-scrolling
    fontSize: 56,
    lineHeight: 1.5,
    textWidth: 80, // percent of the window
    mirror: false,
    width: 900,
    height: 700,
    x: null,
    y: null,
  };
}

function limited(value, fallback, [min, max]) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function sanitizeTeleprompter(input) {
  const d = defaultTeleprompter();
  const src = input && typeof input === 'object' ? input : {};
  const position = (v) => (v === null || v === undefined || v === '' ? null : toInt(v, null));
  return {
    enabled: Boolean(src.enabled),
    script: typeof src.script === 'string' ? src.script.trim().slice(0, 1000) : d.script,
    scripts: [...new Set((Array.isArray(src.scripts) ? src.scripts : []).filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim().slice(0, 1000)))].slice(0, PROMPTER_LIMITS.scripts),
    speed: Math.round(limited(src.speed, d.speed, PROMPTER_LIMITS.speed)),
    fontSize: Math.round(limited(src.fontSize, d.fontSize, PROMPTER_LIMITS.fontSize)),
    lineHeight: Math.round(limited(src.lineHeight, d.lineHeight, PROMPTER_LIMITS.lineHeight) * 10) / 10,
    textWidth: Math.round(limited(src.textWidth, d.textWidth, PROMPTER_LIMITS.textWidth)),
    mirror: Boolean(src.mirror),
    width: Math.round(limited(src.width, d.width, PROMPTER_LIMITS.size)),
    height: Math.round(limited(src.height, d.height, PROMPTER_LIMITS.size)),
    x: position(src.x),
    y: position(src.y),
  };
}

// Recording: which backend records ('obs' or the built-in recorder), and the built-in recorder's own settings. One per profile.
const RECORDING_BACKENDS = ['obs', 'builtin'];
const RECORDING_LAYOUTS = ['one', 'side', 'corner', 'center', 'cam']; // one window | two side by side | a window with the webcam in a corner | ... in the middle | the webcam alone
const CAMERA_CORNERS = ['tl', 'tr', 'bl', 'br'];
const CAMERA_SIZES = ['small', 'medium', 'large'];
const RECORDING_SIZES = [[1280, 720], [1920, 1080]];

function defaultRecording() {
  return {
    backend: 'obs',
    folder: '', // where the built-in recorder writes; empty means the Videos folder
    layout: 'one', // 'one' (the first window fills the picture) or 'side' (two windows side by side)
    sources: [], // ids of the windows to record, in order
    width: 1920,
    height: 1080,
    fps: 30,
    fit: 'fit', // a window whose shape differs from its place: 'fit' (all of it, with bars) or 'fill' (fills the place, crops the edges)
    capture: process.platform === 'darwin' ? 'screen' : 'pictures', // how the windows are captured: 'pictures' (each window's own pictures) or 'screen' (the system's screen capture, like OBS)
    encoder: 'auto', // 'auto' (the Mac's own encoder, switching to software if it stalls), 'hardware' or 'software'
    format: 'mp4', // the file type: 'mp4' or 'mkv' (both are written as they go, so both survive a crash)
    audio: defaultRecordingAudio(),
    camera: { device: '', deviceLabel: '', corner: 'br', size: 'medium', flip: false, background: 'none', keyColor: '#00b140', keyTolerance: 35, keySoftness: 25, blur: 50, cx: 0.5, cy: 0.5 }, // the webcam (cx and cy: where its middle is, as shares of the picture, for the 'center' layout) (flip mirrors it left to right), for the 'corner' and 'cam' layouts; background 'key' removes a backdrop of keyColor, 'blur' blurs everything but the person
    toolbar: { auto: true, atStart: false, preview: true, hidePreviewOnRecord: true, keepReady: false, x: null, y: null }, // the recording toolbar: opens when recording starts (auto) or when Showrunner starts (atStart), shows the live picture (preview), and where it was left
  };
}

// Sound for the Showrunner Recorder: a level (0 to 1.5, where 1 is as it is) and a mute for each chosen window, and the microphone.
function defaultRecordingAudio() {
  return {
    windows: [{ level: 1, muted: false }, { level: 1, muted: false }],
    mic: { enabled: false, device: '', deviceLabel: '', level: 1, muted: false, echoCancel: false, delayMs: 0 },
  };
}

function sanitizeRecordingAudio(input) {
  const d = defaultRecordingAudio();
  const src = input && typeof input === 'object' ? input : {};
  const level = (v, fallback) => (Number.isFinite(Number(v)) ? Math.min(1.5, Math.max(0, Number(v))) : fallback);
  const win = (w, i) => ({ level: level(w && w.level, d.windows[i].level), muted: Boolean(w && w.muted) });
  const m = src.mic && typeof src.mic === 'object' ? src.mic : {};
  const list = Array.isArray(src.windows) ? src.windows : [];
  return {
    windows: [win(list[0], 0), win(list[1], 1)],
    mic: {
      enabled: Boolean(m.enabled),
      device: typeof m.device === 'string' ? m.device.slice(0, 300) : '',
      deviceLabel: typeof m.deviceLabel === 'string' ? m.deviceLabel.slice(0, 200) : '',
      level: level(m.level, d.mic.level),
      muted: Boolean(m.muted),
      echoCancel: Boolean(m.echoCancel),
      delayMs: Math.min(500, Math.max(0, Math.round(Number(m.delayMs) || 0))), // to line the voice up with a slow webcam
    },
  };
}

function sanitizeRecording(input) {
  const d = defaultRecording();
  const src = input && typeof input === 'object' ? input : {};
  const size = RECORDING_SIZES.find(([w, h]) => w === Number(src.width) && h === Number(src.height)) || [d.width, d.height];
  return {
    backend: RECORDING_BACKENDS.includes(src.backend) ? src.backend : d.backend,
    folder: typeof src.folder === 'string' ? src.folder.trim().slice(0, 1000) : d.folder,
    layout: RECORDING_LAYOUTS.includes(src.layout) ? src.layout : d.layout,
    // One entry for each place in the picture: a window's id, 'image:<file>' for a picture, or '' for nothing. Places keep their position.
    sources: (() => { const raw = (Array.isArray(src.sources) ? src.sources : []).slice(0, 2).map((v) => (typeof v === 'string' ? v.slice(0, 200) : '')); if (raw[1] && raw[1] === raw[0]) raw[1] = ''; while (raw.length && !raw[raw.length - 1]) raw.pop(); return raw; })(),
    images: (() => { const out = {}; if (src.images && typeof src.images === 'object') for (const [k, v] of Object.entries(src.images).slice(0, 50)) if (/^image:[A-Za-z0-9._-]{1,100}$/.test(k) && typeof v === 'string') out[k] = v.slice(0, 120); return out; })(), // the pictures chosen for the recorder: stored name -> the name it had
    width: size[0],
    height: size[1],
    fps: [24, 30, 60].includes(Number(src.fps)) ? Number(src.fps) : d.fps,
    format: src.format === 'mkv' ? 'mkv' : 'mp4',
    fit: src.fit === 'fill' ? 'fill' : 'fit',
    capture: src.capture === 'screen' || src.capture === 'pictures' ? src.capture : d.capture,
    encoder: ['auto', 'hardware', 'software'].includes(src.encoder) ? src.encoder : 'auto',
    audio: sanitizeRecordingAudio(src.audio),
    camera: {
      device: src.camera && typeof src.camera.device === 'string' ? src.camera.device.slice(0, 300) : '',
      corner: src.camera && CAMERA_CORNERS.includes(src.camera.corner) ? src.camera.corner : 'br',
      size: src.camera && CAMERA_SIZES.includes(src.camera.size) ? src.camera.size : 'medium',
      deviceLabel: src.camera && typeof src.camera.deviceLabel === 'string' ? src.camera.deviceLabel.slice(0, 200) : '',
      flip: Boolean(src.camera && src.camera.flip),
      background: src.camera && ['key', 'blur'].includes(src.camera.background) ? src.camera.background : 'none',
      cx: src.camera && Number.isFinite(Number(src.camera.cx)) ? Math.min(1, Math.max(0, Number(src.camera.cx))) : 0.5,
      cy: src.camera && Number.isFinite(Number(src.camera.cy)) ? Math.min(1, Math.max(0, Number(src.camera.cy))) : 0.5,
      blur: src.camera && Number.isFinite(Number(src.camera.blur)) ? Math.min(100, Math.max(0, Math.round(Number(src.camera.blur)))) : 50,
      keyColor: src.camera && typeof src.camera.keyColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(src.camera.keyColor) ? src.camera.keyColor.toLowerCase() : '#00b140',
      keyTolerance: src.camera && Number.isFinite(Number(src.camera.keyTolerance)) ? Math.min(100, Math.max(0, Math.round(Number(src.camera.keyTolerance)))) : 35,
      keySoftness: src.camera && Number.isFinite(Number(src.camera.keySoftness)) ? Math.min(100, Math.max(0, Math.round(Number(src.camera.keySoftness)))) : 25,
    },
    toolbar: {
      auto: !src.toolbar || src.toolbar.auto !== false,
      atStart: Boolean(src.toolbar && src.toolbar.atStart),
      preview: !src.toolbar || src.toolbar.preview !== false,
      hidePreviewOnRecord: !src.toolbar || src.toolbar.hidePreviewOnRecord !== false,
      keepReady: Boolean(src.toolbar && src.toolbar.keepReady),
      x: src.toolbar && Number.isInteger(src.toolbar.x) ? src.toolbar.x : null,
      y: src.toolbar && Number.isInteger(src.toolbar.y) ? src.toolbar.y : null,
    },
  };
}

function sanitizeObs(input) {
  const d = defaultObs();
  const src = input && typeof input === 'object' ? input : {};
  const host = typeof src.host === 'string' && src.host.trim() ? src.host.trim().slice(0, 200) : d.host;
  return {
    autoConnect: Boolean(src.autoConnect),
    host,
    port: clamp(toInt(src.port, d.port), 1, 65535),
  };
}

// Normalise any object into a valid config with 1 to 5 views and unique ids.
function sanitizeConfig(input) {
  const defaults = defaultConfig();
  const src = input && typeof input === 'object' ? input : {};
  let inputViews = Array.isArray(src.views) ? src.views : defaults.views;
  if (inputViews.length < LIMITS.minViews) inputViews = defaults.views.slice(0, LIMITS.minViews);
  inputViews = inputViews.slice(0, LIMITS.maxViews);

  const seen = new Set();
  const views = inputViews.map((v, index) => {
    const view = sanitizeView(v, index);
    let id = view.id;
    let n = 2;
    while (seen.has(id)) id = `${view.id}-${n++}`;
    seen.add(id);
    return { ...view, id };
  });

  return {
    version: CONFIG_VERSION,
    menuBarIcon: src.menuBarIcon === undefined ? defaults.menuBarIcon : Boolean(src.menuBarIcon),
    hideDockIcon: src.hideDockIcon === undefined ? defaults.hideDockIcon : Boolean(src.hideDockIcon),
    retinaDouble: src.retinaDouble === undefined ? defaults.retinaDouble : Boolean(src.retinaDouble),
    arrangeDisplayId: Number.isFinite(Number(src.arrangeDisplayId)) && src.arrangeDisplayId !== null ? Number(src.arrangeDisplayId) : null,
    dock: sanitizeDock(src.dock),
    obs: sanitizeObs(src.obs),
    tavern: sanitizeTavern(src.tavern),
    automations: sanitizeAutomations(src.automations),
    youtube: sanitizeYoutube(src.youtube),
    session: sanitizeSession(src.session),
    obsPins: sanitizeObsPins(src.obsPins),
    teleprompter: sanitizeTeleprompter(src.teleprompter),
    recording: sanitizeRecording(src.recording),
    metadataFields: sanitizeMetadataFields(src.metadataFields),
    appWindows: sanitizeAppWindows(src.appWindows),
    panel: sanitizePanel(src.panel),
    views,
  };
}

// ---------------------------------------------------------------------------
// Profiles
//
// A profile is the part of the setup that changes between kinds of recording:
// its windows, Session fields, filename template, automation rules and the
// Chameleon settings that depend on the table. Everything else (the OBS and
// YouTube connections, the dock, preferences, and the Chameleon and
// Automations connection details) is global.
//
// The rest of the app reads and writes one flat config -- the active profile's
// part merged over the global part -- exactly as before profiles existed.
// project() builds that flat config from the stored shape and fold() writes
// one back, so only this file knows how the file is laid out.
// ---------------------------------------------------------------------------

const PROFILE_LIMITS = { maxProfiles: 12, maxNameLen: 40 };
const TAVERN_PROFILE_KEYS = ['enabled', 'characterWithPlayer', 'space', 'followAdmin', 'players', 'autoLevel'];
// YouTube's login and defaults are global; whether it is on is the profile's.
const YOUTUBE_PROFILE_KEYS = ['enabled'];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

function omit(obj, keys) {
  const out = {};
  for (const k of Object.keys(obj)) if (!keys.includes(k)) out[k] = obj[k];
  return out;
}

// The per-profile part of a (sanitized) flat config.
function profileFromFlat(flat, id, name) {
  return {
    id,
    name,
    views: flat.views,
    appWindows: flat.appWindows,
    metadataFields: flat.metadataFields,
    session: flat.session,
    obsPins: flat.obsPins,
    teleprompter: flat.teleprompter,
    recording: flat.recording,
    automations: { enabled: flat.automations.enabled, ruleSets: flat.automations.ruleSets },
    tavern: pick(flat.tavern, TAVERN_PROFILE_KEYS),
    youtube: pick(flat.youtube, YOUTUBE_PROFILE_KEYS),
  };
}

// The global part of a (sanitized) flat config.
function globalFromFlat(flat) {
  return {
    version: CONFIG_VERSION,
    menuBarIcon: flat.menuBarIcon,
    hideDockIcon: flat.hideDockIcon,
    retinaDouble: flat.retinaDouble,
    arrangeDisplayId: flat.arrangeDisplayId,
    dock: flat.dock,
    obs: flat.obs,
    youtube: omit(flat.youtube, YOUTUBE_PROFILE_KEYS),
    panel: flat.panel,
    tavern: omit(flat.tavern, TAVERN_PROFILE_KEYS),
    automations: { port: flat.automations.port, token: flat.automations.token },
  };
}

function sanitizeProfileName(value, fallback) {
  const text = typeof value === 'string' ? value.trim().slice(0, PROFILE_LIMITS.maxNameLen) : '';
  return text || fallback;
}

// The flat config one profile produces: the global part with that profile's part
// merged over it.
function flatFor(stored, profile) {
  return sanitizeConfig({
    ...stored,
    tavern: { ...stored.tavern, ...profile.tavern },
    automations: { ...stored.automations, ...profile.automations },
    youtube: { ...stored.youtube, ...profile.youtube },
    views: profile.views,
    appWindows: profile.appWindows,
    metadataFields: profile.metadataFields,
    session: profile.session,
    obsPins: profile.obsPins,
    teleprompter: profile.teleprompter,
    recording: profile.recording,
  });
}

// What the rest of the app sees: the active profile's flat config, plus the
// profile list and which one is active.
function project(stored) {
  const profile = stored.profiles.find((s) => s.id === stored.activeProfile) || stored.profiles[0];
  return {
    ...flatFor(stored, profile),
    // Each profile's name and which integrations it has switched on, so the
    // Manage profiles page can show and change them for any profile.
    profiles: stored.profiles.map((s) => ({
      id: s.id,
      name: s.name,
      integrations: { tavern: Boolean(s.tavern.enabled), automations: Boolean(s.automations.enabled), youtube: Boolean(s.youtube && s.youtube.enabled) },
      obsPins: s.obsPins ? { enabled: Boolean(s.obsPins.enabled), profile: s.obsPins.profile || '', collection: s.obsPins.collection || '' } : defaultObsPins(),
    })),
    activeProfile: profile.id,
  };
}

// Writes a flat config (an edit of the projection) back into the stored shape.
function fold(stored, flatInput) {
  const flat = sanitizeConfig(flatInput);
  const active = stored.profiles.find((s) => s.id === stored.activeProfile) || stored.profiles[0];
  return {
    ...globalFromFlat(flat),
    profiles: stored.profiles.map((s) => (s.id === active.id ? profileFromFlat(flat, s.id, s.name) : s)),
    activeProfile: active.id,
  };
}

// A stored config from a flat one (a version 12 file, or a fresh install).
function storedFromFlat(input, name) {
  const flat = sanitizeConfig(input);
  return {
    ...globalFromFlat(flat),
    profiles: [profileFromFlat(flat, 'profile1', name)],
    activeProfile: 'profile1',
  };
}

// Validates a stored config read from disk: unique ids, sane names, an
// active profile that exists, and every profile's part passed through the same
// sanitizers the flat config uses.
function sanitizeStored(input) {
  const src = input && typeof input === 'object' ? input : {};
  const rawProfiles = (Array.isArray(src.profiles) ? src.profiles : []).filter((s) => s && typeof s === 'object').slice(0, PROFILE_LIMITS.maxProfiles);
  if (rawProfiles.length === 0) return storedFromFlat(src, 'My Profile');
  const taken = new Set();
  const clean = rawProfiles.map((raw, index) => {
    let id = sanitizeId(raw.id, `profile${index + 1}`);
    let n = 2;
    const base = id;
    while (taken.has(id)) id = `${base}-${n++}`;
    taken.add(id);
    // Before YouTube's switch moved into the profile it was global: a profile
    // saved without its own inherits that value.
    const youtube = raw.youtube && typeof raw.youtube === 'object' ? raw.youtube : { enabled: Boolean(src.youtube && src.youtube.enabled) };
    return { ...raw, id, name: sanitizeProfileName(raw.name, `Profile ${index + 1}`), youtube };
  });
  const flats = clean.map((raw) => flatFor(src, raw));
  const profiles = flats.map((flat, i) => profileFromFlat(flat, clean[i].id, clean[i].name));
  const activeProfile = profiles.some((s) => s.id === src.activeProfile) ? src.activeProfile : profiles[0].id;
  return { ...globalFromFlat(flats[0]), profiles, activeProfile };
}

// A profile with nothing set up yet.
function blankProfile(id, name) {
  return profileFromFlat(sanitizeConfig({}), id, name);
}

function newProfileId(profiles) {
  const taken = new Set(profiles.map((s) => s.id));
  let n = profiles.length + 1;
  while (taken.has(`profile${n}`)) n++;
  return `profile${n}`;
}

// Before version 15 one number, wakeAudioDelay, set the wait for every window. Each window now
// has its own wakeDelay, so a file with the old number gives it to every window it has.
function moveWakeDelayToWindows(parsed) {
  if (!parsed || typeof parsed !== 'object' || parsed.wakeAudioDelay === undefined) return;
  const delay = parsed.wakeAudioDelay;
  const give = (views) => { for (const v of Array.isArray(views) ? views : []) if (v && v.wakeDelay === undefined) v.wakeDelay = delay; };
  give(parsed.views);
  for (const profile of Array.isArray(parsed.profiles) ? parsed.profiles : Array.isArray(parsed.shows) ? parsed.shows : []) give(profile && profile.views);
  delete parsed.wakeAudioDelay;
}

class ConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.loadedVersion = null;
    this.stored = this.load();
    this.data = project(this.stored);
    // Rewrite files saved by an older version so they carry the new shape.
    if (this.loadedVersion !== null && this.loadedVersion !== CONFIG_VERSION) {
      // An older build cannot read the new format, so keep a copy of the old
      // files before the first rewrite.
      try {
        backup.create(path.dirname(this.filePath), `migrate-v${this.loadedVersion === undefined ? 'unknown' : this.loadedVersion}`);
      } catch (err) {
        console.warn(`[config] Could not back up before migrating: ${err.message}`);
      }
      this.write();
    }
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      moveWakeDelayToWindows(parsed);
      this.loadedVersion = parsed && typeof parsed === 'object' ? parsed.version : undefined;
      // Version 13 called profiles shows.
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.shows) && !Array.isArray(parsed.profiles)) {
        const { shows, activeShow, ...rest } = parsed;
        return sanitizeStored({ ...rest, profiles: shows, activeProfile: activeShow });
      }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.profiles)) return sanitizeStored(parsed);
      // Before profiles: the whole file is one profile.
      return storedFromFlat(parsed, 'D&D');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[config] Could not read ${this.filePath}, using defaults: ${err.message}`);
      }
      return storedFromFlat({}, 'My Profile');
    }
  }

  write() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.stored, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  // Saves a flat config (an edit of get()) into the active profile and the
  // global part. The profile list itself is changed only by the profile methods.
  save(next) {
    this.stored = fold(this.stored, next);
    this.data = project(this.stored);
    this.write();
    return this.data;
  }

  // --- Profiles ---

  // Replaces the stored config and refreshes the flat view of it.
  commit(stored) {
    this.stored = stored;
    this.data = project(this.stored);
    this.write();
    return this.data;
  }

  listProfiles() {
    return this.data.profiles.slice();
  }

  // A new profile with nothing set up. Returns the new profile's id.
  createProfile(name) {
    if (this.stored.profiles.length >= PROFILE_LIMITS.maxProfiles) throw new Error(`At most ${PROFILE_LIMITS.maxProfiles} profiles.`);
    const id = newProfileId(this.stored.profiles);
    const profile = blankProfile(id, sanitizeProfileName(name, `Profile ${this.stored.profiles.length + 1}`));
    this.commit({ ...this.stored, profiles: [...this.stored.profiles, profile] });
    return id;
  }

  // A copy of a profile with everything in it, windows and regions included.
  duplicateProfile(id, name) {
    if (this.stored.profiles.length >= PROFILE_LIMITS.maxProfiles) throw new Error(`At most ${PROFILE_LIMITS.maxProfiles} profiles.`);
    const source = this.stored.profiles.find((s) => s.id === id);
    if (!source) throw new Error(`Unknown profile: ${id}`);
    const copyId = newProfileId(this.stored.profiles);
    const copy = { ...JSON.parse(JSON.stringify(source)), id: copyId, name: sanitizeProfileName(name, `${source.name} copy`) };
    this.commit({ ...this.stored, profiles: [...this.stored.profiles, copy] });
    return copyId;
  }

  renameProfile(id, name) {
    if (!this.stored.profiles.some((s) => s.id === id)) throw new Error(`Unknown profile: ${id}`);
    const profiles = this.stored.profiles.map((s) => (s.id === id ? { ...s, name: sanitizeProfileName(name, s.name) } : s));
    return this.commit({ ...this.stored, profiles });
  }

  // The last profile cannot be deleted. Deleting the active one activates the first left.
  deleteProfile(id) {
    if (this.stored.profiles.length <= 1) throw new Error('The last profile cannot be deleted.');
    const profiles = this.stored.profiles.filter((s) => s.id !== id);
    if (profiles.length === this.stored.profiles.length) throw new Error(`Unknown profile: ${id}`);
    const activeProfile = this.stored.activeProfile === id ? profiles[0].id : this.stored.activeProfile;
    return this.commit({ ...this.stored, profiles, activeProfile });
  }

  // Switches one integration on or off for any profile, the active one or not,
  // without switching to it. The active profile's own switches also start or
  // stop the integration itself; use them for that (see the control panel).
  setProfileIntegration(id, key, enabled) {
    const group = { tavern: 'tavern', automations: 'automations', youtube: 'youtube' }[key];
    if (!group) throw new Error(`Unknown integration: ${key}`);
    if (!this.stored.profiles.some((s) => s.id === id)) throw new Error(`Unknown profile: ${id}`);
    const profiles = this.stored.profiles.map((s) => (s.id === id ? { ...s, [group]: { ...s[group], enabled: Boolean(enabled) } } : s));
    return this.commit({ ...this.stored, profiles });
  }

  switchProfile(id) {
    if (!this.stored.profiles.some((s) => s.id === id)) throw new Error(`Unknown profile: ${id}`);
    return this.commit({ ...this.stored, activeProfile: id });
  }

  get() {
    return JSON.parse(JSON.stringify(this.data));
  }

  getView(id) {
    return this.data.views.find((v) => v.id === id) || null;
  }

  updateView(id, patch) {
    const views = this.data.views.map((v) => (v.id === id ? { ...v, ...patch } : v));
    return this.save({ ...this.data, views });
  }

  getRegion(viewId, regionId) {
    const view = this.getView(viewId);
    return view ? view.regions.find((r) => r.id === regionId) || null : null;
  }

  // Add (no id / unknown id) or replace a region on a view. Returns the saved region.
  saveRegion(viewId, region) {
    const view = this.getView(viewId);
    if (!view) throw new Error(`Unknown view: ${viewId}`);
    const regions = view.regions.slice();
    const index = regions.findIndex((r) => r.id === region.id);
    if (index >= 0) {
      regions[index] = { ...regions[index], ...region, id: regions[index].id };
    } else {
      if (regions.length >= REGION_LIMITS.maxRegions) throw new Error(`At most ${REGION_LIMITS.maxRegions} regions per window.`);
      regions.push({ ...region, id: undefined });
    }
    const saved = this.updateView(viewId, { regions });
    const savedView = saved.views.find((v) => v.id === viewId);
    return index >= 0 ? savedView.regions[index] : savedView.regions[savedView.regions.length - 1];
  }

  removeRegion(viewId, regionId) {
    const view = this.getView(viewId);
    if (!view) return;
    this.updateView(viewId, { regions: view.regions.filter((r) => r.id !== regionId) });
  }

  // Append a new view with defaults. Returns it, or null when at the limit.
  addView() {
    const views = this.data.views.slice();
    if (views.length >= LIMITS.maxViews) return null;
    const taken = new Set(views.map((v) => v.id));
    const view = defaultView(views.length);
    let id = view.id;
    let n = 2;
    while (taken.has(id)) id = `${view.id}-${n++}`;
    views.push({ ...view, id });
    const saved = this.save({ ...this.data, views });
    return saved.views[saved.views.length - 1];
  }

  // Remove a view by id. The last remaining view cannot be removed.
  removeView(id) {
    if (this.data.views.length <= LIMITS.minViews) return false;
    const views = this.data.views.filter((v) => v.id !== id);
    if (views.length === this.data.views.length) return false;
    this.save({ ...this.data, views });
    return true;
  }
}

module.exports = {
  ConfigStore,
  defaultConfig,
  sanitizeConfig,
  defaultSourceName,
  SOURCE_SUFFIX,
  upgradeSourceName,
  LIMITS,
  REGION_LIMITS,
  AUTOMATIONS_LIMITS,
  AUTOMATIONS_ACTIONS,
  AUTOMATIONS_ACTION_SCHEMA,
  STUDIO_ACTIONS,
  STUDIO_ACTION_SCHEMA,
  CONFIG_VERSION,
  PROFILE_LIMITS,
  DEFAULT_GROUP,
  RESERVED_FIELD_KEYS,
  METADATA_FIELD_LIMITS,
};
