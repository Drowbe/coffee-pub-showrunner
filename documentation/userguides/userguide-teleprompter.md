# Teleprompter

**Audience:** anyone who reads from a script while recording or streaming, and wants Showrunner to show it and, later,
to change scenes from it.

The teleprompter is a window for the presenter that shows a **Markdown file**. It has the same look as the capture
windows, a borderless window with the slim bar on top, but it is not one: it is never an OBS source, so it stays off the
stream, and it does not appear under Windows, in the edge dock or in Start All and Stop All.

## Set it up

Open **Teleprompter** in the left rail, under Recording. Click **Choose file...** and pick a Markdown file (`.md`,
`.markdown` or `.txt`, up to 2 MB), then **Open**. Tick **Open when this profile starts** to have it ready every time. Each
profile has its own script, settings and window position, so a podcast profile and a D&D profile can each open their own.

**New...** creates a script file to start from. You can also press **Edit** with no file chosen: the window opens a new script, and the first **Save** asks where on the computer to put it. The script is edited in the teleprompter window itself, below.

**In the window.** Press **Edit** on the window's controls, or E, to edit the script where it is read. The text looks as it
does when reading, in the same size and width, and you type into it: `# `, `- `, `1. ` and `> ` at the start of a line make
a heading, list or quote, and `**bold**` and `*italic*` work as you type. The bar at the top has bold, italic, three heading levels, lists and a quote. **Save** (or Cmd/Ctrl+S) writes the file and **Done** saves and goes back to reading. The **File** menu holds **New** (a blank script; it asks before dropping unsaved changes, and your current script stays as it is until the new one is saved), **Save as...** (asks where to save a copy and uses that file from then on) and **Discard changes** (goes back to reading without saving).
Auto-scroll and cues are off while you edit, and the keys that run the window (Space, `[`,
`]` and the rest) type normally. A cue shows as a small outlined chip with its name. **Insert cue** adds one above the paragraph the cursor is in, with the name selected so you type over it; click into a chip to rename it, and press Enter in one to move to the line below. The cue's event name is the chip's name turned into a name, so renaming a cue changes the event a rule set listens for. **Events** opens a list beside the text of every heading and cue with the event it fires, in order. Click a line to jump to it, or **Copy** to copy the event name for a rule set. A line is flagged when two share an event name, since a rule set cannot tell them apart. The file stays Markdown, and only the blocks you change are rewritten; the rest of the
file is left exactly as it was.

Saving the file, here or in another editor, reloads it in the window, and the window keeps your place by the nearest heading.

## Drag it to the size you want

Unlike a capture window, which has a fixed size for OBS, the teleprompter is resized by dragging its edges (or with the
arrow keys while its bar is selected, 1 pixel at a time, 10 with Shift). The size and position are kept for next time.
Its width and height are also on its page.

## Reading

Move the mouse over the window and a small control strip appears; it hides again when the mouse is still.

| Control | Key |
| --- | --- |
| Play or pause auto-scroll | Space |
| Slower, faster (pixels per second) | `[` and `]` |
| Smaller, larger text | `-` and `=` |
| Previous, next heading | P and N |
| Back to the top | Home |
| Mirror the text left to right, for a beam-splitter prompter | M |

The wheel, the trackpad and the arrow and page keys scroll by hand, and any of them stops auto-scroll; press Space to
carry on from where you are. A thin line a third of the way down the window is the **reading line**: the line you are
reading, and the place cues are measured from. Speed, text size and mirroring are saved with the profile, and can also be set
on the Teleprompter page, along with line spacing and text width.

## Markdown

Headings, emphasis, lists, quotes, rules and code are supported. Raw HTML in the file is shown as plain text, not run,
links are shown as their text and images are left out.

## Cues

A cue tells Showrunner that you have reached a point in the script. There are two kinds:

- **A heading** is a cue on its own. Reaching `## Act two` is an event.
- **A cue line** is a line by itself in the form `<!-- cue: Be Right Back -->`. It is not shown as text; in the window it
  appears as a small, dim chip so you can see it coming.

When the reading line crosses a cue, the window fires an **Automations event**, the same kind of event a Foundry module can send. The name
comes from the cue's text:

| In the script | Event |
| --- | --- |
| `<!-- cue: Be Right Back -->` | `teleprompter:be-right-back` |
| `## Act Two` | `teleprompter:heading:act-two` |

Two ways to make a rule set for a cue:

- **From the script.** Open **Events** in the editor (the list beside the text). Each line has **Create rule**: it adds a
  rule set that already listens for that event, named after the cue, and opens it on the Automations page in Showrunner so
  you can add its steps (switch the scene, show or hide a source, start or stop recording, and so on). A line that already
  has a rule set shows **Rule set ✓** instead, and clicking it opens that rule set. **Show headings** turns the headings
  off in the list so a long script shows only its cues.
- **From the rule set.** On the **Automations** page (left rail, under Recording), the event box of any rule set suggests
  the script's events as you click or type in it, along with events that arrived recently. You can still type any name.

Every cue also appears in the Status page's activity log as it fires, so you can check the
names before writing a rule.

A few things to know:

- Scrolling back up and reading a cue again fires it again.
- Jumping with a heading key, the Top key or a long drag does not fire the cues you skipped; only the ones the reading line
  actually crosses fire.
- The names are the text lowercased, with anything that is not a letter or digit turned into a dash, cut to 36 characters.
  Two cues with the same text fire the same event.
- Nothing needs switching on for this. Cues reach rule sets inside the app. The **Events from Foundry modules** switch on
  the Automations page is only for game modules on another machine, and it opens a port on your network; leave it off if
  the teleprompter is all you use.

## Troubleshooting

- **"No script loaded":** choose a file on the Teleprompter page.
- **"Cannot find" or "Cannot read":** the file moved or is not readable; choose it again.
- **A cue never fires:** check its name in the Status log by scrolling past it, and make sure the rule set's event is
  spelled exactly the same.
