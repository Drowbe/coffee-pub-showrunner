// What the ported editor files expect from Coffee Pub Chameleon's Documents module and Showrunner does not have, and the
// teleprompter's own cue behaviour. See README.md in this folder.

// The address form of a link to another object (Chameleon's f-format file). Showrunner never makes one; the schema needs the word.
const DL_SCHEME = 'obj' + 'ect';

// Chameleon's page-break plugin (t-editor-pages) is not needed here. This stands in for it and is also the place the editor
// gets the cue behaviour, because it is the one plugin the editor lets its page supply:
//  - env.onView(view) hands the page the editor's view, so the page can insert a cue;
//  - Enter at a cue's name ends it and moves to the line below (a cue's name is one line).
function dlEditorPagesPlugin(PM, env) {
  const e = env || {};
  const plugin = new PM.Plugin({
    view(view) {
      if (e.onView) e.onView(view);
      return { destroy() { if (e.onView) e.onView(null); } };
    },
    props: {
      handleDOMEvents: {
        keydown(view, event) {
          if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
          const { $from, empty } = view.state.selection;
          if (!empty || $from.parent.type.name !== 'cue') return false;
          const after = $from.after();
          const tr = view.state.tr;
          const next = tr.doc.resolve(after).nodeAfter;
          if (!next || next.type.name !== 'paragraph') tr.insert(after, view.state.schema.nodes.paragraph.create());
          view.dispatch(tr.setSelection(PM.TextSelection.create(tr.doc, after + 1)).scrollIntoView());
          event.preventDefault();
          return true;
        },
      },
    },
  });
  return { plugin, setPaged() {}, info() { return null; }, measure() {}, destroy() {} };
}

// Put a new cue above the block the caret is in and select its name so typing replaces it. Returns true if it was inserted.
function dlInsertCue(PM, view, name, hold) {
  if (!view) return false;
  const state = view.state;
  const { $from } = state.selection;
  const at = $from.depth >= 1 ? $from.before(1) : 0;
  const cue = state.schema.nodes.cue.create({ hold: Boolean(hold) }, state.schema.text(name));
  const tr = state.tr.insert(at, cue);
  tr.setSelection(PM.TextSelection.create(tr.doc, at + 1, at + 1 + name.length));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}
