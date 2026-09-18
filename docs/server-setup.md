# Family server setup

Kids build furniture in Blockshop in a browser. A grown-up puts it on a shared Minecraft server with one
button, and everyone picks it from a menu in game, on Java and on Bedrock (tablets, phones, consoles).

This guide runs everything with Docker Compose on one computer: a Paper server with Geyser, Floodgate and
CraftEngine, and Blockshop next to it.

## 1. Create the files

Make a folder, for example `minecraft/`, with these two files.

`docker-compose.yml` (also in [deploy/docker-compose.yml](../deploy/docker-compose.yml)):

```yaml
services:
  mc:
    image: itzg/minecraft-server:java25-alpine
    restart: unless-stopped
    environment:
      EULA: "true"
      TYPE: PAPER
      VERSION: "26.2"
      MODE: creative
      SPAWN_PROTECTION: "0"
      RCON_PASSWORD: ${RCON_PASSWORD:?set RCON_PASSWORD in the .env file}
      PLUGINS: |
        https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/spigot
        https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot
      MODRINTH_PROJECTS: |
        craftengine:beta
    ports:
      - "25565:25565"          # Java
      - "19132:19132/udp"      # Bedrock
    volumes:
      - ./data:/data

  blockshop:
    image: ghcr.io/fdeantoni/blockshop:0.4.0
    restart: unless-stopped
    depends_on:
      - mc
    user: "1000:1000"
    environment:
      HOST_URL: http://192.168.1.20:8081      # change: this computer's address as other devices reach it
      RCON_PASSWORD: ${RCON_PASSWORD:?set RCON_PASSWORD in the .env file}
    ports:
      - "8081:8081"
    volumes:
      - ./blockshop:/blockshop/data
      - ./data/plugins:/mc/plugins
      - ./data/logs:/mc/logs:ro
```

`.env`:

```sh
RCON_PASSWORD=pick-a-long-random-password
```

Change `HOST_URL` to this computer's address on your network, keeping port 8081.

## 2. Start it

```sh
mkdir -p blockshop && sudo chown 1000:1000 blockshop   # Blockshop's data folder, owned by the server's user
docker compose up -d mc
docker compose logs -f mc                               # wait for: Done (…)! For help, type "help"; then Ctrl+C
```

The first start downloads Paper and the plugins, and the plugins write their config files. Change two
settings in those files:

- In `data/plugins/Geyser-Spigot/config.yml`, under `gameplay`, set `enable-custom-content: true`.
- In `data/plugins/CraftEngine/config.yml`, under `resource-pack` → `delivery` → `hosting`, set the `ip` of
  the `self` entry to this computer's address, for example `ip: "192.168.1.20"`. The default `auto` hands
  Java players your public IP, which does not work inside a home network.

Then restart the server and start Blockshop:

```sh
docker compose restart mc
docker compose up -d blockshop
```

## 3. Use it

1. Open `http://192.168.1.20:8081` (your address) in a browser. The setup screen creates the grown-up
   profile and its PIN.
2. On the grown-up page, add a profile for each kid with a name and an icon. There are up to five profiles; a
   friend who is visiting gets a **guest** profile, which stays off the family server unless you turn that on.
   Pieces are limited only by what the shared world can hold (35), and only the pieces chosen for it count.
3. Kids build furniture; a tablet set up as in [ipad-setup.md](ipad-setup.md) picks it up by itself, and
   **Download** makes a pack file, which can also be downloaded
   for a device's own worlds. It does not change the server.
4. When you want the furniture on the server, open the grown-up page and press **Update the family server**.
   The page shows who is online and whether the update will restart the server. New furniture needs a
   restart; changes to existing pieces only need a reload.
