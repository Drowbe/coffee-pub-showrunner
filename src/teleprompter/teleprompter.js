'use strict';

// The teleprompter page: shows the script the app hands it, scrolls it by hand or at a set
// speed, and tells the app when the reading line crosses a cue or a heading.

const $ = (id) => document.getElementById(id);
const scriptEl = $('script');
const noticeEl = $('notice');
const speedEl = $('speed');
const playButton = document.querySelector('[data-do="play"]');
const mirrorButton = document.querySelector('[data-do="mirror"]');

const LIMITS = { speed: [5, 400], fontSize: [16, 200] };
const clamp = (n, [min, max]) => Math.min(max, Math.max(min, n));

let settings = { speed: 60, fontSize: 56, lineHeight: 1.5, textWidth: 80, mirror: false };
let playing = false;
let pos = 0;
let cueEls = [];
let lastIndex = 0; // how many cues the reading line has passed
let lastScrollY = 0;
let saveTimer = null;
let heldContent = null; // text that arrived while editing; shown when editing ends
const editing = () => document.body.classList.contains('editing');

const lineY = () => window.innerHeight / 3;
const maxScroll = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

// ---- settings ---------------------------------------------------------------------------

function applySettings(next) {
  settings = { ...settings, ...next };
  const root = document.documentElement.style;
  root.setProperty('--size', `${settings.fontSize}px`);
  root.setProperty('--leading', String(settings.lineHeight));
  root.setProperty('--measure', `${settings.textWidth}%`);
  document.body.classList.toggle('mirror', Boolean(settings.mirror));
  mirrorButton.classList.toggle('on', Boolean(settings.mirror));
  speedEl.textContent = String(Math.round(settings.speed));
  resetCues();
}

let pending = {};
function change(patch) {
  applySettings(patch);
  pending = { ...pending, ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { window.prompter.save(pending); pending = {}; }, 400);
}

// ---- cues -------------------------------------------------------------------------------

function passed() {
  const y = lineY() + 1;
  let n = 0;
  for (const el of cueEls) {
    if (el.getBoundingClientRect().top <= y) n += 1;
    else break;
  }
  return n;
}

// Forget what has been passed without firing anything (new text, a resize, a settings change).
function resetCues() {
  cueEls = [...scriptEl.querySelectorAll('[data-cue]')];
  lastIndex = passed();
  lastScrollY = window.scrollY;
}

function checkCues() {
  if (editing()) return;
  const n = passed();
  const jump = Math.abs(window.scrollY - lastScrollY) > window.innerHeight * 0.6;
  if (n > lastIndex && !jump) {
    for (let i = lastIndex; i < n; i += 1) {
      const el = cueEls[i];
      window.prompter.cue({ event: el.dataset.cue, label: el.dataset.label, kind: el.dataset.kind });
    }
  }
  lastIndex = n;
  lastScrollY = window.scrollY;
}

let checkQueued = false;
window.addEventListener('scroll', () => {
  if (checkQueued) return;
  checkQueued = true;
  requestAnimationFrame(() => { checkQueued = false; checkCues(); });
}, { passive: true });
window.addEventListener('resize', resetCues);

// ---- content ----------------------------------------------------------------------------

function notice(text) {
  noticeEl.textContent = text || '';
  noticeEl.hidden = !text;
}

function showContent(content) {
  if (editing()) { heldContent = content; return; }
  // Keep the reader's place across a reload: the heading nearest above the line, and how far past it.
  let anchor = null;
  const y = lineY();
  for (const el of cueEls) {
    if (el.dataset.kind !== 'heading') continue;
    const top = el.getBoundingClientRect().top;
    if (top <= y) anchor = { event: el.dataset.cue, label: el.dataset.label, delta: y - top };
  }
  const before = window.scrollY;

  if (content.error || !content.html) {
    scriptEl.innerHTML = '';
    notice(content.error || 'No script loaded. Choose a Markdown file on the Teleprompter page in Showrunner.');
    resetCues();
    return;
  }
  notice('');
  scriptEl.innerHTML = content.html;
  resetCues();
  let target = before;
  if (anchor) {
    const el = cueEls.find((c) => c.dataset.kind === 'heading' && c.dataset.cue === anchor.event && c.dataset.label === anchor.label);
    if (el) target = el.getBoundingClientRect().top + window.scrollY - (y - anchor.delta);
  }
  window.scrollTo(0, Math.max(0, target));
  pos = window.scrollY;
  resetCues();
}

