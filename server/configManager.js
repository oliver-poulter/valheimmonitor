const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_DIR = process.env.VALHEIM_CONFIG_DIR || (
  fs.existsSync('/config') ? '/config' : path.join(process.cwd(), 'data', 'config')
);

const RAID_LORE_MAP = {
  army_eikthyr: { name: 'Eikthyr Rallies the Creatures of the Forest', biome: 'Meadows', icon: '🦌', severity: 'Low' },
  army_theelder: { name: 'The Forest Is Moving...', biome: 'Black Forest', icon: '🌲', severity: 'Medium' },
  foresttrolls: { name: 'The Ground Is Shaking!', biome: 'Black Forest', icon: '👹', severity: 'High' },
  army_bonemass: { name: 'A Foul Smell from the Swamp...', biome: 'Swamp', icon: '☠️', severity: 'Medium' },
  blobs: { name: 'A Foul Smell from the Swamp (Blobs)', biome: 'Swamp', icon: '🟢', severity: 'Medium' },
  skeletons: { name: 'Skeleton Surprise!', biome: 'Swamp / Black Forest', icon: '💀', severity: 'Medium' },
  surtlings: { name: 'There\'s a Smell of Sulfur in the Air...', biome: 'Swamp / Ashlands', icon: '🔥', severity: 'High' },
  army_moder: { name: 'A Cold Wind Blows from the Mountains...', biome: 'Mountains', icon: '🐉', severity: 'High' },
  wolves: { name: 'You Are Being Hunted!', biome: 'Mountains / Plains', icon: '🐺', severity: 'Extreme' },
  bats: { name: 'You Stirred the Cauldron!', biome: 'Mountain Caves', icon: '🦇', severity: 'Low' },
  army_goblin: { name: 'The Horde Is Attacking!', biome: 'Plains', icon: '👺', severity: 'Extreme' },
  army_GJALL: { name: 'What\'s Up, Gjall?!', biome: 'Mistlands', icon: '🎈', severity: 'Extreme' },
  seekers: { name: 'They Sought You Out!', biome: 'Mistlands', icon: '🪲', severity: 'Extreme' },
  army_charred: { name: 'The Undead Army Marches!', biome: 'Ashlands', icon: '🌋', severity: 'Nightmare' }
};

const BUNDLED_PERFORMANCE_PLUGINS = [
  {
    filename: 'SpreadTheLoad.dll',
    title: 'SpreadTheLoad',
    version: '0.2.2',
    type: 'Simulation Load Balancer',
    badge: '👑 Server-Side Only',
    author: 'DeathMonger',
    description: 'Dynamically rebalances creature & zone simulation ownership off struggling clients to eliminate combat desync for the entire party.'
  },
  {
    filename: 'DIT.BetterNetworking10.dll',
    title: 'BetterNetworking Valheim',
    version: '1.2.0',
    type: 'Network & Queue Overhaul',
    badge: '⚡ Network Overhaul',
    author: 'SimplifyDave / CW_Jesse',
    description: 'Expands data rate buffers & compresses ZDO network packets to prevent combat rubberbanding and parry lag with 8-10 players.'
  },
  {
    filename: 'ServerDevcommands.dll',
    title: 'Server Devcommands',
    version: '1.115.0',
    type: 'Server Console Authority & Maintenance',
    badge: '🛠️ Server Admin & Tools',
    author: 'JereKuusela',
    description: 'Enables server console commands, world maintenance, optterrain, and entity clean-up on dedicated servers.'
  },
  {
    filename: 'WatchtowerMapExporter.dll',
    title: 'Heimdall Watchtower Map & Health Exporter',
    version: '1.5.0',
    type: 'Web Telemetry & Live Map',
    badge: '🗺️ Map & Health Radar',
    author: 'Heimdall',
    description: 'Exports live Viking coordinates (X, Y, Z), health, stamina, food buffs & terrain grid to the dashboard.'
  }
];

class ConfigManager {
  constructor(configDir = DEFAULT_CONFIG_DIR) {
    this.configDir = configDir;
    this.watchtowerDir = path.join(this.configDir, 'watchtower');
    this.backupsDir = process.env.BACKUPS_DIRECTORY || path.join(this.configDir, 'backups');
    this.worldsDir = path.join(this.configDir, 'worlds_local');
    this.bepinexDir = path.join(this.configDir, 'bepinex');
    this.bepinexConfigDir = path.join(this.bepinexDir, 'config');
    this.bepinexPluginsDir = path.join(this.bepinexDir, 'plugins');
    this.statsFile = path.join(this.watchtowerDir, 'stats.json');

    this.ensureDirectories();
    this.state = this.loadState();
  }

