const fs = require('fs');
const path = require('path');

/**
 * Manages Valheim Live World Map state:
 * - In Docker mode:
 *   1. Reads real world metadata (worldName, seedName, seedNumeric) directly from /config/worlds_local/<World>.fwl
 *   2. Reads /config/watchtower/live_map.json if the BepInEx ZDO exporter plugin is active
 *   3. Maps real online players from ValheimLogParser (never fake demo players!)
 * - In Local Preview mode (no Docker socket):
 *   Uses simulated Vikings so the UI can be previewed standalone.
 */
class ValheimMapEngine {
  constructor(configManager) {
    this.configManager = configManager;
    this.liveMapFile = path.join(this.configManager.watchtowerDir, 'live_map.json');
    this.worldTerrainFile = path.join(this.configManager.watchtowerDir, 'world_terrain.json');
    this.terrainMtime = 0;
    this.isDockerMode = fs.existsSync(process.env.DOCKER_SOCKET || '/var/run/docker.sock');

    this.mapState = {
      worldName: this.configManager.state.serverMeta.worldName || process.env.WORLD_NAME || 'Dedicated',
      seedName: 'Reading .fwl...',
      seedNumeric: 0,
      worldRadius: 10500,
      telemetrySource: this.isDockerMode
        ? 'World Save (.fwl/.db) + Server Logs (Enable BepInEx for Live GPS/HP)'
        : 'BepInEx ZDO Bridge (Simulated Preview)',
      bepinexTelemetryActive: false,
      lastUpdated: new Date().toISOString(),
      terrainGrid: null,
      discoveredZones: [
        { x: 0, z: 0, radius: 1350, discoveredBy: 'Sacrificial Stones (Spawn)', biome: 'Meadows' }
      ],
      livePlayers: {},
      portals: [],
      landmarks: [
        { id: 'lm-spawn', type: 'spawn', name: 'Sacrificial Stones', x: 0, z: 0, biome: 'Meadows', icon: '🏛️', status: 'Active' },
        { id: 'lm-eikthyr', type: 'boss', name: 'EIKTHYR', x: -180, z: -340, biome: 'Meadows', icon: '🦌', status: 'Forsaken Altar' },
        { id: 'lm-elder', type: 'boss', name: 'THE ELDER', x: 1420, z: 1180, biome: 'Black Forest', icon: '🌲', status: 'Forsaken Altar' },
        { id: 'lm-bonemass', type: 'boss', name: 'BONEMASS', x: -2450, z: 1850, biome: 'Swamp', icon: '☠️', status: 'Forsaken Altar' },
        { id: 'lm-moder', type: 'boss', name: 'MODER', x: 2150, z: -2680, biome: 'Mountains', icon: '🐉', status: 'Forsaken Altar' },
        { id: 'lm-yagluth', type: 'boss', name: 'YAGLUTH', x: -3850, z: -2150, biome: 'Plains', icon: '👑', status: 'Forsaken Altar' }
      ],
      tombstones: []
    };

    if (!this.isDockerMode) {
      this.seedPreviewData();
    } else {
      this.inspectRealWorldFiles();
      this.loadTerrainFileIfUpdated();
    }

    this.startLiveTick();
  }

  loadTerrainFileIfUpdated() {
    try {
      if (!fs.existsSync(this.worldTerrainFile)) return;
      const stat = fs.statSync(this.worldTerrainFile);
      if (stat.mtimeMs <= this.terrainMtime) return;
      this.terrainMtime = stat.mtimeMs;
      const raw = JSON.parse(fs.readFileSync(this.worldTerrainFile, 'utf8'));
      if (raw && raw.biomesBase64 && raw.heightsBase64) {
        this.mapState.terrainGrid = {
          gridSize: raw.gridSize || 200,
          seaLevelByte: raw.seaLevelByte || 40,
          biomesBase64: raw.biomesBase64,
          heightsBase64: raw.heightsBase64
        };
        if (Array.isArray(raw.landmarks) && raw.landmarks.length > 0) {
          this.mapState.landmarks = raw.landmarks;
        }
      }
    } catch (_) {}
  }

