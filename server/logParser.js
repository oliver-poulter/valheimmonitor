const { RAID_LORE_MAP } = require('./configManager');
const { sendDiscordNotification } = require('./discordNotifier');

class ValheimLogParser {
  constructor(configManager, onUpdateCallback = () => {}) {
    this.configManager = configManager;
    this.onUpdate = onUpdateCallback;
    this.pendingSteamIds = [];
    this.recentLogs = [];
    this.maxLogLines = 400;
  }

  get state() {
    return this.configManager.state;
  }

  /**
   * Process a single line from valheim-server logs
   */
  processLine(rawLine, { isHistorical = false } = {}) {
    if (!rawLine || typeof rawLine !== 'string') return;
    // Strip Docker multiplexed stream header control characters if present
    const cleanLine = rawLine.replace(/^[\x00-\x08][\x00-\x1f]{0,7}/, '').trim();
    if (!cleanLine) return;

    // Extract timestamp if present (MM/DD/YYYY HH:MM:SS:)
    let timestamp = new Date().toISOString();
    const tsMatch = cleanLine.match(/^(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}):\s*(.*)$/);
    let body = cleanLine;
    if (tsMatch) {
      const parsedDate = new Date(tsMatch[1]);
      if (!isNaN(parsedDate.getTime())) {
        timestamp = parsedDate.toISOString();
      }
      body = tsMatch[2];
    }

