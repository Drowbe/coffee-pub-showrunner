# The Showrunner Recorder

**Audience:** anyone who wants to record Showrunner's windows without setting up OBS.

The Showrunner Recorder saves the pictures and sound of your Showrunner windows to an **MP4** file. It is on its own page, which appears under **Recordings** once you choose it
(under Recording in the left rail). OBS still works exactly as before: the Recorder page just says which of the two the Start, Pause
and Stop recording steps use for this profile.

## Set it up

1. Open **Recordings** and set **Records with** to **Showrunner Recorder**; its page appears just below.
2. Choose the **Window** to record. For two windows side by side, set **Layout** to *Two windows side by side* and choose a
   **Second window**.
3. Pick the **Size** (1920 x 1080 or 1280 x 720) and **Frames per second** (24, 30 or 60).
4. Choose where it **Saves to**. Empty means your Movies folder.
5. **Start recording.** The page shows the time and the file name; **Pause** and **Stop recording** are beside it.

The same Start, Pause, Resume and Stop recording steps in Automations (and the cues in your teleprompter script) work with the
built-in recorder: nothing in a rule set changes. Steps that need OBS (scenes, sources, text, volumes, Auto level) still need OBS.

## The toolbar

A small toolbar floats above your other windows while you record, with **Record**, **Pause** and **Stop**, the time, and a level slider, mute button and meter for each sound source. It opens by itself when a recording starts (untick **Show the toolbar when recording starts** on the recorder page to stop that), and **Show the toolbar** opens it any time. Drag it where you like; it remembers its place. It is never part of the recording.

## Webcam

Choose a **Layout** with the webcam: **One window, webcam in a corner** puts the webcam over a corner of the window (pick the corner and a size), and **Webcam fills the picture** records the webcam alone, with no window. The **Webcam** card shows a live preview and lets you pick the camera. macOS asks once whether Showrunner may use the webcam.

**Flip the webcam (mirror)** turns the webcam picture left to right, as a mirror would, in the preview and in the recording.

Webcams show your picture a little late. If your voice seems ahead of your lips in a test recording, raise **Match voice to webcam (ms)** on the Audio card (start around 100) to delay the microphone by that much.

## Audio

The **Audio** card on the Showrunner Recorder page has a row for each window and one for the microphone. The bars move **before you record** too, so you can check the sound is arriving: speak into the microphone, or play something in the window, and its bar should move. If a window's bar stays still while it is playing sound, Showrunner cannot copy that sound. Move the slider to set a level (100% is as it is) and press **Mute** to silence a source. Both work while recording, and the bars show what is going into the recording.

To record your voice, tick **Record the microphone** and pick the microphone. The first time, macOS asks whether Showrunner may use it; if you said no, allow it in System Settings, Privacy & Security, Microphone. Wear headphones, or your speakers will be heard on the microphone too. **Echo cancel** helps if you cannot. Everything is mixed into one sound track.

## What it records

- Each window's page as you see it, without the title bar. Windows must be open; docked windows record too.
- The sound each window plays, mixed into one track. Chameleon voices, Foundry sound and music are all included.
- Files are named `Showrunner 2026-11-21 14-05-30.mp4`. **Upload to YouTube** picks up the last recording from either recorder.

The file is written as you record, so memory stays flat however long the session is, and a crash loses only the last second or two.

## If something goes wrong

- **Low disk space.** The recorder will not start with less than 1 GB free. Below 3 GB it warns you, with roughly how many minutes are left, and below 0.3 GB it stops and keeps what it has.
- **Quitting while recording** finishes the file first.
- **A crash or power cut.** The file is written as it records, so it still plays, missing only the last second or two. The next time Showrunner starts it tells you where the file is.
- **Show in Finder** (on the recorder page and the toolbar) opens the folder with your last recording selected.

## Limits for now

- macOS only. Windows follows.
- The sound is one mixed track. Per-person tracks and leveling stay an OBS feature.
- No scenes, overlays or live streaming (use OBS for those). The microphone is not recorded yet.
- A page's sound is copied by a small script that runs in each window; it does nothing unless the recorder is recording.
- Sound lines up with the picture to about 20 ms.
