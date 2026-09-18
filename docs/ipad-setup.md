# Furniture in a tablet's own worlds, without importing

A tablet can keep its own worlds up to date by itself. Minecraft reads packs in its `development_behavior_packs`
and `development_resource_packs` folders **fresh from disk every time a world loads**, instead of copying them into
the world, so replacing the files is enough: no pack to import, no version to activate, nothing to clean out of
Storage. Blockshop serves those packs, and an Apple Shortcut on the tablet downloads them when Minecraft opens.

What the kids get: build a piece, open Minecraft, enter the world, it is there. The *Download* button is then
only for another device or a friend, and the family server has its own button
(see [family-server-internals.md](family-server-internals.md)).

The device facts behind this are in [format-notes.md](format-notes.md) ("Development packs work on iPad").

## What Blockshop serves

**One pack per profile**, so a kid can switch someone else's furniture off in their own world, and
**one download** that carries them all, so a tablet can never end up with one profile's blocks and another
profile's models from a later build. The links are on the grown-up page (`#/admin`) under *Tablets' own worlds*.

```
blockshop-all.zip
├── behavior/
│   ├── blockshop_dad_bp/        → development_behavior_packs/
│   └── blockshop_robin_bp/
└── resource/
    ├── blockshop_dad_rp/        → development_resource_packs/
    └── blockshop_robin_rp/
```

Each profile is also served on its own as `blockshop_<profile>.zip`, laid out the same way, for a tablet that
should only carry one person's furniture.

Every pack is the same one the *Download* button hands over as an `.mcaddon` — same block ids, models, seats
and script —
with three differences: its own pack ids, a **version that never changes** (1.0.0), and "(live)" after the name
in the pack list. So furniture already placed in a world from an imported pack keeps working after the switch,
and the world never has to be told about a new version. The packs are built from the pieces **as they are saved
right now**, straight from the editor; a piece with no voxels yet is left out until it has some.

**The folder names are a contract.** `blockshop_<profile>_bp` and `_rp` are what land in Minecraft's folders.
Renaming them would leave a stale folder behind on every tablet.

## Setting up a tablet (once)

1. **Find the folders.** Files → On My iPad → Minecraft → games → com.mojang. If `development_behavior_packs`
   and `development_resource_packs` are not there, make them (exact spelling, no capitals). If the `games` folder
   itself is missing, open Minecraft once and create a world first.
2. **Build the Shortcut.** In the Shortcuts app, make one called *Update furniture*:
   1. **Get Contents of URL** — `http://<blockshop address>/dev/blockshop-all.zip` (the exact link is on the
      grown-up page with a copy button; use a profile's own link instead to carry just that person's furniture).
   2. **Extract Archive** — input: the file from step 1.
   3. **Get File from Folder** — folder: the extracted folder from step 2; path `behavior`.
   4. **Get Contents of Folder** — input: that folder. This is every profile's behaviour pack at once, so the
      Shortcut does not grow when a profile is added.
   5. **Save Files** — destination `development_behavior_packs` (tap the default "Shortcuts" and pick the folder;
      it is remembered), *Ask Where to Save* **off**, *Overwrite If File Exists* **on**.
   6. Steps 3 to 5 again with `resource` and `development_resource_packs`.

   If a run leaves a `blockshop_dad_bp 2` behind, *Save Files* is not replacing folders. Add, before each save,
   **Get Contents of Folder** on the destination → **Filter Files** (*Name contains* `blockshop_`) →
   **Delete Files** with *Ask Before Deleting* **off**.
3. **Run it once by hand** and check in Files that the folders are there, one pair per profile, nothing
   duplicated as "… 2".
4. **Automate it.** Shortcuts → Automation → New → **App** → Minecraft → **Is Opened** → **Run Shortcut** →
   *Update furniture*. Then turn *Ask Before Running* off and *Notify When Run* off. Opening Minecraft now
   refreshes the packs in the background.
5. **Activate the packs on each world**: Edit world → Behavior Packs → My Packs → the "(live)" packs the kid
   wants. Each resource pack comes along with its behaviour pack. This is the only time a world needs touching,
   and it is where a kid chooses whose furniture their world has.
6. **Turn off that world's imported furniture packs.** A live pack carries the same block ids as the profile's
   imported pack, and two active packs claiming one id is a conflict. Placed furniture survives the switch.

**On the other tablets**, don't rebuild the Shortcut: AirDrop it from the first one (Shortcuts → the shortcut →
Share). The two *Save Files* destinations may have to be picked again, since they point at folders on the device
that made it. The automation cannot be shared — iOS has no way to export one — so steps 4 to 6 are done per tablet.

## Day to day

Build in Blockshop, open Minecraft, enter the world. Someone who is already in a world leaves it and comes back.

Worth knowing:

- **Two kids building at once** is fine. One download carries every pack from a single build, so a tablet can
  never mix a behaviour pack with a newer resource pack (which would show as wrong colours on a piece someone
  recoloured, until the next launch).
- **A new profile** appears on the tablets by itself: its packs are in the archive, and the Shortcut saves
  whatever is in there. It still has to be activated once on a world that wants it.
- **Away from home** the download fails and Minecraft opens as usual, but the Shortcut shows an error. To keep it
  quiet, start the Shortcut with **Get Network Details** → current Wi-Fi name, and **Stop This Shortcut** when it
  isn't the home network.
- **A kid who is very quick** can be in the world before the download lands; the change then shows the next time.
  Keeping the Shortcut on the home screen gives them a way to force it.
- **A piece being drawn right now** (no voxels yet) is skipped; the grown-up page says how many were left out.
- **A removed profile** leaves its folders behind on the tablets. Deleting them by hand, and deactivating the
  pack on any world that had it, is the tidy-up.
- The packs are rebuilt on the server only when something actually changed, so every launch of every tablet
  asking for them costs nothing.

## Troubleshooting

| What you see | Why |
|---|---|
| A `blockshop_dad_bp 2` folder | *Save Files* did not overwrite; add the delete actions described under step 2 |
| A "(live)" pack is missing from My Packs | The folders are in the wrong place, misspelled, or a pack landed one level too deep (its `manifest.json` must sit directly in `blockshop_<profile>_bp`) |
| A piece is missing in game | It has no voxels yet, or it is hidden; the grown-up page lists what was skipped |
| Furniture turned into purple-black blocks | Only the behaviour packs were refreshed; make sure both halves of the Shortcut ran |
| Blocks that vanish, or a pack that will not enable | The profile's imported pack and its live pack are both active on that world; turn the imported one off |
| Everything is gone after a world edit | The world's packs were deactivated; re-activate the "(live)" ones |
| The Shortcut asks for confirmation | *Ask Before Running* came back on; an iPadOS update can flip it |
