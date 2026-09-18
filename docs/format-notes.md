# Bedrock format notes

Verified facts about the Bedrock add-on format that the generator relies on. Resolved against public documentation on **2026-09-13**; items marked *device* need a check on a real iPad. Re-check this file whenever the iPads update Minecraft.

## Version numbers

Bedrock switched to year-based release names in February 2026. Internal engine and format numbers continue the old `1.x` line, so release **26.40** is format/engine **1.26.40**. This is confirmed by the `@minecraft/server` npm tags (e.g. `2.10.0-beta.1.26.40-stable`) and by the wiki block examples using `"format_version": "1.26.40"`.

| Release | Date | Block `format_version` | `min_engine_version` | `@minecraft/server` stable |
|---|---|---|---|---|
| 26.30 (Chaos Cubed) | 2026-06-16 | `"1.26.30"` † | `[1, 26, 30]` † | `2.8.0` |
| **26.40** | 2026-08-04 | `"1.26.40"` | `[1, 26, 40]` | **`2.9.0`** |
| 26.50 (Wilderness Bound) | 2026-09-15 | `"1.26.50"` † | `[1, 26, 50]` † | `2.10.0` † |
| 26.60 | 2026-10-27 (planned) | | | `2.11.0` † |

† Inferred from the release-date pattern and the npm rc/beta tag names (e.g. `2.10.0-rc.1.26.50-preview.*`), not read from a changelog. Only the 26.40 row is directly confirmed.

Rule: pin `project.json` to the **lowest** version installed on the family iPads. A pack whose `min_engine_version` exceeds the client is refused. Higher-versioned formats are not needed for anything this project does.

**Family devices (2026-09-14): the iPad runs Minecraft 26.32**, so the project pins `formatVersion` `"1.26.30"`, `minEngineVersion` `[1, 26, 30]` and `scriptApiVersion` `"2.8.0"`. Raise these only after every iPad has updated.

## Block JSON

- Custom components **v2** (format ≥ `1.21.90`, script ≥ `2.0.0`): the `"minecraft:custom_components": [...]` array was **removed** at 1.21.90. Custom components are listed directly in `components`, with optional parameters:
  ```json
  "components": { "family:seat": { "height": 8 } }
  ```
  Handlers receive `(event, params)`; read `params.params.height`. Registration:
  ```js
  system.beforeEvents.startup.subscribe((init) => {
    init.blockComponentRegistry.registerCustomComponent("family:seat", { onPlayerInteract(e, p) { /* ... */ } });
  });
  ```
- `minecraft:collision_box`: `origin` in `[-8, 0, -8]..[8, 16, 8]`; `origin + size` ≤ `[8, 24, 8]` (the extra 8 on y and the array-of-boxes form are stable since 1.26.0). `false` disables collision. Up to 16 boxes in array form.
- `minecraft:selection_box`: same origin range; `origin + size` ≤ `[8, 16, 8]`. `false` disables selection.
- `minecraft:geometry`: block models may be up to **30×30×30** pixels with at least one pixel on each axis inside the 16×16×16 unit cube; transformed models must still respect the limit. Per-face UV form: a face without an entry is not rendered. Faces may name a `material_instance`.
- `minecraft:material_instances`: **all instances of one block must use the same `render_method`**. `"*"` is the fallback instance. Methods: `opaque`, `alpha_test`, `blend`, `double_sided`, plus `*_to_opaque` variants since 1.21.80. `ambient_occlusion` is a float only since 1.26.0.
- `minecraft:transformation`: `rotation` in 90° steps, optional `rotation_pivot`; the rotated model must stay inside the geometry limits.
- `minecraft:placement_direction` trait: `minecraft:cardinal_direction` is the direction the **player** was facing when placing (`south` default); `y_rotation_offset` (90/180/270) shifts all horizontal values. `minecraft:sixteen_way_rotation` exists since 1.26.40 if finer rotation is ever wanted.
- `menu_category.category: "none"` is valid (hidden pieces). `group` values require a namespace since 1.21.60.
- `minecraft:light_emission`: integer 0–15.

## Resource pack

