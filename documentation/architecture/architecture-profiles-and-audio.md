# Profiles, Backups and Audio Leveling Architecture

**Audience:** developers changing how Showrunner stores a setup per kind of recording, switches OBS with it, or
levels the participants' audio.

How these parts are built and why. What they do for a user is in
[Settings, windows and the edge dock](../userguides/userguide-settings.md) and
[Coffee Pub Chameleon in OBS](../userguides/userguide-chameleon.md); the design history and the OBS findings that
shaped them are in [plan-profiles](../plans/plan-profiles.md).

## One flat config, stored as profiles

The file holds global fields plus a `profiles` list and an `activeProfile` id (configuration version 15; the shape
is in [Configuration file reference](../userguides/userguide-configuration.md)). The rest of the app does not know
that. `project(stored)` in `src/config.js` builds the flat config of the active profile, and `fold(stored, flat)`
writes an edit of that flat config back into the active profile and the global part. `ConfigStore.get()` returns the
projection and `save()` folds, so the code that reads windows, Session fields and rules never changed when profiles
arrived.

Which field is global and which belongs to a profile is a list, not a convention: `profileFromFlat` and
`globalFromFlat` name every field, and `TAVERN_PROFILE_KEYS` and `YOUTUBE_PROFILE_KEYS` split the two integrations
that are partly each. The Chameleon address and login, the YouTube login, the OBS connection, the dock and the
preferences are global; windows, Session fields, the filename format, rule sets, the Chameleon space, per-player
choices and level settings, the integration switches and the OBS pins are per profile. A new per-profile field has to
be added to the list or it will be saved globally.

`ConfigStore` also owns the profile operations (`createProfile`, `duplicateProfile`, `renameProfile`,
`deleteProfile`, `switchProfile`, `setProfileIntegration`) and every format change. A file with an older `version`
is converted in `load()` (version 12 becomes one profile named "D&D"; version 13's `shows` become `profiles`; version
15 copies the old global `wakeAudioDelay` to each window as `wakeDelay`), and the constructor makes a backup before
the converted file is written.

## Switching a profile

`switchProfile` in `src/main.js` is the one path for a switch, and the `profiles:switch` handler asks
`confirmLeaveProfile` first, so anything that would surprise the user (OBS recording or streaming while OBS is about to
change profile) is confirmed before anything closes. `switchProfile` then closes the old profile's windows, saves the
switch, applies the new profile's OBS pins (a failure there is logged and does not stop the switch), connects or
disconnects Chameleon to match the new profile, restarts the Automations server, opens the new profile's windows,
rebuilds the tray, dock and menu, and schedules the OBS source sync, Chameleon sync and Auto level sync. Sources the
old profile made stay in OBS.

## OBS follows the profile

A profile's `obsPins` is `{ enabled, profile, collection }`. `planObsPins` compares them with what OBS reports,
`describeObsPlan` turns the plan into the sentence in the confirmation, `assertObsCanSwitch` refuses a change while
OBS is busy in a way the user did not accept, and `applyObsPins` calls `ObsBridge.setProfile` and
`setSceneCollection` and the source sync follows. OBS lets both change while recording, so
the guard is Showrunner's own, not OBS's. OBS cannot delete a scene collection remotely, which is why a test
collection has to be removed by hand.

## Backups

`src/backup.js` copies the settings files (the config, the secret and trust files, the Automations certificates, the
recordings list and the renamed-source list) into a dated folder under `backups/`. `create` runs before a migration
rewrites the file, on demand, and just before a restore; names carry milliseconds and the list is sorted by
creation time, so two backups in one second cannot collide and a prune can never delete the one just made. The newest
20 are kept and migration backups are never pruned. `restore` copies the files back and exits with `app.exit`, not
`quit`, because closing windows would otherwise save the old in-memory settings over the restored ones.

## Audio leveling

Three layers, each useful alone.

**Filter chain.** When a Participant source is created, `ObsBridge.addLevelingFilters` adds noise suppression
(`noise_suppress_filter_v2`, RNNoise), a compressor (ratio 4, threshold -22, attack 6, release 80, output gain 6) and
a limiter (threshold -3), skipping any kind the source already has. `tavern.audioFilters` turns it on for new sources;
**Add filters to existing sources** runs it over the ones that exist. It evens out one person and does not match
people to each other.

**Measuring.** OBS sends input level meters only to a client that asks, with the `InputVolumeMeters` event
subscription, so `ObsBridge.watchMeters` counts its users and re-identifies the connection when the first one
arrives and the last one leaves, and re-applies the subscription on a reconnect. For each input OBS reports, per
channel and about twenty times a second, `magnitude` (RMS after the volume fader), `peak` (after it) and `inputPeak`
(before it). `src/leveling.js` subtracts the fader setting from the magnitude to get a level that does not depend on
where the fader happens to be, so measuring twice gives the same answer (checked with a tone at -8, 0 and +6 dB).
It keeps frames above a -55 dB gate, takes the 75th percentile as how loud the person speaks (the louder part of
speech, not the pauses), needs about 20 frames or reports "no speech heard", and sets the volume to the target minus
that, held to -30 to +20 dB. A peak above -1 dB is flagged as clipping, which no volume setting fixes.

**Calibrate and Auto level.** Calibrate (`calibrateInputs`, the `tavern:calibrate` handler) collects meters for the
chosen seconds, applies and saves each volume as `levelDb` on the player's entry, and re-applies a saved `levelDb`
whenever a Participant source is created. Auto level (`src/autolevel.js`, `AutoLevelService`) keeps the meter
subscription on and, every two seconds, reconsiders each participant using the last eight seconds of speech above a
-48 dB gate (at least 25 frames). It ignores anyone within 1.5 dB of the target, moves a volume by 1 dB (3 dB when
more than 6 dB off), reads the fader every tick and holds off for 60 seconds on a person whose fader was moved by
hand, writes changed levels down every 20 seconds, and is paused while Calibrate runs. `syncAutoLevel()` in
`src/main.js` starts and stops it from the one place that knows the conditions: OBS connected, Auto level on for the
profile, Chameleon enabled. Both features read the same target, `tavern.levelTargetDb` (-40 to -6, default -20), and
only ever touch inputs `getPeople()` returns, which are the Participant sources of Chameleon people.

## The control panel's dropdown menu

The open list of a `<select>` is drawn by the system and cannot be styled, so a mousedown on any select opens
`.dropmenu` (the last block of `src/control/control.js`) instead. The select stays visible and stays the source of
truth: the menu sets `selectedIndex` and dispatches `input` and `change`, so handlers, labels and programmatic `.value`
writes are untouched, and selects created later (the Automations step editor builds many) need no setup.
