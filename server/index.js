const express = require('express');
const path = require('path');
const { ConfigManager, RAID_LORE_MAP } = require('./configManager');
const { ValheimLogParser } = require('./logParser');
const { DockerController } = require('./dockerController');
const { sendDiscordNotification } = require('./discordNotifier');
const { ValheimMapEngine } = require('./mapEngine');

const PORT = Number(process.env.PORT || 3000);
const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const sseClients = new Set();

function broadcastSSE(type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

const configManager = new ConfigManager();
const mapEngine = new ValheimMapEngine(configManager);
const logParser = new ValheimLogParser(configManager, ({ logEntry, stateChanged }) => {
  broadcastSSE('log', logEntry);
  if (stateChanged) {
    broadcastSSE('state_updated', { timestamp: new Date().toISOString() });
  }
});
const dockerController = new DockerController(configManager, logParser);

function buildOverviewPayload() {
  const state = configManager.state;
  const playersList = Object.values(state.players).sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
  });
  const { backups, worlds } = configManager.getBackupsAndWorlds();
  const accessLists = configManager.getAccessLists();
  const mods = configManager.getModConfigs();

  return {
    container: dockerController.currentStatus,
    serverMeta: state.serverMeta,
    players: playersList,
    onlineCount: playersList.filter((p) => p.online).length,
    totalKnownPlayers: playersList.length,
    totalDeaths: playersList.reduce((acc, p) => acc + (p.deathsCount || 0), 0),
    events: state.events.slice(0, 60),
    worldSaves: state.worldSaves,
    raids: state.raids.slice(0, 20),
    raidCatalog: RAID_LORE_MAP,
    telemetryHistory: dockerController.telemetryHistory,
    accessLists,
    backups,
    worlds,
    mods,
    worldMap: mapEngine.getSnapshot(),
    settings: {
      ...state.settings,
      rconPassConfigured: Boolean(state.settings.rconPass)
    }
  };
}

// SSE Live Stream
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Full Dashboard Overview
app.get('/api/overview', (req, res) => {
  res.json(buildOverviewPayload());
});

// Recent Logs
app.get('/api/logs', (req, res) => {
  res.json({ logs: logParser.recentLogs });
});

