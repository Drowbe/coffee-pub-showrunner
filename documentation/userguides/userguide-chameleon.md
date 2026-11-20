# Coffee Pub Chameleon in OBS

**Audience:** anyone using Coffee Pub Chameleon to publish players into OBS through Showrunner.

[Coffee Pub Chameleon](https://github.com/Drowbe/coffee-pub-chameleon) is the party's voice and video
server. Showrunner signs in to it as an admin and gives every player their own OBS Browser Source.

## Sign in

Switch **Chameleon** on in the left rail under Integrations (use **Add integration** if it is not listed;
each profile has its own switch), then on the Chameleon page enter the server address (for example `https://chameleon.example.com`),
your admin login and password, click **Save password**, then **Sign in**. Tick **Sign in
automatically** to reconnect at every launch.

The password is stored encrypted with the macOS keychain, like the OBS password. The stream key
the sources use is fetched from the server at sign-in and never has to be copied.

If the account has two-step sign-in turned on (or the server requires it for everyone), a
**Two-step code** field appears after **Sign in** -- enter the six-digit code from your
authenticator app and click **Verify**, or **Cancel** to back out. Showrunner remembers that it
verified for 30 days, so it isn't asked again until then. If the account hasn't set up two-step
sign-in yet, Showrunner can't do that part -- sign in once in a browser to set it up, then come back
and sign in here as usual.

## Source sizes

The **Participant source** is their video, or a still image when the camera is off, with the
talking border, overlays and name plate set on Chameleon. Set its width and height, with
**Constrain proportions** keeping them at 16:9. Audio is always included; the source's own
**Control audio via OBS** in OBS decides whether it reaches the mixer. The **Character source** is
the character image with the talking and muted images on top, transparent until they talk or mute
when there is no character image, made for overlaying a character bar. Set its size;
**New users get Character on by default** decides the starting tick for anyone you haven't set by
hand.

## The Chameleon page

Every account on the server is listed as one box per person. The header of the box holds what is true of
the person, once: a green dot while they are at the table, their name, whether their camera and microphone are on, the
OBS volume Calibrate or Auto level set for them (or "not calibrated"), and at the far right which room they're actually in
right now (or OFFLINE, or OFF STREAM). Under the header are the person's two sources as plain rows, **Participant** first
and **Character** second, each with its picture, its OBS name, a link button, **Delete from OBS** and a **Show in OBS** /
**Hide in OBS** toggle. A room whose profile excludes one of them (Participants only, say) simply doesn't show that row.
Hiding never deletes the source, so any position, scale or filter you set on it in OBS survives, and **Delete from OBS** is
the button that actually removes it. OBS names follow one pattern everywhere: `Participant: <name> (CPS)` and
`Character: <name> (CPS)`.

The bulk buttons above the list act on the whole room at once: **Show All in OBS** / **Hide All in
OBS** only touch visibility, never creating or deleting anything; **Add All in OBS** creates a
source for everyone ticked but not there yet; **Delete All from OBS** removes every Chameleon source
outright.

**Sync OBS** re-points every source at its current link and size and follows renames; the app
also does this whenever OBS connects or Chameleon reports a change. The link button on a row puts
its OBS view link on the clipboard for a source you manage yourself. Users are tracked by the
Chameleon's stable key, so renaming someone on Chameleon renames both OBS sources without breaking
anything. Muting and kicking players is done on Chameleon's manage page, which **Manage users**
opens in your browser, along with passwords, links, images and rooms.

## Audio filters

These live in the **Audio** card on the Chameleon page. Everyone is at a different microphone level, and OBS has no setting that balances several speakers. With
**Add audio filters to new participants** on (it is on by default), each new Participant source gets three OBS
audio filters, in this order: noise suppression, a compressor with makeup gain, and a limiter. The compressor
evens out loud and quiet moments for that person, and the limiter catches peaks. They are named
"Showrunner: Noise suppression", "Showrunner: Compressor" and "Showrunner: Limiter", so you can find and tune
them in OBS under the source's **Filters**.

A source that already has a filter of one of those kinds keeps it, and only the missing kinds are added. Click **Add to
existing participants** to add the filters to the Participant sources already in OBS. Turning the setting off
stops new sources from getting them and never removes any. The filters even out each person; they do not match
people to each other, so you may still nudge a volume.

## Level the participants

The audio filters even out each person; **Calibrate** and **Auto level** match people to each other. Both are on the
Chameleon page, under **Audio** (below the participant list), and both bring everyone's speech to the
**Target level** slider (-20 dB by default; speech usually sits around there).

**Calibrate** is the manual one. Have everyone talk normally and click **Calibrate**. Showrunner listens to the
Participant sources in OBS for the number of seconds you set (10 by default), measures how loud each person speaks, and
sets each person's OBS volume so they land at the target. The volume is saved with the person, so a new Participant source
for someone you have calibrated starts at their saved volume.

**Auto level** is the same idea running quietly through the whole session. Switch it on (the switch beside the title) and
Showrunner keeps watching the Participant sources and nudges each person's volume toward the target, so someone who
joins late, or whose microphone or room changes from one game to the next, is brought in line without you doing anything.
It is deliberately gentle:
- It only counts moments when a person is speaking, so silence and background noise do not pull the volume around.
- It moves slowly: at most 1 dB at a time, or 3 dB when someone is far off, about every two seconds.
- It leaves anyone within about 1.5 dB of the target alone, so it does not hunt.
- If you move someone's volume in OBS yourself, it leaves that person alone for a minute, then resumes.
- Calibrate pauses it while it runs.
Auto level belongs to the profile (it is on or off per profile), runs only while Chameleon is on and OBS is connected, and
saves the levels it settles on, like Calibrate does. A tag beside the title shows how many people it is watching, and
the line below shows its last change.

What Calibrate's results say, one line per person:
- **Heard about X dB, volume now Y dB:** what was measured and the volume it was set to.
- **No speech heard:** the person was offline or silent. Their volume is left as it was.
- **Clipping:** their peaks hit the top. Turning them down in OBS does not fix that; ask them to lower their microphone
  gain.
- **Very quiet or very loud:** the fix needed more than Showrunner will do (it works within -30 to +20 dB), so ask them
  to move closer, or to raise or lower their mic level.

Measuring is independent of where the OBS volume is now, so running Calibrate again gives the same answer. Both only adjust
volume, so they work on top of the filters and do not replace them.

## Rooms and Asides

The **Room** card at the top of the Chameleon page picks which room's users are listed: the
**Lobby** holds everyone, and the rooms an admin curates on Chameleon's Rooms tab hold the users
they picked. This is always a manual pick -- "this room is for this OBS session" -- and is never
overridden by wherever the admin happens to be live; a room whose profile restricts which source
kinds it offers (Participants only, say) gates what's published here too. **Publish all**
publishes the chosen room's users.

**Enable Asides**, on by default, mutes anyone whose OBS source is live in a different room than
wherever the signed-in admin actually is right now (including a pull-aside room), so a private
conversation elsewhere doesn't bleed into the stream's audio -- the source itself stays visible
either way, and this only ever mutes, it never changes which room is shown above. It only takes
effect while an admin is actually online; with none online there's no "current conversation" to be
aside from. Someone offline is never muted by this setting -- there is no live audio to mute in
the first place. None of this is visual: any dim or tint for someone offline or aside is rendered
by Chameleon server's own page, not by Showrunner.
