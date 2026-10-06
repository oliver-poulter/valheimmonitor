const fs = require('fs');
const path = require('path');

/**
 * Manages Valheim Live World Map state:
 * - Reads /config/watchtower/live_map.json or POST /api/map/telemetry when BepInEx ZDO exporter is active
 * - Extracts world seed from /config/worlds_local/<World>.fwl if present
 * - Maintains shared discovered areas (fog of war), live player (X, Z) positions, HP/MaxHP, Stamina,
 *   linked Portals, Boss Altars, Traders, and Death Tombstones.
 */
class ValheimMapEngine {
  constructor(configManager) {
    this.configManager = configManager;
    this.liveMapFile = path.join(this.configManager.watchtowerDir, 'live_map.json');

    this.mapState = {
      worldName: this.configManager.state.serverMeta.worldName || 'Midgard',
      seedName: 'Yggdrasil9',
      seedNumeric: 84920177,
      worldRadius: 10500,
      telemetrySource: 'BepInEx ZDO Bridge (Simulated Preview)',
      lastUpdated: new Date().toISOString(),

      // Discovered Fog-of-War circles: { x, z, radius, discoveredBy, biome }
      discoveredZones: [
        { x: 0, z: 0, radius: 950, discoveredBy: 'All Vikings', biome: 'Meadows' },
        { x: 620, z: 480, radius: 720, discoveredBy: 'Ragnar Lothbrok', biome: 'Black Forest' },
        { x: -850, z: 1120, radius: 820, discoveredBy: 'Lagertha Shieldmaiden', biome: 'Black Forest' },
        { x: 1680, z: 1450, radius: 920, discoveredBy: 'Ragnar Lothbrok', biome: 'Swamp' },
        { x: -2100, z: -1250, radius: 880, discoveredBy: 'Bjorn Ironside', biome: 'Mountains' },
        { x: 2850, z: -1950, radius: 1100, discoveredBy: 'Floki Boatbuilder', biome: 'Plains' },
        { x: 3900, z: -2400, radius: 850, discoveredBy: 'Ragnar Lothbrok', biome: 'Plains' },
        { x: -4600, z: 3100, radius: 1050, discoveredBy: 'Lagertha Shieldmaiden', biome: 'Mistlands' },
        { x: -5350, z: 3650, radius: 800, discoveredBy: 'Lagertha Shieldmaiden', biome: 'Mistlands' },
        { x: 1200, z: -6800, radius: 1150, discoveredBy: 'Ragnar Lothbrok', biome: 'Ocean / Ashlands Approach' },
        { x: 1650, z: -8150, radius: 980, discoveredBy: 'Ragnar Lothbrok', biome: 'Ashlands' }
      ],

      // Live Player Telemetry: keyed by steamId
      livePlayers: {
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
          eitr: 0,
          biome: 'Ashlands',
          activity: 'Storming Charred Fortress',
          foods: ['Misthare Supreme', 'Meat Platter', 'Mashed Meat'],
          vx: 14,
          vz: -11,
          trail: [
            { x: 1480, z: -7890 },
            { x: 1550, z: -8010 },
            { x: 1610, z: -8085 },
            { x: 1640, z: -8120 }
          ]
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
          eitr: 85,
          biome: 'Mistlands',
          activity: 'Harvesting Jotun Puffs & Sap',
          foods: ['Seeker Aspic', 'Yggdrasil Porridge', 'Salad'],
          vx: -12,
          vz: 9,
          trail: [
            { x: -4890, z: 3260 },
            { x: -4980, z: 3310 },
            { x: -5060, z: 3375 },
            { x: -5120, z: 3420 }
          ]
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
          eitr: 0,
          biome: 'Mountains',
          activity: 'Fighting Stone Golem (Low HP!)',
          foods: ['Wolf Skewer', 'Onion Soup', 'Sausages'],
          vx: 9,
          vz: 11,
          trail: [
            { x: -2180, z: -1310 },
            { x: -2120, z: -1260 },
            { x: -2075, z: -1220 },
            { x: -2040, z: -1190 }
          ]
        }
      },

      // Linked Portals (from piece_portal_wood ZDOs)
      portals: [
        { id: 'p1', tag: 'Main Base Hub', x: 45, z: 60, linkedTo: { x: 45, z: 60 }, biome: 'Meadows' },
        { id: 'p2', tag: 'Swamp Iron', x: 1650, z: 1420, linkedTo: { x: 45, z: 60 }, biome: 'Swamp' },
        { id: 'p3', tag: 'Plains Barley Farm', x: 3820, z: -2350, linkedTo: { x: 45, z: 60 }, biome: 'Plains' },
        { id: 'p4', tag: 'Mistlands Roots', x: -5180, z: 3480, linkedTo: { x: 45, z: 60 }, biome: 'Mistlands' },
        { id: 'p5', tag: 'Ashlands Beachhead', x: 1590, z: -8050, linkedTo: { x: 45, z: 60 }, biome: 'Ashlands' }
      ],

      // World Points of Interest (Boss Altars, Traders, Spawn)
      landmarks: [
        { id: 'lm-spawn', type: 'spawn', name: 'Sacrificial Stones (Spawn)', x: 0, z: 0, biome: 'Meadows', icon: '🪨', status: 'Active' },
        { id: 'lm-eikthyr', type: 'boss', name: 'Eikthyr Altar', x: 420, z: 310, biome: 'Meadows', icon: '🦌', status: 'Defeated' },
        { id: 'lm-elder', type: 'boss', name: 'The Elder Altar', x: -920, z: 1240, biome: 'Black Forest', icon: '🌲', status: 'Defeated' },
        { id: 'lm-haldor', type: 'trader', name: 'Haldor the Merchant', x: 740, z: 590, biome: 'Black Forest', icon: '💰', status: 'Discovered' },
        { id: 'lm-hildir', type: 'trader', name: 'Hildir\'s Camp', x: 1120, z: -640, biome: 'Meadows', icon: '👕', status: 'Discovered' },
        { id: 'lm-bonemass', type: 'boss', name: 'Bonemass Skull', x: 1790, z: 1560, biome: 'Swamp', icon: '☠️', status: 'Defeated' },
        { id: 'lm-bogwitch', type: 'trader', name: 'The Bog Witch', x: 1520, z: 1380, biome: 'Swamp', icon: '🧙‍♀️', status: 'Discovered' },
        { id: 'lm-moder', type: 'boss', name: 'Moder Summit', x: -2190, z: -1320, biome: 'Mountains', icon: '🐉', status: 'Defeated' },
        { id: 'lm-yagluth', type: 'boss', name: 'Yagluth Fingers', x: 3980, z: -2490, biome: 'Plains', icon: '👑', status: 'Defeated' },
        { id: 'lm-queen', type: 'boss', name: 'Infested Citadel (The Queen)', x: -5450, z: 3720, biome: 'Mistlands', icon: '🪲', status: 'Discovered' },
        { id: 'lm-fader', type: 'boss', name: 'Fader\'s Colosseum', x: 1780, z: -8320, biome: 'Ashlands', icon: '🌋', status: 'In Progress' }
      ],

      // Active Death Tombstones (Player_tombstone ZDOs)
      tombstones: [
        {
          id: 'tomb-1',
          player: 'Bjorn Ironside',
          steamId: '76561198119402875',
          x: -2095,
          z: -1245,
          biome: 'Mountains',
          createdAt: new Date(Date.now() - 19 * 60 * 1000).toISOString(),
          itemsCount: 24
        },
        {
          id: 'tomb-2',
          player: 'Ragnar Lothbrok',
          steamId: '76561198042198311',
          x: 1690,
          z: -8190,
          biome: 'Ashlands',
          createdAt: new Date(Date.now() - 54 * 60 * 1000).toISOString(),
          itemsCount: 29
        }
      ]
    };