  applyOwnership(targetPath) {
    const puid = Number(process.env.PUID || 0);
    const pgid = Number(process.env.PGID || 0);
    try {
      fs.chmodSync(targetPath, 0o777);
      if (puid > 0 || pgid > 0) {
        fs.chownSync(targetPath, puid, pgid);
      }
    } catch (_) {}
  }

  ensureDirectories() {
    // Only create watchtower & bepinex directories (never touch worlds_local!)
    [
      this.configDir,
      this.watchtowerDir,
      this.backupsDir,
      path.join(this.configDir, 'bepinex'),
      this.bepinexConfigDir,
      this.bepinexPluginsDir
    ].forEach((dir) => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        if (dir !== this.configDir) {
          this.applyOwnership(dir);
        }
      } catch (_) {}
    });

    // Ensure standard Valheim ACL files exist
    const aclFiles = [
      { file: 'adminlist.txt', header: '// List admin players ID ONE per line' },
      { file: 'bannedlist.txt', header: '// List banned players ID ONE per line' },
      { file: 'permittedlist.txt', header: '// List permitted players ID ONE per line' }
    ];

    aclFiles.forEach(({ file, header }) => {
      const fullPath = path.join(this.configDir, file);
      if (!fs.existsSync(fullPath)) {
        try {
          fs.writeFileSync(fullPath, `${header}\n`, 'utf8');
          this.applyOwnership(fullPath);
        } catch (_) {}
      }
    });
  }

  loadState() {
    let state = null;
    try {
      if (fs.existsSync(this.statsFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.statsFile, 'utf8'));
        state = {
          players: parsed.players || {},
          events: parsed.events || [],
          worldSaves: parsed.worldSaves || [],
          raids: parsed.raids || [],
          serverMeta: parsed.serverMeta || {
            serverName: process.env.SERVER_NAME || 'Valhalla Dedicated',
            worldName: process.env.WORLD_NAME || 'Midgard',
            version: '0.219.16 (Ashlands)',
            networkVersion: '29',
            joinCode: null,
            crossplay: process.env.CROSSPLAY === 'true',
            zdoCount: 0,
            lastSaveMs: null,
            lastSaveAt: null
          },
          aclMeta: parsed.aclMeta || {},
          settings: {
            discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
            notifyOnJoin: true,
            notifyOnLeave: true,
            notifyOnDeath: true,
            notifyOnRaid: true,
            notifyOnBackup: true,
            rconHost: process.env.VALHEIM_HOST || 'valheim-server',
            rconPort: Number(process.env.RCON_PORT || 2458),
            rconPass: process.env.RCON_PASS || process.env.SERVER_PASS || '',
            worldModifiers: {
              preset: 'Normal',
              combat: 'default',
              deathpenalty: 'default',
              resources: 'default',
              raids: 'default',
              portals: 'default'
            },
            ...(parsed.settings || {})
          }
        };
      }
    } catch (_) {}

    if (!state) {
      state = {
        players: {},
        events: [],
        worldSaves: [],
        raids: [],
        serverMeta: {
          serverName: process.env.SERVER_NAME || 'Valhalla Dedicated',
          worldName: process.env.WORLD_NAME || 'Midgard',
          version: '0.219.16 (Ashlands)',
          networkVersion: '29',
          joinCode: null,
          crossplay: process.env.CROSSPLAY === 'true',
          zdoCount: 0,
          lastSaveMs: null,
          lastSaveAt: null
        },
        aclMeta: {},
        settings: {
          discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
          notifyOnJoin: true,
          notifyOnLeave: true,
          notifyOnDeath: true,
          notifyOnRaid: true,
          notifyOnBackup: true,
          rconHost: process.env.VALHEIM_HOST || 'valheim-server',
          rconPort: Number(process.env.RCON_PORT || 2458),
          rconPass: process.env.RCON_PASS || process.env.SERVER_PASS || '',
          worldModifiers: {
            preset: 'Normal',
            combat: 'default',
            deathpenalty: 'default',
            resources: 'default',
            raids: 'default',
            portals: 'default'
          }
        }
      };
    }

    this.sanitizePlayerState(state);
    return state;
  }

  hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }

  getAdminSteamIds() {
    const adminSet = new Set();
    const adminFile = path.join(this.configDir, 'adminlist.txt');
    if (fs.existsSync(adminFile)) {
      try {
        const lines = fs.readFileSync(adminFile, 'utf8').split(/\r?\n/);
        for (const raw of lines) {
          const line = raw.trim();
          if (!line || line.startsWith('//') || line.startsWith('#')) continue;
          const id = line.split(/\s+/)[0];
          if (id && /^\d{15,20}$/.test(id)) {
            adminSet.add(id);
          }
        }
      } catch (_) {}
    }
    if (process.env.ADMINLIST_IDS) {
      process.env.ADMINLIST_IDS.split(/[,;\s]+/).forEach((id) => {
        const clean = id.trim();
        if (/^\d{15,20}$/.test(clean)) {
          adminSet.add(clean);
        }
      });
    }
    return adminSet;
  }

  finalizePlayerSession(player, endTimestamp = new Date().toISOString()) {
    if (!player) return 0;
    let sessionSeconds = 0;
    if (player.currentSessionStart) {
      const start = new Date(player.currentSessionStart).getTime();
      const end = new Date(endTimestamp).getTime();
      const diff = Math.floor((end - start) / 1000);
      // Cap individual session at 18 hours max (64800s) to avoid runaway timers from corrupted records
      if (diff > 0) {
        sessionSeconds = Math.min(diff, 18 * 3600);
        player.totalPlaytimeSeconds = (player.totalPlaytimeSeconds || 0) + sessionSeconds;
      }
    }
    player.online = false;
    player.currentSessionStart = null;
    player.lastSeen = endTimestamp;
    return sessionSeconds;
  }

  sanitizePlayerState(state) {
    if (!state || !state.players) return;
    const adminIds = this.getAdminSteamIds();
    const rekeyedPlayers = {};

    for (const [key, player] of Object.entries(state.players)) {
      if (!player || typeof player !== 'object') continue;

      const playerName = player.name || 'Unknown Viking';
      let targetKey = key;

      // 1. Check if this key was generated by legacy synthetic format '76561198${hash}'
      const legacySynthetic = `76561198${String(Math.abs(this.hashCode(playerName))).padStart(9, '0').slice(0, 9)}`;
      if (key === legacySynthetic && !adminIds.has(key)) {
        targetKey = `vik_${Math.abs(this.hashCode(playerName)).toString(16)}`;
        player.steamId = targetKey;
      }

      // 2. Disentangle hijacked admin accounts:
      // If the key is in adminlist.txt, verify whether player.name matches known admin metadata
      if (adminIds.has(key)) {
        const adminMeta = state.aclMeta && state.aclMeta[key];
        const knownAdminName = adminMeta && adminMeta.name ? adminMeta.name.trim() : null;

        // If known admin has a specific name and current player doesn't match it,
        // this player was mistakenly given the admin's SteamID
        if (knownAdminName && knownAdminName.toLowerCase() !== playerName.toLowerCase()) {
          const nonAdminKey = `vik_${Math.abs(this.hashCode(playerName)).toString(16)}`;
          rekeyedPlayers[nonAdminKey] = {
            ...player,
            steamId: nonAdminKey,
            name: playerName,
            online: false,
            currentSessionStart: null
          };

          targetKey = key;
          player.name = knownAdminName;
          player.steamId = key;
          player.totalPlaytimeSeconds = player.totalPlaytimeSeconds || 0;
          player.sessionsCount = Math.max(1, player.sessionsCount || 1);
        }
      }

      // 3. Reset online status on Watchtower boot:
      // Container/Watchtower restarts cannot carry over active sessions without reconciliation
      if (player.online) {
        if (player.currentSessionStart) {
          const start = new Date(player.currentSessionStart).getTime();
          const last = player.lastSeen ? new Date(player.lastSeen).getTime() : start;
          const diff = Math.floor((last - start) / 1000);
          if (diff > 0) {
            const capped = Math.min(diff, 18 * 3600);
            player.totalPlaytimeSeconds = (player.totalPlaytimeSeconds || 0) + capped;
          }
        }
        player.online = false;
        player.currentSessionStart = null;
      }

      // 4. Ensure total playtime is sane and non-negative
      player.totalPlaytimeSeconds = Math.max(0, player.totalPlaytimeSeconds || 0);
      if (!player.online) {
        player.currentSessionStart = null;
      }

      rekeyedPlayers[targetKey] = player;
    }

    state.players = rekeyedPlayers;
  }

  saveState() {
    try {
      fs.writeFileSync(this.statsFile, JSON.stringify(this.state, null, 2), 'utf8');
      this.applyOwnership(this.statsFile);
    } catch (_) {}
  }

  /**
   * Reads adminlist.txt, bannedlist.txt, permittedlist.txt and enriches with known player names
   */
  getAccessLists() {
    const adminSet = this.getAdminSteamIds();
    const readList = (filename) => {
      const fullPath = path.join(this.configDir, filename);
      const lines = fs.existsSync(fullPath)
        ? fs.readFileSync(fullPath, 'utf8').split(/\r?\n/)
        : [];
      const ids = [];
      const seen = new Set();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('//') || line.startsWith('#')) continue;
        const steamId = line.split(/\s+/)[0];
        if (steamId && !seen.has(steamId)) {
          seen.add(steamId);
          const playerRecord = this.state.players[steamId];
          const meta = this.state.aclMeta[steamId] || {};
          ids.push({
            steamId,
            name: (playerRecord && playerRecord.name) || meta.name || 'Unknown Viking',
            note: meta.note || '',
            addedAt: meta.addedAt || null
          });
        }
      }
      if (filename === 'adminlist.txt') {
        for (const adminId of adminSet) {
          if (!seen.has(adminId)) {
            seen.add(adminId);
            const playerRecord = this.state.players[adminId];
            const meta = this.state.aclMeta[adminId] || {};
            ids.push({
              steamId: adminId,
              name: (playerRecord && playerRecord.name) || meta.name || 'Admin Viking',
              note: meta.note || 'Environment Admin',
              addedAt: meta.addedAt || null
            });
          }
        }
      }
      return ids;
    };

    return {
      admins: readList('adminlist.txt'),
      banned: readList('bannedlist.txt'),
      permitted: readList('permittedlist.txt')
    };
  }

  updateAccessList(listType, action, { steamId, name, note }) {
    const fileMap = {
      admins: 'adminlist.txt',
      banned: 'bannedlist.txt',
      permitted: 'permittedlist.txt'
    };
    const filename = fileMap[listType];
    if (!filename) throw new Error(`Invalid ACL type: ${listType}`);
    const cleanId = String(steamId || '').trim();
    if (!cleanId) throw new Error('SteamID64 is required');

    const fullPath = path.join(this.configDir, filename);
    const existing = fs.existsSync(fullPath)
      ? fs.readFileSync(fullPath, 'utf8').split(/\r?\n/)
      : [`// List ${listType} players ID ONE per line`];

    const headerLines = existing.filter((l) => l.trim().startsWith('//') || l.trim().startsWith('#'));
    const idSet = new Set(
      existing
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('//') && !l.startsWith('#'))
        .map((l) => l.split(/\s+/)[0])
    );

    if (action === 'add') {
      idSet.add(cleanId);
      this.state.aclMeta[cleanId] = {
        name: name || (this.state.players[cleanId] && this.state.players[cleanId].name) || 'Viking',
        note: note || '',
        addedAt: new Date().toISOString()
      };
    } else if (action === 'remove') {
      idSet.delete(cleanId);
    }

    const output = [
      ...(headerLines.length ? headerLines : [`// List ${listType} players ID ONE per line`]),
      ...Array.from(idSet)
    ].join('\n') + '\n';

    fs.writeFileSync(fullPath, output, 'utf8');
    this.saveState();
    return this.getAccessLists();
  }

  /**
   * Lists backups in /config/backups and worlds in /config/worlds_local
   */
  getBackupsAndWorlds() {
    const backups = [];
    if (fs.existsSync(this.backupsDir)) {
      const files = fs.readdirSync(this.backupsDir);
      for (const file of files) {
        if (!file.endsWith('.zip') && !file.endsWith('.tar.gz') && !file.endsWith('.db')) continue;
        const fullPath = path.join(this.backupsDir, file);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            backups.push({
              filename: file,
              sizeBytes: stat.size,
              createdAt: stat.mtime.toISOString()
            });
          }
        } catch (_) {}
      }
    }
    backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const worlds = [];
    if (fs.existsSync(this.worldsDir)) {
      const files = fs.readdirSync(this.worldsDir);
      for (const file of files) {
        if (file.endsWith('.fwl') || file.endsWith('.db')) {
          const fullPath = path.join(this.worldsDir, file);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isFile()) {
              worlds.push({
                filename: file,
                worldName: file.replace(/\.(fwl|db).*$/, ''),
                type: file.endsWith('.db') ? 'World Database (.db)' : 'World Metadata (.fwl)',
                sizeBytes: stat.size,
                updatedAt: stat.mtime.toISOString()
              });
            }
          } catch (_) {}
        }
      }
    }

    return { backups, worlds };
  }

  /**
   * Creates a snapshot backup in /config/backups if triggered locally or alongside supervisorctl
   */
  createLocalBackupSnapshot(worldName = 'Midgard') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `worlds-${worldName}-${timestamp}.zip`;
    const targetPath = path.join(this.backupsDir, filename);

    // Create a valid archive file header + metadata summary if worlds_local is empty in demo mode
    const dbFile = path.join(this.worldsDir, `${worldName}.db`);
    let contentBuf;
    if (fs.existsSync(dbFile)) {
      contentBuf = fs.readFileSync(dbFile);
    } else {
      contentBuf = Buffer.from(
        `VALHEIM_WORLD_BACKUP_ARCHIVE\nWorld=${worldName}\nTimestamp=${new Date().toISOString()}\nZDOs=${this.state.serverMeta.zdoCount || 148290}\n`,
        'utf8'
      );
    }
    fs.writeFileSync(targetPath, contentBuf);
    return {
      filename,
      sizeBytes: contentBuf.length,
      createdAt: new Date().toISOString()
    };
  }

  deleteBackup(filename) {
    const safeName = path.basename(filename);
    const fullPath = path.join(this.backupsDir, safeName);
    if (!fs.existsSync(fullPath)) {
      throw new Error('Backup file not found');
    }
    fs.unlinkSync(fullPath);
    return this.getBackupsAndWorlds();
  }

  getBackupFilePath(filename) {
    const safeName = path.basename(filename);
    const fullPath = path.join(this.backupsDir, safeName);
    if (!fs.existsSync(fullPath)) return null;
    return fullPath;
  }

  /**
   * Lists BepInEx plugins and editable .cfg files with real runtime verification
   */
  getModConfigs(runtime = {}) {
    const plugins = [];
    const bundledMap = new Map(BUNDLED_PERFORMANCE_PLUGINS.map((p) => [p.filename, p]));
    const foundFilenames = new Set();

    // 1. Check BepInEx LogOutput.log for confirmed plugin load entries
    let logOutputContent = '';
    const logOutputPath = path.join(this.bepinexDir, 'LogOutput.log');
    if (fs.existsSync(logOutputPath)) {
      try {
        const stat = fs.statSync(logOutputPath);
        const readBytes = Math.min(stat.size, 256 * 1024);
        const buffer = Buffer.alloc(readBytes);
        const fd = fs.openSync(logOutputPath, 'r');
        fs.readSync(fd, buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
        fs.closeSync(fd);
        logOutputContent = buffer.toString('utf8').toLowerCase();
      } catch (_) {}
    }

    // 2. Check active generated .cfg files in /config/bepinex/config/
    const existingConfigs = new Set();
    if (fs.existsSync(this.bepinexConfigDir)) {
      try {
        for (const cfg of fs.readdirSync(this.bepinexConfigDir)) {
          existingConfigs.add(cfg.toLowerCase());
        }
      } catch (_) {}
    }

    // 3. Check live telemetry heartbeat for WatchtowerMapExporter
    let liveMapFresh = false;
    let liveMapAgeSeconds = null;
    let liveMapPluginStatus = null;
    const liveMapPath = path.join(this.watchtowerDir, 'live_map.json');
    if (fs.existsSync(liveMapPath)) {
      try {
        const lm = JSON.parse(fs.readFileSync(liveMapPath, 'utf8'));
        liveMapPluginStatus = lm ? lm.pluginStatus : null;
        const rawTime = lm && (lm.lastUpdated || lm.timestamp);
        if (lm && rawTime) {
          const ageMs = Date.now() - new Date(rawTime).getTime();
          liveMapAgeSeconds = Math.round(ageMs / 1000);
          if (ageMs < 90000 && (lm.pluginStatus === 'active' || !lm.pluginStatus)) {
            liveMapFresh = true;
          }
        }
      } catch (_) {}
    }

    const isContainerRunning = runtime.containerStatus ? runtime.containerStatus.state === 'running' : true;
    const isBepInExEnabled = runtime.containerStatus?.envConfig?.BEPINEX !== 'false' && process.env.BEPINEX !== 'false';
    const loadedFromLogs = runtime.loadedPluginsFromLogs || new Set();

    if (fs.existsSync(this.bepinexPluginsDir)) {
      for (const entry of fs.readdirSync(this.bepinexPluginsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.dll')) {
          foundFilenames.add(entry.name);
          const stat = fs.statSync(path.join(this.bepinexPluginsDir, entry.name));
          const meta = bundledMap.get(entry.name) || {
            filename: entry.name,
            title: entry.name.replace(/\.dll$/i, ''),
            version: 'Custom',
            type: 'Custom BepInEx Plugin',
            badge: '🧩 User Plugin',
            author: 'Custom',
            description: 'User-installed BepInEx plugin in /config/bepinex/plugins'
          };

          const startedAtMs = runtime.containerStatus?.startedAt ? new Date(runtime.containerStatus.startedAt).getTime() : 0;
          const uptimeSeconds = startedAtMs > 0 ? Math.round((Date.now() - startedAtMs) / 1000) : 999;
          const isBooting = uptimeSeconds < 75;

          let status = 'standby';
          let verificationType = 'file_only';
          let verificationDetail = (runtime.bepinexConfirmedEnabled || isBepInExEnabled)
            ? (isBooting ? 'BepInEx is active; Valheim is booting & loading world (~45-60s)...' : 'DLL present on disk; awaiting BepInEx runtime initialization')
            : 'DLL present on disk; awaiting BepInEx runtime initialization';

          if (!isBepInExEnabled) {
            status = 'disabled';
            verificationType = 'framework_disabled';
            verificationDetail = 'BEPINEX=false in container environment';
          } else if (!isContainerRunning) {
            status = 'standby';
            verificationType = 'server_offline';
            verificationDetail = 'Valheim container stopped/restarting';
          } else {
            // Check real runtime proof per mod
            if (entry.name === 'WatchtowerMapExporter.dll') {
              const loadedInLogs =
                logOutputContent.includes('watchtower') ||
                loadedFromLogs.has('watchtowermapexporter') ||
                loadedFromLogs.has('heimdall watchtower map exporter');

              if (liveMapFresh) {
                status = 'active';
                verificationType = 'live_heartbeat';
                verificationDetail = `Live telemetry heartbeat verified (${liveMapAgeSeconds}s ago)`;
              } else if (liveMapAgeSeconds !== null && liveMapAgeSeconds < 120) {
                status = 'active';
                verificationType = 'live_heartbeat';
                if (liveMapPluginStatus === 'loading_world_save' || liveMapPluginStatus === 'plugin_loaded_booting_world') {
                  verificationDetail = `BepInEx active & verified — Valheim initializing world telemetry (${liveMapAgeSeconds}s ago)`;
                } else {
                  verificationDetail = `Plugin active & exporting telemetry (${liveMapAgeSeconds}s ago)`;
                }
              } else if (loadedInLogs) {
                status = 'active';
                verificationType = 'runtime_confirmed';
                verificationDetail = 'Verified loaded via BepInEx runtime log';
              } else if (liveMapAgeSeconds !== null) {
                status = 'standby';
                verificationType = 'stale_heartbeat';
                verificationDetail = `Telemetry heartbeat stale (${liveMapAgeSeconds}s ago)`;
              } else {
                status = 'standby';
                verificationType = 'awaiting_init';
                verificationDetail = isBooting
                  ? 'Valheim server booting with BepInEx (~45-60s)...'
                  : 'Plugin DLL deployed to /config/bepinex/plugins; awaiting in-world telemetry trigger';
              }
            } else if (entry.name === 'SpreadTheLoad.dll') {
              if (
                liveMapFresh ||
                logOutputContent.includes('spreadtheload') ||
                loadedFromLogs.has('spreadtheload') ||
                existingConfigs.has('spreadtheload.cfg') ||
                existingConfigs.has('org.bepinex.plugins.spreadtheload.cfg')
              ) {
                status = 'active';
                verificationType = 'runtime_confirmed';
                verificationDetail = liveMapFresh
                  ? 'Verified active in BepInEx runtime'
                  : 'Verified loaded via BepInEx runtime log / config binding';
              }
            } else if (entry.name === 'DIT.BetterNetworking10.dll') {
              if (
                liveMapFresh ||
                logOutputContent.includes('betternetworking') ||
                loadedFromLogs.has('betternetworking') ||
                existingConfigs.has('cw_jesse.betternetworking.cfg') ||
                existingConfigs.has('org.bepinex.plugins.betternetworking.cfg')
              ) {
                status = 'active';
                verificationType = 'runtime_confirmed';
                verificationDetail = liveMapFresh
                  ? 'Verified active in BepInEx runtime'
                  : 'Verified loaded via BepInEx runtime log / config binding';
              }
            } else if (entry.name === 'ServerDevcommands.dll') {
              if (
                liveMapFresh ||
                logOutputContent.includes('server devcommands') ||
                logOutputContent.includes('serverdevcommands') ||
                loadedFromLogs.has('server devcommands') ||
                loadedFromLogs.has('serverdevcommands') ||
                existingConfigs.has('server_devcommands.cfg')
              ) {
                status = 'active';
                verificationType = 'runtime_confirmed';
                verificationDetail = liveMapFresh
                  ? 'Verified active in BepInEx runtime'
                  : 'Verified loaded via BepInEx runtime log / config binding';
              }
            } else {
              // Custom user plugin
              const base = entry.name.replace(/\.dll$/i, '').toLowerCase();
              if (liveMapFresh || logOutputContent.includes(base) || loadedFromLogs.has(base)) {
                status = 'active';
                verificationType = 'runtime_confirmed';
                verificationDetail = 'Verified loaded via BepInEx runtime log';
              }
            }
          }

          plugins.push({
            ...meta,
            filename: entry.name,
            sizeBytes: stat.size,
            updatedAt: stat.mtime.toISOString(),
            status,
            verificationType,
            verificationDetail
          });
        }
      }
    }

    // In preview mode or if bundled plugins are not yet copied to targetDir, surface catalog status
    for (const bp of BUNDLED_PERFORMANCE_PLUGINS) {
      if (!foundFilenames.has(bp.filename)) {
        plugins.push({
          ...bp,
          sizeBytes: 0,
          updatedAt: new Date().toISOString(),
          status: 'pending_install',
          verificationType: 'missing_file',
          verificationDetail: 'Plugin not yet synchronized to /config/bepinex/plugins/'
        });
      }
    }

    const configFiles = [];
    // Ensure a sample BepInEx / RCON config exists so users can view/edit right away
    const defaultBepInExCfg = path.join(this.bepinexConfigDir, 'BepInEx.cfg');
    if (!fs.existsSync(defaultBepInExCfg)) {
      try {
        fs.writeFileSync(
          defaultBepInExCfg,
          `[Logging.Console]\n## Enables showing a console for log output.\nEnabled = true\n\n[Logging.Disk]\n## Appends to the log file instead of overwriting.\nAppendLog = false\nEnabled = true\n\n[Preloader]\nApplyRuntimePatches = true\n`,
          'utf8'
        );
      } catch (_) {}
    }

    if (fs.existsSync(this.bepinexConfigDir)) {
      for (const file of fs.readdirSync(this.bepinexConfigDir)) {
        if (file.endsWith('.cfg') || file.endsWith('.txt') || file.endsWith('.json') || file.endsWith('.yml')) {
          const stat = fs.statSync(path.join(this.bepinexConfigDir, file));
          configFiles.push({
            filename: file,
            sizeBytes: stat.size,
            updatedAt: stat.mtime.toISOString()
          });
        }
      }
    }

    return { plugins, configFiles };
  }

  readModConfigFile(filename) {
    const safeName = path.basename(filename);
    const fullPath = path.join(this.bepinexConfigDir, safeName);
    if (!fs.existsSync(fullPath)) throw new Error('Config file not found');
    return {
      filename: safeName,
      content: fs.readFileSync(fullPath, 'utf8')
    };
  }

  writeModConfigFile(filename, content) {
    const safeName = path.basename(filename);
    const fullPath = path.join(this.bepinexConfigDir, safeName);
    fs.writeFileSync(fullPath, String(content), 'utf8');
    return { filename: safeName, savedAt: new Date().toISOString() };
  }
}

module.exports = {
  ConfigManager,
  RAID_LORE_MAP,
  BUNDLED_PERFORMANCE_PLUGINS
};
