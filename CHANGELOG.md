# Changelog

All notable changes to Coffee Pub Showrunner. Versions follow the Git tags; each release has a macOS
installer and a Windows installer on the [Releases page](https://github.com/Drowbe/coffee-pub-showrunner/releases).

The app has had three names: **Coffee Pub Browser**, then **Coffee Pub Studio** (0.1.9), then **Coffee Pub
Showrunner** (0.3.0). Its Chameleon integration was called the **Tavern** until 0.3.2. Entries use the name
in use at the time, except where noted.

Releases 0.1.5 to 0.1.8 were never tagged; their changes are listed under 0.1.9.

## Unreleased

- **Built-in recorder (Mac).** A new Recordings page chooses what records for the profile: OBS, or Showrunner itself, which saves
  one window, or two side by side, with their sound to an MP4 (H.264 and AAC, 1080p or 720p, up to 60 fps), with pause. The Start,
  Pause, Resume and Stop recording steps work with either. The file is written as it records. See
  `documentation/userguides/userguide-recorder.md`.
- **Showrunner Recorder audio.** Record the microphone with the windows' sound. Each window and the microphone has its own level
  and mute, which you can change while recording, with live meters. Recordings are named from the Session filename format.
  **Webcam:** two new layouts, a window with the webcam in a corner (any corner, three sizes) and the webcam filling the picture
  (no window needed), with a live preview and a camera picker.
  **Recording toolbar:** a small window that floats above everything with Record, Pause, Stop, the time, and a level, mute and
  meter for each sound source. It opens when a recording starts (switch off on the recorder page) and is never in the recording.
  **Live preview:** the recorder page shows the picture as it will be recorded (windows and webcam in their places), drawn by the
  same code the recorder uses.
  **Safety:** the recorder will not start with under 1 GB free, warns below 3 GB (with minutes left), and stops cleanly, keeping the
  file, before the disk is full. Quitting during a recording finishes the file first. If the app is ever killed mid-recording, the
  file still plays and the next launch says where it is. **Show in Finder** on the recorder page and the toolbar.
  The left rail scrolls when it is long, and long names show "..." with the full name on hover.
- Recording and streaming actions now go through a recording backend (`src/recording.js`); OBS is the first backend.

## 0.4.9 -- 2026-11-20

### Fixed
- **Window names in the left rail.** With a long window name and the two icons beside it, the status dot shrank away and the name ran into the icons; the name now ends with an ellipsis and the dot stays.

### Changed
- **Screenshots.** New pictures of the teleprompter (the window, the editor with its Events list, the page and its scripts), and refreshed Automations and window pages that show the new left rail and header.

## 0.4.8 -- 2026-11-20

### Added
- **Teleprompter actions for Automations.** Rule set steps (and `POST /api/automations/action`) can start, pause or toggle the scroll, change the speed, jump to the next or previous heading, or go back to the top, so a cue can start the scroll or a scene change can slow it. They need the teleprompter window open.
- **Teleprompter editor.** An always-visible status bar along the bottom, styled like the control panel's (the cue just crossed, scrolling, speed changes, script reloads, the rule set an event is running, held until it finishes (with a countdown during a delay), Unsaved and File saved while editing, and the script's name), **Events** moved after **Insert cue** behind a divider, the cue or heading under the caret highlighted in the Events list, and a **Delete** button on each event that removes it from the script (undo with Cmd/Ctrl+Z).
- **Teleprompter scripts and a load-a-script step.** The Teleprompter page now holds the profile's **Scripts**: Add script... or New... put a file on the list, one is the **Start Up** script (the window always opens with it), and each row can Show now, Make Start Up or Remove. A new **Teleprompter: load a script** step picks a script from that list, or `Start Up`, or Browses for a file (which joins the list), so a show can run in segments: a cue ends a script, a rule set switches the scene and loads the next one. A loaded script is shown for now only. The editor's File menu lists the same scripts.
- **Teleprompter page and shortcuts.** The page now runs Teleprompter, Cues, Reading, then a **Scripts** card of its own, whose rows can be reordered with arrows (the order is for reading only). The same arrow icon sits beside Teleprompter in the left rail and opens or closes the window.
- **Windows are controlled from the left rail.** Each window under Windows has a restart icon (it starts a stopped window) and an arrow icon that shows the window on the desktop or docks it, starting it first if it is stopped. The same two icons sit beside the **Windows** heading for every window: restart all (it asks first), and dock or show all. The header's Start All, Stop All, Dock Windows and Teleprompter buttons are gone; the header now has **Hide** (hides the panel only, so every window keeps running) and **Quit**. Start All and Stop All stay in the menu bar menu and as Automations steps.
- **Cues fire at the middle of the line.** A cue or heading now counts as reached when the reading line is through the middle of it, not when its top edge touches the line, and Next/Previous heading rests it there.
- **File pickers in rule set steps.** Browsing for a file in a Set text step, a YouTube video step, or the new load-a-script step could save the path to an out-of-date copy of the step and show the box empty again; fixed.
- **Rule set groups can be switched on and off.** Above the Rule sets on the Automations page, one chip per group (and "No group") shows or hides that group's rule sets; the choice is remembered. Rule sets made with **Create rule** in the teleprompter editor now go in a **Teleprompter** group.