- Texture strategy: one solid 16×16 PNG per palette entry, registered in `terrain_texture.json` and referenced by a material instance per palette id. A W×1 palette strip would bleed under mipmapping (`num_mip_levels: 4`).
- Geometry `format_version` `"1.16.0"` is still what current examples use; not re-verified. Treat an `mct` warning as the cue to bump.
- `blocks.json` needs only `sound` for blocks whose textures come from material instances.
- The in-game font renders emoji as boxes; keep `.lang` values to letters.

## Tooling

- Validator: `@minecraft/creator-tools` **0.17.8** (2026-08-28), binary `mct`, Node 22+.
  ```sh
  npx mct validate default -i data/dist/current -o data/dist/report
  npx mct validate addon   -i data/dist/current -o data/dist/report-addon   # Marketplace rules, warnings only
  ```
  Suites: `all`, `default`, `addon`, `currentplatform`, `main`. Which suite is the right hard gate is *to confirm on first run*; `addon` is expected to flag naming/icon conventions that do not matter here.
- `@minecraft/server` dist-tags on 2026-09-13: `latest` = `2.9.0`, `rc` = `2.11.0-rc.1.26.60-preview.23`, `beta` = `2.12.0-beta.1.26.60-preview.23`. Stable line: 2.5.0 (26.0), 2.6.0 (26.10), 2.7.0 (26.20), 2.8.0 (26.30), 2.9.0 (26.40).

## Established while implementing (2026-09-14)

- `mct validate main` passes the generated pack with 0 errors / 0 warnings in about 1 s offline. Its report lands as `<input-folder-name>.csv`, `.mcr.json` and `.report.html` in the `-o` folder; the CSV `Type` column is what the server classifies (`Error`, `Test fail` → fail; `Warning`, `Recommendation` → surfaced).
- `mct validate addon` fails every hobby pack: it demands `creatorshortname_projectshortname:item` identifiers, `textures/blocks/<game>/` sub-folders and `pack_scope: world`. Not used.
- The `mct` CLI prints nothing and writes no report when it inherits a test runner's environment (`NODE_ENV=test`, `NODE_PATH`, `VITEST`). The server spawns it with a curated environment (PATH, HOME, TMPDIR, LANG only).
- `terrain_texture.json`: the community schema only accepts `"textures": [ "..." ]` (array). Bedrock treats a one-element array like a string, so the generator emits arrays.
- Entity and client-entity `format_version` follow the project format version (`1.26.40`); older values only draw recommendations, not errors.
- `render_method` for pieces with glass is `blend`, not `alpha_test`: the palette's glass has partial alpha, which `alpha_test` would cut to fully transparent.
- Merged geometry is small: the asymmetric chair fixture is 199 voxels → 8 cubes, 38 faces; the full 16³ cube → 1 cube.

## Device test results (iPad, Minecraft 26.32, 2026-09-14)

- **x axis is mirrored**: with `mirrorX: false` the chair's armrest came out on the opposite side. Bedrock block-model +x points west; `generator.mirrorX` now defaults to `true`. The back (north) was fine, so `rotationOffset` stays 0.
- **Left and right sides see-through (reported 2026-09-17)**: two pieces from a local-world pack showed holes in
  their sides. `toCube` mirrored the x positions *and* swapped the `east`/`west` uv keys, but the keys name world
  sides: the east face of a cube sits at its file −x side and is still called `east`. Blockbench's Bedrock codec
  reads files the same way (`parseCube`/`compileCube` negate x and keep the keys). Every merged box with only one
  exposed side drew its hidden side instead: 18–67 % of the east/west faces of the four pieces published at the
  time, and 14 of 86 on the device-tested chair, which nobody had noticed. `mirrorX` now keeps the keys (without
  it the piece is mirrored and the keys swap). *Device*: confirm the sides are
  closed after publishing, importing and activating the new version on the world.
- **Development packs work on iPad (2026-09-17)**: a pack folder moved with the Files app into
  `On My iPad/Minecraft/games/com.mojang/development_behavior_packs` (and `development_resource_packs`)
  appears under My Packs, activates on a world, and is **referenced, not copied**: replacing the folder's
  contents and re-entering the world shows the new geometry, colours and item names at once. No import, no
  version bump, no Storage cleanup, and the pack keeps one uuid and version forever. Verified with a two-piece
  test pack in two colour variants.
