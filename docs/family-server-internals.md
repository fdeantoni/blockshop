# Family server internals

How Blockshop puts furniture on a Paper server with CraftEngine and Geyser, what it writes where, and what was
verified on a real server. To set a server up, see [server-setup.md](server-setup.md).

The local-world add-on reaches each device's own worlds and needs the update routine on every device. The
family server export puts the same furniture into the **shared Paper world**: on the grown-up's request
("Update the family server" on the grown-up page), Blockshop takes the pieces every profile has chosen for it, as
they are saved at that moment, merges them into one CraftEngine pack and one set of Geyser mappings, writes them into the server's
plugin folders, and Geyser hands Bedrock players one resource pack per profile when they join. Nothing is
imported on the devices; nobody deletes old packs. Only that button touches the server, so nobody gets kicked by
someone else's edit.

## What a server update produces (`DATA_DIR/server/dist/java/`, served at `/java/`)

| Path | Goes to | What |
|---|---|---|
| `craftengine/` | `plugins/CraftEngine/resources/blockshop/` | `pack.yml` (namespace `blockshop`), `configuration/blockshop.json` (one `paper` item per piece of every profile, ids `<profile>:<piece>`, each with an inline `block_item` block: four facings on explicit carrier states, `seat_block` for chairs, `loot: self`; one `/ce` browser category per profile; the shared `blockshop:catalog` item), Java block models under `resourcepack/assets/<profile>/models/block/`, solid palette textures per profile |
| `geyser/custom_mappings/blockshop_blocks.json` | `plugins/Geyser-Spigot/custom_mappings/` | Custom block mappings v1: one entry per carrier block (`minecraft:<type>_leaves`), `only_override_states`, one state override per piece and facing (Bedrock geometry id, the whole palette as material instances, full-cube collision and selection boxes, rotation, light). Deliberately independent of shape, colours and name, because Geyser reads it at startup only |
| `geyser/custom_mappings/blockshop_items.json` | `plugins/Geyser-Spigot/custom_mappings/` | Custom item mappings v2 on `minecraft:paper`, keyed by the `item_model` `<profile>:<piece>`, with an icon; not in the Bedrock creative tab (a pickup from there cannot produce a working piece) |
| `geyser/packs/blockshop_<profile>.mcpack` | `plugins/Geyser-Spigot/packs/` | One Bedrock resource pack per profile, served by Geyser: the same geometry and palette textures as that profile's local pack, item icons from the editor thumbnails, `item_texture.json`, the shared catalog icon. Each manifest uuid is derived from the profile's (never equal to the local pack's); the version is the server export counter, so clients re-download on join after every update. Packs of removed profiles are deleted |
| `catalog/pieces.json` | `plugins/BlockshopCatalog/` | What the furniture menu plugin shows: one group per profile with its visible pieces, names and served-pack icons |
| `geyser_rp/<profile>/` | (unzipped copies of the packs) | for inspection |
| `report.json`, `build.json`, `deploy.json` | | build report, last build, last deploy result |

**What is on the server is a choice, and a budget.** A piece carries `options.onFamilyServer` (absent means yes,
so nothing already on the server falls off), and a profile carries `onFamilyServer` (a guest starts off it). Only
chosen pieces of included profiles are built, allocated states and listed in `/cat`; everything else costs the
server nothing and still reaches its own worlds through that profile's packs. Turning a piece or profile off
leaves its states allocated — states are never reused — and anything placed from it in the shared world becomes
plain leaves. The grown-up page shows the pieces still left (`piecesLeft`, `statesLeft / 4`).

Carrier states (vanilla *leaves* states that CraftEngine frees; `carrier` in `DATA_DIR/server/java-states.json`)
are assigned to a piece the first time it reaches the server (keyed `<profile>:<piece>`, four per piece, 143
available) and never change afterwards, not even when a profile is removed: placed furniture is stored in the
world as those vanilla states. That is 35 pieces for the whole family, whoever they belong to.
Leaves rather than note blocks because the Java client culls the neighbours of an opaque note block,
which made the floor under a chair show the sky; leaves are non-occluding with the same full-cube
collision. Changing the carrier reassigns every state and turns already placed furniture into plain leaves
or note blocks. `pnpm gen --java --all fixtures/pieces` builds the
same tree from the fixtures for a look without a server.

## The furniture menu (BlockshopCatalog plugin)

Neither client offers a kid-proof way to get a CraftEngine item: a vanilla Java creative inventory never
lists them, and a pickup from the Bedrock creative tab reaches the server as a plain paper. So Blockshop
ships a small Paper plugin, [`plugin/`](../plugin/), built into the Docker image and installed by the
deploy step when `PLUGINS_DIR` is set:

- `/cat` (or `/catalog`) opens the menu: with several profiles it first asks whose furniture, then lists that
  person's pieces (a Back button returns). `/cat <1-9>` gives the player the **Furniture catalog** item (a
  paper with a chair icon) if they do not have it and puts it in that hotbar slot (whatever sits there
  moves to where the catalog landed). Nothing is given automatically unless `give-on-join: true`, and
  nothing is restored on its own: a lost catalog is one `/cat 9` away. A server cannot add entries to
  Bedrock's own settings menu, so the command and the item are the menu's handles. Keys missing from an
  existing `plugins/BlockshopCatalog/config.yml` are added with their defaults when the plugin starts.
