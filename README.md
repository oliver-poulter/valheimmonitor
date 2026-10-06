# 🛡️ Heimdall Watchtower — Valheim Dedicated Server Dashboard

A companion Docker container designed specifically for [`lloesche/valheim-server`](https://hub.docker.com/r/lloesche/valheim-server) (`ghcr.io/community-valheim-tools/valheim-server`) in a **Portainer Stack**.

🐳 **Pre-built Container Image (GitHub Container Registry):**
```text
ghcr.io/oliver-poulter/valheimmonitor:latest
```

---

## 🚀 Quick Deploy in Portainer

Add this `valheim-watchtower` service block directly to your existing Valheim **Portainer Stack** (or deploy the full [`docker-compose.yml`](./docker-compose.yml)):

```yaml
  valheim-watchtower:
    image: ghcr.io/oliver-poulter/valheimmonitor:latest
    container_name: valheim-watchtower
    ports:
      - "3000:3000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /path/to/your/valheim/config:/config
    environment:
      - PORT=3000
      - VALHEIM_CONTAINER_NAME=valheim-server
      - VALHEIM_CONFIG_DIR=/config
      - DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
    restart: unless-stopped
```

> **Important:**
> 1. Make sure `/config` in `valheim-watchtower` mounts the **exact same host folder or named volume** as `/config` in your `lloesche/valheim-server` container.
> 2. If the GitHub package is initially private after the first GitHub Actions build, go to **GitHub -> Packages -> `valheimmonitor` -> Package settings -> Change visibility to Public** so Portainer can pull `ghcr.io/oliver-poulter/valheimmonitor:latest` without authentication.

---

## ✨ Features Included

1. **🗺️ Live Interactive World Map & Viking Health (`Yggdrasil Cartography`)**
   - Pan & zoom procedural Valheim world map with **Shared Fog-of-War** toggle, live moving Viking pins, movement breadcrumb trails, floating **Health (`HP / MaxHP`) & Stamina bars**, active food buffs, **Death Tombstone (`💀`) markers**, and **Bifrost Portal Network (`🌀`)** links.
   - Includes [`bepinex-plugin/WatchtowerMapExporter.cs`](./bepinex-plugin/WatchtowerMapExporter.cs) for `lloesche/valheim-server` (`BEPINEX="true"`) to export live ZDO positions & health every 2 seconds to `/config/watchtower/live_map.json`.
2. **🎛️ Full Server Lifecycle & `supervisord` Control**
   - Graceful **Start / Stop / Restart** via `supervisorctl` (saves `.db` world cleanly before stopping), **1-Click Hot Backup (`valheim-backup`)**, and **1-Click SteamCMD Update Check (`valheim-updater`)**.
3. **⚔️ Viking Roster & Player Analytics**
   - Tracks currently online Vikings, live session timers, **Last Login / Last Seen**, **First Seen**, **Cumulative Playtime**, **Total Sessions**, and **Death Counter (`💀`)** (via `ZDOID 0:0` log detection).
4. **⚡ Command Deck, RCON Terminal & Forsaken Raid Launcher**
   - 1-Click command cards (`save`, `info`, `say`, `env Clear`, `env ThunderStorm`, `tod 0.5`, `listkeys`) and interactive Forsaken Raid Launcher (`army_eikthyr`, `foresttrolls`, `wolves`, `seekers`, `army_charred`, `stopevent`).
5. **📜 Visual Access Control Lists (`ACL`) & Backup Vault**
   - Manage `/config/adminlist.txt`, `/config/permittedlist.txt`, and `/config/bannedlist.txt` with 1 click, and browse/download `.zip` world backups from `/config/backups`.
6. **⚖️ World Modifiers Builder, BepInEx `.cfg` Editor & Discord Webhooks**
   - Visual `SERVER_ARGS` builder, in-browser `.cfg` editor, and rich Discord webhook embeds for logins, logouts, deaths, raids, and backups.