## 0.4.7 -- 2026-11-20

### Added
- **Teleprompter window.** A presenter-only window, never an OBS source, that shows a Markdown file, resizable by dragging, with
  auto-scroll or manual scrolling, text size, mirror and a reading line. Saving the file reloads it. A heading, or a
  `<!-- cue: Name -->` line, fires an Automations event (`teleprompter:name` or `teleprompter:heading:name`) when
  the reading line reaches it, so rule sets can change scenes from the script. It has its own **Teleprompter** page under
  Recording, one per profile, and is not a capture window. Bundles `marked` (MIT) to read Markdown. **New...** on the Teleprompter page creates a script file. In the window, **Edit** (or E) edits the script in place with a formatting bar, using the rich Markdown editor from Chameleon (ProseMirror); only the blocks you change are rewritten. Cues show as chips there, with an **Insert cue** button, and are renamed by typing in them. A **File** menu in the edit bar holds **New** (a blank script), **Save as...** (a copy) and **Discard changes**; **Save** and **Done** stay on the bar. Save as saves a copy to a file you choose and uses it from then on, and pressing Edit with no file chosen starts a new script that asks where to save on its first Save. An **Events** panel lists every heading and cue with the Automations event it fires, with jump and copy, and flags duplicates.
- **Rule sets from the script.** The Events list in the teleprompter editor has a **Create rule** button on every line that
  makes a rule set already listening for that event and opens it on the Automations page, or **Rule set ✓** when one exists.
  **Show headings** can hide the headings so a long script lists only its cues.
- **Event suggestions.** A rule set's event box suggests the teleprompter script's events and the events that arrived
  lately, as the Session page's Group box does with the groups you already have. Any name can still be typed.

### Changed
- **Automations is its own page, not a Foundry feature.** It now sits under Recording in the left rail and is always there:
  rule sets react to events from the teleprompter's cues, from game modules and from the test box. The Foundry listener
  (the port, token and certificate help, and the only part that opens a network port) moved to its own card, **Events from
  Foundry modules**, with its own switch, off by default. The page's help text now explains events in general, and Automations
  no longer appears under **Add integration**. The profile card's switch for it is called **Foundry events**.

## 0.4.6 -- 2026-11-19

### Added
- **Auto level.** A checkbox that keeps every Chameleon participant near the target level while a session runs: it
  acts only while a person is speaking, moves slowly, and leaves a volume alone for a minute after you move it
  yourself. It only ever changes the Participant sources of Chameleon people.
- **Target level slider** for leveling, with a strip under it in the colors of OBS's own meter (Quiet, Speech,
  Loud).
- **Session rail dot.** Green when every session field that needs a value has one, red (with the names in the
  tooltip) when something is blank. Prompt fields never count, and YouTube fields count only while YouTube is on for
  the profile.
- **Wake delay per window.** Each window now sets how long to wait after its page loads before waking its sound,
  shown under its **Wake audio after load** option. The configuration moves to version 15; the old global number is
  copied to every window, after an automatic backup.

### Changed
- The Chameleon page shows each person once: Participant and Character sources grouped in one box, with the online
  dot, camera, mic, level and room in a header. Camera and mic icons are always shown, slashed when off or offline.
- The leveling card is now the **Audio** card at the bottom of the Chameleon page. It holds the target slider,
  Manually calibrate, Auto-level, and the audio filter options (**Add filters to existing sources** is the new name
  of the old button).
- Every dropdown has a proper chevron and opens a menu in the app's own style, with keyboard support, instead of the
  system popup.
- Status and Preferences have icons in the rail. The Status page fills the window, with the connection log taking
  the free height.

## 0.4.5 -- 2026-11-19

### Added
- **Calibrate.** Listens to the Participant sources in OBS while everyone talks, measures how loud each person
  speaks, and sets each person's OBS volume so they all land at one target level. The volume is saved with the person
  and applied to a new source for them.

## 0.4.4 -- 2026-11-19

### Changed
- The selected tab in the rail is marked by a clearer highlight instead of a teal edge bar.

## 0.4.3 -- 2026-11-19

### Fixed
- The YouTube dot in the rail now follows the connection, and each integration's state is drawn at startup.

### Changed
- Screenshots replaced with ones of the current layout.

## 0.4.2 -- 2026-11-19

### Added
- **OBS follows the profile.** A profile can pin an OBS profile and a scene collection; switching Showrunner profiles
  switches OBS, after a warning if OBS is recording or streaming. **Apply now** and a per-profile switch are on the
  OBS page.