// ---- scrolling --------------------------------------------------------------------------

function setPlaying(on) {
  playing = on;
  pos = window.scrollY;
  playButton.textContent = on ? 'Pause' : 'Play';
  playButton.classList.toggle('on', on);
  if (on) { previous = performance.now(); requestAnimationFrame(tick); }
  document.body.classList.toggle('hide-cursor', on);
}

let previous = 0;
function tick(now) {
  if (!playing) return;
  const dt = Math.min(0.1, (now - previous) / 1000);
  previous = now;
  pos = Math.min(maxScroll(), pos + settings.speed * dt);
  window.scrollTo(0, pos);
  if (pos >= maxScroll()) { setPlaying(false); return; }
  requestAnimationFrame(tick);
}

// Anything the reader does by hand takes over from auto-scroll.
function manual() { if (playing) setPlaying(false); }
window.addEventListener('wheel', manual, { passive: true });
window.addEventListener('touchstart', manual, { passive: true });

function headingStep(direction) {
  const headings = cueEls.filter((el) => el.dataset.kind === 'heading');
  const y = lineY();
  let target = null;
  if (direction > 0) target = headings.find((el) => el.getBoundingClientRect().top > y + 4);
  else target = [...headings].reverse().find((el) => el.getBoundingClientRect().top < y - 4);
  const top = target ? target.getBoundingClientRect().top + window.scrollY - y : direction > 0 ? maxScroll() : 0;
  window.scrollTo(0, Math.max(0, top));
  pos = window.scrollY;
}

// ---- controls ---------------------------------------------------------------------------

const actions = {
  play: () => setPlaying(!playing),
  slower: () => change({ speed: clamp(Math.round(settings.speed - (settings.speed > 60 ? 10 : 5)), LIMITS.speed) }),
  faster: () => change({ speed: clamp(Math.round(settings.speed + (settings.speed >= 60 ? 10 : 5)), LIMITS.speed) }),
  smaller: () => change({ fontSize: clamp(settings.fontSize - 4, LIMITS.fontSize) }),
  larger: () => change({ fontSize: clamp(settings.fontSize + 4, LIMITS.fontSize) }),
  prev: () => { manual(); headingStep(-1); },
  next: () => { manual(); headingStep(1); },
  top: () => { manual(); window.scrollTo(0, 0); pos = 0; },
  mirror: () => change({ mirror: !settings.mirror }),
  edit: () => { manual(); window.scriptEdit.enter(); },
};

document.querySelector('#controls').addEventListener('click', (event) => {
  const button = event.target.closest('[data-do]');
  if (button && actions[button.dataset.do]) actions[button.dataset.do]();
  button && button.blur();
});

const KEYS = { ' ': 'play', '[': 'slower', ']': 'faster', '-': 'smaller', '=': 'larger', '+': 'larger', m: 'mirror', e: 'edit', n: 'next', p: 'prev', Home: 'top' };
window.addEventListener('keydown', (event) => {
  if (editing()) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'End'].includes(event.key)) { manual(); return; }
  const action = KEYS[event.key];
  if (!action) return;
  event.preventDefault();
  actions[action]();
});

// The controls and the cursor show while the mouse moves, then get out of the way.
let idleTimer = null;
window.addEventListener('mousemove', () => {
  document.body.classList.add('show-controls');
  document.body.classList.remove('hide-cursor');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    document.body.classList.remove('show-controls');
    if (playing) document.body.classList.add('hide-cursor');
  }, 2500);
});

// ---- start ------------------------------------------------------------------------------

// Reading controls sent from Automations (a rule set step or a bare action call).
window.prompter.onCommand((command) => {
  if (editing()) return;
  if (command === 'start') { if (!playing) setPlaying(true); }
  else if (command === 'pause') { if (playing) setPlaying(false); }
  else if (actions[command] && command !== 'edit') actions[command]();
});

window.prompter.onContent(showContent);
window.prompter.onSettings(applySettings);
window.prompter.init().then(({ content, settings: initial }) => {
  applySettings(initial);
  showContent(content);
});
