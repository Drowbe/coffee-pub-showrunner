'use strict';

const $ = (id) => document.getElementById(id);
let state = { side: 'right', windows: [], obsConnected: false, outputs: {} };

function render() {
  document.body.classList.toggle('side-left', state.side === 'left');
  if (state.collapsed) {
    document.documentElement.style.setProperty('--collapsed-w', `${state.collapsed.width}px`);
    document.documentElement.style.setProperty('--collapsed-h', `${state.collapsed.height}px`);
  }
  const outputs = state.outputs || {};

  // Collapsed strip
  const dots = $('dots');
  dots.textContent = '';
  for (const w of state.windows) {
    const dot = document.createElement('span');
    dot.className = `dot${w.open ? ' on' : ''}${w.parked ? ' parked' : ''}`;
    dot.title = `${w.label}: ${w.parked ? 'docked' : w.open ? 'on screen' : 'stopped'}`;
    dots.appendChild(dot);
  }
  const rec = state.recorder; // the Showrunner Recorder, when the profile records with it (otherwise OBS does)
  const recLive = rec ? ['recording', 'paused'].includes(rec.state) : false;
  const recTime = rec ? `${Math.floor(rec.seconds / 60)}:${String(rec.seconds % 60).padStart(2, '0')}` : '';
  $('rec-dot').hidden = rec ? !recLive : !outputs.recording;
  $('live-dot').hidden = !outputs.streaming;

  // Expanded panel
  const obsState = $('obs-state');
  obsState.textContent = rec ? (rec.state === 'paused' ? 'Paused' : recLive ? 'Recording' : 'Ready to record') : state.obsConnected ? 'OBS connected' : 'OBS offline';
  obsState.classList.toggle('on', rec ? recLive : state.obsConnected);
  $('rec').hidden = rec ? !recLive : !outputs.recording;
  $('rec').firstChild.textContent = rec && rec.state === 'paused' ? 'PAUSED ' : 'REC ';
  $('rec-time').textContent = rec ? recTime : (outputs.recordTime || '');
  // The one big action: start or stop recording, for whichever recorder the profile uses.
  const live = rec ? recLive : Boolean(outputs.recording);
  const starting = rec ? ['starting', 'stopping'].includes(rec.state) : false;
  $('rec-toggle').classList.toggle('live', live);
  $('rec-toggle').disabled = starting || (!rec && !state.obsConnected);
  $('rec-toggle-label').textContent = live ? `Stop recording${rec ? ` (${recTime})` : outputs.recordTime ? ` (${outputs.recordTime})` : ''}` : rec && rec.state === 'starting' ? 'Starting...' : 'Start recording';
  $('menu-obs').hidden = Boolean(rec);
  $('scene').textContent = state.obsConnected && outputs.scene ? `Scene: ${outputs.scene}` : '';

  const cards = $('cards');
  cards.textContent = '';
  for (const w of state.windows) {
    const card = document.createElement('div');
    card.className = `card${w.parked ? ' parked' : ''}`;
    card.dataset.id = w.id;
    card.title = w.open ? (w.parked ? 'Click to undock' : 'Click to dock') : 'Click to start';
    const head = document.createElement('div');
    head.className = 'card-head';
    const d = document.createElement('span');
    d.className = `dot${w.open ? ' on' : ''}`;
    head.appendChild(d);
    const label = document.createElement('span');
    label.className = 'card-label';
    label.textContent = w.label;
    head.appendChild(label);
    const size = document.createElement('span');
    size.className = 'card-size';
    size.textContent = `${w.width}×${w.height}`;
    head.appendChild(size);
    card.appendChild(head);
    if (w.thumb) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = w.thumb;
      img.alt = '';
      card.appendChild(img);
    } else {
      const empty = document.createElement('div');
      empty.className = 'thumb-empty';
      empty.textContent = w.open ? 'on screen' : 'stopped';
      card.appendChild(empty);
    }
    const foot = document.createElement('div');
    foot.className = 'card-foot';
    const st = document.createElement('span');
    st.className = 'state';
    st.textContent = w.parked ? 'docked' : w.open ? 'on screen' : 'stopped';
    foot.appendChild(st);
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = rec ? '' : w.sources && w.sources.length ? w.sources.join(', ') : 'no OBS source';
    src.title = src.textContent;
    foot.appendChild(src);
    card.appendChild(foot);
    cards.appendChild(card);
  }
}

window.dock.onState((next) => {
  state = next;
  render();
});

// The window is click-through until the pointer is over the pill, and the
// pointer's movement is forwarded to us meanwhile. Expanding is immediate;
// collapsing waits a moment so crossing the pill's edge does not flicker.
let expanded = false;
let collapseTimer = 0;

