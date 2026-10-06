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

class ConfigManager {
  constructor(configDir = DEFAULT_CONFIG_DIR) {
    this.configDir = configDir;
    this.watchtowerDir = path.join(this.configDir, 'watchtower');
    this.backupsDir = process.env.BACKUPS_DIRECTORY || path.join(this.configDir, 'backups');
    this.worldsDir = path.join(this.configDir, 'worlds_local');
    this.bepinexConfigDir = path.join(this.configDir, 'bepinex', 'config');
    this.bepinexPluginsDir = path.join(this.configDir, 'bepinex', 'plugins');
    this.statsFile = path.join(this.watchtowerDir, 'stats.json');

    this.ensureDirectories();
    this.state = this.loadState();
  }

  ensureDirectories() {
    [
      this.configDir,
      this.watchtowerDir,
      this.backupsDir,
      this.worldsDir,
      this.bepinexConfigDir,
      this.bepinexPluginsDir
    ].forEach((dir) => {
      try {
        fs.mkdirSync(dir, { recursive: true });
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
        } catch (_) {}
      }
    });
  }

  loadState() {
    try {
      if (fs.existsSync(this.statsFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.statsFile, 'utf8'));
        return {
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

    return {
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

  saveState() {
    try {
      fs.writeFileSync(this.statsFile, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (_) {}
  }

  /**
   * Reads adminlist.txt, bannedlist.txt, permittedlist.txt and enriches with known player names
   */
  getAccessLists() {
    const readList = (filename) => {
      const fullPath = path.join(this.configDir, filename);
      if (!fs.existsSync(fullPath)) return [];
      const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
      const ids = [];
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('//') || line.startsWith('#')) continue;
        const steamId = line.split(/\s+/)[0];
        if (steamId) {
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
   * Lists BepInEx plugins and editable .cfg files
   */
  getModConfigs() {
    const plugins = [];
    if (fs.existsSync(this.bepinexPluginsDir)) {
      for (const entry of fs.readdirSync(this.bepinexPluginsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.dll')) {
          const stat = fs.statSync(path.join(this.bepinexPluginsDir, entry.name));
          plugins.push({ name: entry.name, sizeBytes: stat.size, updatedAt: stat.mtime.toISOString() });
        } else if (entry.isDirectory()) {
          plugins.push({ name: `${entry.name}/`, sizeBytes: 0, updatedAt: new Date().toISOString() });
        }
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
  RAID_LORE_MAP
};
