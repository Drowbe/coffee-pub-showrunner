# Profiles: one app, many kinds of recording

**Audience:** whoever builds 0.4.0 and 0.4.1, and anyone reviewing the direction before code starts.

## The problem

Showrunner grew up around one use: recording a D&D session. The code is more generic than that (Session
fields are user-defined, windows have no assumed URL, filenames come from a template), but the app has
one global setup. Someone who records D&D one night, a GTA livestream the next, and a product review
after that has to rewire windows, fields, automations, OBS and YouTube by hand each time.

## The idea

A **profile** is a saved bundle of everything that changes between kinds of recording. One profile is active.
Switching the active profile swaps the setup, including the OBS profile and scene collection.

"Session" stays the word for one recording and for the Session page. The cookie-sharing "session group"
on windows is renamed **Login group** in the UI so the two meanings stop colliding. It is a label
change only; saved configs keep their field names.

## What belongs to a profile

- Name.
- Session fields and the recording filename template.
- Windows, their sources and regions, and each window's audio-wake setting.
- Automation rules.
- Chameleon: which users and rooms feed this profile.
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

## Switching profiles

1. The user picks a profile in the sidebar picker.
2. A confirmation names the profile, the OBS profile, the OBS scene collection and the YouTube channel,
   and says the current scenes close but are not deleted.
3. If OBS is streaming or recording, the switch is blocked with an explanation and an offer to stop
   first. OBS may refuse a profile change while active anyway.
4. If OBS is not connected, only the app's own settings change, and the message says OBS was left alone.
5. OBS profile and scene collection are set with separate websocket calls, so a failure on one is
   reported without hiding the other.
6. After the scene collection changes, Showrunner syncs the profile's windows, regions and Chameleon
   sources into it, so they exist in the collection the profile owns.
7. "Don't ask again" skips the confirmation only when nothing is recording.

## YouTube per profile

Several channels can be connected at once. Each profile picks one. A profile with no channel set cannot upload
or edit YouTube metadata. The existing login becomes the first connected channel and the migrated D&D
profile points at it.

## The picker

The picker is always at the top of the sidebar, even with one profile, so it is clear which profile is
active. Its last entry, "Manage profiles...", opens a page of its own for creating, renaming, duplicating and
deleting profiles and for backups. Those apply to the whole app, so they do not sit on a page that belongs
to a profile.

## Migration

Config version 12 to 13 added a list of shows and an `activeShow` id, and 0.4.0 shipped that. Existing
windows, Session fields, filename template, automations and Chameleon settings moved into one show named
"D&D", and the existing YouTube login stays global for now. Nothing was deleted; fields that stay global keep
their current place.

The product calls these **profiles**: "show" implied making a show, when someone may be recording for a
website or a product review. Version 14 renames the stored keys, `shows` to `profiles` and `activeShow` to
`activeProfile`, and converts a version 13 file the first time the app starts. Like every format change it is
preceded by an automatic backup.

## Releases

- **0.4.0, profiles foundation:** profile list and picker, per-profile windows, Session fields, filename template
  and automations, enable switches, the Login group rename, migration to version 13.
- **0.4.1, profile setup and backups:** OBS profile and scene collection switching with the confirmation
  flow, multiple YouTube channels and per-profile YouTube defaults, templates for D&D, Livestream and
  Podcast, the backups described below, the audio actions in "Local sources and audio", and the first two steps of "Audio leveling".
- **Later:** neutral wording for Automations and the Foundry copy, and a Chameleon workspace-sharing
  source (a whiteboard or document shared into a profile) once that module exists.

## Decisions

- **Duplicate profile** copies everything, including windows and regions.
- **Session field values** belong to the profile. Each profile keeps its own counters and text, so switching
  away and back leaves the D&D profile at its last season and episode. Prompt fields keep their existing
  behaviour of clearing after use.
- **A source that cannot be created** during the sync after a switch is still created in OBS and is
  marked failed. It shows red in the Windows list, and the window's page says what went wrong, the same
  way a disconnected source looks today.

## Local sources and audio

Showrunner does not set up cameras, capture cards or microphones. OBS does that better, with its own
filters and per-device settings, and a profile's pinned scene collection carries whatever the user
set up there. Video into a profile comes from Chameleon, application windows or web windows.