### Changed
- Switches are used only to turn a feature on or off; other options are checkboxes. Renaming a profile saves with
  Enter and says so.

## 0.4.1 -- 2026-11-19

### Added
- **Backups.** Settings are backed up automatically before any format change, and on demand from the Manage
  profiles page, with restore (which backs up first).
- **Manage profiles page** and an always-visible profile picker in the rail; profiles can be renamed. Shows are now
  called profiles, which moves the configuration to version 14.
- **Per-profile integration switches** for Chameleon, Automations and YouTube.
- **Audio filter chain** for new Chameleon participants: noise suppression, a compressor and a limiter.
- **Audio actions** for Automations: mute, unmute, toggle mute and set volume.

### Changed
- The Configuration page is split into pages in a grouped left rail.

## 0.4.0 -- 2026-11-19

### Added
- **Profiles** (first called shows): a saved setup for each kind of recording, holding its windows, session fields,
  filename format, Automations rules and Chameleon settings. Configuration version 13.

## 0.3.4 -- 2026-11-19

### Changed
- Electron updated to 45.4.1.

## 0.3.3 -- 2026-11-19

### Changed
- The control panel moves from top tabs to a grouped side navigation.
- New screenshots, with faces, names and addresses redacted.

## 0.3.2 -- 2026-11-07

### Added
- Quit button in the control panel header.
- A proprietary, free-to-download license.

### Changed
- The app moves from brown to the Coffee Pub dark blue; the coloured brand mark is used in the header and dock; the
  header fonts (Fraunces and Figtree) are bundled; the macOS icon is layered and follows the system appearance.
- Tavern is renamed Chameleon in the visible text, and the user guide follows.

## 0.3.1 -- 2026-11-07

### Changed
- The new Showrunner mark and the new repository name.

## 0.3.0 -- 2026-11-06

### Changed
- The app is renamed **Coffee Pub Showrunner**.

## 0.2.11 -- 2026-10-15

### Added
- OBS window sources can be managed on Windows.

## 0.2.10 -- 2026-10-15

### Changed
- The status bar shows one non-wrapping upload line; build details move to About.

## 0.2.9 -- 2026-10-14

### Added
- Before a new session starts, the app asks what to do with a recording that was never uploaded.

## 0.2.8 -- 2026-10-14

### Added
- The last recording and what has uploaded are remembered across restarts.

## 0.2.7 -- 2026-10-14

### Added
- YouTube upload progress shows in the footer on every tab.

## 0.2.6 -- 2026-10-14

### Fixed
- The app says plainly when the saved YouTube sign-in has expired.

## 0.2.5 -- 2026-09-25

### Changed
- The app icon is full-bleed art.

## 0.2.4 -- 2026-09-25

### Added
- Support for Chameleon's two-step sign-in.

## 0.2.3 -- 2026-09-24

### Changed
- Reads Chameleon's renamed fields, falling back to the old names.

## 0.2.2 -- 2026-09-22

### Changed
- New wordmark and app icon; the menu bar icon stays a template image.

## 0.2.1 -- 2026-09-22

### Fixed
- `GET /capabilities` no longer lists a Prompt field that has already been answered.

## 0.2.0 -- 2026-09-22

### Added
- Herald text sources, session metadata defined in the app (including Prompt fields), YouTube upload, app-window
  capture, conditional rule steps, and notifications.

## 0.1.11 -- 2026-09-16

### Added
- **Automations** rebuilt as named, sequenced rule sets, with Studio Control actions and a live OBS Control card.
- An Automations tab for events from game modules, and Window and Region OBS audio that follows each window's
  **Mute audio**.

### Changed
- Windows support documented, including the gap in managing OBS sources there.

## 0.1.10 -- 2026-09-16

### Added
- Asides, Private Conversations and room-profile gating for the Tavern.

## 0.1.9 -- 2026-09-12

### Added
- **Tavern** integration: each player and character can be published as its own OBS Browser Source, with a talking
  border and indicator, a room chooser, and a follow-the-admin mode.
- **Edge dock** with parking, live thumbnails and an expanding pill; windows park off a free display edge.
- **Wake audio** for game pages that stay silent until clicked: a delay setting, a dock button, and a middle-click
  that waits for the page to be ready.
- Windows installer build alongside the macOS one.
- Retina option that scales the app's sources in OBS; window bar, login groups, per-window start switches, region
  cards, and a remembered display for auto-arrange.
- The app is renamed Coffee Pub Studio.

## 0.1.4 -- 2026-09-10

### Added
- Named regions, each a cropped OBS source.

## 0.1.3 -- 2026-09-10

### Added
- OBS WebSocket integration.

## 0.1.2 -- 2026-09-10

### Added
- First release, as Coffee Pub Browser: an Electron wrapper for capturing FoundryVTT windows in OBS, with up to five
  windows and a macOS installer published to GitHub Releases.
