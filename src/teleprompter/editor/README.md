# The script editor

The editing half of the teleprompter window (Edit button, or E). It is the rich Markdown editor from Coffee Pub Chameleon's
Documents module, copied here with the files it needs and nothing else. Markdown stays the stored form: reading goes through
the `marked` lexer, writing goes through ProseMirror's Markdown serializer, and a block you did not touch is written back
word for word, so an edit changes only the blocks it touches. The script file stays an ordinary `.md` file.

Copied from `Drowbe/coffee-pub-chameleon`, `modules/documents/src/`, commit `42cf7a3d73c7051246be977c1ddac3a4932326b9`:

| Here | Chameleon file | Why |
| --- | --- | --- |
| `lib-0-marked.js` | `documents-lib-0-marked.js` | marked 18.2.0 (MIT), used only as a lexer |
| `lib-0-prosemirror.js` | `documents-lib-0-prosemirror.js` | ProseMirror, 16 packages (MIT); it also contains Yjs, which the teleprompter does not use |
| `lib-a-records.js` | `documents-lib-a-records.js` | text cleaning helpers the others call |
| `lib-d-reader.js` | `documents-lib-d-reader.js` | the one safe reading gate (raw HTML is kept as text, never run) |
| `lib-l-schema.js` | `documents-lib-l-schema.js` | the editor's document schema |
| `lib-m-parse.js` | `documents-lib-m-parse.js` | Markdown to editor nodes |
| `lib-n-serialise.js` | `documents-lib-n-serialise.js` | editor nodes to Markdown |
| `lib-o-write.js` | `documents-lib-o-write.js` | block-by-block write that keeps untouched blocks as they were |
| `lib-q-rich-rules.js` | `documents-lib-q-rich-rules.js` | typing shortcuts (`# `, `- `, `**bold**`) and the toolbar's state |
| `lib-r-rich-link.js` | `documents-lib-r-rich-link.js` | link helpers the editor file refers to |
| `lib-p-rich-editor.js` | `documents-lib-p-rich-editor.js` | the editor itself |
| `lib-stubs.js` | (written here) | stands in for the page-break plugin and one constant |

The files are unchanged copies. They are plain scripts that share one scope, loaded in this order by `../index.html`; the
page's own glue is `../edit.js`. Each package's licence is in `licenses/` and listed in the README at the top of the project.
Updating means copying the newer files from Chameleon and running the round-trip check described in the project's tests.