What the automations lack is control of audio. They can show, hide and toggle any source, but they
cannot mute or unmute an OBS audio source or change its volume, although the OBS connection already
mutes an input internally. Planned:

- **Audio actions:** mute, unmute and toggle mute for any OBS audio source, and set its volume. They use
  the same source picker the other source actions use.

Considered and not committed: an action that turns a named OBS filter on or off, and a per-profile list
of expected OBS sources with a found or missing status.

## Audio leveling

OBS has no loudness normalization. Its filters shape one source at a time, but nothing balances several speakers
against each other, so each person's volume is adjusted by hand: mic level, distance and room all differ. Three
fixes, in this order, each useful on its own.

1. **A standard filter chain on every participant.** When Showrunner creates a Chameleon participant source in
   OBS, it also adds noise suppression, a compressor with makeup gain, and a limiter, in that order, using the
   same OBS call that adds the crop filter today. The compressor evens out loud and quiet moments within one
   person. It does not balance people against each other. The chain is on by default and can be turned off, and a
   source that already has filters of those kinds is left alone.
2. **Calibrate and keep leveled.** OBS reports a live level for every audio source and Showrunner can set each
   source's volume.
   - **Calibrate:** a button on the Chameleon page. Everyone talks for about ten seconds, Showrunner measures each
     person's level during speech only, and sets each source's volume to reach one target level. The volume is
     saved with the participant, so calibration is a one-time job per person.
   - **Keep leveled:** an optional per-profile switch that nudges each volume slowly while the person is speaking,
     within a limited range, and never during silence. It cannot fix a microphone that is clipping, and it says
     so when it sees clipping.
   - **Target level and range** are settings, with sensible defaults.
3. **What Chameleon already does.** Its microphone capture has the browser's automatic gain control, noise suppression
   and echo cancellation on by default, per person, plus a Mic level slider that can boost; see "Audio leveling: as built
   and what Chameleon does" below. Showrunner builds nothing here; steps 1 and 2 cover what the built-in processing does
   not.

Open: whether a continuous Keep leveled mode is worth building on top of Calibrate, whether it should also apply to sources that are not Chameleon participants, and whether the standard filter chain's settings should be editable.

## Audio leveling: as built and what Chameleon does

- **Calibrate** is built (`src/leveling.js`, `collectMeters` in `src/obs.js`, the Level the participants card). OBS
  sends level meters only to a client that asks, so Showrunner subscribes for the length of a calibration and no
  longer. OBS's "magnitude" is an RMS level taken after the volume fader and its "input peak" is taken before it, so
  the fader setting is subtracted to get a level that does not depend on it (verified: a tone reads the same at -8, 0
  and +6 dB). Per person, the loudest quarter of the frames above a -55 dB gate is taken as how loud they speak;
  fewer than about a second of speech is "no speech heard". The volume is the target minus that, limited to -30 to
  +20 dB. The result is saved as `levelDb` on the player's entry and re-applied when a Participant source is created.
- **People grouped.** The Participants and Characters lists became one list of people: a box each, with a header for what
  is true of the person (online, name, camera, mic, level, room) and one plain row per source. Nothing was dropped from the
  old rows; the mic, camera and room moved up because they belong to the person, not to a source.
- **Auto level** (the "Keep leveled" idea, now built; `src/autolevel.js`): a per-profile switch (`tavern.autoLevel`) beside the card
  title. It keeps a shared meter subscription on (`ObsBridge.watchMeters`, counted so Calibrate and Auto level can
  overlap and a reconnect restores it) and, every two seconds, reconsiders each participant using the last eight seconds of
  speech above a -48 dB gate (at least about 1.25 s of it). It moves a volume by at most 1 dB, or 3 dB when more than 6 dB
  off, ignores anyone within 1.5 dB of the target, reads each fader every tick and holds off for 60 s on a person whose
  fader was moved by hand, and writes changed levels down every 20 s. Calibrate pauses it. The target is the same slider
  Calibrate uses (`tavern.levelTargetDb`, -40 to -6, default -20).