- **A Shortcut can do the placing, and an automation can run it (2026-09-17)**: one zip per destination folder,
  named exactly like that folder (Shortcuts names an extracted folder after the archive), then per folder:
  *Get Contents of URL* → *Extract Archive* → *Save Files* to `development_behavior_packs` /
  `development_resource_packs` with *Ask Where to Save* off and *Overwrite If File Exists* on. The destination
  is picked once in the action (default is iCloud Drive → Shortcuts) and remembered. Deleting the old folder
  first is optional; keep *Get File from Folder* (or *Get Contents of Folder* + *Filter Files*) → *Delete Files*
  as the fallback if a run duplicates a folder as "… 2". Automation: Automation → New → App → Minecraft →
  Is Opened → **Run Shortcut** → the shortcut, with *Ask Before Running* and *Notify When Run* off. Opening
  Minecraft ran it. Worth guarding on the home Wi-Fi name so launches away from home fail quietly.
- **A newer pack version was not picked up by the world**: version 1.0.4 (changed chair) was imported, yet the world kept showing the 1.0.3 model. The expectation was that the newest version is used automatically; it is not, at least while the older version is still installed. See step 5 of "After a Minecraft update" for the manual switch. **2026-09-15:** deleting the old copies from Storage does not make the world switch either; the new version must be activated on the world (Edit → Behavior Packs → My Packs), otherwise the world has no furniture pack and every piece is gone from the creative inventory.
- **Tapping a block in a creative world breaks it instantly**, so `onPlayerInteract` is not reachable by touch on a creative world. Seats now use a persistent rideable entity per placed chair (touch shows a ride button for rideable entities); `onPlayerInteract` remains for mouse/controller.
- `min_engine_version` 1.26.40 was refused by the 26.32 client (see the version table).
- **Entity format 1.26.20+ dropped `minecraft:pushable`** (now `pushable_by_entity` / `pushable_by_block`, see vanilla boat.json and iron_golem.json). Our seat entity declared 1.26.30 with the old component was silently dropped; the content log then showed `'family:seat' is not a valid entity type` from the script. Entity files are now pinned to **1.26.0** (verified against vanilla armor_stand.json) and the client entity to 1.10.0, independent of the block format version. mct's schema check did not catch this.
- A client entity needs **at least one render controller** (`[Animation][error] … render_controllers | Array too small (0 < 1)`). The invisible seat now has a render controller that draws an empty geometry.
- After mounting, Minecraft shows the dismount hint from `action.hint.action.<entity id>` (raw key visible on device without it); the pack ships that key and the older `action.hint.exit.<entity id>` form in its lang file. The iPad runs Minecraft in Dutch and still picks up the pack's `en_US.lang`, so one language file is enough.

## Java side: CraftEngine and Geyser (from documentation and source, 2026-09-14; server test pending)