  /**
   * Parses Valheim's binary /config/worlds_local/<WorldName>.fwl (or <WorldName>/<WorldName>.fwl)
   * to extract the real World Name & Seed
   */
  inspectRealWorldFiles() {
    try {
      const worldsDir = this.configManager.worldsDir;
      if (!fs.existsSync(worldsDir)) return;

      const fwlPaths = [];
      for (const entry of fs.readdirSync(worldsDir, { withFileTypes: true })) {
        const fullPath = path.join(worldsDir, entry.name);
        if (entry.isFile() && entry.name.endsWith('.fwl') && !entry.name.includes('.old')) {
          fwlPaths.push({ fullPath, name: entry.name, mtime: fs.statSync(fullPath).mtimeMs });
        } else if (entry.isDirectory()) {
          for (const sub of fs.readdirSync(fullPath)) {
            if (sub.endsWith('.fwl') && !sub.includes('.old')) {
              const subFull = path.join(fullPath, sub);
              fwlPaths.push({ fullPath: subFull, name: sub, mtime: fs.statSync(subFull).mtimeMs });
            }
          }
        }
      }

      const targetWorld = this.configManager.state.serverMeta.worldName || process.env.WORLD_NAME;
      let match = fwlPaths.find((f) => f.name === `${targetWorld}.fwl`);
      if (!match && fwlPaths.length > 0) {
        fwlPaths.sort((a, b) => b.mtime - a.mtime);
        match = fwlPaths[0];
      }

      if (match) {
        const buf = fs.readFileSync(match.fullPath);
        const parsed = this.parseFwlBuffer(buf);
        if (parsed) {
          this.mapState.worldName = parsed.worldName || match.name.replace(/\.fwl$/, '');
          this.mapState.seedName = parsed.seedName || 'Custom Seed';
          this.mapState.seedNumeric = parsed.seedNumeric || 0;
          this.configManager.state.serverMeta.worldName = this.mapState.worldName;
        }
      }
    } catch (_) {}
  }

  /**
   * Decodes C# BinaryWriter .fwl header:
   * [int32 length][int32 version][string worldName][string seedName][int32 seedNumeric]
   */
  parseFwlBuffer(buf) {
    try {
      if (!buf || buf.length < 16) return null;
      let offset = 8; // skip 4-byte block length + 4-byte world version

      const readCsString = () => {
        if (offset >= buf.length) return '';
        let len = 0;
        let shift = 0;
        while (offset < buf.length) {
          const b = buf[offset++];
          len |= (b & 0x7f) << shift;
          if ((b & 0x80) === 0) break;
          shift += 7;
        }
        if (len <= 0 || offset + len > buf.length) return '';
        const str = buf.toString('utf8', offset, offset + len);
        offset += len;
        return str;
      };

      const worldName = readCsString();
      const seedName = readCsString();
      const seedNumeric = offset + 4 <= buf.length ? buf.readInt32LE(offset) : 0;

      return { worldName, seedName, seedNumeric };
    } catch (_) {
      return null;
    }
  }

  startLiveTick() {
    setInterval(() => {
      this.tickLiveState();
    }, 3000);
  }