function setExpanded(next) {
  if (expanded === next) return;
  expanded = next;
  if (!next) closeMenu();
  document.body.classList.toggle('expanded', next);
  window.dock.hover(next);
}

function overPill(event) {
  const r = $('pill').getBoundingClientRect();
  return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
}

function scheduleCollapse() {
  clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => setExpanded(false), 260);
}

document.addEventListener('mousemove', (event) => {
  if (overPill(event)) {
    clearTimeout(collapseTimer);
    setExpanded(true);
  } else if (expanded) {
    scheduleCollapse();
  }
});
document.addEventListener('mouseleave', () => {
  if (expanded) scheduleCollapse();
});

$('cards').addEventListener('click', (event) => {
  const card = event.target.closest('.card');
  if (card) window.dock.toggle(card.dataset.id);
});

// ---- Menus: the main button is the one thing used every session; the rest live in small menus (and right-click on a window) ----
const menu = $('menu');
function closeMenu() { menu.hidden = true; menu.textContent = ''; }
function openMenu(items, x, y) {
  menu.textContent = '';
  for (const item of items) {
    if (item === '-') { const hr = document.createElement('div'); hr.className = 'menu-sep'; menu.appendChild(hr); continue; }
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'menu-item'; b.textContent = item.label; b.disabled = Boolean(item.disabled); b.setAttribute('role', 'menuitem');
    b.addEventListener('click', () => { closeMenu(); item.run(); });
    menu.appendChild(b);
  }
  menu.hidden = false;
  const panel = $('panel').getBoundingClientRect(); const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, panel.width - box.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, panel.height - box.height - 4))}px`;
}
const anchored = (el, items) => { const r = el.getBoundingClientRect(); const p = $('panel').getBoundingClientRect(); openMenu(items, r.left - p.left, r.bottom - p.top + 2); };
const act = (name) => () => window.dock.action(name);
document.addEventListener('mousedown', (event) => { if (!menu.hidden && !event.target.closest('#menu') && !event.target.closest('.tool') && !event.target.closest('.card')) closeMenu(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });

$('menu-windows').addEventListener('click', (event) => {
  if (!menu.hidden) { closeMenu(); return; }
  anchored(event.currentTarget, [
    { label: 'Start all', run: act('startAll') }, { label: 'Stop all', run: act('stopAll') }, '-',
    { label: 'Dock all', run: () => window.dock.parkAll() }, { label: 'Undock all', run: () => window.dock.restoreAll() }, '-',
    { label: 'Auto-arrange on display', run: act('arrange') }, { label: 'Wake audio', run: act('wakeAudio') },
  ]);
});
$('menu-obs').addEventListener('click', (event) => {
  if (!menu.hidden) { closeMenu(); return; }
  anchored(event.currentTarget, [{ label: 'Sync OBS sources', disabled: !state.obsConnected, run: act('sync') }]);
});
$('rec-more').addEventListener('click', (event) => {
  if (!menu.hidden) { closeMenu(); return; }
  const rec = state.recorder; const outputs = state.outputs || {};
  const live = rec ? ['recording', 'paused'].includes(rec.state) : Boolean(outputs.recording);
  const paused = rec ? rec.state === 'paused' : Boolean(outputs.recordingPaused);
  const items = [];
  if (live) items.push({ label: paused ? 'Resume recording' : 'Pause recording', run: act('recPause') });
  if (rec) items.push({ label: rec.toolbarOpen ? 'Hide recording toolbar' : 'Show recording toolbar', run: act('toolbar') });
  if (!items.length) items.push({ label: 'Nothing to change while not recording', disabled: true, run: () => {} });
  anchored(event.currentTarget, items);
});

// Right-click a window: what can be done to that one window.
$('cards').addEventListener('contextmenu', (event) => {
  const card = event.target.closest('.card');
  if (!card) return;
  event.preventDefault();
  const w = state.windows.find((x) => x.id === card.dataset.id);
  if (!w) return;
  const p = $('panel').getBoundingClientRect();
  const doIt = (what) => () => window.dock.card(w.id, what);
  openMenu(w.open
    ? [{ label: w.parked ? 'Undock' : 'Dock', run: doIt('toggle') }, { label: 'Stop', run: doIt('stop') }, '-', { label: 'Reload', run: doIt('reload') }, { label: 'Wake audio', run: doIt('wake') }, { label: 'Reset window', run: doIt('reset') }]
    : [{ label: 'Start', run: doIt('start') }], event.clientX - p.left, event.clientY - p.top);
});

document.querySelector('.primary').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (button) window.dock.action(button.dataset.action);
});
document.querySelector('.tools').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (button) window.dock.action(button.dataset.action);
});