- **What Chameleon does** (from the Chameleon project, read from its code, not run): it does not rely on LiveKit's own
  capture defaults. It opens the microphone itself with `noiseSuppression`, `echoCancellation` and `autoGainControl`,
  all on by default and each a per-person setting, so the browser's gain control is on unless someone turns it off.
  The microphone then goes through a gain node (the "Mic level" slider, 0 to 3.0x, default 1.0, applied before it is
  published) and a noise gate. Playback volume in Chameleon can only reduce, never boost. It ships `livekit-client`
  2.22.3. So a very quiet person can be raised in two places, their own Mic level in Chameleon or Calibrate in OBS,
  and Calibrate's "raise their mic level" message points at the first.

## Backups

Moving to version 13 rewrote the config in a format older builds cannot read, and the only safety
net was a hand-made copy. 0.4.1 adds backups so that no format change can lose a setup.

- **Automatic backup before a migration.** The first time a new version changes the config format, the
  old files are copied into a dated folder next to the config (for example
  `backups/config-v13-2026-11-19.json`) before anything is rewritten. This comes first.
- **Back up now.** A button on the Manage profiles page that makes the same kind of copy on demand.
- **Restore.** A list of backups with a Restore button. A restore first backs up the current
  settings, so it cannot be a one-way trip, and warns that it replaces the current setup.
- **Show in Finder.** Opens the backups folder.
- **What is included:** `config.json` and the files holding the passwords, certificates and
  recordings list. The browser cache is not.
- **Later:** export and import a single profile, which also makes profiles shareable.

## 0.4.0 as built

- The app still reads one flat config. `project()` and `fold()` in `src/config.js` turn the stored list
  of profiles into the active profile's flat config and back, so the code that reads windows, Session fields
  and rules did not change.
- Chameleon and Automations are split between global and per profile. Global: the Chameleon address,
  login and source sizes, and the Automations port and token. Per profile: whether each is enabled, the
  rule sets, and the Chameleon space and per-player source choices.
- Switching a profile closes the old profile's windows, starts the new one's and re-syncs OBS. Sources that
  the old profile made stay in OBS. OBS profile and scene collection switching, and the warning that goes
  with it, belong to 0.4.1.
- Feedback after the 0.4.0 release changed the layout in 0.4.1: the picker is always visible, and the
  Profiles card moved from Configuration to the Manage profiles page, with Backups.
- A new profile starts empty. Duplicate copies everything. A version 12 file becomes one profile named
  "D&D"; a fresh install starts with one named "My Profile".
- The enable switches in 0.4.0 are the ones that already existed: each window's Start on launch,
  Automations and Chameleon. The OBS switch and YouTube defaults get theirs in 0.4.1.
- Rail order: the app's own pages (Status, Preferences) sit above the profile picker because they do not follow
  the profile; below it come Recording (OBS before Session, since Session depends on it), Integrations and Windows.
  About moved into Status and Reset & Diagnostics into Preferences. An integration's switch sits beside its title.
- Switches are for turning a whole feature on or off, which today means the three integrations. 0.4.1 first
  restyled every checkbox as a switch; that went too far and ordinary options are checkboxes again. A switch is
  opted into with `class="switch"`.
- The word "show" shipped in 0.4.0 and was renamed to "profile" in 0.4.1 after feedback; the stored keys
  changed with the version 14 migration.
- Integration switches are per profile: Chameleon, Automations and YouTube each have one, shown on the Manage
  profiles page for every profile and at the top of the integration's own page for the active one. YouTube's was
  global in 0.4.0; a profile saved without its own inherits that value. The login and defaults remain global.
- The cookie-sharing "session group" is now called "login group" in the UI and docs. The config field
  is still `session`.

## 0.4.1 as built so far

- **Backups** (`src/backup.js`): a dated folder under `backups/` in the settings folder, holding the
  config, the secret and trust files, the Automations certificates, the recordings list and the
  renamed-source list. One is made before a config migration rewrites the file, on demand, and just
  before a restore. A restore copies the files back and restarts the app with `app.exit`, not `quit`, so
  closing windows cannot save the old in-memory settings over the restored ones. The newest 20 are kept;
  migration backups are never pruned.
