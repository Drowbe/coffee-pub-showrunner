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
