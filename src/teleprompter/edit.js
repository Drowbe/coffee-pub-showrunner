'use strict';

// Edit mode: the script's Markdown is edited in this window, in the same text size and width as the
// reading view. The editor (src/teleprompter/editor/) is Coffee Pub Chameleon's Documents editor: ProseMirror,
// with Markdown kept as the stored form and every block you did not touch written back word for word.

const editBar = $('edit-bar');
const editBox = $('editor');
const lexer = new marked.Marked({ gfm: true });

let ed = null;
let savedText = '';
let baseRevision = 0;
let readingY = 0;
let saving = false;
let editorView = null;
const STARTER = '# Title\n\nWrite what you will say here.\n';
let hasFile = true; // false for a new script that has not been saved anywhere yet
let eventsTimer = null;

// The same turning of a name into an event name as src/prompter.js does when the window reads the file.
function slug(text) {
  const s = String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
  return s || 'cue';
}

// Every heading and cue in the text, in order, with the event each fires.
function listEvents() {
  const found = [];
  if (!editorView) return found;
  editorView.state.doc.descendants((node, pos) => {
    if (node.type.name === 'cue') {
      const hold = node.attrs.hold;
      const label = node.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) || (hold ? 'Hold' : 'Cue');
      found.push({ kind: hold ? 'Hold' : 'Cue', label, event: hold ? `teleprompter:hold:${slug(label)}` : `teleprompter:${slug(label)}`, pos });
    } else if (node.type.name === 'heading') {
      const label = node.textContent.trim();
      found.push({ kind: 'Heading', label, event: `teleprompter:heading:${slug(label)}`, pos });
    }
    return true;
  });
  return found;
}

// Take a cue or heading out of the script. A heading takes its text with it, so that one asks first.
function deleteEvent(item) {
  if (!editorView) return;
  const node = editorView.state.doc.nodeAt(item.pos);
  if (!node || (node.type.name !== 'cue' && node.type.name !== 'heading')) return;
  if (node.type.name === 'heading' && !window.confirm(`Delete the heading "${item.label}" and its line from the script?`)) return;
  editorView.dispatch(editorView.state.tr.delete(item.pos, item.pos + node.nodeSize).scrollIntoView());
  say(`${item.kind} removed. Cmd/Ctrl+Z brings it back.`);
  editorView.focus();
}

// Highlight, in the list, the cue or heading the caret is in, and bring it into view there.
function markCurrent() {
  const list = $('event-list');
  if (!editorView || $('events').hidden) return;
  const { $from } = editorView.state.selection;
  const top = $from.depth >= 1 ? $from.before(1) : -1;
  let found = null;
  for (const li of list.children) {
    const on = li.dataset.pos !== undefined && Number(li.dataset.pos) === top;
    li.classList.toggle('current', on);
    if (on) found = li;
  }
  if (found) found.scrollIntoView({ block: 'nearest' });
}

let ruleMap = {}; // event name -> the rule sets that listen for it, from the app
const headingsBox = $('event-headings');
try { headingsBox.checked = localStorage.getItem('prompter.showHeadings') !== 'no'; } catch (err) { /* keep the default */ }

async function renderEvents() {
  try { ruleMap = await window.prompter.ruleStatus(); } catch (err) { ruleMap = {}; }
  const list = $('event-list');
  list.textContent = '';
  const found = listEvents();
  const seen = new Map();
  for (const item of found) seen.set(item.event, (seen.get(item.event) || 0) + 1);
  const shown = headingsBox.checked ? found : found.filter((item) => item.kind === 'Cue' || item.kind === 'Hold');
  if (!shown.length) {
    const none = document.createElement('li');
    none.className = 'none';
    none.textContent = found.length ? 'No cues yet. Turn on Show headings to see the headings.' : 'No headings or cues yet.';
    list.append(none);
    return;
  }
  for (const item of shown) {
    const li = document.createElement('li');
    li.dataset.pos = String(item.pos);
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'jump';
    jump.title = 'Jump to this in the text';
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = item.kind;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.label || '(empty)';
    const code = document.createElement('code');
    code.textContent = item.event;
    jump.append(kind, label, code);
    jump.addEventListener('click', () => {
      const node = editorView.state.doc.nodeAt(item.pos);
      if (!node) return;
      // Put the caret in it, so it is the one highlighted here and in the text.
      const tr = editorView.state.tr.setSelection(DlPM.TextSelection.create(editorView.state.doc, item.pos + 1));
      editorView.dispatch(tr.scrollIntoView());
      const dom = editorView.nodeDOM(item.pos);
      if (dom && dom.scrollIntoView) dom.scrollIntoView({ block: 'center' });
      editorView.focus();
    });
    const actions = document.createElement('div');
    actions.className = 'actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy';
    copy.textContent = 'Copy';
    copy.title = 'Copy the event name';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(item.event); copy.textContent = 'Copied'; } catch (err) { copy.textContent = 'Could not copy'; }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    });
    const rule = document.createElement('button');
    rule.type = 'button';
    const existing = ruleMap[item.event];
    if (existing && existing.length) {
      rule.className = 'copy has-rule';
      rule.textContent = 'Rule set \u2713';
      rule.title = `Open ${existing[0].name ? `"${existing[0].name}"` : 'the rule set'} in Showrunner`;
      rule.addEventListener('click', () => window.prompter.openRule(existing[0].id));
    } else {
      rule.className = 'copy';
      rule.textContent = 'Create rule';
      rule.title = 'Make a rule set that listens for this event, and open it in Showrunner to add its steps';
      rule.addEventListener('click', async () => {
        rule.disabled = true;
        try { await window.prompter.createRule(item.event, item.label); } finally { renderEvents(); }
      });
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'copy delete';
    del.textContent = 'Delete';
    del.title = `Remove this ${item.kind.toLowerCase()} from the script (Cmd/Ctrl+Z brings it back)`;
    del.addEventListener('click', () => deleteEvent(item));
    actions.append(copy, rule, del);
    li.append(jump, actions);
    if (seen.get(item.event) > 1) {
      const warn = document.createElement('div');
      warn.className = 'warn';
      warn.textContent = 'Same event as another line: a rule set cannot tell them apart.';
      li.append(warn);
    }
    list.append(li);
  }
  markCurrent();
}