- Bedrock: tapping the catalog's hotbar slot, tapping the ground while holding it, or `/catalog` opens a
  native form with one picture button per piece (icons from the served pack, via Floodgate). A choice runs
  `ce item give` from the console, then the plugin moves the piece into the hotbar if needed and selects
  it, so the next tap on the ground places it while the catalog stays in its own slot.
- Java: right-clicking the catalog (CraftEngine's own `right_click` event on the item) or `/catalog` opens
  CraftEngine's item browser. The hotbar trigger is Bedrock-only because the scroll wheel passes through slots.
- Bedrock far taps: a tap beyond reach with a non-block item reaches the server as a block click on the air
  position at the end of the reach ray, and CraftEngine would place the piece there, floating in the sky. The
  plugin cancels such clicks for custom items from Bedrock players and shows a "Too far away" hint
  (`bedrock-air-click-guard` in its config).
- The list comes from `plugins/BlockshopCatalog/pieces.json`, written on every server update and re-read on every
  menu open, so new or renamed pieces need no plugin reload. Only a changed jar needs a restart, which
  the deploy handles like a mapping change.

The plugin needs Floodgate (already there for Bedrock players) and CraftEngine (for the commands); it compiles
against Paper 26.2 with JDK 25.

## Server requirements

- Paper **1.21.4 or newer** (Geyser's v2 item mappings; CraftEngine's `item_model` needs 1.21.2+).
- **CraftEngine** (the free build is enough). Blockshop owns `resources/blockshop/` completely and
  replaces it on every deploy; keep your own packs in other folders.
- **Geyser-Spigot** with `enable-custom-content: true` in its `config.yml`. Geyser reads
  `custom_mappings/` and `packs/` when it starts. (`/geyser reload` re-reads the packs but not the mappings; see the checklist.)
- **RCON** in `server.properties` (`enable-rcon=true`, `rcon.port=25575`, `rcon.password=…`) so
  Blockshop can run `ce reload all` after a deploy. Keep the port on localhost / the LAN firewall.
- Blockshop **on the same host** with write access to both plugin folders (see server-setup.md).

- `SPAWN_PROTECTION: "0"` on the `mc` service (server.properties `spawn-protection=0`), or op every player:
  vanilla spawn protection stops non-op players from building within 16 blocks of the world spawn, which on
  Bedrock shows as "x, y, z is under spawn protection".

## What "Update the family server" does

The grown-up page shows, per profile, the version last sent and the version on the server, who is online, and
whether the next update restarts or only reloads (exact: the merged build is pure, so its mapping is compared
with the file in the Geyser folder). The update then bumps the export counter, allocates carrier states for new
pieces, makes each profile's pack file current (which is where the Creator Tools validation runs, and what
leaves the version and history behind), builds from every profile's pieces as they are now,
replaces the CraftEngine folder, syncs the Geyser files and the plugin, and either runs the RCON commands
(`JAVA_RCON_COMMANDS`) or the restart command (`JAVA_RESTART_COMMAND`). Command failures are reported on the
page; the files are already in place.

Why restarts: Geyser reads its block/item mappings at startup only, so an update that *adds* furniture (or
renames a piece, or changes its light) needs a server restart; edits to existing pieces are covered by the
reloads. A pending restart is remembered across updates until the server actually restarts: seen in the
mounted server log (`MC_LOG_FILE`), done by `JAVA_RESTART_COMMAND`, or confirmed with "The server was restarted".
After its own restart the update waits for RCON (`JAVA_RESTART_WAIT_MS`) and runs `ce reload all` again, because
CraftEngine serves its last *uploaded* pack after a start and only a reload regenerates it (seen 2026-09-15: a
new piece showed as leaves on Java until the reload).

## Verification checklist (done once on a real server)

Same idea as the first iPad test: prove the format on a real server. Repeat it when the export format changes.

1. Set up the stack from [server-setup.md](server-setup.md), draw a piece in a profile, then press
   "Update the family server" on the grown-up page. `DATA_DIR/server/dist/java/` now holds the export (also
   browsable at `/java/` on Blockshop) and the update copied it through the mounts.
