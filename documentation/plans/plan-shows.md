# Shows: one app, many kinds of recording

**Audience:** whoever builds 0.4.0 and 0.4.1, and anyone reviewing the direction before code starts.

## The problem

Showrunner grew up around one use: recording a D&D session. The code is more generic than that (Session
fields are user-defined, windows have no assumed URL, filenames come from a template), but the app has
one global setup. Someone who records D&D one night, a GTA livestream the next, and a product review
after that has to rewire windows, fields, automations, OBS and YouTube by hand each time.

## The idea

A **show** is a saved bundle of everything that changes between kinds of recording. One show is active.
Switching the active show swaps the setup, including the OBS profile and scene collection.

"Session" stays the word for one recording and for the Session page. The cookie-sharing "session group"
on windows is renamed **Login group** in the UI so the two meanings stop colliding. It is a label
change only; saved configs keep their field names.

## What belongs to a show

- Name.
- Session fields and the recording filename template.
- Windows, their sources and regions, and each window's audio-wake setting.
- Automation rules.
- Chameleon: which users and rooms feed this show.
- OBS profile (stream key, encoder, output settings), optional.
- OBS scene collection (scenes and sources), optional.
- YouTube channel and defaults (category, privacy, playlist, title and description templates).

## What stays global

- The OBS connection.
- The list of connected YouTube channels (the login itself).
- The Chameleon connection and credentials.
- App preferences.

## Explicit enable switches

Every optional piece has its own on/off toggle: Chameleon, Automations, the OBS profile switch, the OBS
scene collection switch, YouTube defaults, and each window. An empty field means "not set up yet". A
disabled piece keeps its settings and does nothing. The sidebar hides a disabled integration.

## Switching shows

1. The user picks a show in the sidebar picker.
2. A confirmation names the show, the OBS profile, the OBS scene collection and the YouTube channel,
   and says the current scenes close but are not deleted.
3. If OBS is streaming or recording, the switch is blocked with an explanation and an offer to stop
   first. OBS may refuse a profile change while active anyway.
4. If OBS is not connected, only the app's own settings change, and the message says OBS was left alone.
5. OBS profile and scene collection are set with separate websocket calls, so a failure on one is
   reported without hiding the other.
6. After the scene collection changes, Showrunner syncs the show's windows, regions and Chameleon
   sources into it, so they exist in the collection the show owns.
7. "Don't ask again" skips the confirmation only when nothing is recording.

## YouTube per show

Several channels can be connected at once. Each show picks one. A show with no channel set cannot upload
or edit YouTube metadata. The existing login becomes the first connected channel and the migrated D&D
show points at it.

## Picker visibility

The picker is hidden until a second show exists, so single-show users see no change.

## Migration

Config version 12 to 13. A `shows` list and an `activeShow` id are added. Existing windows, Session
fields, filename template, automations and Chameleon settings move into one show named "D&D". The
existing YouTube login becomes the first connected channel. Nothing is deleted; fields that stay global
keep their current place.

## Releases

- **0.4.0, shows foundation:** show list and picker, per-show windows, Session fields, filename template
  and automations, enable switches, the Login group rename, migration to version 13.
- **0.4.1, show setup and backups:** OBS profile and scene collection switching with the confirmation
  flow, multiple YouTube channels and per-show YouTube defaults, templates for D&D, Livestream and
  Podcast, and the backups described below.
- **Later:** neutral wording for Automations and the Foundry copy, and a Chameleon workspace-sharing
  source (a whiteboard or document shared into a show) once that module exists.

## Decisions

- **Duplicate show** copies everything, including windows and regions.
- **Session field values** belong to the show. Each show keeps its own counters and text, so switching
  away and back leaves the D&D show at its last season and episode. Prompt fields keep their existing
  behaviour of clearing after use.
- **A source that cannot be created** during the sync after a switch is still created in OBS and is
  marked failed. It shows red in the Windows list, and the window's page says what went wrong, the same
  way a disconnected source looks today.

## Backups

Moving to version 13 rewrote the config in a format older builds cannot read, and the only safety
net was a hand-made copy. 0.4.1 adds backups so that no format change can lose a setup.

- **Automatic backup before a migration.** The first time a new version changes the config format, the
  old files are copied into a dated folder next to the config (for example
  `backups/config-v13-2026-11-19.json`) before anything is rewritten. This comes first.
- **Back up now.** A button on Configuration that makes the same kind of copy on demand.
- **Restore.** A list of backups with a Restore button. A restore first backs up the current
  settings, so it cannot be a one-way trip, and warns that it replaces the current setup.
- **Show in Finder.** Opens the backups folder.
- **What is included:** `config.json` and the files holding the passwords, certificates and
  recordings list. The browser cache is not.
- **Later:** export and import a single show, which also makes shows shareable.

## 0.4.0 as built

- The app still reads one flat config. `project()` and `fold()` in `src/config.js` turn the stored list
  of shows into the active show's flat config and back, so the code that reads windows, Session fields
  and rules did not change.
- Chameleon and Automations are split between global and per show. Global: the Chameleon address,
  login and source sizes, and the Automations port and token. Per show: whether each is enabled, the
  rule sets, and the Chameleon space and per-player source choices.
- Switching a show closes the old show's windows, starts the new one's and re-syncs OBS. Sources that
  the old show made stay in OBS. OBS profile and scene collection switching, and the warning that goes
  with it, belong to 0.4.1.
- A new show starts empty. Duplicate copies everything. A version 12 file becomes one show named
  "D&D"; a fresh install starts with one named "My Show".
- The enable switches in 0.4.0 are the ones that already existed: each window's Start on launch,
  Automations and Chameleon. The OBS switch and YouTube defaults get theirs in 0.4.1.
- The cookie-sharing "session group" is now called "login group" in the UI and docs. The config field
  is still `session`.
