# Teleprompter plan

**Audience:** anyone deciding how Showrunner's teleprompter window should work, and the developers building it.

Status: draft for review. Nothing here is built.

## What it is

A **Teleprompter** is a new kind of window, listed under Windows in the left rail beside the web windows. It has the
same borderless Chromium window and slim bar, is resizable, and belongs to the profile like any other window. Instead of
a web address it shows a **Markdown file** you load. It is a **presenter-only screen**: it is not captured in OBS unless
you add a source for it, so a window of this kind starts with its OBS window source switched off.

The reason it is a window of its own, and not a page in the control panel, is the same reason the others are: it sits on
the presenter's monitor at the size they choose, and it can be docked, parked and kept across launches by the machinery
that already exists.

The point of building it now is the one that comes later: **the script drives scene changes**. Phase 1 builds the
hooks for that, so no teleprompter work is thrown away when scene changes arrive.

## Decisions already made

- **Presenter only.** Not captured by default.
- **Scrolling:** manual (wheel, trackpad, keys) or auto-scroll at a chosen speed. Following the speaker's voice is out
  of scope for now.
- **Both markers and headings** can drive events: explicit markers for precision, headings for speed.
- **Anything bundled must be free for commercial use.** See Licensing.

## The window

- Created with **Add window** and a choice of kind (Web page, Teleprompter), or a separate **Add teleprompter** entry.
  It is a view in the profile with `kind: "teleprompter"`; the usual fields (size, position, dock on launch, start on
  launch) apply, and `url` is replaced by `script` (the path of the Markdown file). Its card on the page for the window
  holds the file picker, the path, and the reading settings below.
- The page it shows is a local one, `src/teleprompter/`, bundled in the app, not a web address, so there is no login
  group and no audio wake for this kind.
- **Loading:** the file is read by the main process and sent to the page. The path is remembered per window (so per
  profile). The file is watched, and saving it in an editor reloads the text while keeping the reading position as
  close as the headings allow. A missing or unreadable file shows a plain message in the window, not a blank one.
- **Resizable** like every window, and the text reflows.

### Reading controls

On the window's bar and on the keyboard, and mirrored by Automations actions so a rule set or an external caller can
use them:

- Play and pause auto-scroll, speed up and down (the speed is stored per window).
- Font size, line spacing and text width.
- A **reading line**: a faint band a third of the way down the window, which is where the cue logic below measures.
- **Mirror** (flip horizontally) for a beam-splitter prompter, and **flip vertical** if needed.
- Jump to the previous or next heading, and to the top.
- The theme is fixed, high-contrast light text on dark, with no settings in the first version.

Manual scrolling always wins: the wheel or a key stops auto-scroll, and play resumes it from where the reader is.

## Markdown

Rendered with `marked`. Raw HTML in the file is **escaped, not rendered**, which is what makes it safe to open a file
from anywhere and means no separate sanitizer has to be bundled. Standard Markdown only: headings, emphasis, lists,
quotes, rules, links (shown as text, not followed), code. Images are not supported in the first version.

### Cues

A **cue** is a line of the form

```
<!-- cue: Be Right Back -->
```

on a line of its own. Showrunner reads these itself, before the text is rendered, so they are never shown as content.
In the window they appear as a small, dim chip in the margin so the presenter can see what is coming. A **heading** is
a cue too, without anything extra: reaching "## Act Two" is an event.

### How cues drive scenes (later), and what is built now

The teleprompter does **not** switch scenes itself. When the reading line crosses a cue or a heading, the window tells
the main process, which fires an **Automations event** the same way a Foundry module's event arrives. A rule set the user
has already learned to build reacts to it: switch scene, show or hide a source, start or stop recording, or any other
step. Scene logic stays in one place.

Event names are the cue text made into a name, because rule sets match on the event name:

| In the script | Event fired |
| --- | --- |
| `<!-- cue: Be Right Back -->` | `teleprompter:be-right-back` |
| `## Act Two` | `teleprompter:heading:act-two` |

The same cue read again (scrolling back) fires again. A cue passed over while paging far ahead with a jump is not fired,
only the ones the reading line actually crosses. Events also carry the window's label and the cue's text in their data,
for modules and the activity log.

Phase 1 fires these events and records them in the Status activity log (so cues can be tested without any rule set). The
Automations page gets a **Teleprompter cues** helper in a later phase: a list of the cues found in the loaded script, each
with a button that creates a rule set listening for it.

## Phases

1. **The window and the text.** The window kind and its card, loading a Markdown file with reload on save, reading
   controls, manual and auto scroll, cue and heading detection with chips and events into the Automations engine and the
   activity log. Docs and a user guide.
2. **Cue helper and actions.** The Teleprompter cues list on the Automations page with one-click rule sets, and
   Automations actions for the reading controls (play, pause, faster, slower, next heading).
3. **Direct scene cues.** An optional `<!-- scene: Name -->` shorthand that switches the OBS scene without a rule set.
4. **Later, not committed:** following the speaker's voice, a playlist of scripts, a second screen for a remote reader.

## Licensing

Showrunner is proprietary and free to download, so everything it bundles has to be free for commercial use.

- **`marked`** (Markdown parser): MIT, currently 18.2.1; Coffee Pub Chameleon already ships 18.2.0. Bundled locally, not
  fetched at run time.
- Nothing else is needed: no sanitizer (raw HTML is escaped), no editor, no UI framework.
- The MIT license text and copyright notice for `marked` ship with the app and are listed in the README next to the
  existing font notice.

## Open questions

- Should a teleprompter be capturable at all, or should Showrunner refuse to make an OBS source for one? Current plan: it
  can be added by hand like any window, but defaults to off.
- One script per window is assumed. A window that cycles through several scripts is phase 4.
- Where the speed and size settings live if two profiles use the same file: with the window, so they differ per profile.