    this.startLiveTick();
  }

  startLiveTick() {
    setInterval(() => {
      this.tickLiveSimulation();
    }, 3000);
  }

  /**
   * Reads /config/watchtower/live_map.json if a BepInEx plugin writes to disk,
   * otherwise gently animates online Vikings' coordinates & health in Preview Mode.
   */
  tickLiveSimulation() {
    if (fs.existsSync(this.liveMapFile)) {
      try {
        const externalData = JSON.parse(fs.readFileSync(this.liveMapFile, 'utf8'));
        this.ingestExternalTelemetry(externalData, 'BepInEx /config/watchtower/live_map.json');
        return;
      } catch (_) {}
    }

    const knownPlayers = this.configManager.state.players || {};

    // Ensure any newly online simulated player appears on the map
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

    // Update positions, trails, and HP regeneration/combat for online players
    for (const lp of Object.values(this.mapState.livePlayers)) {
      // Slightly vary velocity vector
      lp.vx = Math.max(-24, Math.min(24, (lp.vx || 8) + (Math.random() - 0.5) * 8));
      lp.vz = Math.max(-24, Math.min(24, (lp.vz || 8) + (Math.random() - 0.5) * 8));
      lp.x = Math.round(lp.x + lp.vx);
      lp.z = Math.round(lp.z + lp.vz);
      lp.heading = Math.round(((Math.atan2(lp.vx, -lp.vz) * 180) / Math.PI + 360) % 360);

      // Update trail
      lp.trail = lp.trail || [];
      lp.trail.push({ x: lp.x, z: lp.z });
      if (lp.trail.length > 10) lp.trail.shift();

      // Fluctuate HP & Stamina realistically
      const hpDelta = Math.round((Math.random() - 0.44) * 9);
      lp.hp = Math.max(24, Math.min(lp.maxHp, lp.hp + hpDelta));
      lp.stamina = Math.max(15, Math.min(lp.maxStamina, lp.stamina + Math.round((Math.random() - 0.48) * 18)));
    }

    this.mapState.lastUpdated = new Date().toISOString();
  }

  /**
   * Accepts live telemetry pushed by the BepInEx WatchtowerMapExporter plugin
   */
  ingestExternalTelemetry(payload, sourceLabel = 'BepInEx HTTP Webhook') {
    this.mapState.telemetrySource = sourceLabel;
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

        // Also expand discovered fog-of-war if player enters a new area
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
    const x = lp ? lp.x : Math.round((Math.random() - 0.5) * 3000);
    const z = lp ? lp.z : Math.round((Math.random() - 0.5) * 3000);
    this.mapState.tombstones.unshift({
      id: `tomb-${Date.now()}`,
      player: playerName,
      steamId,
      x,
      z,
      biome: lp ? lp.biome : this.estimateBiome(x, z),
      createdAt: new Date().toISOString(),
      itemsCount: 18 + Math.floor(Math.random() * 14)
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

  getSnapshot() {
    return {
      ...this.mapState,
      livePlayersList: Object.values(this.mapState.livePlayers)
    };
  }
}

module.exports = { ValheimMapEngine };