headingsBox.addEventListener('change', () => {
  try { localStorage.setItem('prompter.showHeadings', headingsBox.checked ? 'yes' : 'no'); } catch (err) { /* not remembered */ }
  renderEvents();
});
// A rule set may have been made or removed in Showrunner meanwhile.
window.addEventListener('focus', () => { if (!$('events').hidden) renderEvents(); });

function toggleEvents(force) {
  const open = force === undefined ? $('events').hidden : force;
  $('events').hidden = !open;
  document.body.classList.toggle('events-open', open);
  if (open) renderEvents();
}

const dirty = () => Boolean(ed) && ed.revision() !== baseRevision;

// What the status bar says when nothing has just happened.
function editIdle() {
  if (!ed) return 'Ready';
  if (dirty()) return 'Unsaved';
  return hasFile ? 'Ready' : 'Not saved yet';
}
function say(text, isError) { status(text || editIdle(), isError); }

function showFile(path) {
  statusFile.textContent = path ? path.split(/[\\/]/).pop() : 'New script, not saved yet';
  statusFile.title = path || '';
}

function paint() {
  if (!ed) return;
  const active = ed.active();
  for (const button of editBar.querySelectorAll('[data-fmt]')) {
    const id = button.dataset.fmt;
    const heading = /^h(\d)$/.exec(id);
    button.classList.toggle('on', heading ? active.heading === Number(heading[1]) : active[id] === true);
  }
  markCurrent();
  if (dirty()) status('Unsaved');
  else if (statusText.textContent === 'Unsaved') status(editIdle());
}

async function enter() {
  if (ed) return;
  const source = await window.prompter.readSource();
  if (source.error) {
    notice(source.error);
    setTimeout(() => { if (!editing()) notice(''); }, 3500);
    return;
  }
  hasFile = Boolean(source.path); // with no script chosen, this is a new one: it asks where to save the first time
  readingY = window.scrollY;
  document.body.classList.add('editing');
  window.prompter.editing(true);
  editBar.hidden = false;
  showFile(source.path);
  ed = dlRichEditor(DlPM, document, (markdown) => lexer.lexer(markdown), editBox, { onView: (view) => { editorView = view; } });
  ed.setText(source.text || (hasFile ? '' : STARTER));
  savedText = hasFile ? source.text : '';
  baseRevision = ed.revision();
  ed.onChange(() => { paint(); if (!$('events').hidden) { clearTimeout(eventsTimer); eventsTimer = setTimeout(renderEvents, 200); } });
  ed.onSelect(paint);
  say('');
  window.scrollTo(0, 0);
  ed.focus();
  paint();
}

// Ask where to save, then use that file from now on. A cancelled dialog changes nothing.
async function saveAs() {
  if (!ed || saving) return false;
  const text = ed.getText();
  saving = true;
  try {
    const result = await window.prompter.saveSourceAs(text, { fresh: !hasFile });
    if (result.canceled) return false;
    if (!result.ok) { say(result.error || 'Could not save', true); return false; }
    hasFile = true;
    showFile(result.path);
    savedText = text;
    baseRevision = ed.revision();
    say('File saved');
    return true;
  } finally {
    saving = false;
  }
}

