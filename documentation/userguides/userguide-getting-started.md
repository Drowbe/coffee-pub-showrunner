# Getting Started with Coffee Pub Showrunner

**Audience:** anyone who has just installed Coffee Pub Showrunner and wants to see it working.

## Install it and open it

Download the installer from the repository's Releases page: the disk image on a Mac, the `.exe` on
Windows. On a Mac, drag Coffee Pub Showrunner into Applications and open it; the first time, macOS
blocks an unsigned build, so right-click the app and choose Open, then Open again in the dialog that
follows. On Windows, run the installer; SmartScreen may say "Windows protected your PC", so click
**More info**, then **Run anyway**.

## What happens the moment it opens

A control panel opens, with a left rail of pages and no windows configured yet. Showrunner wraps any web page in a
borderless, fixed-size Chromium window with a thin bar of its own at the top for dragging and
resizing; it is optimized for running FoundryVTT sessions but works with any web-based
experience. The rest of this guide uses a two-window FoundryVTT setup as the running example,
since that is the most common case, but any page works the same way.

## Add a window and point it at your game

Click **Add window** at the bottom of the left rail (under Windows) to add one (up to five), give it a label such as Game, and set its
address to your Foundry game's URL. Add a second one labeled Stream if you use a stream-facing
view. Log in to Foundry once, in the Game window; every window sharing the default login group
uses that same login, so you do not log in twice.

## Set the size OBS will capture

Set each window's Width and Height on its card to the exact pixel size you want in OBS. Changes
apply immediately to an open window and save on their own -- there is no separate save action to
remember.

## Bring it into OBS

Connect Showrunner to OBS from the **OBS** page, under Recording in the left rail (OBS's own WebSocket server has to be
turned on first, from OBS's Tools menu). Once connected, Showrunner creates and points OBS sources at
your windows on its own, cropping out Showrunner's own bar so OBS only ever sees the page underneath
it.

## Set up a profile for each kind of recording

Everything above lives in a **profile**: your windows, Session fields, filename format, Automations rules and
Chameleon settings. The first one is called D&D; rename it on the **Manage profiles** page (the last entry in the
Profile picker), and add another profile for each other kind of recording, such as a livestream or a podcast. A
profile can also pin an OBS profile and scene collection, so switching Showrunner profiles switches OBS too. See
[Settings, windows and the edge dock](userguide-settings.md).

## Where to go from here

That covers watching your own game render and land in OBS. From here:

- [Coffee Pub Chameleon in OBS](userguide-chameleon.md) -- publishing the party as their own OBS sources, and
  levelling everyone's volume with Calibrate and Auto level.
- [Windows and regions as OBS sources](userguide-obs.md) -- cropping part of a window into its own source.
- [Automations API](../api/api-automations.md) -- letting a Foundry module drive OBS.
- The [product page](https://coffeepubstudio.com/products/showrunner) and the [changelog](https://github.com/Drowbe/coffee-pub-showrunner/blob/main/CHANGELOG.md).
