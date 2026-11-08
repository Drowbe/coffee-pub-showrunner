# Known Issues

**Audience:** anyone using Coffee Pub Showrunner who wants to know what is broken before reporting
it as new.

A defect is recorded here once it is confirmed -- either by watching it happen, or, for a gap this
unambiguous, by a plain reading of the code -- with a workaround if one exists, and moves to the
CHANGELOG once fixed.

## Windows OBS source management: tested on an earlier release

On macOS, Showrunner creates and maintains capture sources with OBS's `screen_capture` input and
points each at a window by its numeric system ID. Windows OBS has a different input kind,
`window_capture`, which identifies a window by a `Title:Class:Executable` string. Showrunner now asks
OBS which platform it is running on and uses the matching one: the same flow (list the windows OBS
offers, match by title, point the source, crop, scale, mute) with that input kind and that kind of
window value. The macOS behavior is unchanged.

It has been built against OBS's documented behavior and tested against a stand-in for OBS. It has
also been run on a real Windows machine, on an earlier release, and worked there. **It has not been
re-checked on 0.3.2.** Two details are worth confirming on any Windows machine, and the **Copy
capture report** button on the OBS card (Configuration tab) settles them in one go:

- What OBS actually returns for the window list on Windows (the label and value formats Showrunner's
  matching depends on).
- That a source set to "window title must match" really does capture nothing, rather than a
  different Showrunner window, when its own window is closed. Every Showrunner window shares one
  executable and one window class, so any looser matching could show the wrong window.

Display scaling on Windows has not been separately confirmed. Showrunner's size readout and the "scaled back
down" correction assume the capture is the window's size times the display's scale factor, which is
how a Retina display behaves on macOS; whether Windows display scaling behaves the same way is part
of what the report records.

If a source ends up pointing at the wrong window or none, the by-hand route still works: in OBS
add a **Window Capture** source under Sources, pick the window by its Showrunner-set title, and
re-pick it yourself if OBS ever loses track of it. Attach the capture report to any report of this.