// Start a new script in the editor. The profile keeps its current script until the new one is first saved.
function startNew() {
  if (!ed) return;
  if (dirty() && !window.confirm('Drop the unsaved changes and start a new script?')) return;
  ed.setText(STARTER);
  hasFile = false;
  showFile('');
  savedText = '';
  baseRevision = ed.revision();
  say('Not saved yet');
  window.scrollTo(0, 0);
  ed.focus();
  paint();
}

async function save() {
  if (!ed || saving) return false;
  if (!hasFile) return saveAs();
  const text = ed.getText();
  if (text === savedText) { baseRevision = ed.revision(); say('File saved'); return true; }
  saving = true;
  try {
    const result = await window.prompter.writeSource(text);
    if (!result.ok) { say(result.error || 'Could not save', true); return false; }
    savedText = text;
    baseRevision = ed.revision();
    say('File saved');
    return true;
  } finally {
    saving = false;
  }
}

function leave() {
  if (!ed) return;
  ed.destroy();
  ed = null;
  editBox.textContent = '';
  editorView = null;
  toggleEvents(false);
  editBar.hidden = true;
  statusFile.title = '';
  showScriptName(scriptName);
  document.body.classList.remove('editing');
  window.prompter.editing(false);
  if (heldContent) { showContent(heldContent); heldContent = null; }
  requestAnimationFrame(() => { window.scrollTo(0, readingY); pos = window.scrollY; resetCues(); });
}

editBar.addEventListener('mousedown', (event) => {
  if (event.target.closest('button')) event.preventDefault(); // keep the selection in the text
});
const fileMenu = $('file-menu');
const fileButton = editBar.querySelector('[data-edit="file"]');
// The scripts this profile has used, in the File menu: pick one to edit it, or go back to the Start Up script.
async function fillRecent() {
  const box = $('recent-scripts');
  box.textContent = '';
  let info;
  try { info = await window.prompter.scripts(); } catch (err) { return; }
  const known = [...new Set([info.startUp, ...info.scripts].filter(Boolean))];
  if (known.length < 2) return;
  const heading = document.createElement('div');
  heading.className = 'heading';
  heading.textContent = 'Scripts';
  box.append(heading);
  for (const file of known) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.title = file;
    item.textContent = file.split(/[\\/]/).pop();
    const marks = [file === info.current ? 'open' : '', file === info.startUp ? 'Start Up' : ''].filter(Boolean).join(', ');
    if (marks) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = marks;
      item.append(tag);
    }
    item.disabled = file === info.current;
    item.addEventListener('click', () => openScript(file));
    box.append(item);
  }
}

async function openScript(file) {
  toggleFileMenu(false);
  if (!ed) return;
  if (dirty() && !window.confirm('Drop the unsaved changes and open another script?')) return;
  const result = await window.prompter.useScript(file);
  if (!result.ok) { say(result.error, true); return; }
  const source = await window.prompter.readSource();
  if (source.error) { say(source.error, true); return; }
  hasFile = true;
  ed.setText(source.text || '');
  savedText = source.text || '';
  baseRevision = ed.revision();
  showFile(source.path);
  window.scrollTo(0, 0);
  say(`Opened ${file.split(/[\\/]/).pop()}`);
  ed.focus();
  paint();
}

function toggleFileMenu(open) {
  if (open) fillRecent();
  fileMenu.hidden = !open;
  fileButton.setAttribute('aria-expanded', String(open));
}
document.addEventListener('click', (event) => { if (!event.target.closest('.menu-wrap')) toggleFileMenu(false); });
window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !fileMenu.hidden) toggleFileMenu(false); });

editBar.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button || !ed) return;
  if (button.dataset.edit === 'file') { toggleFileMenu(fileMenu.hidden); return; }
  if (button.closest('#file-menu')) toggleFileMenu(false);
  if (button.dataset.fmt) { ed.run(button.dataset.fmt); ed.focus(); paint(); return; }
  if (button.dataset.edit === 'events') { toggleEvents(); return; }
  if (button.dataset.edit === 'cue') { dlInsertCue(DlPM, editorView, 'Cue name'); paint(); return; }
  if (button.dataset.edit === 'hold') { dlInsertCue(DlPM, editorView, 'What to do next', true); paint(); return; }
  if (button.dataset.edit === 'new') startNew();
  else if (button.dataset.edit === 'save') await save();
  else if (button.dataset.edit === 'saveas') await saveAs();
  else if (button.dataset.edit === 'done') {
    if (!hasFile && !dirty()) { leave(); return; } // a new script nobody typed in: nothing to save
    if (await save()) leave();
  }
  else if (button.dataset.edit === 'cancel') {
    if (dirty() && !window.confirm('Drop the unsaved changes to the script?')) return;
    leave();
  }
});
window.addEventListener('keydown', (event) => {
  if (!ed || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
  event.preventDefault();
  save();
});

window.scriptEdit = { enter, leave };
