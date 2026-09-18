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
2. **Build the Shortcut.** In the Shortcuts app, make one called *Update furniture*. This is the whole thing,
   as verified on iPadOS 16.5 (2026-09-18), which is the oldest version this is meant for:
   1. **Get contents of** `http://<blockshop address>:8081/dev/blockshop-all.zip` — the exact link is on the
      grown-up page with a copy button; a profile's own link instead carries just that person's furniture.
   2. **Extract** *Contents of URL*. Its output is called **Files**: the archive's two folders.
   3. **Get contents of folder** — folder: **Files** (the output of *Extract*). This flattens both folders into
      one list of pack folders, which is why no navigating into `behavior` or `resource` is needed.
   4. **Filter** *Contents of Folder* where **Name ends with `_bp`**.
   5. **Save Files** to `development_behavior_packs` — tap the default "Shortcuts" and pick the folder, which is
      then remembered; *Ask Where to Save* **off** and ***Overwrite If File Exists* on**. That toggle is what
      makes a run replace the pack folders instead of adding another copy next to them.
   6. **Filter** *Contents of Folder* where **Name ends with `_rp`** — the input must be re-selected: Shortcuts
      offers the previous action's output, and what you want is step 3's list.
   7. **Save Files** to `development_resource_packs`, with the same two toggles.

   Nothing in the Shortcut names a profile, so it keeps working when a profile is added or removed.

   **Both *Save Files* actions need *Overwrite If File Exists* on.** With it off, every run saves another copy
   as `blockshop_dad_rp-2`, `-3`; the copies all declare the same blocks, and Minecraft then shows items with no
   model and turns placed furniture invisible. It is the first thing to check if that happens.

3. **Run it once by hand** and check in Files that each development folder holds exactly one folder per
   profile, with no `-2` copies.
4. **Automate it.** Shortcuts → Automation → New → **App** → Minecraft → **Is Opened** → **Run Shortcut** →
   *Update furniture*. Then turn *Ask Before Running* off and *Notify When Run* off. Opening Minecraft now
   refreshes the packs in the background.
5. **Activate the packs on each world**: Edit world → Behavior Packs → My Packs → the "(live)" packs the kid
   wants. Each resource pack comes along with its behaviour pack. This is the only time a world needs touching,
   and it is where a kid chooses whose furniture their world has.
6. **If this world already has a pack that was imported from a download, turn that one off.** In the same
   Behavior Packs screen, the imported one is the profile's pack *without* "(live)" after its name — the
   `.mcaddon` someone downloaded and opened on this tablet. A profile's live pack and its imported pack declare
   the same blocks, so leaving both on is a conflict: items lose their models and placed furniture goes
   invisible. Switching is safe: the blocks are the same ids, so furniture already placed stays exactly as it
   is. A world that never had an imported pack has nothing to turn off here.

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
| `blockshop_dad_rp-2`, `-3` folders, items with no model, placed furniture invisible | *Overwrite If File Exists* is off in a *Save Files* action, so every run added another copy and the copies fight over the same blocks; turn it on and delete the strays |
| A "(live)" pack is missing from My Packs | The folders are in the wrong place, misspelled, or a pack landed one level too deep (its `manifest.json` must sit directly in `blockshop_<profile>_bp`) |
| A piece is missing in game | It has no voxels yet, or it is hidden; the grown-up page lists what was skipped |
| Furniture turned into purple-black blocks | Only the behaviour packs were refreshed; make sure both *Save Files* actions ran |
| You cannot move | You are sitting on a piece with a seat; sneak to stand up |
| Blocks that vanish, or a pack that will not enable | The profile's imported pack and its live pack are both active on that world; turn the imported one off |
| Everything is gone after a world edit | The world's packs were deactivated; re-activate the "(live)" ones |
| The Shortcut asks for confirmation | *Ask Before Running* came back on; an iPadOS update can flip it |