2. The same by hand, from the stack directory (`./blockshop` is Blockshop's state, `./data` the server's):
   ```sh
   rm -rf data/plugins/CraftEngine/resources/blockshop
   cp -r blockshop/server/dist/java/craftengine data/plugins/CraftEngine/resources/blockshop
   cp blockshop/server/dist/java/geyser/custom_mappings/*.json data/plugins/Geyser-Spigot/custom_mappings/
   cp blockshop/server/dist/java/geyser/packs/blockshop_*.mcpack data/plugins/Geyser-Spigot/packs/
   sudo chown -R 1000:1000 data/plugins/CraftEngine/resources/blockshop data/plugins/Geyser-Spigot/custom_mappings data/plugins/Geyser-Spigot/packs
   ```
3. `docker compose restart mc`. Watch `docker compose logs -f mc` for CraftEngine (`blockshop` pack
   loaded, no conflict warnings) and Geyser (`Registered N custom blocks`, `custom items`,
   `Loaded 1 resource pack`).
4. Join from an iPad. Check, in this order, and note the answers in `docs/format-notes.md`:
   1. **Pack**: the join screen downloads one "<Name>'s Furniture (server)" pack per profile. Without them nothing else works.
   2. **Item**: type `/cat 9`; the **Furniture catalog** item lands in slot 9. Selecting it (or `/cat`)
      shows the iPad a menu with pictures (first whose furniture, then the pieces), Java gets CraftEngine's
      browser. Alternatives: `/ce` (browser with a category per profile), or `/ce item get <profile>:<piece>` for ops.
   3. **Creative** (settled 2026-09-15): a vanilla Java client never shows CraftEngine items in its creative
      inventory (that needs CraftEngine's client mod). The iPad showed them under Items, but a piece taken
      from there vanished when moved to the hotbar: Bedrock creative hands Java a plain paper that the
      server discards. The pieces are therefore kept out of the Bedrock creative tab; `/cat` or `/ce`
      are the ways to get them.
   4. **Facing**: place a chair while looking north. Its front (the editor's +z side) should face you
      (south). If it faces away, swap north↔south and east↔west in `java.yaw` **and** `java.bedrockYaw`
      in `project.json` and update again. If Java and Bedrock disagree with each other, only
      `bedrockYaw` is wrong.
   5. **Shape**: armrest on the same side as in the editor (Bedrock geometry is the one already verified
      in local worlds; the Java model is unmirrored by design).
   6. **Sit**: tap the chair. Sitting height is `seat.height/16 + java.seatOffset` blocks; tune
      `java.seatOffset` (−1..1) if you sit inside or above the seat.
   7. **Break**: breaking the block drops the piece (loot table `self`).
   8. **Update path** (settled 2026-09-15 on the dev stack): `ce reload all` rebuilds and re-sends the Java
      pack, so Java clients see an edited piece at once, no rejoin. `geyser reload` re-reads the served
      Bedrock pack (it kicks Bedrock players, who rejoin and download the new version) but **not** the
      block/item mappings, which Geyser registers at startup only. The mapping therefore contains nothing a
      kid edits (shape and colours come from the served pack; boxes are the full cube) and changes only for a
      **new piece**, a **rename** (item name) or a **light** change; those need a Paper restart, everything
      else is covered by the reloads. The server update runs both reloads by default, remembers a pending
      restart across updates until the server actually restarts (seen in `MC_LOG_FILE`, done by
      `JAVA_RESTART_COMMAND`, or confirmed with the grown-up page's "The server was restarted"), and the
      grown-up page says beforehand whether the next update restarts or only reloads, and who is online. Seen on 2026-09-15: recolouring the table did not
      show on the iPad until a restart, because the colour list used to live in the mapping.

Known limits: glass is opaque on Java (cutout render layer; Bedrock blends as in the local pack). Collision
is a full block on both sides because the Java carrier is a full cube. Java shader packs that wave leaves
(for example Materials → Waving Textures → Waving Leaves) wave the furniture too, because its carrier
states are leaves; turn that toggle off on the client.

## Endpoints (grown-up session: `x-admin-token` from `POST /api/admin/login`)

- `GET /api/admin/server` — mode, per-profile versions (sent / on the server), online players, whether an update is needed and whether it restarts, last build, last deploy, pending restart, states left.
- `POST /api/admin/server/update` — refresh every profile's pack, build from their current pieces and deploy (409 while another update runs or when `JAVA_DEPLOY=off`, 422 before anyone has drawn a piece).
- `POST /api/admin/server/restarted` — the grown-up restarted the server by hand; clears the pending restart.
- `GET /java/…` — the export files (directory listing).
