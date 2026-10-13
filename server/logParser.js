const { RAID_LORE_MAP } = require('./configManager');
const { sendDiscordNotification } = require('./discordNotifier');

class ValheimLogParser {
  constructor(configManager, onUpdateCallback = () => {}) {
    this.configManager = configManager;
    this.onUpdate = onUpdateCallback;
    this.pendingSteamIds = [];
    this.recentLogs = [];
    this.maxLogLines = 400;
    this.loadedBepInExPlugins = new Set();
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
      const now = Date.now();
      // Prune handshakes older than 90 seconds
      this.pendingSteamIds = this.pendingSteamIds.filter((h) => now - (h.time || 0) <= 90000);
      if (!this.pendingSteamIds.some((h) => h.steamId === steamId)) {
        this.pendingSteamIds.push({ steamId, time: now, timestamp });
      }
      if (this.pendingSteamIds.length > 15) this.pendingSteamIds.shift();
    }

    // 2. Character ZDOID (Spawn/Join or Death 0:0)
    const zdoMatch = body.match(/Got character ZDOID from (.+?)\s*:\s*(-?\d+:\d+)/i);
    if (zdoMatch) {
      const playerName = zdoMatch[1].trim();
      const zdoId = zdoMatch[2].trim();
      const playerKey = this.resolvePlayerKey(playerName, { isHistorical });

      let player = this.state.players[playerKey];
      // CRITICAL: Ensure playerKey belongs to playerName, never overwrite an existing player record
      if (player && player.name && player.name.toLowerCase() !== playerName.toLowerCase()) {
        const altKey = `vik_${Math.abs(this.hashCode(playerName)).toString(16)}`;
        player = this.state.players[altKey] || {
          steamId: altKey,
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
        this.state.players[altKey] = player;
      } else if (!player) {
        player = {
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
        this.state.players[playerKey] = player;
      }

      player.name = playerName;
      player.lastSeen = timestamp;
      player.lastZdoId = zdoId;

      if (isHistorical) {
        return;
      }

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

      stateChanged = true;
    }

    // 3. Player Disconnects
    // Pattern A: Authoritative Valheim ZDO teardown with SteamID64:
    const zdoDestroyMatch = body.match(/Destroying abandoned non persistent zdo\s+(-?\d+:\d+)\s+owner\s+(\d{15,20})/i);
    if (zdoDestroyMatch) {
      const ownerSteamId = zdoDestroyMatch[2];
      if (this.finalizePlayerDisconnect(ownerSteamId, timestamp, { isHistorical })) {
        stateChanged = true;
      }
    }

    // Pattern B: Closing socket
    const closeSocketMatch = body.match(/Closing socket\s+(\d+)/i);
    if (closeSocketMatch) {
      const sock = closeSocketMatch[1];
      if (sock.length >= 15) {
        if (this.finalizePlayerDisconnect(sock, timestamp, { isHistorical })) {
          stateChanged = true;
        }
      } else {
        const onlineList = Object.values(this.state.players).filter((p) => p.online);
        if (onlineList.length === 1) {
          if (this.finalizePlayerDisconnect(onlineList[0].steamId, timestamp, { isHistorical })) {
            stateChanged = true;
          }
        }
      }
    }

    // Pattern C: Disconnecting client
    const disconnectClientMatch = body.match(/Disconnecting client\s+(\d+)/i);
    if (disconnectClientMatch) {
      const targetId = disconnectClientMatch[1];
      if (targetId.length >= 15) {
        if (this.finalizePlayerDisconnect(targetId, timestamp, { isHistorical })) {
          stateChanged = true;
        }
      } else {
        const onlineList = Object.values(this.state.players).filter((p) => p.online);
        if (onlineList.length === 1) {
          if (this.finalizePlayerDisconnect(onlineList[0].steamId, timestamp, { isHistorical })) {
            stateChanged = true;
          }
        }
      }
    }

    // Pattern D: Explicit disconnect messages e.g. "Player <Name> disconnected"
    const playerDiscMatch = body.match(/Player\s+['"]?([^'"]+?)['"]?\s+disconnected/i);
    if (playerDiscMatch) {
      if (this.finalizePlayerDisconnect(playerDiscMatch[1].trim(), timestamp, { isHistorical })) {
        stateChanged = true;
      }
    }

    // Pattern E: Server startup / restart markers (reset all stale sessions from previous runs)
    if (
      body.match(/Game server connected/i) ||
      body.match(/Server ID:\s*\d+/i) ||
      body.match(/Valheim version:?\s*[0-9.]+/i) ||
      body.match(/Server registered with join code/i)
    ) {
      if (this.finalizeAllSessions(timestamp)) {
        stateChanged = true;
      }
    }

    // Pattern F: BepInEx plugin chainloader tracking from stdout
    const lowerBody = body.toLowerCase();
    if (lowerBody.includes('bepinex is enabled')) {
      this.bepinexConfirmedEnabled = true;
    }
    if (lowerBody.includes('spreadtheload')) {
      this.loadedBepInExPlugins.add('spreadtheload');
    }
    if (lowerBody.includes('betternetworking')) {
      this.loadedBepInExPlugins.add('betternetworking');
    }
    if (lowerBody.includes('serverdevcommands') || lowerBody.includes('server devcommands')) {
      this.loadedBepInExPlugins.add('serverdevcommands');
    }
    if (
      lowerBody.includes('watchtowermapexporter') ||
      lowerBody.includes('heimdall watchtower') ||
      lowerBody.includes('watchtower map exporter') ||
      lowerBody.includes('com.watchtower.valheim.mapexporter')
    ) {
      this.loadedBepInExPlugins.add('watchtowermapexporter');
      this.loadedBepInExPlugins.add('heimdall watchtower map exporter');
    }
    const bepinexPluginMatch = body.match(/\[(?:Info|Message)\s*:\s*BepInEx\]\s*(?:Loading\s*\[(.+?)(?:\s+[\d\.]+)?\]|Loaded\s*\[(.+?)\])/i);
    if (bepinexPluginMatch) {
      const pName = (bepinexPluginMatch[1] || bepinexPluginMatch[2] || '').trim();
      if (pName) {
        this.loadedBepInExPlugins.add(pName.toLowerCase());
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
    const joinCodeMatch = body.match(/join code\s+(\d{5,10})/i);
    if (joinCodeMatch) {
      this.state.serverMeta.joinCode = joinCodeMatch[1];
      this.state.serverMeta.crossplay = true;
      stateChanged = true;
    }

    const sessionMatch = body.match(/(?:Session|Server)\s+["'](.+?)["']\s+registered with join code/i);
    if (sessionMatch) {
      this.state.serverMeta.serverName = sessionMatch[1].trim();
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

  resolvePlayerKey(playerName, { isHistorical = false } = {}) {
    const adminIds = this.configManager.getAdminSteamIds();
    const now = Date.now();
    // Prune stale handshakes older than 90 seconds (unless replaying historical logs)
    if (!isHistorical) {
      this.pendingSteamIds = this.pendingSteamIds.filter((h) => now - (h.time || 0) <= 90000);
    }

    // 1. Check if this player is already known by name
    for (const [key, record] of Object.entries(this.state.players)) {
      if (record.name && record.name.toLowerCase() === playerName.toLowerCase()) {
        // If this record has a real SteamID64:
        if (/^\d{15,20}$/.test(key)) {
          // If key is in adminIds, verify it's the known admin
          if (adminIds.has(key)) {
            const adminMeta = this.state.aclMeta && this.state.aclMeta[key];
            const knownAdminName = adminMeta && adminMeta.name ? adminMeta.name.trim() : null;
            if (knownAdminName && knownAdminName.toLowerCase() !== playerName.toLowerCase()) {
              // This is a hijacked admin record, do not reuse
              break;
            }
          }
          return key;
        }

        // If this record has a synthetic key ('vik_' or 'viking_'):
        if (key.startsWith('vik_') || key.startsWith('viking_')) {
          // Check if a pending non-admin SteamID is waiting
          const suitableIdx = this.pendingSteamIds.findIndex((h) => {
            if (adminIds.has(h.steamId)) {
              const adminMeta = this.state.aclMeta && this.state.aclMeta[h.steamId];
              const knownAdminName = adminMeta && adminMeta.name ? adminMeta.name.trim() : null;
              return knownAdminName && knownAdminName.toLowerCase() === playerName.toLowerCase();
            }
            return true;
          });
          if (suitableIdx !== -1) {
            const [{ steamId }] = this.pendingSteamIds.splice(suitableIdx, 1);
            delete this.state.players[key];
            record.steamId = steamId;
            this.state.players[steamId] = record;
            return steamId;
          }
        }
        return key;
      }
    }

    // 2. Not yet known: match with first suitable pending handshake (FIFO)
    const suitableIdx = this.pendingSteamIds.findIndex((h) => {
      if (adminIds.has(h.steamId)) {
        const adminMeta = this.state.aclMeta && this.state.aclMeta[h.steamId];
        const knownAdminName = adminMeta && adminMeta.name ? adminMeta.name.trim() : null;
        return knownAdminName && knownAdminName.toLowerCase() === playerName.toLowerCase();
      }
      return true;
    });

    if (suitableIdx !== -1) {
      const [{ steamId }] = this.pendingSteamIds.splice(suitableIdx, 1);
      return steamId;
    }

    // 3. Fallback: generate non-colliding synthetic key vik_${hex}
    return `vik_${Math.abs(this.hashCode(playerName)).toString(16)}`;
  }

  finalizePlayerDisconnect(identifier, timestamp, { isHistorical = false } = {}) {
    if (!identifier) return false;
    let target = null;

    if (this.state.players[identifier]) {
      target = this.state.players[identifier];
    } else {
      for (const p of Object.values(this.state.players)) {
        if (p.steamId === identifier || (p.name && p.name.toLowerCase() === String(identifier).toLowerCase())) {
          target = p;
          break;
        }
      }
    }

    if (!target) return false;

    if (target.online) {
      if (isHistorical) {
        target.online = false;
        target.currentSessionStart = null;
        target.lastSeen = timestamp;
        return true;
      }
      const sessionSeconds = this.configManager.finalizePlayerSession(target, timestamp);
      this.addEvent({
        type: 'leave',
        timestamp,
        player: target.name,
        steamId: target.steamId,
        title: `${target.name} disconnected`,
        detail: sessionSeconds > 0 ? `Session lasted ${Math.round(sessionSeconds / 60)}m` : `SteamID: ${target.steamId}`
      });

      if (!isHistorical && this.state.settings.notifyOnLeave) {
        sendDiscordNotification(this.state.settings.discordWebhookUrl, {
          type: 'leave',
          serverName: this.state.serverMeta.serverName,
          message: `**${target.name}** departed from **${this.state.serverMeta.worldName}**.`,
          fields: [
            { name: 'Session Time', value: `${Math.max(1, Math.round(sessionSeconds / 60))} mins`, inline: true }
          ]
        });
      }
      return true;
    } else {
      target.currentSessionStart = null;
      target.lastSeen = timestamp;
      return false;
    }
  }

  finalizeAllSessions(timestamp) {
    let changed = false;
    for (const p of Object.values(this.state.players)) {
      if (p.online) {
        this.configManager.finalizePlayerSession(p, timestamp);
        changed = true;
      }
    }
    return changed;
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
    if (
      lower.includes('handshake') ||
      lower.includes('zdoid from') ||
      lower.includes('closing socket') ||
      lower.includes('destroying abandoned') ||
      lower.includes('disconnecting client')
    ) {
      return 'player';
    }
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
