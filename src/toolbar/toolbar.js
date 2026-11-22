'use strict';
// The recording toolbar: record, pause and stop, the time, and a level and mute for each sound source, with meters.
const $ = (id) => document.getElementById(id);
let state = null; let shape = '';
const rowEls = [];

const mmss = (n) => `${Math.floor(n / 3600) ? `${Math.floor(n / 3600)}:` : ''}${String(Math.floor(n / 60) % 60).padStart(Math.floor(n / 3600) ? 2 : 1, '0')}:${String(n % 60).padStart(2, '0')}`;

function sources(s) {
  const list = [];
  if (s.layout !== 'cam') list.push({ kind: 'w', i: 0, label: s.names[0] || 'Window', meter: 0 });
  if (s.layout === 'side') list.push({ kind: 'w', i: 1, label: s.names[1] || 'Second window', meter: 1 });
  if (s.audio.mic.enabled) list.push({ kind: 'm', label: 'Microphone', meter: 2 });
  return list;
}

function build(list) {
  const rows = $('rows'); rows.textContent = ''; rowEls.length = 0;
  for (const src of list) {
    const row = document.createElement('div'); row.className = 'row';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = src.label; name.title = src.label;
    const range = document.createElement('input'); range.type = 'range'; range.min = '0'; range.max = '150'; range.setAttribute('aria-label', `${src.label} level`);
    const pct = document.createElement('span'); pct.className = 'pct';
    const mute = document.createElement('button'); mute.className = 'mute'; mute.type = 'button';
    const meter = document.createElement('div'); meter.className = 'meter'; meter.appendChild(document.createElement('i'));
    row.append(name, range, pct, mute, meter); rows.appendChild(row);
    const el = { src, row, range, pct, mute, bar: meter.firstChild };
    range.addEventListener('input', () => change(el, { level: Number(range.value) / 100 }));
    mute.addEventListener('click', () => change(el, { muted: !current(el).muted }));
    rowEls.push(el);
  }
}

const current = (el) => (el.src.kind === 'm' ? state.audio.mic : state.audio.windows[el.src.i]);

function change(el, patch) {
  const next = { windows: state.audio.windows.map((w) => ({ ...w })), mic: { ...state.audio.mic } };
  Object.assign(el.src.kind === 'm' ? next.mic : next.windows[el.src.i], patch);
  state.audio = next;
  window.recbar.setAudio(next);
  paintRows();
}

function paintRows() {
  for (const el of rowEls) {
    const v = current(el);
    if (document.activeElement !== el.range) el.range.value = String(Math.round(v.level * 100));
    el.pct.textContent = `${Math.round(v.level * 100)}%`;
    el.mute.textContent = v.muted ? 'Muted' : 'Mute';
    el.mute.classList.toggle('on', v.muted);
    el.row.classList.toggle('off', v.muted);
  }
}

function render(s) {
  state = s;
  const live = s.state === 'recording' || s.state === 'paused';
  const rec = $('rec');
  rec.textContent = live ? 'Stop' : s.state === 'starting' ? 'Starting...' : s.state === 'stopping' ? 'Saving...' : 'Record';
  rec.className = live ? 'stop' : 'go';
  rec.disabled = s.state === 'starting' || s.state === 'stopping';
  $('pause').hidden = !live;
  $('pause').textContent = s.state === 'paused' ? 'Resume' : 'Pause';
  $('time').textContent = mmss(s.seconds);
  const label = s.state === 'paused' ? 'PAUSED' : live ? 'RECORDING' : s.error ? '' : s.file ? `Saved ${s.file.split(/[\\/]/).pop()}` : 'Ready';
  const st = $('state'); st.textContent = label; st.title = label; st.className = live ? 'live' : '';
  $('msg').textContent = s.error || '';
  const list = sources(s);
  const key = list.map((x) => `${x.kind}${x.i}${x.label}`).join('|');
  if (key !== shape) { shape = key; build(list); }
  paintRows();
  window.recbar.size(Math.ceil(document.body.scrollHeight));
}

window.recbar.onState(render);
window.recbar.onLevels((levels) => {
  for (const el of rowEls) {
    const peak = (levels && levels[el.src.meter]) || 0;
    const db = peak > 0 ? 20 * Math.log10(peak) : -90;
    el.bar.style.width = `${Math.round(Math.min(1, Math.max(0, (db + 60) / 60)) * 100)}%`;
    el.bar.className = db > -1 ? 'clip' : db > -9 ? 'hot' : '';
  }
});
$('rec').addEventListener('click', async () => {
  const live = state && (state.state === 'recording' || state.state === 'paused');
  const result = await window.recbar.action(live ? 'stop' : 'start');
  if (result && result.error) $('msg').textContent = result.error;
});
$('pause').addEventListener('click', async () => {
  const result = await window.recbar.action(state.state === 'paused' ? 'resume' : 'pause');
  if (result && result.error) $('msg').textContent = result.error;
});
$('close').addEventListener('click', () => window.recbar.close());
window.recbar.init().then(render);
