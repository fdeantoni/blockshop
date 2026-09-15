package family.blockshop.catalog;

import com.google.gson.Gson;
import com.google.gson.JsonSyntaxException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import net.kyori.adventure.text.Component;
import org.bukkit.Bukkit;
import org.bukkit.NamespacedKey;
import org.bukkit.block.Block;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerItemHeldEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.PlayerInventory;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.plugin.java.JavaPlugin;
import org.geysermc.cumulus.form.SimpleForm;
import org.geysermc.cumulus.util.FormImage;
import org.geysermc.floodgate.api.FloodgateApi;

/**
 * Furniture menu for the family server.
 *
 * <p>Blockshop writes {@code pieces.json} into this plugin's folder on every family-server update: one group
 * per profile (each person's pack) with its visible pieces. {@code /cat} (or
 * {@code /catalog}) opens the menu; {@code /cat <1-9>} gives the player the catalog item if they do not
 * have it and puts it in that hotbar slot. With the item in hand, Bedrock players open the menu by tapping
 * its hotbar slot or the ground. Bedrock players get a native form with one picture button per piece (with
 * several groups it first asks whose furniture). The
 * chosen piece is given with {@code ce item give} (the one path that hands out a real CraftEngine item on
 * both editions), then moved into the hotbar if needed and selected, so the next tap on the ground places
 * it while the catalog stays in its slot. Java players get CraftEngine's item browser: right-click is
 * CraftEngine's own event on the item, {@code /cat} works too; the hotbar trigger is Bedrock-only because
 * a Java scroll wheel passes through slots.
 */
public final class CatalogPlugin extends JavaPlugin implements Listener {
  private static final Gson GSON = new Gson();
  private static final int HOTBAR = 9;
  private static final int STORAGE = 36;
  private static final int OFFHAND = 40;
  private static final int FIND_TRIES = 10;
  private static final long GIVE_GRACE_MS = 2000;

  /** Shape of pieces.json (written by Blockshop). */
  static final class Catalog {
    String version;
    String catalogItem;
    Ui ui;
    List<Group> groups;

    int pieceCount() {
      int n = 0;
      for (Group g : groups) if (g.pieces != null) n += g.pieces.size();
      return n;
    }
  }

  static final class Ui {
    String title; String chooseGroup; String content; String back; String empty; String given; String failed; String tooFar; String full;
    String pinned; String usage;
  }

  /** One profile's pack: its name and visible pieces. */
  static final class Group { String id; String name; List<Piece> pieces; }

  static final class Piece { String id; String item; String name; String icon; }

  private final Map<UUID, Long> lastOpen = new HashMap<>();
  private final Map<UUID, Long> giving = new HashMap<>();
  private Path piecesFile;
  private boolean floodgate;
  private Catalog cached;
  private FileTime cachedAt;

  @Override
  public void onEnable() {
    saveDefaultConfig();
    getConfig().options().copyDefaults(true);
    saveConfig();
    piecesFile = getDataFolder().toPath().resolve("pieces.json");
    floodgate = getServer().getPluginManager().getPlugin("floodgate") != null;
    getServer().getPluginManager().registerEvents(this, this);
    Catalog c = load();
    getLogger().info("pieces.json: " + (c == null ? "not there yet (update the family server from Blockshop)" : c.groups.size() + " group(s), " + c.pieceCount() + " pieces, v" + c.version)
        + "; floodgate " + (floodgate ? "present" : "absent, Bedrock players get the Java browser")
        + (getConfig().getBoolean("give-on-join", false) ? "; give on join" : ""));
  }

  // ---- the command: /cat, /cat <1-9>

