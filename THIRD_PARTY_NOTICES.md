# Third-party notices

Blockshop itself is licensed under the GNU Affero General Public License v3.0 or later (see [LICENSE](LICENSE)).
It uses the open source software below. Each component keeps its own license; none of them is modified.

## Editor (the web page served by Blockshop)

The editor bundle includes:

| Component | License |
|---|---|
| [three.js](https://github.com/mrdoob/three.js) | MIT |
| [zod](https://github.com/colinhacks/zod) | MIT |

The build writes their full license texts to `third-party-licenses.txt` next to the editor, linked from its footer.

## Docker image (`ghcr.io/fdeantoni/blockshop`)

The image contains Blockshop's production dependencies from npm, installed unmodified. Each package's license text
is inside the image under `/app/node_modules/.pnpm/<package>/node_modules/<package>/`.

| Component | License | Notes |
|---|---|---|
| [Fastify](https://github.com/fastify/fastify), [@fastify/static](https://github.com/fastify/fastify-static) | MIT | web server |
| [zod](https://github.com/colinhacks/zod) | MIT | |
| [fflate](https://github.com/101arrowz/fflate) | MIT | zip files |
| [pngjs](https://github.com/pngjs/pngjs) | MIT | PNG textures |
| [Minecraft Creator Tools](https://github.com/Mojang/minecraft-creator-tools) (`@minecraft/creator-tools`) | MIT | pack validation. Its assets under `res/latest/van` are subject to the [Minecraft End User License Agreement](https://www.minecraft.net/eula). |
| [resvg-js](https://github.com/thx/resvg-js) (`@resvg/resvg-js`) | MPL-2.0 | used by Minecraft Creator Tools; source code at the link |
| [JSZip](https://github.com/Stuk/jszip) | MIT or GPL-3.0 | used under the MIT license |
| [Playwright](https://github.com/microsoft/playwright), [RxJS](https://github.com/ReactiveX/rxjs), localforage, before-after-hook | Apache-2.0 | used by Minecraft Creator Tools |
| glob, minimatch, minipass, lru-cache, path-scurry | BlueOak-1.0.0 | |
| esprima, esprima-next, json-schema-typed | BSD-2-Clause | |
| pako | MIT and Zlib | |
| type-fest | MIT or CC0-1.0 | |
| json-schema | AFL-2.1 or BSD-3-Clause | |
| jsonify | Public Domain | |
| tslib | 0BSD | |
| about 300 further packages | MIT, ISC or BSD-3-Clause | |

The image is based on the official [Node.js image](https://hub.docker.com/_/node) (`node:22-alpine`): Node.js is
MIT licensed, and the Alpine Linux packages carry their own licenses (BusyBox, for example, is GPL-2.0; sources are
available from Alpine Linux). The image adds Alpine's `docker-cli` package (Apache-2.0).

## BlockshopCatalog plugin (`plugin/`)

The plugin jar contains only Blockshop code. It is compiled against these APIs, which are not included in the jar:

| Component | License |
|---|---|
| [Paper API](https://github.com/PaperMC/Paper) | GPL-3.0, parts MIT |
| [Floodgate API](https://github.com/GeyserMC/Floodgate) and [Cumulus](https://github.com/GeyserMC/Cumulus) | MIT |

## Used at runtime, not included

The example compose file in `deploy/` downloads these; Blockshop does not redistribute them:
[Paper](https://github.com/PaperMC/Paper) (GPL-3.0), [CraftEngine](https://github.com/Xiao-MoMi/craft-engine) (GPL-3.0),
[Geyser and Floodgate](https://github.com/GeyserMC) (MIT), and the
[itzg/minecraft-server](https://github.com/itzg/docker-minecraft-server) image (Apache-2.0). Running a Minecraft server
requires accepting the [Minecraft End User License Agreement](https://www.minecraft.net/eula).

## Minecraft

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
Minecraft is a trademark of Mojang Synergies AB.
