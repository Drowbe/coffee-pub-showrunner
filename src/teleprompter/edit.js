'use strict';

// Edit mode: the script's Markdown is edited in this window, in the same text size and width as the
// reading view. The editor (src/teleprompter/editor/) is Coffee Pub Chameleon's Documents editor: ProseMirror,
// with Markdown kept as the stored form and every block you did not touch written back word for word.

const editBar = $('edit-bar');
const editBox = $('editor');
const editStatus = $('edit-status');
const lexer = new marked.Marked({ gfm: true });

let ed = null;
let savedText = '';
let baseRevision = 0;
let readingY = 0;
let saving = false;
let editorView = null;
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
      const label = node.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Cue';
      found.push({ kind: 'Cue', label, event: `teleprompter:${slug(label)}`, pos });
    } else if (node.type.name === 'heading') {
      const label = node.textContent.trim();
      found.push({ kind: 'Heading', label, event: `teleprompter:heading:${slug(label)}`, pos });
    }
    return true;
  });
  return found;
}

function renderEvents() {
  const list = $('event-list');
  list.textContent = '';
  const found = listEvents();
  const seen = new Map();
  for (const item of found) seen.set(item.event, (seen.get(item.event) || 0) + 1);
  if (!found.length) {
    const none = document.createElement('li');
    none.className = 'none';
    none.textContent = 'No headings or cues yet.';
    list.append(none);
    return;
  }
  for (const item of found) {
    const li = document.createElement('li');
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
      const dom = editorView.nodeDOM(item.pos);
      if (dom && dom.scrollIntoView) dom.scrollIntoView({ block: 'center' });
    });
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy';
    copy.textContent = 'Copy';
    copy.title = 'Copy the event name';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(item.event); copy.textContent = 'Copied'; } catch (err) { copy.textContent = 'Could not copy'; }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    });
    li.append(jump, copy);
    if (seen.get(item.event) > 1) {
      const warn = document.createElement('div');
      warn.className = 'warn';
      warn.textContent = 'Same event as another line: a rule set cannot tell them apart.';
      li.append(warn);
    }
    list.append(li);
  }
}

function toggleEvents(force) {
  const open = force === undefined ? $('events').hidden : force;
  $('events').hidden = !open;
  document.body.classList.toggle('events-open', open);
  if (open) renderEvents();
}

const dirty = () => Boolean(ed) && ed.revision() !== baseRevision;

function say(text) { editStatus.textContent = text; }

function paint() {
  if (!ed) return;
  const active = ed.active();
  for (const button of editBar.querySelectorAll('[data-fmt]')) {
    const id = button.dataset.fmt;
    const heading = /^h(\d)$/.exec(id);
    button.classList.toggle('on', heading ? active.heading === Number(heading[1]) : active[id] === true);
  }
  if (!$('events').hidden) { clearTimeout(eventsTimer); eventsTimer = setTimeout(renderEvents, 200); }
  if (dirty()) say('Unsaved changes');
  else if (editStatus.textContent === 'Unsaved changes') say('');
}

async function enter() {
  if (ed) return;
  const source = await window.prompter.readSource();
  if (source.error || !source.path) {
    notice(source.error || 'No script loaded. Choose or create a script on the Teleprompter page in Showrunner.');
    setTimeout(() => { if (!editing()) notice(''); }, 3500);
    return;
  }
  readingY = window.scrollY;
  document.body.classList.add('editing');
  editBar.hidden = false;
  ed = dlRichEditor(DlPM, document, (markdown) => lexer.lexer(markdown), editBox, { onView: (view) => { editorView = view; } });
  ed.setText(source.text);
  savedText = source.text;
  baseRevision = ed.revision();
  ed.onChange(paint);
  ed.onSelect(paint);
  say('');
  window.scrollTo(0, 0);
  ed.focus();
  paint();
}

async function save() {
  if (!ed || saving) return false;
  const text = ed.getText();
  if (text === savedText) { baseRevision = ed.revision(); say('Saved'); return true; }
  saving = true;
  try {
    const result = await window.prompter.writeSource(text);
    if (!result.ok) { say(result.error || 'Could not save'); return false; }
    savedText = text;
    baseRevision = ed.revision();
    say('Saved');
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
  document.body.classList.remove('editing');
  if (heldContent) { showContent(heldContent); heldContent = null; }
  requestAnimationFrame(() => { window.scrollTo(0, readingY); pos = window.scrollY; resetCues(); });
}

editBar.addEventListener('mousedown', (event) => {
  if (event.target.closest('button')) event.preventDefault(); // keep the selection in the text
});
editBar.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button || !ed) return;
  if (button.dataset.fmt) { ed.run(button.dataset.fmt); ed.focus(); paint(); return; }
  if (button.dataset.edit === 'events') { toggleEvents(); return; }
  if (button.dataset.edit === 'cue') { dlInsertCue(DlPM, editorView, 'Cue name'); paint(); return; }
  if (button.dataset.edit === 'save') await save();
  else if (button.dataset.edit === 'done') { if (await save()) leave(); }
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
