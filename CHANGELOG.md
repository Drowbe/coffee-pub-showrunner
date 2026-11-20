# Changelog

All notable changes to Coffee Pub Showrunner. Versions follow the Git tags; each release has a macOS
installer and a Windows installer on the [Releases page](https://github.com/Drowbe/coffee-pub-showrunner/releases).

The app has had three names: **Coffee Pub Browser**, then **Coffee Pub Studio** (0.1.9), then **Coffee Pub
Showrunner** (0.3.0). Its Chameleon integration was called the **Tavern** until 0.3.2. Entries use the name
in use at the time, except where noted.

Releases 0.1.5 to 0.1.8 were never tagged; their changes are listed under 0.1.9.

## Unreleased

### Added
- **Teleprompter window.** A presenter-only window, never an OBS source, that shows a Markdown file, resizable by dragging, with
  auto-scroll or manual scrolling, text size, mirror and a reading line. Saving the file reloads it. A heading, or a
  `<!-- cue: Name -->` line, fires an Automations event (`teleprompter:name` or `teleprompter:heading:name`) when
  the reading line reaches it, so rule sets can change scenes from the script. It has its own **Teleprompter** page under
  Recording, one per profile, and is not a capture window. Bundles `marked` (MIT) to read Markdown. The page has a script editor: write or change the Markdown in the app, insert a cue line at the cursor, and see the Automations event each heading and cue will fire. **New...** creates a script file. In the window, **Edit** (or E) edits the script in place with a formatting bar, using the rich Markdown editor from Chameleon (ProseMirror); only the blocks you change are rewritten. Cues show as chips there, with an **Insert cue** button, and are renamed by typing in them.

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
