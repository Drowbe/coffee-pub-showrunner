# Settings, windows and the edge dock

**Audience:** anyone setting up windows, the edge dock, keyboard shortcuts, or Retina display
handling in Coffee Pub Showrunner.

## The control panel

The control panel has a **Session** tab (layout, the edge dock, OBS connection and login), a
**Chameleon** tab when Coffee Pub Chameleon is enabled, and one tab per window with its whole-window
source and its regions; every window's own tab has a **Delete window** button. Reopen the panel
with **Cmd+0** or by clicking the Dock icon after closing it -- the app keeps running in the
background so OBS keeps its sources. Quit with **Cmd+Q**.

## Adding a window

Click the **+** tab to add a window (up to five), give it a label and a URL. A new window starts
with no URL and shows a placeholder until you enter one. Each window is listed in OBS by its
label, so give every window a different label.

If you are running FoundryVTT, log into it in whichever window you use to follow the game, as the
user you want the recording to follow (a dedicated observer user works well). Windows in the same
**Login group** share that login; give a window a different group name to give it its own
cookies, for a different login or a different site entirely. Any number of windows can share a
group. The change applies the next time the window starts.

## Shows

A show is a saved setup for one kind of recording: its windows and regions, its Session fields and
filename format, its Automations rules, and the Chameleon settings that depend on the table. Use one
show per kind of recording, such as a D&D campaign, a game livestream or a podcast.

The **Show** picker at the top of the sidebar names the active show. Pick another show from it to
switch. The last entry, **Manage shows...**, opens a page of its own, separate from any show's pages. There,
type a name and click **New show** to start an empty one, or click **Duplicate** on an existing show to
copy it, windows and regions included. Edit a show's name in place, click **Switch** to make it the
active show, and **Delete** to remove one (the last show cannot be deleted).

Switching closes the windows of the show you are leaving and starts the new show's windows, then
re-syncs OBS. Showrunner asks first when windows are open. Each show keeps its own Session field values,
so going back to a show finds its season and episode counters where you left them.

These stay the same for every show: the OBS connection, the YouTube login, the Chameleon address and
login, the Automations port and token, the dock, and the app preferences. Sources a show created in OBS
stay in OBS when you switch away; Showrunner does not remove them.

## Backups

The **Manage shows...** page has a **Backups** card. A backup is a dated copy of your settings: your shows and
everything in them, the saved passwords, the Automations certificates, the recordings list and the
renamed-source list. It does not include the browser cache or sign-ins to Foundry.

Showrunner makes a backup by itself the first time a new version changes the settings format, before
anything is rewritten, because an older version cannot read the new format. Click **Back up now** to
make one whenever you like, and **Show in Finder** to open the folder (`backups` inside the app's
settings folder; see the [configuration reference](userguide-configuration.md)).

**Restore** puts a backup's files back and restarts Showrunner. It makes a backup of your current
settings first, so a restore can be undone from the same list. The newest 20 backups are kept; the
ones made before a format change are never removed.

## Size and position

Set each window's **Width** and **Height** to the exact size you want; changes apply live to open
windows and are saved automatically. The **Start** button on each card opens its window and turns
into **Stop**; an ACTIVE tag shows while the window is open. **Reset window** centers it on its
display and brings it to the front.

Move a window by dragging the **bar** at its top. Click the bar and use the arrow keys to resize
the page: Right/Left change the width and Down/Up change the height by 1 px, or 10 px with Shift.
The bar shows the current position and page size. Double-click it to focus the page for typing.
**Auto-arrange on display** lays the windows out left to right from the top-left corner of a
display, wrapping to a new row when they no longer fit.

## The edge dock

The edge dock is a small rounded pill on the right (or left) edge of the display chosen on the
Session tab, with a dot per window and a blinking red dot while OBS records. Hover it to expand
it: REC and LIVE timers, the current OBS scene, and one card per window with its state, OBS
source and a thumbnail taken when it was docked. Click a card to dock that window (slide it off
screen) or bring it back; **Dock Windows** and **Undock Windows** do it for every window, as does
Cmd+Shift+C.

To shut the app down, use **Quit** at the top right of the control panel, Cmd+Q on a Mac, or **Quit** in
the menu bar icon's menu if that icon is on. Quitting closes every window Showrunner opened, so you
are asked first if any are open.

A docked window keeps a 6 pt sliver on screen under a thin dark line, so OBS keeps capturing it,
whereas hiding or minimizing a window stops the capture. Windows dock on the display they are on,
toward an edge that has no other monitor beyond it (the dock's side when free, otherwise the
opposite side, then the bottom), so a docked window never slides onto another screen or changes
its captured size. Turn the dock off on the Session tab if you do not want it.

## The menu bar icon

The optional menu bar icon (Session tab) offers Start, Stop, Dock, Sync OBS and Quit, and can
hide the Dock icon so the app behaves like a utility.

## Retina displays

On a Retina display macOS renders 2 physical pixels per point, so a 1920 x 1080 window is
captured by OBS at 3840 x 2160. The control panel shows the exact **Captured pixels** for each
open window. The **Retina display: double the pixel dimensions** tick on the Session tab decides
what the app does about it. Unticked (the default), Sync OBS scales the window and region sources
it creates by half, so they land in the scene at the sizes set here. Ticked, it keeps the double
pixels for a sharper 4K canvas. A scale you set by hand on a source in OBS is left alone. On a
non-Retina display, or when the app windows sit on a non-Retina external monitor, the sizes match
1:1 and the tick makes no difference.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Cmd+0 | Show the control panel |
| Cmd+Shift+C | Dock all windows (slide them off screen), or undock them |
| Cmd+1 to Cmd+5 | Open (or focus) window 1 to 5 |
| Cmd+Shift+1 to Cmd+Shift+5 | Reload window 1 to 5 |
| Cmd+R | Reload the focused window |
| Alt+Cmd+I | Toggle developer tools for the focused window |
| Cmd+Q | Quit |

## Troubleshooting

- **A window shows a Chromium error page.** Check the URL on the window's tab and press
  **Reload**. The window must be able to reach the site you pointed it at.
- **Logged out unexpectedly.** Use **Sign out (clear cookies)** on that window's tab and log in
  again.
- **Audio/video chat permissions.** The app allows microphone, camera and notification permission
  requests only from the origins of the URLs you have configured.