  tickLiveState() {
    this.loadTerrainFileIfUpdated();
    if (this.isDockerMode) {
      this.inspectRealWorldFiles();
    }

    // 1. Always check if the real BepInEx plugin wrote /config/watchtower/live_map.json
    if (fs.existsSync(this.liveMapFile)) {
      try {
        const externalData = JSON.parse(fs.readFileSync(this.liveMapFile, 'utf8'));
        this.mapState.bepinexTelemetryActive = true;
        const pStatus = externalData.pluginStatus || 'active';
        let statusLabel = '✅ BepInEx ZDO Live Telemetry (/config/watchtower/live_map.json)';
        if (pStatus === 'configuring_and_restarting_server') {
          statusLabel = '⏳ BepInEx Installed — Gracefully Restarting Valheim Server (~45-60s)...';
        } else if (
          pStatus === 'plugin_loaded_booting_world' ||
          pStatus === 'waiting_for_assembly_valheim' ||
          pStatus === 'loading_world_save'
        ) {
          statusLabel = '⏳ BepInEx Plugin Loaded — Valheim Server Loading World Save...';
        }
        this.mapState.pluginStatus = pStatus;
        this.ingestExternalTelemetry(externalData, statusLabel);
        return;
      } catch (_) {}
    }

    // 2. If running in real Docker mode WITHOUT BepInEx live_map.json:
    if (this.isDockerMode) {
      this.mapState.pluginStatus = 'not_configured';
      const knownPlayers = this.configManager.state.players || {};
      const nextLive = {};

      for (const [steamId, p] of Object.entries(knownPlayers)) {
        if (p.online) {
          const prev = this.mapState.livePlayers[steamId];
          nextLive[steamId] = prev || {
            steamId,
            name: p.name,
            x: 0,
            y: 20,
            z: 0,
            heading: 0,
            hp: 100,
            maxHp: 100,
            stamina: 100,
            maxStamina: 100,
            biome: 'Connected (Install BepInEx Plugin for exact GPS/HP)',
            activity: `Online • ZDOID: ${p.lastZdoId || 'Active'}`,
            foods: [],
            trail: [{ x: 0, z: 0 }]
          };
        }
      }
      this.mapState.livePlayers = nextLive;
      this.mapState.lastUpdated = new Date().toISOString();
      return;
    }

    // 3. Local Preview Mode (only when no Docker socket is present)
    const knownPlayers = this.configManager.state.players || {};
    for (const [steamId, p] of Object.entries(knownPlayers)) {
      if (p.online && !this.mapState.livePlayers[steamId]) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 300 + Math.random() * 1800;
        const x = Math.round(Math.cos(angle) * dist);
        const z = Math.round(Math.sin(angle) * dist);
        this.mapState.livePlayers[steamId] = {
          steamId,
          name: p.name,
          x,
          y: 24,
          z,
          heading: Math.round((angle * 180) / Math.PI),
          hp: 145,
          maxHp: 165,
          stamina: 110,
          maxStamina: 130,
          eitr: 0,
          biome: this.estimateBiome(x, z),
          activity: 'Exploring & Mapping',
          foods: ['Cooked Lox Meat', 'Bread', 'Cloudberries'],
          vx: (Math.random() - 0.5) * 18,
          vz: (Math.random() - 0.5) * 18,
          trail: [{ x, z }]
        };
      } else if (!p.online && this.mapState.livePlayers[steamId]) {
        delete this.mapState.livePlayers[steamId];
      }
    }

    for (const lp of Object.values(this.mapState.livePlayers)) {
      lp.vx = Math.max(-24, Math.min(24, (lp.vx || 8) + (Math.random() - 0.5) * 8));
      lp.vz = Math.max(-24, Math.min(24, (lp.vz || 8) + (Math.random() - 0.5) * 8));
      lp.x = Math.round(lp.x + lp.vx);
      lp.z = Math.round(lp.z + lp.vz);
      lp.heading = Math.round(((Math.atan2(lp.vx, -lp.vz) * 180) / Math.PI + 360) % 360);

      lp.trail = lp.trail || [];
      lp.trail.push({ x: lp.x, z: lp.z });
      if (lp.trail.length > 10) lp.trail.shift();

      const hpDelta = Math.round((Math.random() - 0.44) * 9);
      lp.hp = Math.max(24, Math.min(lp.maxHp, lp.hp + hpDelta));
      lp.stamina = Math.max(15, Math.min(lp.maxStamina, lp.stamina + Math.round((Math.random() - 0.48) * 18)));
    }

