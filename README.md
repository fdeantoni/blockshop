# Blockshop

A web app where kids build furniture as 3D pixel art on a tablet and get it as custom blocks in Minecraft: in
their own Bedrock worlds, and on a shared family server that Java and Bedrock players join.

- **Set up a family server:** [docs/server-setup.md](docs/server-setup.md)
- **Keep a tablet's own worlds up to date by itself:** [docs/ipad-setup.md](docs/ipad-setup.md)
- How the server export works: [docs/family-server-internals.md](docs/family-server-internals.md)
- Verified Bedrock format facts, and what to check after a Minecraft update: [docs/format-notes.md](docs/format-notes.md)

## What it does

- **Build.** A touch editor in the browser, made for iPad Safari: place and erase voxels on a 16×16×16 grid,
  pick colours, start from templates (chair, sofa, table, lamp, TV and more), mark seats and light.
- **Tablets update themselves.** A tablet fetches everyone's furniture as live packs and drops them straight
  into Minecraft's development pack folders, so its own worlds pick up new and changed pieces when they load,
  with no importing and no pack versions ([docs/ipad-setup.md](docs/ipad-setup.md)).
- **Download.** *Download* makes that profile's Bedrock add-on (`.mcaddon`), validated with Minecraft Creator
  Tools, for another device or for a friend. It is on the home screen and in the gallery.
- **Family server.** A grown-up presses one button to merge every profile's furniture into a Paper server with
  CraftEngine and Geyser. In game, `/cat` opens a furniture menu with pictures.

Without a Minecraft server, run only the `blockshop` service from the [setup guide](docs/server-setup.md) with
`JAVA_DEPLOY: off`; the packs are then only for devices' own worlds.

## Profiles

Every person has a profile: a name, an icon and their own pack (own namespace, UUIDs, version counter, pieces,
history), at most five profiles. The first visit shows a setup screen: the grown-up picks
a PIN and makes their own profile, then adds the kids on the grown-up page (`#/admin`). A friend visiting for an
afternoon gets a **guest** profile there: the same editor and the same packs for their own worlds, but off the
family server unless a grown-up turns that on. The home screen lists all profiles with *Open* and *Download*, so
a kid can import anyone's pack into a local world; each kid bookmarks their own gallery (`#/p/<id>`). *Download*
makes that profile's pack file. A kid may change their own icon; renaming, removing and the family server are
behind the PIN. A forgotten PIN is replaced by starting the server once with `ADMIN_PIN=<digits>`. Data layout:
`DATA_DIR/blockshop.json` (profiles, PIN hash, export counter), `profiles/<id>/` (one project each), `server/`
(shared Java states and the merged export), `deleted/` (folders of removed profiles).

**What goes on the family server.** A tablet's own worlds get everything a profile has. The shared world has room
for 35 pieces in total, whoever they belong to, because each one takes four Java block states that are never
reused. That is the only count that matters: a profile's own worlds can hold as much as its packs carry, and a
new piece stays at home until someone chooses it: long-press it in the gallery and answer *On the family server?*, or use
the 🏠 button while building. A card with a green outline is on the server. A piece on it can only be hidden, not deleted, because
other people have it placed in the shared world; take it off the server first. The grown-up page shows how much room
is left, and choosing one more than fits is refused there and then. Taking a piece off after it has been on the
server makes anything already placed there turn into leaves.

## Templates

"New" opens a *Start from…* picker: an empty grid or one of the templates in
[`packages/editor/src/templates.ts`](packages/editor/src/templates.ts) (chair, armchair, sofa, stool, table, desk,
lamp, TV, bookshelf, plant, bed, bath). A pick creates a piece with a copy of the template's voxels, seat and light,
named after it. Long-pressing a gallery card offers *Copy* as well. To add a template, append an entry built from
`box`/`shape`/`cut` (x left→right, y up, z back→front, colours from `DEFAULT_PALETTE`); `pnpm test` checks that
every template fits the grid, uses known colours and stands on the floor. The pictures in the picker are rendered
in the browser at first use, per profile. New default colours are appended to every profile's palette when the
server starts; the first server update afterwards restarts the family server once (the Geyser mapping lists the palette).

## Layout

| Package | What |
|---|---|
| `packages/schema` | zod schemas and types for pieces, projects, palettes and profiles |
| `packages/generator` | pure `buildPack(project, pieces)` → Bedrock behavior + resource pack, zip, sanity checks; `buildServerPack` for CraftEngine + Geyser; `pnpm gen` CLI |
| `packages/server` | Fastify API, JSON-on-disk store, pack builder with Minecraft Creator Tools validation, live packs for tablets, family server export, serves the editor |
| `packages/editor` | Vite + Three.js touch editor for iPad Safari |
| `plugin` | BlockshopCatalog, the Paper plugin with the in-game furniture menu (built in the Docker image) |

## Develop

Node 22 and pnpm (via corepack). Docker for the full stack.

```sh
pnpm install
pnpm test                       # unit and integration tests (BLOCKSHOP_SKIP_MCT=1 skips the validator)
pnpm gen --all fixtures/pieces --out tmp --mcaddon   # generate packs from fixtures
pnpm gen --java --all fixtures/pieces                # the family server export for the fixtures, under tmp/java/
pnpm validate tmp/packs         # run Minecraft Creator Tools on them
pnpm seed                       # a "family" profile with the fixture pieces in DATA_DIR (once); the setup screen then adds the PIN
pnpm dev:server                 # API on :8080 (reads .env; copy .env.example)
pnpm dev:editor                 # Vite dev server with /api proxied to :8080
pnpm build && pnpm start        # production: server serves the built editor at /
pnpm rollback --profile robin --list   # history; pnpm rollback --profile robin 1.0.4 restores that snapshot
```

Open `tmp/preview/*.geo.json` in Blockbench with the palette textures next to them for a visual check.

**From a tablet.** Set `HOST_URL=http://<computer-name>.local:8080` in `.env` (on a Mac the name is in System
Settings → General → Sharing), then `pnpm build && pnpm start`. Allow node through the firewall when asked, and
open the same address on the tablet.

**The whole stack.** `docker-compose.yml` in the repo root is the stack from the setup guide with Blockshop built
from this checkout; state lives under `stack/`. Set `BLOCKSHOP_HOST_URL` in `.env` (see `.env.example`), then:

```sh
docker compose up -d mc                 # first start; then the two plugin settings from the setup guide, step 2
docker compose restart mc
docker compose up -d --build blockshop  # again after every code change
docker compose exec mc rcon-cli op <you>
```

Here Blockshop runs as root with the Docker socket mounted, so it restarts the server itself.

## Releases

Pushing a `v*` tag runs CI and publishes `ghcr.io/fdeantoni/blockshop:<version>` for amd64 and arm64. Bump the
version in the five `package.json` files, `plugin/pom.xml` and `plugin/src/main/resources/plugin.yml`, and the image
tag in `deploy/docker-compose.yml` and `docs/server-setup.md`.

## License

Copyright (C) 2026 fdeantoni

Blockshop is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public
License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
version. See [LICENSE](LICENSE).

If you run a modified Blockshop for other people, the license asks you to offer them its source code. The footer of
the home and grown-up pages links to the source; change `SOURCE_URL` in `packages/editor/src/i18n.ts` to point at
your version.

Third-party components and their licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
