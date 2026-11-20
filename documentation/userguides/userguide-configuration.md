# Configuration file reference

**Audience:** anyone reading or editing Coffee Pub Showrunner's config.json directly, or scripting
against it.

Settings are stored as JSON at
`~/Library/Application Support/Coffee Pub Studio/config.json` (the folder keeps the app's earlier name on purpose, so a rename never loses settings or passwords; the control panel's
**Show config file** button reveals it in Finder).

Backups of this file and the other settings files are kept in a `backups` folder beside it; see
[Settings, windows and the edge dock](userguide-settings.md#backups).

Since version 13 the file holds a list of **profiles**. Each profile owns its `views`, `appWindows`,
`metadataFields`, `session` (the filename format), `automations` (`enabled` and `ruleSets`), `youtube` (`enabled` only; the login and defaults stay global), `obsPins` (`enabled`, `profile`, `collection`: the OBS profile and scene collection to switch OBS to; either name can be empty to leave that part alone) and the
`tavern` settings that depend on the table (`enabled`, `space`, `followAdmin`,
`characterWithPlayer`, `players`). `activeProfile` names the one in use. Everything else
(`obs`, `youtube`, `dock`, `panel`, the preferences, the Chameleon connection details such as
`tavern.url`, and the Automations `port` and `token`) stays at the top level and is shared by every
profile. A version 12 file becomes one profile named "D&D" when the app first starts. Version 13 called profiles `shows` (with `activeShow`); a version 13 file is converted when the app first starts, after an automatic backup. Version 15 moved the wake delay from one global `wakeAudioDelay` to a `wakeDelay` on each window; the old number is copied to every window.

The example is trimmed to the window and OBS shape for readability, and shows one profile with two
windows; `tavern` and `automations` are covered in their own guides:
[Coffee Pub Chameleon in OBS](userguide-chameleon.md) and the
[Automations API](../api/api-automations.md).

```json
{
  "version": 15,
  "obs": { "autoConnect": false, "host": "127.0.0.1", "port": 4455 },
  "activeProfile": "profile1",
  "profiles": [
    {
      "id": "profile1",
      "name": "D&D",
      "views": [
        {
          "id": "window1",
          "label": "Game",
          "url": "https://your-server.example/game",
          "width": 1920,
          "height": 1080,
          "x": null,
          "y": null,
          "muted": false,
          "enabled": true,
          "session": "Main",
          "windowSource": { "enabled": true, "name": "Window: Game (CPS)" },
          "regions": []
        },
        {
          "id": "window2",
          "label": "Stream",
          "url": "https://your-server.example/stream",
          "width": 1920,
          "height": 1080,
          "x": null,
          "y": null,
          "muted": true,
          "enabled": true,
          "session": "Main",
          "windowSource": { "enabled": false, "name": "Window: Stream (CPS)" },
          "regions": [
            {
              "id": "region1",
              "name": "Scoreboard",
              "mode": "selector",
              "selector": "#scoreboard",
              "x": 0,
              "y": 0,
              "width": 600,
              "height": 200,
              "obsSource": "Region: Stream>Scoreboard (CPS)"
            }
          ]
        }
      ]
    }
  ]
}
```

A profile's `views` holds zero to five entries, in the order they appear in the panel and in the menu.

| Field | Meaning |
| --- | --- |
| `panel` | Where the control panel was last left (`x`, `y`, `width`, `height`), written by the app; `null` lets macOS place it. |
| `menuBarIcon`, `hideDockIcon` | Show the menu bar icon; optionally hide the Dock icon while it is shown. |
| `retinaDouble` | On a Retina display OBS captures twice the pixels of a window's size. `false` (default): the app scales its window and region sources by half in OBS so they land at the sizes set here. `true`: it keeps the double pixels (**Retina display: double the pixel dimensions**). A scale you set by hand on a source in OBS is left alone. |
| `dock` | The edge dock: `enabled`, `side` (`right` or `left`) and `overlap`, the points of a docked window left on screen (0 slides it fully off). It lives on the display chosen for auto-arrange. |
| `obs` | OBS WebSocket connection: `autoConnect`, `host`, `port`. The password lives in `obs-secret.bin` next to the config, encrypted. |
| `tavern` | Coffee Pub Chameleon: `enabled`, `url`, `login`, `autoConnect`, the Participant source's `playerWidth`, `playerHeight`, `lockRatio` (still `player`-prefixed in the field names and in `players` below, kept for back-compat with existing config files and Chameleon's own `kind=player` view-link parameter); the Character source's `characterWidth`, `characterHeight`, `characterWithPlayer`; `space` (an existing config file may still say `room`, read the same way), Chameleon space whose users the Chameleon tab lists by hand (`lobby` by default); `followAdmin` (default `true`), which overrides `space` with whatever space the signed-in admin is actually in at the table and hides a published user's OBS sources while they are off it; and `players`, a map from the user's Tavern key to `{ player, character, source, characterSource }` (the two ticks, and the OBS source names while published). The password lives in `tavern-secret.bin`. |
| `label` | Shown in the window title, so it is also the name OBS lists. |
| `url` | Page to load. Must be `http` or `https`; empty shows a placeholder. |
| `width`, `height` | Content size in points (100 to 7680). |
| `x`, `y` | Window position, written by the app when you move the window; `null` lets macOS place it. |
| `windowSource` | The whole window as one OBS source: `enabled` (off hides it in OBS and stops maintenance) and `name`, the OBS source name. |
| `regions` | Named parts of the window. `mode` is `rect` or `selector`; `x`, `y`, `width`, `height` are in window points and are re-measured from `selector` when set; `obsSource` names the cropped OBS source the app maintains; `enabled` false hides it in OBS and stops maintenance. |
| `muted` | Mute the window's audio. Handy for a chat-facing window so its sounds are not doubled. |
| `enabled` | Open this window when the app launches (**Start on launch**). |
| `dockOnLaunch` | Slide the window into the dock as soon as its page has loaded at launch (**Dock on launch**). |
| `wakeAudio` | Send the page a middle-button click after the window's **Wake its sound** delay (`wakeDelay`), so Foundry can start its audio (**Wake audio after load**, on by default). Browsers keep a page silent until someone interacts with it, and Foundry ignores clicks until it is fully set up; after the delay the app clicks, and keeps clicking every few seconds while Foundry still says its audio is locked, for up to three minutes. The **Wake audio** button on the card and on the dock does the same on demand, and the **Page audio** row says whether the page is making sound right now. |
| `wakeDelay` | Seconds after the page loads before its audio is woken (**Wake its sound** on the window's card, 10 to 300, default 30; shown while **Wake audio after load** is ticked). Some pages ignore clicks until they have fully loaded, which can take longer than the page says. |
| `session` | Login group name (default `Main`). Windows with the same name share cookies and storage. (Named `session` in the file for compatibility; the control panel calls it the login group.) |