5. If the page asks for a restart, run `docker compose restart mc` and press **The server was restarted**.
   To have Blockshop restart the server itself, see [Options](#let-blockshop-restart-the-server).
6. In game, `/cat` opens the furniture menu. `/cat 9` puts the catalog item in hotbar slot 9; tapping it
   opens the menu too. Bedrock players get a menu with pictures, Java players CraftEngine's item browser.

Players join at the same address: Java on port 25565, Bedrock on port 19132.

## Options

Set these under `environment:` of the `blockshop` service.

| Variable | Default | What it does |
|---|---|---|
| `HOST_URL` | none, set it | Address other devices use to reach Blockshop. Used in download links. |
| `RCON_PASSWORD` | none, set it | Same password as the server. Blockshop uses it to reload the server and to see who is online. |
| `RCON_HOST` | `mc` | Name of the server service, if yours is not called `mc`. |
| `JAVA_DEPLOY` | `on` | `off` turns the family server off. Blockshop then only makes packs to download for a device's own worlds. |
| `JAVA_RESTART_COMMAND` | empty | A command that restarts the server when an update needs it. See below. |
| `ADMIN_PIN` | empty | Forgot the PIN? Set a new one of 4 to 8 digits and run `docker compose up -d blockshop`. Then remove the line and run it again. |
| `UI_TITLE` | `Blockshop` | Name shown in the browser tab. |
| `VALIDATE` | `true` | Checks every pack with Minecraft Creator Tools before it is published. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `JAVA_RCON_COMMANDS` | `ce reload all; geyser reload` | Commands sent after an update that needs no restart. `geyser reload` makes Bedrock players rejoin. |
| `JAVA_RESTART_WAIT_MS` | `180000` | How long to wait for the server to come back after a restart. |
| `RCON_TIMEOUT_MS` | `120000` | How long to wait for an answer from the server. |

### Let Blockshop restart the server

Blockshop can restart the server through Docker. This gives the Blockshop container control over every
container on the computer, so leave it out if that worries you. Merge these lines into the two services:

```yaml
services:
  mc:
    container_name: mc
  blockshop:
    group_add: ["988"]        # the docker group's id on this computer: getent group docker | cut -d: -f3
    environment:
      JAVA_RESTART_COMMAND: docker restart mc
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

On Docker Desktop (Mac or Windows), leave out `group_add` and remove `user: "1000:1000"` instead.

### Another port

If port 8081 is taken, change the left number under `ports` (for example `"8090:8081"`) and use the same port
in `HOST_URL`.

## Updating Blockshop

Change the version in `image: ghcr.io/fdeantoni/blockshop:…`, then:

```sh
docker compose pull blockshop
docker compose up -d blockshop
```

Profiles, pieces and history stay in `./blockshop`. If the new version includes a new menu plugin, the next
server update asks for a restart.

## Backups

Back up `./data` (the world and the plugins) and `./blockshop` (profiles, pieces and pack history) together.

## Already have a server?

Add the `blockshop` service to your compose file and point its last two mounts at your server's `plugins`
and `logs` folders. Your server needs Paper 1.21.4 or newer, Geyser and Floodgate, CraftEngine, and a fixed
RCON password. Then follow step 2 for the two settings. Set `user:` to the user that owns your server's files.

## Troubleshooting

- **Bedrock players don't see the furniture.** Check `enable-custom-content: true` in Geyser's config, and
  restart the server if the grown-up page says a restart is pending.
- **Java players see leaves instead of furniture.** Their resource pack did not download. Check the `ip`
  in CraftEngine's config, then run `docker compose exec mc rcon-cli ce reload all`.
- **"x, y, z is under spawn protection".** Set `SPAWN_PROTECTION: "0"` on the server, or make the player an
  operator.
- **Furniture sways on Java.** A shader pack with waving leaves is active. The furniture is stored as leaves
  blocks, so turn waving leaves off in the shader settings.
- **Glass looks solid on Java.** That is a known limit of the Java version.
- **The browser can't reach Blockshop.** Check that port 8081 is open in the computer's firewall.

How it works under the hood: [family-server-internals.md](family-server-internals.md).
