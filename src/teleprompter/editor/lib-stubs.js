// What the ported editor files expect from Coffee Pub Chameleon's Documents module and Showrunner does not have.
// See README.md in this folder.

// The address form of a link to another object (Chameleon's f-format file). Showrunner never makes one; the schema needs the word.
const DL_SCHEME = 'obj' + 'ect';

// Page breaks and paper layout (Chameleon's t-editor-pages file): the teleprompter has no pages, so this does nothing.
function dlEditorPagesPlugin(PM) {
  return {
    plugin: new PM.Plugin({}),
    setPaged() {},
    info() { return null; },
    measure() {},
    destroy() {},
  };
}