  @Override
  public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
    if (!(sender instanceof Player p)) { sender.sendMessage("Players only."); return true; }
    Catalog c = load();
    if (c == null) { p.sendMessage("No furniture list yet: publish from Blockshop first."); return true; }
    if (args.length == 0) {
      lastOpen.remove(p.getUniqueId());
      open(p, c);
      return true;
    }
    int slot;
    try {
      slot = Integer.parseInt(args[0]);
    } catch (NumberFormatException e) {
      slot = 0;
    }
    if (slot < 1 || slot > HOTBAR) {
      p.sendMessage(text(c, "usage", "/cat opens the furniture menu. /cat 1-9 puts the catalog in that slot."));
      return true;
    }
    if (ensureCatalog(p, c, slot - 1)) {
      p.sendMessage(text(c, "pinned", "The catalog is in slot %slot%.").replace("%slot%", String.valueOf(slot)));
    }
    return true;
  }

  @Override
  public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
    List<String> out = new ArrayList<>();
    if (args.length != 1) return out;
    String prefix = args[0].toLowerCase(Locale.ROOT);
    for (int i = 1; i <= HOTBAR; i++) if (String.valueOf(i).startsWith(prefix)) out.add(String.valueOf(i));
    return out;
  }

  /**
   * Makes sure the player has the catalog, in hotbar slot {@code target} when that is 0-8; gives one when it
   * is missing. Returns false when nothing could be done (inventory full, or a give is still in flight).
   */
  private boolean ensureCatalog(Player p, Catalog c, int target) {
    if (!p.isOnline()) return false;
    NamespacedKey key = NamespacedKey.fromString(c.catalogItem);
    if (key == null) return false;
    PlayerInventory inv = p.getInventory();
    int slot = findCatalog(inv, key);
    if (slot >= 0) { moveTo(inv, slot, target); return true; }
    long now = System.currentTimeMillis();
    Long until = giving.get(p.getUniqueId());
    if (until != null && now < until) return false; // a give is in flight
    if (!hasEmptySlot(inv)) {
      p.sendMessage(text(c, "full", "Your inventory is full, so there is no room for the catalog. Free a slot!"));
      return false;
    }
    giving.put(p.getUniqueId(), now + GIVE_GRACE_MS);
    dispatch(getConfig().getString("give-command", "ce item give %player% %item% 1"), p, c.catalogItem);
    Bukkit.getScheduler().runTaskLater(this, () -> {
      if (!p.isOnline()) return;
      int s = findCatalog(inv, key);
      if (s >= 0) moveTo(inv, s, target);
    }, 2L);
    return true;
  }

  /** Swaps the catalog into hotbar slot {@code target} (whatever sat there takes the catalog's old slot). */
  private static void moveTo(PlayerInventory inv, int slot, int target) {
    if (target < 0 || target >= HOTBAR || slot == target) return;
    ItemStack catalog = inv.getItem(slot);
    inv.setItem(slot, inv.getItem(target));
    inv.setItem(target, catalog);
  }

  // ---- other triggers

  @EventHandler(priority = EventPriority.MONITOR)
  public void onJoin(PlayerJoinEvent e) {
    if (!getConfig().getBoolean("give-on-join", false)) return;
    Player p = e.getPlayer();
    Bukkit.getScheduler().runTaskLater(this, () -> {
      Catalog c = load();
      if (c != null) ensureCatalog(p, c, -1);
    }, 60L);
  }

  @EventHandler
  public void onQuit(PlayerQuitEvent e) {
    lastOpen.remove(e.getPlayer().getUniqueId());
    giving.remove(e.getPlayer().getUniqueId());
  }

  /** Tapping the catalog's hotbar slot (Bedrock only: on Java the scroll wheel passes through slots). */
  @EventHandler(ignoreCancelled = true)
  public void onHeld(PlayerItemHeldEvent e) {
    if (!floodgate || !isBedrock(e.getPlayer())) return;
    Catalog c = load();
    if (c == null) return;
    ItemStack held = e.getPlayer().getInventory().getItem(e.getNewSlot());
    if (isCatalog(held, c)) open(e.getPlayer(), c);
  }

  /** Tapping the ground with the catalog (Bedrock only: on Java CraftEngine's own right_click event on the item opens the browser). */
  @EventHandler
  public void onInteract(PlayerInteractEvent e) {
    if (e.getAction() != Action.RIGHT_CLICK_AIR && e.getAction() != Action.RIGHT_CLICK_BLOCK) return;
    if (!floodgate || !isBedrock(e.getPlayer())) return;
    Catalog c = load();
    if (c == null || !isCatalog(e.getItem(), c)) return;
    e.setCancelled(true);
    open(e.getPlayer(), c);
  }

  /**
   * Bedrock quirk: a tap beyond reach with a non-block item arrives as a block click on the air position at the end
   * of the reach ray, and Geyser forwards it as-is. CraftEngine's block-item placement then targets that air block and
   * the piece floats in the sky. A Java client never clicks an air block, so for Bedrock players a custom item used on
   * air is cancelled here, before CraftEngine's handler (HIGHEST priority, ignores cancelled events) runs.
   */
  @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
  public void onAirClick(PlayerInteractEvent e) {
    if (e.getAction() != Action.RIGHT_CLICK_BLOCK || !getConfig().getBoolean("bedrock-air-click-guard", true)) return;
    Block b = e.getClickedBlock();
    if (b == null || !b.getType().isAir()) return;
    if (!isCustom(e.getItem()) || !floodgate || !isBedrock(e.getPlayer())) return;
    e.setCancelled(true);
    e.getPlayer().sendActionBar(Component.text(text(load(), "tooFar", "Too far away! Walk closer and tap the ground.")));
  }

  // ---- the menu

  private void open(Player p, Catalog c) {
    long now = System.currentTimeMillis();
    Long last = lastOpen.get(p.getUniqueId());
    if (last != null && now - last < getConfig().getLong("debounce-ms", 700)) return;
    lastOpen.put(p.getUniqueId(), now);
    if (floodgate && isBedrock(p)) sendForm(p, c);
    else dispatch(getConfig().getString("java-open-command", "ce item browser %player%"), p, "");
  }

  private boolean isBedrock(Player p) {
    try {
      return FloodgateApi.getInstance().isFloodgatePlayer(p.getUniqueId());
    } catch (Throwable t) {
      getLogger().warning("floodgate lookup failed: " + t);
      return false;
    }
  }

  private void sendForm(Player p, Catalog c) {
    List<Group> groups = new ArrayList<>();
    for (Group g : c.groups) if (g.pieces != null && !g.pieces.isEmpty()) groups.add(g);
    if (groups.isEmpty()) {
      p.sendMessage(text(c, "empty", "No furniture yet."));
      return;
    }
    if (groups.size() == 1) sendPiecesForm(p, c, groups.get(0), false);
    else sendGroupForm(p, c, groups);
  }

  /** Whose furniture? One button per profile, with that pack's first piece as the picture. */
  private void sendGroupForm(Player p, Catalog c, List<Group> groups) {
    SimpleForm.Builder form = SimpleForm.builder().title(text(c, "title", "Furniture")).content(text(c, "chooseGroup", "Whose furniture?"));
    for (Group g : groups) {
      Piece first = g.pieces.get(0);
      if (first.icon != null && !first.icon.isEmpty()) form.button(g.name, FormImage.Type.PATH, first.icon);
      else form.button(g.name);
    }
    form.validResultHandler(response -> {
      int i = response.clickedButtonId();
      if (i < 0 || i >= groups.size()) return;
      Group g = groups.get(i);
      Bukkit.getScheduler().runTask(this, () -> { if (p.isOnline()) sendPiecesForm(p, c, g, true); });
    });
    FloodgateApi.getInstance().sendForm(p.getUniqueId(), form);
  }

  private void sendPiecesForm(Player p, Catalog c, Group g, boolean withBack) {
    SimpleForm.Builder form = SimpleForm.builder().title(g.name == null ? text(c, "title", "Furniture") : g.name).content(text(c, "content", ""));
    for (Piece piece : g.pieces) {
      if (piece.icon != null && !piece.icon.isEmpty()) form.button(piece.name, FormImage.Type.PATH, piece.icon);
      else form.button(piece.name);
    }
    if (withBack) form.button(text(c, "back", "Back"));
    form.validResultHandler(response -> {
      int i = response.clickedButtonId();
      if (i < 0) return;
      // Form responses arrive off the main thread; commands and inventory edits must run on it.
      if (i >= g.pieces.size()) {
        if (withBack) Bukkit.getScheduler().runTask(this, () -> { if (p.isOnline()) sendForm(p, c); });
        return;
      }
      Piece piece = g.pieces.get(i);
      Bukkit.getScheduler().runTask(this, () -> {
        if (!p.isOnline()) return;
        dispatch(getConfig().getString("give-command", "ce item give %player% %item% 1"), p, piece.item);
        putInHand(p, c, piece, 0);
      });
    });
    FloodgateApi.getInstance().sendForm(p.getUniqueId(), form);
  }

  /**
   * After a give: find the piece, move it into the hotbar if it landed in the main inventory, and select
   * its slot. Without this the player keeps holding the catalog and the next tap on the ground reopens
   * the menu instead of placing the piece.
   */
  private void putInHand(Player p, Catalog c, Piece piece, int attempt) {
    if (!p.isOnline()) return;
    NamespacedKey key = NamespacedKey.fromString(piece.item);
    PlayerInventory inv = p.getInventory();
    int slot = key == null ? -1 : findSlot(inv, key);
    if (slot < 0) {
      // The give runs through the command dispatcher; allow a few ticks before giving up.
      if (attempt < FIND_TRIES) {
        Bukkit.getScheduler().runTaskLater(this, () -> putInHand(p, c, piece, attempt + 1), 1L);
      } else {
        getLogger().warning("gave " + piece.item + " to " + p.getName() + " but it never showed up in the inventory (unknown item, or inventory full?)");
        p.sendMessage(text(c, "failed", "Could not give %name%.").replace("%name%", piece.name));
      }
      return;
    }
    if (slot >= HOTBAR) {
      int target = hotbarTarget(inv, NamespacedKey.fromString(c.catalogItem));
      ItemStack moved = inv.getItem(slot);
      inv.setItem(slot, inv.getItem(target));
      inv.setItem(target, moved);
      slot = target;
    }
    inv.setHeldItemSlot(slot);
    p.sendMessage(text(c, "given", "%name% is in your hand.").replace("%name%", piece.name));
  }

  // ---- helpers

  /** pieces.json, re-read when its modification time changes. */
  private Catalog load() {
    try {
      if (!Files.exists(piecesFile)) { cached = null; return null; }
      FileTime at = Files.getLastModifiedTime(piecesFile);
      if (cached != null && at.equals(cachedAt)) return cached;
      Catalog c = GSON.fromJson(Files.readString(piecesFile, StandardCharsets.UTF_8), Catalog.class);
      if (c == null || c.catalogItem == null || c.groups == null) { cached = null; return null; }
      cached = c;
      cachedAt = at;
      return c;
    } catch (IOException | JsonSyntaxException e) {
      getLogger().warning("cannot read " + piecesFile + ": " + e.getMessage());
      cached = null;
      return null;
    }
  }

  /** A UI string from pieces.json, or the fallback. */
  private static String text(Catalog c, String key, String fallback) {
    Ui ui = c == null ? null : c.ui;
    if (ui == null) return fallback;
    String s = switch (key) {
      case "title" -> ui.title;
      case "chooseGroup" -> ui.chooseGroup;
      case "back" -> ui.back;
      case "content" -> ui.content;
      case "empty" -> ui.empty;
      case "given" -> ui.given;
      case "failed" -> ui.failed;
      case "tooFar" -> ui.tooFar;
      case "full" -> ui.full;
      case "pinned" -> ui.pinned;
      case "usage" -> ui.usage;
      default -> null;
    };
    return s == null ? fallback : s;
  }

  /** CraftEngine items are recognised by their item_model component, which needs no CraftEngine dependency. */
  private static boolean hasModel(ItemStack stack, NamespacedKey key) {
    if (key == null || stack == null || stack.isEmpty() || !stack.hasItemMeta()) return false;
    ItemMeta meta = stack.getItemMeta();
    return meta != null && meta.hasItemModel() && key.equals(meta.getItemModel());
  }

  /** Any item with a non-vanilla item_model, i.e. a CraftEngine item (pieces, catalog). */
  private static boolean isCustom(ItemStack stack) {
    if (stack == null || stack.isEmpty() || !stack.hasItemMeta()) return false;
    ItemMeta meta = stack.getItemMeta();
    if (meta == null || !meta.hasItemModel()) return false;
    NamespacedKey key = meta.getItemModel();
    return key != null && !NamespacedKey.MINECRAFT.equals(key.getNamespace());
  }

  private static boolean isCatalog(ItemStack stack, Catalog c) {
    return hasModel(stack, NamespacedKey.fromString(c.catalogItem));
  }

  /** First storage slot holding an item with this model; hotbar slots (0-8) come first. -1 if none. */
  private static int findSlot(PlayerInventory inv, NamespacedKey key) {
    for (int i = 0; i < STORAGE; i++) if (hasModel(inv.getItem(i), key)) return i;
    return -1;
  }

  /** The catalog's slot: storage first, then the offhand. -1 if the player has none. */
  private static int findCatalog(PlayerInventory inv, NamespacedKey key) {
    int s = findSlot(inv, key);
    if (s >= 0) return s;
    return hasModel(inv.getItem(OFFHAND), key) ? OFFHAND : -1;
  }

  private static boolean hasEmptySlot(PlayerInventory inv) {
    for (int i = 0; i < STORAGE; i++) {
      ItemStack s = inv.getItem(i);
      if (s == null || s.isEmpty()) return true;
    }
    return false;
  }

  /** Hotbar slot for a piece that landed in the main inventory: the first empty one, else the slot after the held one that is not the catalog. */
  private static int hotbarTarget(PlayerInventory inv, NamespacedKey catalog) {
    for (int i = 0; i < HOTBAR; i++) {
      ItemStack s = inv.getItem(i);
      if (s == null || s.isEmpty()) return i;
    }
    for (int d = 1; d < HOTBAR; d++) {
      int i = (inv.getHeldItemSlot() + d) % HOTBAR;
      if (!hasModel(inv.getItem(i), catalog)) return i;
    }
    return inv.getHeldItemSlot();
  }

  private void dispatch(String template, Player p, String item) {
    String cmd = template.replace("%player%", p.getName()).replace("%item%", item);
    Bukkit.dispatchCommand(Bukkit.getConsoleSender(), cmd);
  }
}