    const category = this.categorizeLine(body);
    const logEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp,
      category,
      raw: cleanLine,
      message: body
    };

    this.recentLogs.push(logEntry);
    if (this.recentLogs.length > this.maxLogLines) {
      this.recentLogs.shift();
    }

    let stateChanged = false;

    // 1. Handshake from client <SteamID64>
    const handshakeMatch = body.match(/Got handshake from client (\d{15,20})/i);
    if (handshakeMatch) {
      const steamId = handshakeMatch[1];
      this.pendingSteamIds.push({ steamId, timestamp });
      if (this.pendingSteamIds.length > 10) this.pendingSteamIds.shift();
    }

    // 2. Character ZDOID (Spawn/Join or Death 0:0)
    const zdoMatch = body.match(/Got character ZDOID from (.+?)\s*:\s*(-?\d+:\d+)/i);
    if (zdoMatch) {
      const playerName = zdoMatch[1].trim();
      const zdoId = zdoMatch[2].trim();
      const playerKey = this.resolvePlayerKey(playerName);

      const player = this.state.players[playerKey] || {
        steamId: playerKey,
        name: playerName,
        online: false,
        currentSessionStart: null,
        firstSeen: timestamp,
        lastSeen: timestamp,
        totalPlaytimeSeconds: 0,
        sessionsCount: 0,
        deathsCount: 0,
        lastZdoId: zdoId,
        avatarHue: Math.abs(this.hashCode(playerName)) % 360
      };

      player.name = playerName;
      player.lastSeen = timestamp;
      player.lastZdoId = zdoId;

      if (zdoId === '0:0') {
        // Player died!
        player.deathsCount = (player.deathsCount || 0) + 1;
        this.addEvent({
          type: 'death',
          timestamp,
          player: playerName,
          steamId: player.steamId,
          title: `${playerName} met their end in battle`,
          detail: `Total deaths: ${player.deathsCount}`
        });
        if (!isHistorical && this.state.settings.notifyOnDeath) {
          sendDiscordNotification(this.state.settings.discordWebhookUrl, {
            type: 'death',
            serverName: this.state.serverMeta.serverName,
            message: `**${playerName}** has fallen in **${this.state.serverMeta.worldName}**!`,
            fields: [
              { name: 'Viking', value: playerName, inline: true },
              { name: 'Total Deaths', value: String(player.deathsCount), inline: true }
            ]
          });
        }
      } else if (!player.online) {
        // Player joined!
        player.online = true;
        player.currentSessionStart = timestamp;
        player.sessionsCount = (player.sessionsCount || 0) + 1;
        this.addEvent({
          type: 'join',
          timestamp,
          player: playerName,
          steamId: player.steamId,
          title: `${playerName} joined the server`,
          detail: `SteamID: ${player.steamId} • Session #${player.sessionsCount}`
        });
        if (!isHistorical && this.state.settings.notifyOnJoin) {
          sendDiscordNotification(this.state.settings.discordWebhookUrl, {
            type: 'join',
            serverName: this.state.serverMeta.serverName,
            message: `**${playerName}** has arrived in **${this.state.serverMeta.worldName}**!`,
            fields: [
              { name: 'SteamID64', value: `\`${player.steamId}\``, inline: true },
              { name: 'Session', value: `#${player.sessionsCount}`, inline: true }
            ]
          });
        }
      }

      this.state.players[playerKey] = player;
      stateChanged = true;
    }

    // 3. Player Disconnect (Closing socket <SteamID64>)
    const disconnectMatch = body.match(/Closing socket (\d{15,20})/i);
    if (disconnectMatch) {
      const steamId = disconnectMatch[1];
      const player = this.state.players[steamId];
      if (player && player.online) {
        player.online = false;
        player.lastSeen = timestamp;
        let sessionSeconds = 0;
        if (player.currentSessionStart) {
          const diff = Math.floor((new Date(timestamp) - new Date(player.currentSessionStart)) / 1000);
          if (diff > 0 && diff < 86400 * 3) {
            sessionSeconds = diff;
            player.totalPlaytimeSeconds = (player.totalPlaytimeSeconds || 0) + sessionSeconds;
          }
        }
        player.currentSessionStart = null;
        this.addEvent({
          type: 'leave',
          timestamp,
          player: player.name,
          steamId,
          title: `${player.name} disconnected`,
          detail: sessionSeconds > 0 ? `Session lasted ${Math.round(sessionSeconds / 60)}m` : `SteamID: ${steamId}`
        });
        if (!isHistorical && this.state.settings.notifyOnLeave) {
          sendDiscordNotification(this.state.settings.discordWebhookUrl, {
            type: 'leave',
            serverName: this.state.serverMeta.serverName,
            message: `**${player.name}** departed from **${this.state.serverMeta.worldName}**.`,
            fields: [
              { name: 'Session Time', value: `${Math.max(1, Math.round(sessionSeconds / 60))} mins`, inline: true }
            ]
          });
        }
        stateChanged = true;
      }
    }

    // 4. Random Event / Raid
    const raidMatch = body.match(/Random event set:\s*([a-zA-Z0-9_]+)/i);
    if (raidMatch) {
      const raidCode = raidMatch[1];
      const lore = RAID_LORE_MAP[raidCode] || {
        name: `Raid: ${raidCode}`,
        biome: 'Unknown Biome',
        icon: '⚔️',
        severity: 'High'
      };
      const raidEntry = {
        code: raidCode,
        ...lore,
        timestamp
      };
      this.state.raids.unshift(raidEntry);
      if (this.state.raids.length > 50) this.state.raids.pop();

      this.addEvent({
        type: 'raid',
        timestamp,
        title: `${lore.icon} ${lore.name}`,
        detail: `Event code: ${raidCode} (${lore.biome} • ${lore.severity} Threat)`
      });
      if (!isHistorical && this.state.settings.notifyOnRaid) {
        sendDiscordNotification(this.state.settings.discordWebhookUrl, {
          type: 'raid',
          serverName: this.state.serverMeta.serverName,
          message: `**${lore.icon} ${lore.name}**\nBiome: **${lore.biome}** | Threat: **${lore.severity}**`
        });
      }
      stateChanged = true;
    }

    // 5. World Saved duration & ZDO count
    const zdoCountMatch = body.match(/Saved (\d+) ZDOs/i);
    if (zdoCountMatch) {
      this.state.serverMeta.zdoCount = Number(zdoCountMatch[1]);
      stateChanged = true;
    }

    const saveMatch = body.match(/World saved\s*\(\s*([\d.]+)\s*ms\s*\)/i);
    if (saveMatch) {
      const durationMs = parseFloat(saveMatch[1]);
      this.state.serverMeta.lastSaveMs = durationMs;
      this.state.serverMeta.lastSaveAt = timestamp;
      this.state.worldSaves.push({
        timestamp,
        durationMs,
        zdoCount: this.state.serverMeta.zdoCount || 0
      });
      if (this.state.worldSaves.length > 50) {
        this.state.worldSaves.shift();
      }
      this.addEvent({
        type: 'save',
        timestamp,
        title: `World saved (${durationMs.toFixed(1)} ms)`,
        detail: `${(this.state.serverMeta.zdoCount || 0).toLocaleString()} active ZDO entities`
      });
      stateChanged = true;
    }

    // 6. Crossplay Join Code & Version
    const joinCodeMatch = body.match(/join code\s+(\d{5,8})/i);
    if (joinCodeMatch) {
      this.state.serverMeta.joinCode = joinCodeMatch[1];
      this.state.serverMeta.crossplay = true;
      stateChanged = true;
    }

    const versionMatch = body.match(/Valheim version:?\s*([0-9.]+(?:\s*\([^)]+\))?)/i);
    if (versionMatch) {
      this.state.serverMeta.version = versionMatch[1].trim();
      stateChanged = true;
    }

    if (stateChanged && !isHistorical) {
      this.configManager.saveState();
    }

    if (!isHistorical) {
      this.onUpdate({ logEntry, stateChanged });
    }
  }

  resolvePlayerKey(playerName) {
    // Check if we already know this player by name
    for (const [key, record] of Object.entries(this.state.players)) {
      if (record.name && record.name.toLowerCase() === playerName.toLowerCase()) {
        // If we had a synthetic key and now have a pending SteamID, upgrade it
        if (key.startsWith('viking_') && this.pendingSteamIds.length > 0) {
          const { steamId } = this.pendingSteamIds.pop();
          delete this.state.players[key];
          record.steamId = steamId;
          this.state.players[steamId] = record;
          return steamId;
        }
        return key;
      }
    }
    if (this.pendingSteamIds.length > 0) {
      const { steamId } = this.pendingSteamIds.pop();
      return steamId;
    }
    return `76561198${String(Math.abs(this.hashCode(playerName))).padStart(9, '0').slice(0, 9)}`;
  }

  addEvent(evt) {
    this.state.events.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ...evt
    });
    if (this.state.events.length > 200) {
      this.state.events.pop();
    }
  }

  categorizeLine(line) {
    const lower = line.toLowerCase();
    if (lower.includes('zdoid from') && lower.includes(': 0:0')) return 'death';
    if (lower.includes('handshake') || lower.includes('zdoid from') || lower.includes('closing socket')) return 'player';
    if (lower.includes('random event set')) return 'raid';
    if (lower.includes('world saved') || lower.includes('saved ') || lower.includes('backup')) return 'save';
    if (lower.includes('error') || lower.includes('exception') || lower.includes('warning')) return 'warn';
    if (lower.includes('bepinex') || lower.includes('plugin')) return 'mod';
    return 'info';
  }

  hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }
}

module.exports = { ValheimLogParser };