- **CraftEngine** (docs: `configuration/*.yml|json` all loaded and merged; `pack.yml` with author/version/description/namespace; `resourcepack/assets/<ns>/{models,textures}/block/`). Blocks borrow vanilla states: `state: "minecraft:note_block[instrument=hat,note=0,powered=false]"` binds one state to one appearance; a `facing` property of type `horizontal_direction` auto-aligns on placement; `appearances.<name>.model: {path, y}` with `variants."facing=<dir>": {appearance}`; `settings` (`hardness`, `resistance`, `sounds`, `tags`, `luminance`, `item`); `loot.template: default:loot_table/self`; `behavior: {type: seat_block, seats: ["x,y,z [yaw]"]}` (positions rotate with `facing`; the docs' sofa uses `0,0,0`, so the y semantics are verified on the server via `java.seatOffset`). Items: `material`, root `item_model` (1.21.2+, auto = item id; forced explicitly here), `model: <ns>:block/<id>` (external model file), `data.item_name` (MiniMessage, `<!i>` = upright), `behavior: {type: block_item, block: {…inline…}}` registers the block under the item id. Reload: `/ce reload all` for models and textures. Vanilla model rotation `y` is clockwise seen from above; the docs' chessboard example uses south 0, west 90, north 180, east 270 with the model front on the south side, and so does Blockshop (`java.yaw`).
- **Geyser custom blocks** (`custom_mappings/*.json`, format 1, from the wiki and `BlockMappingsReader_v1.java`): entry keyed by the Java block id with `name`, `included_in_creative_inventory`, `only_override_states`, and `state_overrides` keyed by the full canonical property list (`instrument=…,note=…,powered=…`, alphabetical as Java's `StateDefinition` sorts them; Geyser looks up `<id>[<key>]` in its registry and refuses unknown states). Components sit **directly** in the override object: `geometry` (string id), `material_instances` (`texture`, `render_method`, `face_dimming`, `ambient_occlusion`), `collision_box`/`selection_box` (`origin`, `size`, same ranges as Bedrock blocks), `transformation.rotation` in 90° steps, `display_name`, `destructible_by_mining` (seconds, float), `light_emission`, `friction`, `place_air`, `unit_cube`, `tags`. Not under a `components` key. Geyser registers **one** Bedrock block (`geyser_custom:<name>`) whose block properties are the Java state properties in use and one permutation per override, so the per-state look comes from permutations, not from separate block names.
- **Geyser custom items v2** (Geyser ≥ 2.9.3 / build 1062, Java 1.21.4+): `{"format_version": 2, "items": {"minecraft:paper": [{"type": "definition", "model": "<item_model>", "bedrock_identifier": "ns:id", "display_name", "bedrock_options": {"icon", "creative_category": "items"|…, "creative_group", "allow_offhand", "display_handheld", "protection_value", "tags"}}]}}`; `model` is the Java `minecraft:item_model` component value the item must carry. Icons come from a Bedrock resource pack in Geyser's `packs/` folder via `textures/item_texture.json`. `enable-custom-content: true` in Geyser's config; the wiki says "restart the server" after adding mappings or packs.
- Bedrock rotation for the served pack: the local pack maps `cardinal_direction` north→0, east→270, south→180, west→90 (device-verified); cardinal_direction is the *player's* facing, and the block front faces the player, so front-facing south ↔ 0, north ↔ 180, west ↔ 270, east ↔ 90 = `java.bedrockYaw`, i.e. `(360 − javaY) % 360`.
- Note-block states in Java 1.20+: 23 instruments (`harp … custom_head`), notes 0–24, `powered` → 1150; allocation order starts at `powered=true`/`custom_head`. Superseded as the default carrier by leaves after the first Java client test (see the dev stack results).

## Dev stack results (docker-compose.yml on a Mac, 2026-09-15)

- Paper 26.2 (`paper-26.2-123`), CraftEngine 26.8.2 (Modrinth tags every build *beta*, so itzg needs `craftengine:beta`), Geyser 2.11.2-b1235, Floodgate 2.2.5. Geyser's generated config already has `enable-custom-content: true`; CraftEngine's generated config uses `resource-pack.hosting: [{type: self, ip: "auto", port: "auto", protocol: "http"}]` (a list, unlike the wiki's `packs:` form) and the first-start script rewrites `ip` to the LAN hostname.
- Publish inside the Blockshop container (mct included) → `POST /api/java/deploy` → RCON `ce reload all` (empty reply; the console shows `Loaded pack: blockshop`, items 109→111, blocks 40→42, pack generated and uploaded in 120 ms, **no state conflict warnings** next to CraftEngine's demo `default_assets`). `default:loot_table/self` comes from the `default_templates` pack, not from the demo pack.
- After `docker compose restart mc`, Geyser logs `Registered 207 custom block overrides` (199 built-in + our 8), `Registered 8 custom blocks` (7 built-in + **one** note_block block with 8 permutations), `Registered 3 custom items` (1 built-in + our 2). No mapping errors.
- CraftEngine's generated `resource_pack.zip` is deliberately unreadable to zip tools (protection); inspect the source under `resources/blockshop/` instead.
- pnpm 12 refuses `pnpm install` in Docker/CI while `allowBuilds` holds placeholders (`ERR_PNPM_IGNORED_BUILDS`); the workspace file now lists esbuild true, bufferutil/utf-8-validate false.
- **Java client, first look (2026-09-15): the floor under the chair showed the sky.** Cause: the carrier was a note block, which the client's block registry treats as a full *opaque* cube, so it culls the faces of neighbouring blocks that touch it; our model does not cover them and the ground's top face is simply not drawn. Nothing in a resource pack can change that; only the carrier can. CraftEngine's own non-full examples use non-occluding carriers (its sofa sits on bed states with an entity renderer; its docs list `leaves`, `tripwire`, `chorus` groups next to `note_block`/`mushroom` for full blocks). Blockshop now uses **leaves** (`java.carrier: leaves`, default): full-cube collision on client and server, `noOcclusion`, cutout render layer. CraftEngine's `internal/configuration/mappings.yml` remaps every vanilla leaves state except `distance=7,persistent=true` (per `waterlogged` value) onto that canonical look, which frees 13 non-waterlogged states per leaf type × 11 types = **143 states ≈ 35 pieces** (waterlogged states are left alone: Geyser would put water in the block). Model of the remap: the server world keeps real vanilla states, CraftEngine registers custom blocks server-side and rewrites *client-bound* state ids, so real leaves and note blocks in the world are never confused with furniture, whatever state Blockshop picks. Side effects of leaves: light passes through (softer shadows), clients may spawn the occasional falling-leaf particle under furniture that floats above air, cherry/pale-oak types are allocated last for that reason. `java.carrier: note_block` stays available for full-cube pieces.
- **Java client with the leaves carrier (2026-09-15): floor correct; the chair swayed "as if on water".** Vanilla 26.2 animates no leaves; it was the shader pack (Complementary Reimagined → Materials → Waving Textures → Waving Leaves), which waves any block with a leaves id. Toggle off per client; Bedrock players get a real custom block and are not affected.
- **iPad joined (2026-09-15)**: Bedrock 26.32 against Geyser 2.11.2 (supports 26.0–26.45); the served pack downloaded on join and the chairs placed by the Java client showed up, but only after a server restart, because the pack file had been replaced under a running Geyser (it caches manifest and size at load). Geyser answers Bedrock pings on the LAN address through Docker's port publishing; the macOS application firewall did not need changes (Docker.app is allowed, signed software auto-allowed). Bedrock does not list the server under LAN Games (no broadcasts through Docker), so it is added by IP and port 19132.
- **Update path (2026-09-15)**: `ce reload all` after a deploy → the Java client saw the edited chair immediately, no rejoin (CraftEngine re-sends its pack). `geyser reload` → Bedrock players are kicked ("Reloading Geyser configurations... all connected bedrock clients will be kicked"), the instance restarts *without* the "Registered … custom blocks/items" lines, and the iPad saw the edited chair after rejoining. So a reload re-reads the served pack but not the mappings: edits need the reloads, new pieces need a Paper restart. The deploy step now tracks `mappingsChanged` and `packChanged` separately and runs `ce reload all; geyser reload` by default.
- **Recoloured table not showing on the iPad (2026-09-15)**: the edit added a palette colour, which added a material instance to the Geyser block mapping; Geyser had the old list, so the new faces fell back to `*` and the table looked unchanged after the reload. A Bedrock custom block's material-instance *names* and boxes are part of the startup-time definition, only the geometry is in the pack. The mapping now lists the whole palette for every piece and uses full-cube boxes, so shape and colour edits never touch it; and the deploy keeps "restart pending" sticky until the server really restarts (log line `Registered … custom blocks` after the deploy mark, or a rotated `latest.log`).
- **New piece after an automatic restart (2026-09-15)**: Bedrock showed it, Java showed azalea leaves. CraftEngine loads the new config at startup (`Loaded items (112)`) but does not regenerate its resource pack; it serves the zip from its last upload (`storage_path`, "loaded again after a restart"). `ce reload all` regenerated and re-sent it. The deploy now waits for RCON after its restart and runs the non-Geyser commands again.
- **Getting the item (2026-09-15)**: a vanilla Java client's creative inventory never lists CraftEngine items (CraftEngine's creative-tab injection goes through its client mod channel only); `/ce` opens its item browser, and a `categories` entry in our config lists the pieces there. The iPad's creative Items tab does show the Geyser custom items, but a piece dragged to the hotbar vanishes: the pickup reaches Java as `minecraft:paper` + `item_model` without CraftEngine's custom data, and the server drops it silently (nothing in the log). `ce item give .<player> family:piece_3 1` from the console worked at once ("Gave 1 family:piece_3 to .<player>"; Floodgate names keep their `.` prefix in `list` and in commands), so the editor got a "Get it in Minecraft" button on that path (removed again on 2026-09-15 once the BlockshopCatalog plugin's `/cat` menu covered it), and the Geyser item definitions no longer carry a `creative_category` (a tab full of pieces that vanish only confuses).
- **Furniture menu plugin (2026-09-15)**: Paper 26.2's API jars are compiled for Java 25 (`class file has wrong version 69.0`), so the plugin builds with `maven:3.9-eclipse-temurin-25` and `maven.compiler.release` 25; the itzg image already runs Java 25. Floodgate forms come from `org.geysermc.floodgate:api:2.2.5-SNAPSHOT` (repo.opencollab.dev), Cumulus `SimpleForm.builder().title().content().button(text, FormImage.Type.PATH, "textures/items/family_piece_1")` with `validResultHandler(r -> r.clickedButtonId())`, sent with `FloodgateApi.getInstance().sendForm(uuid, builder)`; responses arrive off the main thread, so commands are dispatched via the scheduler. The catalog item is recognised by its `item_model` (`ItemMeta.getItemModel()`, Paper 1.21.2+), which avoids a compile dependency on CraftEngine.
- **Plugin deploy observed (2026-09-15, v1.0.17)**: publish → jar + pieces.json synced → `docker restart mc` → post-restart `ce reload all`. Log: `[BlockshopCatalog] Enabling BlockshopCatalog v0.1.0`, `pieces.json: 5 pieces, v1.0.17; floodgate present`, CraftEngine `Loaded items (115)` (one more than the previous run with the same blocks, i.e. the catalog item), Geyser `Registered 7 custom items` (one more). No API-version complaint from Paper 26.2 for `api-version: '1.21'`.
- CraftEngine item config: vanilla data components (`item_name`, `max_stack_size`, ...) go under `data`; the
  `settings` block is only for CraftEngine's own mechanics. An unknown setting can make CraftEngine skip the whole item,
  which for the catalog would look like "the plugin does nothing" (nobody gets a catalog on join).
- On Java, right-clicking the catalog item is handled by CraftEngine's own `right_click` event on the item (opens the
  browser); the plugin only handles right-click for Bedrock players so the browser does not open twice.
- **Menu on the iPad, first try (2026-09-15)**: the form opened and the choice was given, but the piece landed in
  another slot while the catalog stayed in hand, so tapping the ground reopened the form (that is the right-click
  trigger) instead of placing anything. Fix: after the give the plugin finds the piece (`item_model` match), swaps it
  into the hotbar when it landed in the main inventory, and selects its slot (`setHeldItemSlot`, which Geyser forwards
  as a hotbar packet). The hotbar-select trigger is Bedrock-only now; on Java the scroll wheel passes through slots.
- **Bedrock far taps place in the sky (2026-09-15)**: Geyser forwards a Bedrock block click as `ServerboundUseItemOn`
  at the reported position after its own reach check, whatever block is there; for a non-block item (our pieces are
  paper on the Bedrock side) a tap beyond reach reports the air block at the end of the reach ray. CraftEngine's
  `ItemEventListener.onInteractBlock` (HIGHEST, ignoreCancelled) then runs `BlockItemBehavior.useOnBlock`, air is
  replaceable, and the piece lands in mid-air. CraftEngine has no `use` on air for block items, so right-click-air is
  harmless. Fix in the plugin: cancel RIGHT_CLICK_BLOCK on an air block for Bedrock players holding a custom item
  (non-`minecraft` `item_model`), with a "Too far away" action bar.
- **"x, y, z is under spawn protection" (2026-09-15)**: vanilla `spawn-protection=16` (translatable `build.spawn_protection`)
  blocks non-op players near the world spawn; the Java tester is op, the iPad account is not. `SPAWN_PROTECTION: "0"`.
- Still to observe with clients: the menu on the iPad (form opens on hotbar select, pictures show, choice gives the item), facing, sit, break.
- *Device*: **Download** makes a profile's pack file (validated) and the Ready dialog's steps still import it
  on a second device; and **Update the family server** now takes everyone's pieces as they are, with nobody
  having pressed anything first.
- **The live packs work on a tablet (iPadOS 16.5, Minecraft 26.32, 2026-09-18)**: one Shortcut (download →
  extract → *Get contents of folder* on the extracted output → filter on `_bp` / `_rp` → two *Save Files*) keeps
  a tablet's own worlds current, run by the app-open automation. *Get contents of folder* flattens the archive's
  `behavior/` and `resource/`, so the two filters route the packs and nothing navigates into either.
  **`Save Files` needs *Overwrite If File Exists* on**, for folders as much as files: without it every run saved
  another copy as `blockshop_<ns>_rp-2`, `-3`, several copies of one pack claimed the same blocks, and Minecraft
  showed items with no model and turned placed furniture invisible (an invisible seat also kept a player from
  moving until they stood up). With the toggle on, a run replaces the folders. Recipe in docs/ipad-setup.md.
- *Device*: **the live packs**, still to check: that a world can enable one kid's pack and leave another's off,
  and that furniture placed from a profile's imported pack survives switching that world to the live pack.
  (Seats already work: a placed chair mounted a player on 2026-09-18.)

## Still open (device)

| # | Question | Plan until answered |
|---|---|---|
| 5 | ~~`minecraft://?import=<http URL>`~~ → tested 2026-09-14 on iPadOS / Minecraft 26.32: Minecraft opens but **nothing is imported** (plain-http LAN URL). The download path works: tap the link, tap Safari's download arrow, tap the file; Minecraft opens and imports. | Download is the only path; the deep link was dropped. |
| 7 | `.mcaddon` with two pack folders at the zip root vs nested `.mcpack`s. | Folders. Confirm on a device. |
| 8 | ~~World picks up version N+1 automatically~~ → **no** (observed 2026-09-14): the world kept the old version. | Manual switch, see item 11. |
| 10 | ~~Rotation sign and x-axis mirroring~~ → resolved 2026-09-14: x is mirrored (default `mirrorX: true`), rotation is fine. | — |
| 11 | ~~How does a world move to a newer pack version?~~ → settled 2026-09-14. **Model:** activating a pack copies it into the world folder ("behavior packs will be imported into the world files, and are kept when exporting the world" — minecraft.wiki); an import with a higher version replaces the *global* copy only ("The new pack will replace the old one if the version is higher, and ignored if it's the same or lower" — manifest reference). So the world keeps running its own stale copy: that is the v1.0.5 tile under Active next to v1.0.6 under My Packs. The world copy is refreshed by re-applying the pack (deactivate/activate) or by deleting the stale copy in Settings → Storage, which is what worked on the iPad. Mojang's answer for iteration is `development_*_packs`, which are referenced, not copied, and reload on world join; on iOS those folders are reachable only through the Files app. Zero-touch for players means server delivery (BDS or Geyser). | Ready card carries the routine. |

## After a Minecraft update

Minecraft changes the add-on format from time to time. When the tablets or the server move to a new Minecraft
version, check once, in a copy of a test world:

1. In a profile's gallery, press **Download**, download the pack and open it on the tablet. Minecraft
   shows "Successfully imported".
2. Edit the world → Behavior Packs → My Packs, and activate *<Name>'s Furniture*. Its resource pack comes along.
3. Place a chair facing each of the four directions. Its back should point away from you, with the armrest on
   the same side as in the editor. If not, change `generator.rotationOffset` or `generator.mirrorX` in
   `profiles/<id>/project.json` and publish again.
4. Sit on a chair, walk into a table, and look at a piece with glass and a piece with light.
5. Change a piece, publish and import it. Delete the older copies in Settings → Storage (Behavior Packs and
   Resource Packs), then activate the new version on the world.
6. For the family server, run the verification checklist in `docs/family-server-internals.md`.

Write down anything that changed in this file.

## Sources

- https://wiki.bedrock.dev/blocks/block-format-history
- https://wiki.bedrock.dev/blocks/block-components
- https://wiki.bedrock.dev/blocks/block-models
- https://wiki.bedrock.dev/blocks/block-traits
- https://learn.microsoft.com/en-us/minecraft/creator/documents/scripting/custom-components?view=minecraft-bedrock-stable
- https://minecraft.wiki/w/Bedrock_Edition_version_history
- https://learn.microsoft.com/en-us/minecraft/creator/documents/mctoolsoverview?view=minecraft-bedrock-stable
- https://github.com/Mojang/minecraft-creator-tools/blob/main/README.md
- npm registry metadata for `@minecraft/server` and `@minecraft/creator-tools` (queried 2026-09-13)
- https://geysermc.org/wiki/geyser/custom-blocks/ and https://geysermc.org/wiki/geyser/custom-items/ (with `core/src/main/java/org/geysermc/geyser/registry/mappings/versions/block/BlockMappingsReader_v1.java` on GitHub)
- CraftEngine wiki (Xiao-MoMi/craft-engine-wiki): block states, block item, seat block, item models, project structure