    this.mapState.lastUpdated = new Date().toISOString();
  }

  ingestExternalTelemetry(payload, sourceLabel = 'BepInEx HTTP Webhook') {
    this.mapState.telemetrySource = sourceLabel;
    this.mapState.bepinexTelemetryActive = true;
    this.mapState.lastUpdated = new Date().toISOString();

    if (payload.worldName) this.mapState.worldName = payload.worldName;
    if (payload.seedName) this.mapState.seedName = payload.seedName;
    if (Array.isArray(payload.discoveredZones)) {
      this.mapState.discoveredZones = payload.discoveredZones;
    }
    if (Array.isArray(payload.players)) {
      const nextLive = {};
      for (const p of payload.players) {
        const key = p.steamId || p.name;
        const prev = this.mapState.livePlayers[key];
        const trail = prev && Array.isArray(prev.trail) ? [...prev.trail] : [];
        trail.push({ x: Math.round(p.x || 0), z: Math.round(p.z || 0) });
        if (trail.length > 12) trail.shift();

        nextLive[key] = {
          steamId: key,
          name: p.name || 'Viking',
          x: Math.round(p.x || 0),
          y: Math.round(p.y || 0),
          z: Math.round(p.z || 0),
          heading: Math.round(p.heading || 0),
          hp: Math.round(p.hp ?? 100),
          maxHp: Math.round(p.maxHp ?? 100),
          stamina: Math.round(p.stamina ?? 100),
          maxStamina: Math.round(p.maxStamina ?? 100),
          eitr: Math.round(p.eitr ?? 0),
          biome: p.biome || this.estimateBiome(p.x || 0, p.z || 0),
          activity: p.activity || 'Exploring',
          foods: p.foods || [],
          trail
        };

        this.recordExplorationPoint(p.x || 0, p.z || 0, p.name || 'Viking');
      }
      this.mapState.livePlayers = nextLive;
    }
    if (Array.isArray(payload.portals)) this.mapState.portals = payload.portals;
    if (Array.isArray(payload.tombstones)) this.mapState.tombstones = payload.tombstones;
    if (Array.isArray(payload.landmarks)) this.mapState.landmarks = payload.landmarks;
  }

  recordExplorationPoint(x, z, playerName) {
    const close = this.mapState.discoveredZones.some(
      (zone) => Math.hypot(zone.x - x, zone.z - z) < (zone.radius || 600) * 0.6
    );
    if (!close) {
      this.mapState.discoveredZones.push({
        x: Math.round(x),
        z: Math.round(z),
        radius: 550,
        discoveredBy: playerName,
        biome: this.estimateBiome(x, z)
      });
    }
  }

  recordPlayerDeathTombstone(playerName, steamId) {
    const lp = this.mapState.livePlayers[steamId] || Object.values(this.mapState.livePlayers)[0];
    const x = lp ? lp.x : 0;
    const z = lp ? lp.z : 0;
    this.mapState.tombstones.unshift({
      id: `tomb-${Date.now()}`,
      player: playerName,
      steamId,
      x,
      z,
      biome: lp ? lp.biome : this.estimateBiome(x, z),
      createdAt: new Date().toISOString(),
      itemsCount: 20
    });
    if (this.mapState.tombstones.length > 25) this.mapState.tombstones.pop();
  }

  estimateBiome(x, z) {
    const dist = Math.hypot(x, z);
    if (z < -7200) return 'Ashlands';
    if (z > 7200) return 'Deep North';
    if (dist < 850) return 'Meadows';
    if (dist < 2100) return 'Black Forest';
    if (dist < 3400) return 'Swamp / Mountains';
    if (dist < 5000) return 'Plains';
    if (dist < 8200) return 'Mistlands';
    return 'Ocean';
  }

  seedPreviewData() {
    this.mapState.seedName = 'Yggdrasil9';
    this.mapState.seedNumeric = 84920177;
    this.mapState.discoveredZones = [
      { x: 0, z: 0, radius: 950, discoveredBy: 'All Vikings', biome: 'Meadows' },
      { x: 620, z: 480, radius: 720, discoveredBy: 'Ragnar Lothbrok', biome: 'Black Forest' },
      { x: -850, z: 1120, radius: 820, discoveredBy: 'Lagertha Shieldmaiden', biome: 'Black Forest' },
      { x: 1680, z: 1450, radius: 920, discoveredBy: 'Ragnar Lothbrok', biome: 'Swamp' },
      { x: -2100, z: -1250, radius: 880, discoveredBy: 'Bjorn Ironside', biome: 'Mountains' },
      { x: 2850, z: -1950, radius: 1100, discoveredBy: 'Floki Boatbuilder', biome: 'Plains' },
      { x: -4600, z: 3100, radius: 1050, discoveredBy: 'Lagertha Shieldmaiden', biome: 'Mistlands' },
      { x: 1650, z: -8150, radius: 980, discoveredBy: 'Ragnar Lothbrok', biome: 'Ashlands' }
    ];
    this.mapState.livePlayers = {
      '76561198042198311': {
        steamId: '76561198042198311',
        name: 'Ragnar Lothbrok',
        x: 1640,
        y: 18,
        z: -8120,
        heading: 165,
        hp: 194,
        maxHp: 225,
        stamina: 142,
        maxStamina: 160,
        biome: 'Ashlands',
        activity: 'Storming Charred Fortress',
        foods: ['Misthare Supreme', 'Meat Platter', 'Mashed Meat'],
        vx: 14,
        vz: -11,
        trail: [{ x: 1550, z: -8010 }, { x: 1640, z: -8120 }]
      },
      '76561198088312044': {
        steamId: '76561198088312044',
        name: 'Lagertha Shieldmaiden',
        x: -5120,
        y: 64,
        z: 3420,
        heading: 310,
        hp: 168,
        maxHp: 175,
        stamina: 118,
        maxStamina: 135,
        biome: 'Mistlands',
        activity: 'Harvesting Jotun Puffs & Sap',
        foods: ['Seeker Aspic', 'Yggdrasil Porridge', 'Salad'],
        vx: -12,
        vz: 9,
        trail: [{ x: -4980, z: 3310 }, { x: -5120, z: 3420 }]
      },
      '76561198119402875': {
        steamId: '76561198119402875',
        name: 'Bjorn Ironside',
        x: -2040,
        y: 142,
        z: -1190,
        heading: 45,
        hp: 82,
        maxHp: 185,
        stamina: 64,
        maxStamina: 140,
        biome: 'Mountains',
        activity: 'Fighting Stone Golem (Low HP!)',
        foods: ['Wolf Skewer', 'Onion Soup', 'Sausages'],
        vx: 9,
        vz: 11,
        trail: [{ x: -2120, z: -1260 }, { x: -2040, z: -1190 }]
      }
    };
    this.mapState.portals = [
      { id: 'p1', tag: 'Main Base Hub', x: 45, z: 60, biome: 'Meadows' },
      { id: 'p2', tag: 'Swamp Iron', x: 1650, z: 1420, biome: 'Swamp' },
      { id: 'p3', tag: 'Plains Barley Farm', x: 3820, z: -2350, biome: 'Plains' },
      { id: 'p4', tag: 'Mistlands Roots', x: -5180, z: 3480, biome: 'Mistlands' },
      { id: 'p5', tag: 'Ashlands Beachhead', x: 1590, z: -8050, biome: 'Ashlands' }
    ];
    this.mapState.tombstones = [
      {
        id: 'tomb-1',
        player: 'Bjorn Ironside',
        steamId: '76561198119402875',
        x: -2095,
        z: -1245,
        biome: 'Mountains',
        createdAt: new Date(Date.now() - 19 * 60 * 1000).toISOString(),
        itemsCount: 24
      }
    ];
  }

  getSnapshot() {
    return {
      ...this.mapState,
      livePlayersList: Object.values(this.mapState.livePlayers)
    };
  }
}

module.exports = { ValheimMapEngine };