// Server Lifecycle & Supervisor Actions (start, stop, restart, backup, update)
app.post('/api/server/action', async (req, res) => {
  try {
    const { action } = req.body;
    const result = await dockerController.performServerAction(action);
    broadcastSSE('state_updated', { action });
    res.json({ ...result, overview: buildOverviewPayload() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Auto-Configure Valheim Server (Install BepInEx + WatchtowerMapExporter.dll + STATUS_HTTP)
app.post('/api/server/autoconfigure', async (req, res) => {
  try {
    const result = await dockerController.autoConfigureValheimServer({ forceRestart: true });
    broadcastSSE('state_updated', { action: 'autoconfigure' });
    res.json({ ...result, overview: buildOverviewPayload() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Execute Key Commands / RCON / Supervisor Commands
app.post('/api/command', async (req, res) => {
  try {
    const { command, mode } = req.body;
    const result = await dockerController.executeCommand({ command, mode });
    broadcastSSE('state_updated', { command });
    res.json({ ...result, overview: buildOverviewPayload() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Access Control List (adminlist.txt, bannedlist.txt, permittedlist.txt)
app.post('/api/acl', (req, res) => {
  try {
    const { listType, action, steamId, name, note } = req.body;
    const accessLists = configManager.updateAccessList(listType, action, { steamId, name, note });
    logParser.addEvent({
      type: 'system',
      timestamp: new Date().toISOString(),
      title: `ACL Updated (${listType})`,
      detail: `${action === 'add' ? 'Added' : 'Removed'} ${name || steamId} (${steamId})`
    });
    broadcastSSE('state_updated', { acl: listType });
    res.json({ ok: true, accessLists, overview: buildOverviewPayload() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Backups Management
app.post('/api/backups/create', async (req, res) => {
  try {
    const result = await dockerController.performServerAction('backup');
    res.json({ ...result, overview: buildOverviewPayload() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/backups/download/:filename', (req, res) => {
  const filePath = configManager.getBackupFilePath(req.params.filename);
  if (!filePath) {
    return res.status(404).json({ ok: false, error: 'Backup file not found' });
  }
  res.download(filePath);
});

app.delete('/api/backups/:filename', (req, res) => {
  try {
    const { backups, worlds } = configManager.deleteBackup(req.params.filename);
    logParser.addEvent({
      type: 'save',
      timestamp: new Date().toISOString(),
      title: `Deleted Backup Archive`,
      detail: req.params.filename
    });
    res.json({ ok: true, backups, worlds });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// BepInEx / ValheimPlus Config File Reader & Editor
app.get('/api/mods/config/:filename', (req, res) => {
  try {
    const file = configManager.readModConfigFile(req.params.filename);
    res.json({ ok: true, ...file });
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message });
  }
});

app.post('/api/mods/config/:filename', (req, res) => {
  try {
    const result = configManager.writeModConfigFile(req.params.filename, req.body.content || '');
    logParser.addEvent({
      type: 'system',
      timestamp: new Date().toISOString(),
      title: `Edited Mod Configuration`,
      detail: `Saved /config/bepinex/config/${result.filename}`
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Settings, World Modifiers & Discord Webhook Configuration
app.post('/api/settings', (req, res) => {
  try {
    const current = configManager.state.settings;
    configManager.state.settings = {
      ...current,
      ...req.body,
      worldModifiers: {
        ...(current.worldModifiers || {}),
        ...(req.body.worldModifiers || {})
      }
    };
    configManager.saveState();
    res.json({ ok: true, settings: configManager.state.settings });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/settings/test-discord', async (req, res) => {
  const url = req.body.discordWebhookUrl || configManager.state.settings.discordWebhookUrl;
  const result = await sendDiscordNotification(url, {
    type: 'system',
    serverName: configManager.state.serverMeta.serverName,
    message: '🔥 **Heimdall Watchtower is connected!** Real-time Valheim server alerts are active.',
    fields: [
      { name: 'World', value: configManager.state.serverMeta.worldName, inline: true },
      { name: 'Online Vikings', value: String(Object.values(configManager.state.players).filter((p) => p.online).length), inline: true }
    ]
  });
  res.json(result);
});

// Live World Map & Player Telemetry Endpoints
app.get('/api/map', (req, res) => {
  res.json(mapEngine.getSnapshot());
});

app.post('/api/map/telemetry', (req, res) => {
  try {
    mapEngine.ingestExternalTelemetry(req.body, 'BepInEx HTTP Telemetry');
    broadcastSSE('telemetry', {
      container: dockerController.currentStatus,
      telemetryHistory: dockerController.telemetryHistory,
      worldMap: mapEngine.getSnapshot(),
      onlineCount: Object.values(configManager.state.players).filter((p) => p.online).length
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Simulate Viking Events (for testing / previewing live log detection)
app.post('/api/simulate/event', (req, res) => {
  const { eventType, playerName = 'Erik the Red', steamId = '76561198201948572', raidCode = 'foresttrolls' } = req.body;
  const nowStr = dockerController.formatValheimDate();

  if (eventType === 'join') {
    logParser.processLine(`${nowStr}: Got handshake from client ${steamId}`);
    logParser.processLine(`${nowStr}: Got character ZDOID from ${playerName} : 418999102:1`);
  } else if (eventType === 'death') {
    logParser.processLine(`${nowStr}: Got character ZDOID from ${playerName} : 0:0`);
    mapEngine.recordPlayerDeathTombstone(playerName, steamId);
  } else if (eventType === 'leave') {
    logParser.processLine(`${nowStr}: Closing socket ${steamId}`);
  } else if (eventType === 'raid') {
    logParser.processLine(`${nowStr}: Random event set:${raidCode}`);
  }

  mapEngine.tickLiveSimulation();
  res.json({ ok: true, overview: buildOverviewPayload() });
});

async function start() {
  await dockerController.init();

  // Broadcast telemetry & live map positions every 3 seconds to connected SSE clients
  setInterval(() => {
    broadcastSSE('telemetry', {
      container: dockerController.currentStatus,
      telemetryHistory: dockerController.telemetryHistory,
      worldMap: mapEngine.getSnapshot(),
      onlineCount: Object.values(configManager.state.players).filter((p) => p.online).length
    });
  }, 3000);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`============================================================`);
    console.log(`🛡️  HEIMDALL WATCHTOWER — Valheim Server Dashboard`);
    console.log(`🌐 Listening on http://0.0.0.0:${PORT}`);
    console.log(`📦 Mode: ${dockerController.currentStatus.mode.toUpperCase()}`);
    console.log(`📁 Config Path: ${configManager.configDir}`);
    console.log(`============================================================`);
  });
}

start();
