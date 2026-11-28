# Showrunner Recorder on Windows: plan

**Audience:** anyone deciding how the built-in recorder should work on Windows, and the developers building it.

Status: planned, nothing built. The recorder shipped for Mac in 0.5.0.

## What carries over unchanged

The windows, the layouts, fit and fill, pictures as sources, the webcam and its green screen and blur, the audio mixing and the
level meters, the toolbar, Calibrate's measuring code, the settings and profiles. All of it is plain Electron and web code.

## What is Mac-only today, and what Windows needs

| Piece | On Mac | On Windows |
|---|---|---|
| Video encoder | h264_videotoolbox, x264 as fallback | NVENC first (h264_nvenc), then QuickSync (h264_qsv) and AMF (h264_amf), x264 as fallback |
| ffmpeg | our own GPL build, made in CI and bundled | a pinned prebuilt GPL build, copied to our own release and bundled (see below) |
| Window picture | Screen recording (needs permission) or Built-in snapshots | Screen recording (needs no permission) or Built-in snapshots |
| Permissions | Camera, Microphone, Screen Recording, one shared question each | Camera and Microphone privacy switches only; no Screen Recording |
| Menu bar and dock | menu bar icon with a badge and time; dock card | system tray icon and menu; taskbar overlay badge while recording; no dock |
| Timing constants | `VIDEO_DELAY_MS`, `SCREEN_LATENCY_MS` measured on Mac | measured again on Windows |
| Signing | ad hoc | unsigned installer for now (SmartScreen warns); signing is its own project |

## Decisions already made

- **Test on a real PC with an NVIDIA card.** NVENC is the first hardware encoder; QuickSync and AMF come after a machine with them
  is available. Until then they are tried by the same Automatic rule and fall back to software if they stall.
- **ffmpeg: a pinned prebuilt GPL build, mirrored.** Choose one release build that already includes NVENC, QuickSync, AMF and x264
  (the BtbN GPL builds are the usual choice), pin its exact version and SHA-256 in `scripts/ffmpeg/`, copy it into our own release
  (like `ffmpeg-7.1.5-r1`), and bundle that copy. We offer the source the same way as on Mac (`THIRD-PARTY-NOTICES.md`). If it
  ever stops being suitable we can build our own as on Mac.
- **Encoder: Automatic.** Try the hardware encoder for the card found, switch to software if the pipe backs up. Keeps the
  Automatic / Hardware / Software choice.
- **Window picture default on Windows: Screen recording, if it tests well.** Otherwise Built-in snapshots until it does.
- **Names stay the same on both platforms.** Only the line under the choice changes (already done: no permission sentence off Mac).

## Phases

1. **Spike on the PC (measure before building).**
   - Can Electron's window capture (`desktopCapturer` with a window source) record Showrunner's own windows at 30 and 60 fps, also
     when the window is partly covered, and what does it do when the window is minimised?
   - Which ffmpeg encoders open, and how fast is each (`h264_nvenc` with a realtime preset, then `x264 -preset veryfast`)?
   - Does raw pictures on stdin plus raw sound on a fourth pipe work on Windows (Node's `stdio` handles differ from Mac), or must the
     sound go over a named pipe or a second input?
   - How late is the webcam and the screen capture against the sound? That gives the Windows values for the timing constants.
2. **Encoder and ffmpeg.** Add NVENC (then QSV, AMF) to `buildArgs` and the Automatic rule; fetch and bundle the Windows ffmpeg in the
   Windows CI job (checksum-checked, like Mac); the "ffmpeg is in the app" check step.
3. **Capture.** Make Screen recording work on Windows (no permission step); keep Built-in snapshots as the fallback; Calibrate's
   permission check stays Mac-only.
4. **Controls.** Tray menu with Start/Stop, Pause/Resume and Show/Hide toolbar; recording state in the tray tooltip and a taskbar
   overlay badge; the dock card is Mac and stays so. The toolbar already works on both.
5. **Test and tune.** Short test, Calibrate, then the same 30-minute test in a busy Foundry scene; fix what shows up.
6. **Release.** A version bump PR and a tag, as for 0.5.0. Note in the changelog that the Windows installer is unsigned.

## How the work is split

- The plan and the shared code are written on the Mac; a Claude Code session on the PC does the spike, runs the app from source
  (`npm install`, `npx electron .`), and reports or commits to a separate branch. Two sessions never edit the same branch at once.
- Each phase ends with something runnable on the PC and the Mac both, and the Mac behaviour must not change.

## Open questions

- Does Windows capture show the window when it is behind other windows, or must it be on top (as on Mac)? Phase 1 answers this.
- Windows audio devices: does "Echo cancel" behave the same, and does the BRIO microphone label differ? Phase 1 answers this.
- Signing the Windows installer: separate project ("App signing for Apple and Windows"), not part of this work.
