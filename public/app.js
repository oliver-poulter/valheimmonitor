let appState = null;
let allLogs = [];
let activeEventFilter = 'all';
let activeLogFilter = 'all';

// Audio SFX state
let audioCtx = null;
let audioFxEnabled = localStorage.getItem('heimdall_sfx') === 'true';

// Theme state
const THEMES = ['mead', 'bifrost', 'frost', 'ember'];
const THEME_LABELS = {
  mead: 'Mead Gold',
  bifrost: 'Bifrost',
  frost: 'Frost',
  ember: 'Ember'
};

// Roster Table Sort state
let currentRosterSortCol = 'playtime';
let currentRosterSortAsc = false;

// Command History state
let commandHistory = [];
let historyIndex = -1;

// Log Stream Controls
let logAutoscroll = true;
let logStreamPaused = false;

// Command Palette State
let paletteItems = [];
let paletteSelectedIndex = 0;

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  updateAudioUi();
  fetchOverview();
  fetchLogs();
  connectSSE();

  // Copy Crossplay join code button
  const copyBtn = document.getElementById('copyJoinCodeBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const code = document.getElementById('headerJoinCode').textContent;
      navigator.clipboard?.writeText(code);
      playSfx('copy');
      const badge = document.getElementById('joinCodeCopyBadge');
      if (badge) {
        badge.textContent = 'COPIED!';
        setTimeout(() => { badge.textContent = 'Copy'; }, 2000);
      }
      showToast(`🔑 Copied PlayFab Crossplay Join Code: ${code}`);
    });
  }

  // Global keybindings (Ctrl+K / Cmd+K for Command Palette)
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openCommandPalette();
    } else if (e.key === 'Escape') {
      closeCommandPalette();
    }
  });

  // Terminal command history navigation
  const termInput = document.getElementById('terminalCommandInput');
  if (termInput) {
    termInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') {
        if (commandHistory.length > 0) {
          if (historyIndex === -1) historyIndex = commandHistory.length - 1;
          else if (historyIndex > 0) historyIndex--;
          termInput.value = commandHistory[historyIndex];
        }
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        if (commandHistory.length > 0 && historyIndex !== -1) {
          if (historyIndex < commandHistory.length - 1) {
            historyIndex++;
            termInput.value = commandHistory[historyIndex];
          } else {
            historyIndex = -1;
            termInput.value = '';
          }
        }
        e.preventDefault();
      }
    });
  }

  // Refresh relative session timers every 15 seconds
  setInterval(() => {
    if (appState) {
      renderActiveVikings();
      renderPlayersTable();
    }
  }, 15000);
});

/* --------------------------------------------------------------------------
   THEME & AUDIO ENGINES
   -------------------------------------------------------------------------- */
function initTheme() {
  const saved = localStorage.getItem('heimdall_theme') || 'mead';
  setTheme(saved, false);
}

function setTheme(theme, playSound = true) {
  if (!THEMES.includes(theme)) theme = 'mead';
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('heimdall_theme', theme);

  const label = document.getElementById('themeNameLabel');
  if (label) label.textContent = THEME_LABELS[theme] || 'Mead Gold';

  const dot = document.getElementById('themeIndicatorDot');
  if (dot) {
    if (theme === 'mead') dot.style.background = '#f59e0b';
    else if (theme === 'bifrost') dot.style.background = '#10b981';
    else if (theme === 'frost') dot.style.background = '#38bdf8';
    else if (theme === 'ember') dot.style.background = '#f97316';
  }

  if (playSound) {
    playSfx('click');
    showToast(`🎨 Nordic Aura Theme: ${THEME_LABELS[theme]}`);
  }
}

function cycleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'mead';
  const idx = THEMES.indexOf(current);
  const next = THEMES[(idx + 1) % THEMES.length];
  setTheme(next, true);
}

function toggleAudioFx() {
  audioFxEnabled = !audioFxEnabled;
  localStorage.setItem('heimdall_sfx', audioFxEnabled ? 'true' : 'false');
  updateAudioUi();
  if (audioFxEnabled) playSfx('copy');
  showToast(audioFxEnabled ? '🔊 Atmospheric Audio SFX Enabled' : '🔇 Audio SFX Muted');
}

function updateAudioUi() {
  const icon = document.getElementById('audioToggleIcon');
  if (icon) icon.textContent = audioFxEnabled ? '🔊' : '🔇';
}

function playSfx(type) {
  if (!audioFxEnabled) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (type === 'click') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(160, now + 0.05);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc.start(now);
      osc.stop(now + 0.05);
    } else if (type === 'copy') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.setValueAtTime(659.25, now + 0.07);
      osc.frequency.setValueAtTime(783.99, now + 0.14);
      gain.gain.setValueAtTime(0.09, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.start(now);
      osc.stop(now + 0.28);
    } else if (type === 'horn') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.linearRampToValueAtTime(277.18, now + 0.18);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      osc.start(now);
      osc.stop(now + 0.45);
    } else if (type === 'save') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(329.63, now);
      osc.frequency.linearRampToValueAtTime(440, now + 0.15);
      gain.gain.setValueAtTime(0.09, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
    }
  } catch (_) {}
}

/* --------------------------------------------------------------------------
   API FETCHING & SSE
   -------------------------------------------------------------------------- */
async function fetchOverview() {
  try {
    const res = await fetch('/api/overview');
    const data = await res.json();
    appState = data;
    renderAll();
  } catch (err) {
    showToast(`⚠️ Failed to load server overview: ${err.message}`);
  }
}

async function fetchLogs() {
  try {
    const res = await fetch('/api/logs');
    const data = await res.json();
    allLogs = data.logs || [];
    renderLogStream();
  } catch (_) {}
}

function connectSSE() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => {
    fetchOverview();
  });

  es.addEventListener('log', (e) => {
    try {
      const entry = JSON.parse(e.data);
      if (!logStreamPaused) {
        allLogs.push(entry);
        if (allLogs.length > 500) allLogs.shift();
        renderLogStream();
      }
    } catch (_) {}
  });

  es.addEventListener('state_updated', () => {
    fetchOverview();
  });

  es.addEventListener('telemetry', (e) => {
    try {
      const payload = JSON.parse(e.data);
      if (appState) {
        appState.container = payload.container;
        appState.telemetryHistory = payload.telemetryHistory;
        if (payload.worldMap) {
          const existingGrid = appState.worldMap?.terrainGrid;
          appState.worldMap = {
            ...appState.worldMap,
            ...payload.worldMap,
            terrainGrid: payload.worldMap.terrainGrid || existingGrid
          };
        }
        renderHeaderAndKpis();
        renderActiveVikings();
        renderChartsAndSupervisor();
        renderLiveMapAndVitals();
      }
    } catch (_) {}
  });
}

function switchTab(tabId) {
  playSfx('click');
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tabId}`);
  });
  if (tabId === 'map') {
    setTimeout(() => drawValheimMap(), 30);
  } else if (tabId === 'settings') {
    updateDiscordEmbedPreview();
  }
}

function renderAll() {
  if (!appState) return;
  renderHeaderAndKpis();
  renderActiveVikings();
  renderChartsAndSupervisor();
  renderChronicleFeed();
  renderPlayersTable();
  renderRaidCatalogAndHistory();
  renderAclColumns();
  renderBackupsAndWorlds();
  renderActiveModsList();
  populateSettingsAndModifiers();
  renderLiveMapAndVitals();
  updateActiveRaidAlarmBanner();
  updateDiscordEmbedPreview();
}

/* --------------------------------------------------------------------------
   HEADER & KPIS RENDERING
   -------------------------------------------------------------------------- */
function renderHeaderAndKpis() {
  const { container, serverMeta, players, totalDeaths, backups } = appState;
  const onlinePlayers = players.filter((p) => p.online);

  document.getElementById('headerServerName').textContent = serverMeta.serverName || 'Valhalla Dedicated';
  document.getElementById('headerWorldName').textContent = serverMeta.worldName || 'Midgard';
  document.getElementById('headerVersion').textContent = serverMeta.version || '0.219.16';
  document.getElementById('headerJoinCode').textContent = serverMeta.joinCode || '849201';
  document.getElementById('headerUptime').textContent = formatUptime(container.startedAt, container.state);

  // Status badge
  const statusBadge = document.getElementById('serverStatusBadge');
  const statusText = document.getElementById('serverStatusText');
  statusBadge.className = 'status-pill';
  if (container.state === 'running') {
    statusBadge.classList.add('status-running');
    statusText.textContent = 'ONLINE';
  } else if (container.state === 'restarting') {
    statusBadge.classList.add('status-restarting');
    statusText.textContent = 'RESTARTING...';
  } else {
    statusBadge.classList.add('status-stopped');
    statusText.textContent = container.state.toUpperCase();
  }

  // Connection mode badge
  const modeBadge = document.getElementById('connectionModeBadge');
  modeBadge.textContent =
    container.mode === 'docker' ? '🐳 Docker Socket' : '⚡ Interactive Preview';

  // Counters
  document.getElementById('navOnlineCounter').textContent = onlinePlayers.length;
  document.getElementById('navBackupCounter').textContent = (backups || []).length;

  // KPI 1: Online Vikings
  document.getElementById('kpiOnlineCount').textContent = onlinePlayers.length;
  document.getElementById('kpiOnlineNames').textContent =
    onlinePlayers.length > 0
      ? onlinePlayers.map((p) => p.name).join(', ')
      : 'No Vikings currently connected';

  const onlineFill = document.getElementById('kpiOnlineFill');
  if (onlineFill) {
    const pct = Math.min(100, Math.round((onlinePlayers.length / 10) * 100));
    onlineFill.style.width = `${pct}%`;
  }

  // KPI 2: Known Vikings & Sessions
  const totalSessions = players.reduce((acc, p) => acc + (p.sessionsCount || 0), 0);
  document.getElementById('kpiTotalVikings').textContent = players.length;
  document.getElementById('kpiTotalSessions').textContent = `${totalSessions} sessions`;
  const mostRecent = [...players].sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0))[0];
  document.getElementById('kpiLastLoginSummary').textContent = mostRecent
    ? `Latest activity: ${mostRecent.name} (${formatRelativeTime(mostRecent.lastSeen)})`
    : 'No login records yet';

  // KPI 3: ZDO & World Save
  document.getElementById('kpiZdoCount').textContent = (serverMeta.zdoCount || 0).toLocaleString();
  document.getElementById('kpiSaveMs').textContent = serverMeta.lastSaveMs
    ? `${Number(serverMeta.lastSaveMs).toFixed(1)} ms`
    : '—';
  document.getElementById('kpiLastSaveTime').textContent = serverMeta.lastSaveAt
    ? `Last world save: ${formatRelativeTime(serverMeta.lastSaveAt)}`
    : 'Awaiting next world save';

  // KPI 4: Container Load & Deaths
  const ramGb = ((container.memoryUsedMb || 0) / 1024).toFixed(1);
  document.getElementById('kpiCpuRam').textContent = `${container.cpuPercent || 0}% / ${ramGb} GB`;
  document.getElementById('kpiTotalDeaths').textContent = `${totalDeaths || 0} deaths`;
  document.getElementById('kpiNetworkIo').textContent =
    `Net RX: ${container.netRxMb || 0} MB • TX: ${container.netTxMb || 0} MB`;
}

/* --------------------------------------------------------------------------
   ACTIVE VIKINGS RENDERING
   -------------------------------------------------------------------------- */
function renderActiveVikings() {
  const container = document.getElementById('activePlayersContainer');
  if (!container || !appState) return;

  const onlinePlayers = appState.players.filter((p) => p.online);
  const adminIds = new Set((appState.accessLists?.admins || []).map((a) => a.steamId));
  const permittedIds = new Set((appState.accessLists?.permitted || []).map((a) => a.steamId));
  const liveMapPlayers = appState.worldMap?.livePlayers || {};

  if (onlinePlayers.length === 0) {
    container.innerHTML = `
      <div class="event-item">
        <span class="event-icon">🌙</span>
        <div class="event-body">
          <div class="event-title">The Mead Hall is Quiet</div>
          <div class="event-detail">No Vikings are currently logged in. Click "Sandbox Testing" above to test live event detection.</div>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = onlinePlayers
    .map((p) => {
      const isAdmin = adminIds.has(p.steamId);
      const isPermitted = permittedIds.has(p.steamId);
      const curSessionSec = p.online && p.currentSessionStart
        ? Math.max(0, Math.floor((Date.now() - new Date(p.currentSessionStart).getTime()) / 1000))
        : 0;
      const effectiveTotalPlaytimeSec = (p.totalPlaytimeSeconds || 0) + curSessionSec;
      const sessionDuration = formatDurationFromTimestamp(p.currentSessionStart);
      const totalHours = (effectiveTotalPlaytimeSec / 3600).toFixed(1);
      const initials = getInitials(p.name);
      const liveTelemetry = liveMapPlayers[p.steamId];
      const hpBadge = liveTelemetry
        ? `<span class="role-badge" style="background:rgba(239,68,68,0.18);color:#fca5a5;border:1px solid rgba(248,113,113,0.4)">❤️ ${liveTelemetry.hp}/${liveTelemetry.maxHp} HP</span>`
        : '';
      const locBadge = liveTelemetry
        ? ` • 📍 <strong class="text-frost">${escapeHtml(liveTelemetry.biome)}</strong> (${liveTelemetry.x}, ${liveTelemetry.z})`
        : '';

      return `
        <div class="active-viking-card">
          <div class="viking-identity">
            <div class="viking-avatar" style="background: linear-gradient(135deg, hsl(${p.avatarHue || 35}, 75%, 38%), hsl(${(p.avatarHue || 35) + 30}, 80%, 22%))">
              ${initials}
              <span class="online-dot"></span>
            </div>
            <div>
              <div class="viking-name-line">
                <span>${escapeHtml(p.name)}</span>
                ${hpBadge}
                ${isAdmin ? '<span class="role-badge role-admin">👑 Admin</span>' : ''}
                ${isPermitted ? '<span class="role-badge role-permitted">🛡️ Whitelisted</span>' : ''}
              </div>
              <div class="viking-meta-line">
                Session: <strong class="text-emerald">${sessionDuration}</strong> • Total: ${totalHours}h • 💀 ${p.deathsCount || 0}${locBadge}
              </div>
            </div>
          </div>
          <div class="viking-actions">
            ${
              liveTelemetry
                ? `<button class="btn btn-xs btn-amber" onclick="jumpToVikingOnMap('${escapeAttr(p.steamId)}')" title="Track Viking on Live Map">🗺️ Locate</button>`
                : ''
            }
            ${
              !isAdmin
                ? `<button class="btn btn-xs btn-glass" onclick="quickAclAction('admins', 'add', '${escapeAttr(p.steamId)}', '${escapeAttr(p.name)}')" title="Promote to Admin">👑 Admin</button>`
                : ''
            }
            <button class="btn btn-xs btn-frost" onclick="executeDeckCommand('kick ${escapeAttr(p.steamId)}')" title="Kick player from server">⚡ Kick</button>
            <button class="btn btn-xs btn-crimson" onclick="executeDeckCommand('ban ${escapeAttr(p.steamId)}')" title="Ban player & add to bannedlist.txt">🚫 Ban</button>
          </div>
        </div>
      `;
    })
    .join('');
}

/* --------------------------------------------------------------------------
   TELEMETRY & CHARTS RENDERING
   -------------------------------------------------------------------------- */
function renderChartsAndSupervisor() {
  const { container, telemetryHistory, worldSaves } = appState;

  // CPU & Memory label
  document.getElementById('chartCpuLabel').textContent =
    `${container.cpuPercent || 0}% CPU • ${container.memoryUsedMb || 0} MB`;

  const cpuValues = (telemetryHistory || []).map((t) => t.cpuPercent || 0);
  renderSparklineSvg('cpuChartSvg', cpuValues, '#f59e0b', 100);

  // World save duration chart
  const saveValues = (worldSaves || []).map((s) => s.durationMs || 0);
  const lastSave = saveValues.length ? saveValues[saveValues.length - 1] : 42.6;
  document.getElementById('chartSaveLabel').textContent = `${Number(lastSave).toFixed(1)} ms`;
  renderSparklineSvg('saveChartSvg', saveValues, '#34d399', Math.max(80, ...saveValues));

  // Supervisor services
  const services = container.supervisorServices || [];
  const strip = document.getElementById('supervisorServicesStrip');
  document.getElementById('supervisorSummaryBadge').textContent =
    `${services.length} Programs Managed`;

  strip.innerHTML = services
    .map((svc) => {
      const isRun = svc.state === 'RUNNING';
      const colorClass = isRun ? 'text-emerald' : 'text-amber';
      return `
        <div class="sup-item">
          <div class="sup-top">
            <span>${escapeHtml(svc.name)}</span>
            <span class="${colorClass}">${escapeHtml(svc.state)}</span>
          </div>
          <div class="sup-desc">${escapeHtml(svc.description || '')}</div>
        </div>
      `;
    })
    .join('');
}

function renderSparklineSvg(svgId, values, strokeColor, maxScale) {
  const svg = document.getElementById(svgId);
  if (!svg) return;
  const pts = values.length >= 2 ? values : [20, 24, 21, 26, 23];
  const width = 360;
  const height = 95;
  const maxVal = Math.max(maxScale || 100, ...pts, 1);

  const coords = pts.map((v, i) => {
    const x = (i / (pts.length - 1)) * width;
    const y = height - 10 - (Math.min(v, maxVal) / maxVal) * (height - 22);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const polylinePoints = coords.join(' ');
  const areaPoints = `0,${height} ${polylinePoints} ${width},${height}`;

  svg.innerHTML = `
    <defs>
      <linearGradient id="grad-${svgId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${strokeColor}" stop-opacity="0.38"/>
        <stop offset="100%" stop-color="${strokeColor}" stop-opacity="0.0"/>
      </linearGradient>
    </defs>
    <polygon points="${areaPoints}" fill="url(#grad-${svgId})" />
    <polyline fill="none" stroke="${strokeColor}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" points="${polylinePoints}" />
  `;
}

/* --------------------------------------------------------------------------
   CHRONICLE FEED & FILTERS
   -------------------------------------------------------------------------- */
function setEventFilter(filter, btn) {
  activeEventFilter = filter;
  playSfx('click');
  document.querySelectorAll('#eventFilterPills .pill').forEach((p) => p.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderChronicleFeed();
}

function renderChronicleFeed() {
  const feed = document.getElementById('chronicleFeed');
  if (!feed || !appState) return;

  const iconMap = {
    join: '⛵',
    leave: '🏕️',
    death: '💀',
    raid: '⚔️',
    save: '💾',
    system: '🔥'
  };

  const filtered = (appState.events || []).filter((e) => {
    if (activeEventFilter === 'all') return true;
    if (activeEventFilter === 'join') return e.type === 'join' || e.type === 'leave';
    return e.type === activeEventFilter;
  });

  if (filtered.length === 0) {
    feed.innerHTML = `<div class="event-item"><div class="event-body"><div class="event-title">No matching events recorded yet.</div></div></div>`;
    return;
  }

  feed.innerHTML = filtered
    .slice(0, 35)
    .map(
      (evt) => `
      <div class="event-item evt-${escapeAttr(evt.type)}">
        <span class="event-icon">${iconMap[evt.type] || '⚡'}</span>
        <div class="event-body">
          <div class="event-title">${escapeHtml(evt.title)}</div>
          <div class="event-detail">${escapeHtml(evt.detail || '')}</div>
        </div>
        <span class="event-time">${formatRelativeTime(evt.timestamp)}</span>
      </div>
    `
    )
    .join('');
}

/* --------------------------------------------------------------------------
   VIKING ROSTER & TABLE SORTING / EXPORT
   -------------------------------------------------------------------------- */
function sortVikingTable(col) {
  if (currentRosterSortCol === col) {
    currentRosterSortAsc = !currentRosterSortAsc;
  } else {
    currentRosterSortCol = col;
    currentRosterSortAsc = (col === 'name');
  }
  playSfx('click');
  renderPlayersTable();
}

function renderPlayersTable() {
  const tbody = document.getElementById('vikingRosterBody');
  if (!tbody || !appState) return;

  const query = (document.getElementById('playerSearchInput')?.value || '').toLowerCase().trim();
  const filter = document.getElementById('playerFilterSelect')?.value || 'all';

  const adminIds = new Set((appState.accessLists?.admins || []).map((a) => a.steamId));
  const permittedIds = new Set((appState.accessLists?.permitted || []).map((a) => a.steamId));
  const bannedIds = new Set((appState.accessLists?.banned || []).map((a) => a.steamId));

  // Compute Roster Summary stats
  const totalVikingsVal = document.getElementById('rosterTotalVikingsVal');
  const onlineVal = document.getElementById('rosterOnlineVal');
  const deathsVal = document.getElementById('rosterDeathsVal');
  const topJarlVal = document.getElementById('rosterTopJarlVal');

  if (totalVikingsVal) totalVikingsVal.textContent = appState.players.length;
  if (onlineVal) onlineVal.textContent = appState.players.filter((p) => p.online).length;
  if (deathsVal) {
    const totDeaths = appState.players.reduce((acc, p) => acc + (p.deathsCount || 0), 0);
    deathsVal.textContent = `${totDeaths} 💀`;
  }
  if (topJarlVal) {
    const sortedByPlaytime = [...appState.players].sort((a, b) => (b.totalPlaytimeSeconds || 0) - (a.totalPlaytimeSeconds || 0));
    topJarlVal.textContent = sortedByPlaytime[0]?.name || 'Ragnar Lothbrok';
  }

  const filtered = (appState.players || []).filter((p) => {
    if (query && !p.name.toLowerCase().includes(query) && !p.steamId.includes(query)) return false;
    if (filter === 'online' && !p.online) return false;
    if (filter === 'offline' && p.online) return false;
    if (filter === 'admin' && !adminIds.has(p.steamId)) return false;
    return true;
  });

  // Sorting
  filtered.sort((a, b) => {
    let cmp = 0;
    if (currentRosterSortCol === 'name') {
      cmp = a.name.localeCompare(b.name);
    } else if (currentRosterSortCol === 'status') {
      cmp = (a.online ? 1 : 0) - (b.online ? 1 : 0);
    } else if (currentRosterSortCol === 'lastSeen') {
      cmp = new Date(a.lastSeen || 0) - new Date(b.lastSeen || 0);
    } else if (currentRosterSortCol === 'playtime') {
      const curA = a.online && a.currentSessionStart ? (Date.now() - new Date(a.currentSessionStart).getTime()) / 1000 : 0;
      const curB = b.online && b.currentSessionStart ? (Date.now() - new Date(b.currentSessionStart).getTime()) / 1000 : 0;
      cmp = ((a.totalPlaytimeSeconds || 0) + curA) - ((b.totalPlaytimeSeconds || 0) + curB);
    } else if (currentRosterSortCol === 'sessions') {
      cmp = (a.sessionsCount || 0) - (b.sessionsCount || 0);
    } else if (currentRosterSortCol === 'deaths') {
      cmp = (a.deathsCount || 0) - (b.deathsCount || 0);
    }
    return currentRosterSortAsc ? cmp : -cmp;
  });

  // Update table header sort arrows
  ['name', 'status', 'lastSeen', 'playtime', 'sessions', 'deaths'].forEach((col) => {
    const ind = document.getElementById(`sort-${col}`);
    if (ind) {
      if (col === currentRosterSortCol) {
        ind.textContent = currentRosterSortAsc ? '▲' : '▼';
        ind.style.opacity = '1';
        ind.style.color = 'var(--amber)';
      } else {
        ind.textContent = '▲▼';
        ind.style.opacity = '0.4';
        ind.style.color = 'inherit';
      }
    }
  });

  tbody.innerHTML = filtered
    .map((p) => {
      const isAdmin = adminIds.has(p.steamId);
      const isPermitted = permittedIds.has(p.steamId);
      const isBanned = bannedIds.has(p.steamId);
      const initials = getInitials(p.name);
      const curSessionSec = p.online && p.currentSessionStart
        ? Math.max(0, Math.floor((Date.now() - new Date(p.currentSessionStart).getTime()) / 1000))
        : 0;
      const effectiveTotalPlaytimeSec = (p.totalPlaytimeSeconds || 0) + curSessionSec;

      return `
        <tr>
          <td>
            <div class="viking-identity">
              <div class="viking-avatar" style="width:36px;height:36px;font-size:0.88rem;background: linear-gradient(135deg, hsl(${p.avatarHue || 35}, 70%, 36%), hsl(${(p.avatarHue || 35) + 25}, 75%, 20%))">
                ${initials}
                ${p.online ? '<span class="online-dot"></span>' : ''}
              </div>
              <div>
                <div class="viking-name-line">${escapeHtml(p.name)}</div>
                <div class="viking-meta-line">${escapeHtml(p.steamId)}</div>
              </div>
            </div>
          </td>
          <td>
            ${
              p.online
                ? `<span class="status-pill status-running"><span class="pulse-dot"></span>Online (${formatDurationFromTimestamp(p.currentSessionStart)})</span>`
                : `<span class="mono-badge">Offline</span>`
            }
          </td>
          <td>
            <div>${formatRelativeTime(p.lastSeen)}</div>
            <div class="viking-meta-line">${formatShortDate(p.lastSeen)}</div>
          </td>
          <td>
            <div class="viking-meta-line">${formatShortDate(p.firstSeen)}</div>
          </td>
          <td>
            <strong class="text-amber">${formatTotalPlaytime(effectiveTotalPlaytimeSec)}</strong>
          </td>
          <td>${p.sessionsCount || 1}</td>
          <td><strong class="text-crimson">${p.deathsCount || 0}</strong></td>
          <td>
            <div style="display:flex;gap:0.3rem;flex-wrap:wrap">
              ${isAdmin ? '<span class="role-badge role-admin">👑 Admin</span>' : ''}
              ${isPermitted ? '<span class="role-badge role-permitted">🛡️ Whitelist</span>' : ''}
              ${isBanned ? '<span class="role-badge role-banned">🚫 Banned</span>' : ''}
              ${!isAdmin && !isPermitted && !isBanned ? '<span class="viking-meta-line">Standard</span>' : ''}
            </div>
          </td>
          <td class="text-right">
            <div style="display:inline-flex;gap:0.35rem;flex-wrap:wrap;justify-content:flex-end">
              ${
                !isAdmin
                  ? `<button class="btn btn-xs btn-glass" onclick="quickAclAction('admins', 'add', '${escapeAttr(p.steamId)}', '${escapeAttr(p.name)}')">👑 Make Admin</button>`
                  : `<button class="btn btn-xs btn-glass" onclick="quickAclAction('admins', 'remove', '${escapeAttr(p.steamId)}', '${escapeAttr(p.name)}')">Remove Admin</button>`
              }
              ${
                !isPermitted
                  ? `<button class="btn btn-xs btn-glass" onclick="quickAclAction('permitted', 'add', '${escapeAttr(p.steamId)}', '${escapeAttr(p.name)}')">🛡️ Whitelist</button>`
                  : ''
              }
              ${
                p.online
                  ? `<button class="btn btn-xs btn-frost" onclick="executeDeckCommand('kick ${escapeAttr(p.steamId)}')">Kick</button>`
                  : ''
              }
              ${
                !isBanned
                  ? `<button class="btn btn-xs btn-crimson" onclick="executeDeckCommand('ban ${escapeAttr(p.steamId)}')">Ban</button>`
                  : `<button class="btn btn-xs btn-emerald" onclick="executeDeckCommand('unban ${escapeAttr(p.steamId)}')">Unban</button>`
              }
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

function exportVikingRosterCsv() {
  if (!appState || !appState.players) return;
  const headers = ['Viking Name', 'SteamID64', 'Online', 'Total Playtime (Seconds)', 'Total Playtime (Hours)', 'Sessions', 'Deaths', 'Last Seen', 'First Seen'];
  const rows = appState.players.map((p) => [
    `"${(p.name || '').replace(/"/g, '""')}"`,
    `"${p.steamId}"`,
    p.online ? 'Online' : 'Offline',
    p.totalPlaytimeSeconds || 0,
    ((p.totalPlaytimeSeconds || 0) / 3600).toFixed(2),
    p.sessionsCount || 1,
    p.deathsCount || 0,
    `"${p.lastSeen || ''}"`,
    `"${p.firstSeen || ''}"`
  ]);
  const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `heimdall-viking-roster-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('📥 Exported Viking roster to CSV');
  playSfx('copy');
}

function exportVikingRosterJson() {
  if (!appState || !appState.players) return;
  const jsonContent = JSON.stringify(appState.players, null, 2);
  const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `heimdall-viking-roster-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('📥 Exported Viking roster to JSON');
  playSfx('copy');
}

/* --------------------------------------------------------------------------
   RAIDS CATALOG & RECENT HISTORY
   -------------------------------------------------------------------------- */
function renderRaidCatalogAndHistory() {
  const catalogGrid = document.getElementById('raidCatalogGrid');
  const historyList = document.getElementById('recentRaidsList');
  if (!catalogGrid || !appState) return;

  const catalog = appState.raidCatalog || {};
  catalogGrid.innerHTML = Object.entries(catalog)
    .map(
      ([code, info]) => `
      <div class="raid-card">
        <div class="raid-card-top">
          <div>
            <div class="raid-title">${info.icon} ${escapeHtml(info.name)}</div>
            <div class="raid-biome">${escapeHtml(info.biome)} • ${escapeHtml(info.severity)}</div>
          </div>
          <button class="btn btn-xs btn-crimson" onclick="executeDeckCommand('randomevent ${escapeAttr(code)}')">
            Summon
          </button>
        </div>
        <p class="cmd-card-desc"><em>"${escapeHtml(info.lore)}"</em></p>
      </div>
    `
    )
    .join('');

  if (historyList) {
    const raids = appState.raids || [];
    if (raids.length === 0) {
      historyList.innerHTML = `<div class="viking-meta-line">No recent raids recorded on this server.</div>`;
    } else {
      historyList.innerHTML = raids
        .slice(0, 8)
        .map(
          (r) => `
          <div class="event-item evt-raid">
            <span class="event-icon">⚔️</span>
            <div class="event-body">
              <div class="event-title">${escapeHtml(r.name || 'Random Event')}</div>
              <div class="event-detail">${r.biome ? escapeHtml(r.biome) : 'Midgard'} • Duration: ${r.durationSec || 120}s</div>
            </div>
            <span class="event-time">${formatRelativeTime(r.timestamp)}</span>
          </div>
        `
        )
        .join('');
    }
  }
}

function updateActiveRaidAlarmBanner() {
  const banner = document.getElementById('activeRaidAlarmBanner');
  if (!banner || !appState) return;

  const recentRaid = (appState.raids || [])[0];
  const now = Date.now();
  const isRecentRaid = recentRaid && (now - new Date(recentRaid.timestamp).getTime()) < 360000;

  if (isRecentRaid) {
    banner.classList.remove('hidden');
    const titleEl = document.getElementById('activeRaidBannerTitle');
    const detailEl = document.getElementById('activeRaidBannerDetail');
    if (titleEl) titleEl.textContent = `"${recentRaid.name || 'Forsaken Assault'}"`;
    if (detailEl) detailEl.textContent = recentRaid.biome ? `Raid active in ${recentRaid.biome}!` : 'Hostile forces have assaulted the settlement!';
  } else {
    banner.classList.add('hidden');
  }
}

/* --------------------------------------------------------------------------
   ACCESS CONTROL LISTS (ACL)
   -------------------------------------------------------------------------- */
function renderAclColumns() {
  if (!appState || !appState.accessLists) return;
  const acl = appState.accessLists;

  document.getElementById('aclAdminsCount').textContent = (acl.admins || []).length;
  document.getElementById('aclPermittedCount').textContent = (acl.permitted || []).length;
  document.getElementById('aclBannedCount').textContent = (acl.banned || []).length;

  renderAclEntries('aclAdminsList', acl.admins, 'admins', '👑');
  renderAclEntries('aclPermittedList', acl.permitted, 'permitted', '🛡️');
  renderAclEntries('aclBannedList', acl.banned, 'banned', '🚫');

  // Populate known player dropdown
  const select = document.getElementById('aclKnownPlayerSelect');
  if (select && appState.players) {
    select.innerHTML =
      '<option value="">— Pick from Known Vikings or enter manually —</option>' +
      appState.players
        .map((p) => `<option value="${escapeAttr(p.steamId)}">${escapeHtml(p.name)} (${p.steamId})</option>`)
        .join('');
  }
}

function renderAclEntries(containerId, entries, listType, icon) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!entries || entries.length === 0) {
    container.innerHTML = `<div class="viking-meta-line" style="padding:0.5rem 0">No entries in this list.</div>`;
    return;
  }

  container.innerHTML = entries
    .map(
      (e) => `
      <div class="acl-entry">
        <div>
          <div class="viking-name-line">${icon} ${escapeHtml(e.name || 'Viking')}</div>
          <div class="viking-meta-line">${escapeHtml(e.steamId)}</div>
        </div>
        <button class="btn btn-xs btn-crimson" onclick="quickAclAction('${listType}', 'remove', '${escapeAttr(e.steamId)}', '${escapeAttr(e.name || '')}')">
          Remove
        </button>
      </div>
    `
    )
    .join('');
}

function populateAclFromKnownPlayer(val) {
  if (!val || !appState) return;
  const p = appState.players.find((x) => x.steamId === val);
  if (p) {
    document.getElementById('aclSteamIdInput').value = p.steamId;
    document.getElementById('aclNameInput').value = p.name;
  }
}

async function handleAclSubmit(e) {
  e.preventDefault();
  const listType = document.getElementById('aclListTypeSelect').value;
  const steamId = document.getElementById('aclSteamIdInput').value.trim();
  const name = document.getElementById('aclNameInput').value.trim();
  await quickAclAction(listType, 'add', steamId, name);
  document.getElementById('aclSteamIdInput').value = '';
  document.getElementById('aclNameInput').value = '';
}

async function quickAclAction(listType, action, steamId, name) {
  try {
    const res = await fetch('/api/acl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listType, action, steamId, name })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    appState = data.overview;
    renderAll();
    showToast(`📜 Updated ${listType}: ${action === 'add' ? 'Added' : 'Removed'} ${name || steamId}`);
    playSfx('click');
  } catch (err) {
    showToast(`❌ ACL Error: ${err.message}`);
  }
}

/* --------------------------------------------------------------------------
   BACKUPS & WORLDS VAULT
   -------------------------------------------------------------------------- */
function renderBackupsAndWorlds() {
  if (!appState) return;
  const { backups, worlds, container } = appState;

  const backupsEl = document.getElementById('backupsListContainer');
  if (backupsEl) {
    if (!backups || backups.length === 0) {
      backupsEl.innerHTML = `<div class="viking-meta-line">No backup archives found in /config/backups. Click "Create Hot Backup Now" to create one.</div>`;
    } else {
      backupsEl.innerHTML = backups
        .map(
          (b) => `
          <div class="backup-row">
            <div>
              <div class="viking-name-line">📦 ${escapeHtml(b.filename)}</div>
              <div class="viking-meta-line">${formatBytes(b.sizeBytes)} • Created ${formatRelativeTime(b.createdAt)} (${formatShortDate(b.createdAt)})</div>
            </div>
            <div style="display:flex;gap:0.45rem">
              <a class="btn btn-xs btn-frost" href="/api/backups/download/${encodeURIComponent(b.filename)}" download>⬇️ Download</a>
              <button class="btn btn-xs btn-crimson" onclick="deleteBackupFile('${escapeAttr(b.filename)}')">🗑️ Delete</button>
            </div>
          </div>
        `
        )
        .join('');
    }
  }

  const worldsEl = document.getElementById('worldsListContainer');
  if (worldsEl) {
    if (!worlds || worlds.length === 0) {
      worldsEl.innerHTML = `
        <div class="backup-row">
          <div>
            <div class="viking-name-line">🌍 ${escapeHtml(appState.serverMeta.worldName || 'Midgard')}.db / .fwl</div>
            <div class="viking-meta-line">Active World in /config/worlds_local • ${(appState.serverMeta.zdoCount || 154820).toLocaleString()} ZDOs</div>
          </div>
          <span class="status-pill status-running">ACTIVE</span>
        </div>
      `;
    } else {
      worldsEl.innerHTML = worlds
        .map(
          (w) => `
          <div class="backup-row">
            <div>
              <div class="viking-name-line">🌍 ${escapeHtml(w.filename)}</div>
              <div class="viking-meta-line">${escapeHtml(w.type)} • ${formatBytes(w.sizeBytes)} • Updated ${formatRelativeTime(w.updatedAt)}</div>
            </div>
          </div>
        `
        )
        .join('');
    }
  }

  const envGrid = document.getElementById('envConfigGrid');
  if (envGrid && container.envConfig) {
    envGrid.innerHTML = Object.entries(container.envConfig)
      .map(
        ([k, v]) => `
        <div class="env-pill">
          <span class="env-key">${escapeHtml(k)}</span>
          <span class="env-val">${escapeHtml(String(v))}</span>
        </div>
      `
      )
      .join('');
  }
}

async function createNewBackup() {
  await triggerServerAction('backup');
}

async function deleteBackupFile(filename) {
  try {
    const res = await fetch(`/api/backups/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    appState.backups = data.backups;
    renderBackupsAndWorlds();
    renderHeaderAndKpis();
    showToast(`🗑️ Deleted backup ${filename}`);
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

/* --------------------------------------------------------------------------
   LIVE SERVER LOGS
   -------------------------------------------------------------------------- */
function setLogFilter(cat, btn) {
  activeLogFilter = cat;
  playSfx('click');
  document.querySelectorAll('#logCategoryPills .pill').forEach((p) => p.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderLogStream();
}

function toggleLogAutoscroll() {
  logAutoscroll = !logAutoscroll;
  const btn = document.getElementById('btnToggleLogAutoscroll');
  if (btn) btn.textContent = logAutoscroll ? '⬇ Autoscroll: ON' : '⏸ Autoscroll: OFF';
  playSfx('click');
}

function downloadLogStream() {
  if (!allLogs || allLogs.length === 0) {
    showToast('⚠️ No log lines to export');
    return;
  }
  const text = allLogs.map((l) => `[${l.timestamp}] [${l.category.toUpperCase()}] ${l.raw || l.message}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `valheim-server-logs-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('📥 Downloaded server log stream');
  playSfx('copy');
}

function renderLogStream() {
  const viewer = document.getElementById('logStreamContainer');
  if (!viewer) return;
  const search = (document.getElementById('logSearchInput')?.value || '').toLowerCase().trim();

  const filtered = allLogs.filter((l) => {
    if (activeLogFilter !== 'all' && l.category !== activeLogFilter) return false;
    if (search && !l.raw.toLowerCase().includes(search)) return false;
    return true;
  });

  viewer.innerHTML = filtered
    .slice(-250)
    .map(
      (l) => `
      <div class="log-row">
        <span class="log-cat cat-${escapeAttr(l.category)}">${escapeHtml(l.category)}</span>
        <span style="color:#64748b">${formatLogTime(l.timestamp)}</span>
        <span style="color:#e2e8f0;flex:1">${escapeHtml(l.message)}</span>
      </div>
    `
    )
    .join('');

  if (logAutoscroll) {
    viewer.scrollTop = viewer.scrollHeight;
  }
}

/* --------------------------------------------------------------------------
   SERVER ACTIONS & COMMAND EXECUTION
   -------------------------------------------------------------------------- */
async function triggerServerAction(action) {
  try {
    showToast(`⏳ Executing server action: ${action.toUpperCase()}...`);
    playSfx('click');
    const res = await fetch('/api/server/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    appState = data.overview;
    renderAll();
    showToast(`✅ ${data.message}`);
    playSfx('save');
  } catch (err) {
    showToast(`❌ Action failed: ${err.message}`);
  }
}

async function triggerQuickSave() {
  await runPresetCommand('save');
}

async function handleQuickCommand(e) {
  e.preventDefault();
  const input = document.getElementById('quickCommandInput');
  const cmd = input.value.trim();
  if (!cmd) return;
  input.value = '';
  await runPresetCommand(cmd);
}

async function runPresetCommand(command) {
  try {
    const res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    appState = data.overview;
    renderAll();

    const outBox = document.getElementById('quickCommandOutput');
    if (outBox) {
      outBox.classList.remove('hidden');
      outBox.textContent = `[${data.source}] > ${command}\n${data.output}`;
    }
    appendTerminalLine(command, data.output, data.source);
    showToast(`⚡ Executed: ${command}`);
    playSfx(command === 'save' ? 'save' : 'click');
  } catch (err) {
    showToast(`❌ Command error: ${err.message}`);
  }
}

async function handleTerminalSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('terminalCommandInput');
  const cmd = input.value.trim();
  if (!cmd) return;
  if (!commandHistory.length || commandHistory[commandHistory.length - 1] !== cmd) {
    commandHistory.push(cmd);
  }
  historyIndex = -1;
  input.value = '';
  await executeDeckCommand(cmd);
}

async function executeDeckCommand(command) {
  try {
    const res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    appState = data.overview;
    renderAll();
    appendTerminalLine(command, data.output, data.source);
    showToast(`⚡ ${command} — Done`);
    playSfx(command.startsWith('randomevent') ? 'horn' : 'click');
  } catch (err) {
    appendTerminalLine(command, err.message, 'ERROR', true);
    showToast(`❌ ${err.message}`);
  }
}

function appendTerminalLine(cmd, output, source, isError = false) {
  const term = document.getElementById('terminalHistory');
  if (!term) return;
  const block = document.createElement('div');
  block.innerHTML = `
    <div class="term-line term-cmd">heimdall@valheim:~$ ${escapeHtml(cmd)} <span style="color:#64748b;font-weight:400">[${escapeHtml(source)}]</span></div>
    <div class="term-line ${isError ? 'term-err' : 'term-out'}">${escapeHtml(output)}</div>
  `;
  term.appendChild(block);
  term.scrollTop = term.scrollHeight;
}

function copyTerminalOutput() {
  const term = document.getElementById('terminalHistory');
  if (!term) return;
  const text = term.innerText;
  navigator.clipboard?.writeText(text);
  showToast('📋 Copied terminal output to clipboard');
  playSfx('copy');
}

function clearTerminalOutput() {
  const term = document.getElementById('terminalHistory');
  if (term) {
    term.innerHTML = `<div class="term-line term-sys">Terminal cleared. Ready for commands.</div>`;
    playSfx('click');
  }
}

function toggleSimDrawer() {
  const drawer = document.getElementById('simDrawerBody');
  if (!drawer) return;
  drawer.classList.toggle('hidden');
  playSfx('click');
}

async function simulateLiveEvent(eventType) {
  const sampleVikings = [
    { name: 'Erik the Red', steamId: '76561198201948572' },
    { name: 'Sigurd Snake-in-the-Eye', steamId: '76561198331049281' },
    { name: 'Harald Fairhair', steamId: '76561198448192033' }
  ];
  const pick = sampleVikings[Math.floor(Math.random() * sampleVikings.length)];
  const sampleRaids = ['foresttrolls', 'wolves', 'surtlings', 'seekers', 'army_goblin'];
  const raidCode = sampleRaids[Math.floor(Math.random() * sampleRaids.length)];

  try {
    const res = await fetch('/api/simulate/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType,
        playerName: eventType === 'death' ? 'Ragnar Lothbrok' : pick.name,
        steamId: eventType === 'death' ? '76561198042198311' : pick.steamId,
        raidCode
      })
    });
    const data = await res.json();
    if (data.overview) {
      appState = data.overview;
      renderAll();
    }
    showToast(`🔥 Simulated live ${eventType.toUpperCase()} log event!`);
    playSfx(eventType === 'raid' ? 'horn' : 'click');
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

function renderActiveModsList() {
  const container = document.getElementById('overviewModsContainer');
  const countBadge = document.getElementById('overviewModsCountBadge');
  const tableContainer = document.getElementById('settingsModsTableContainer');
  const settingsCountBadge = document.getElementById('settingsModsCountBadge');

  if (!appState) return;
  const modsData = appState.mods || {};
  const plugins = modsData.plugins || [];

  const activeCount = plugins.filter((p) => p.status === 'active').length;

  if (countBadge) {
    countBadge.textContent = `${activeCount} of ${plugins.length} Mods Active • Zero Client Required`;
  }
  if (settingsCountBadge) {
    settingsCountBadge.textContent = `${activeCount} / ${plugins.length} Active in BepInEx`;
  }

  if (container) {
    if (plugins.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 1.5rem; text-align: center; color: var(--text-secondary); background: rgba(15,23,42,0.4); border-radius: 8px;">
          <p>No mods detected in <code>/config/bepinex/plugins/</code>.</p>
        </div>
      `;
    } else {
      container.innerHTML = plugins
        .map((p) => {
          let icon = '🧩';
          if (p.filename.includes('SpreadTheLoad')) icon = '👑';
          else if (p.filename.includes('BetterNetworking')) icon = '⚡';
          else if (p.filename.includes('ServerDevcommands')) icon = '🛠️';
          else if (p.filename.includes('WatchtowerMapExporter')) icon = '🗺️';

          const isActive = p.status === 'active';
          const statusBadge = isActive
            ? '<span class="role-badge role-permitted">Active in BepInEx</span>'
            : '<span class="role-badge">Pending Sync</span>';

          const sizeStr = p.sizeBytes ? formatBytes(p.sizeBytes) : 'Bundled';
          const authorStr = p.author ? `by ${escapeHtml(p.author)}` : '';

          return `
            <div class="cmd-card">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:0.5rem">
                <div>
                  <div class="cmd-card-title">${icon} ${escapeHtml(p.title || p.filename)}</div>
                  <div class="cmd-card-desc">${escapeHtml(p.type || 'BepInEx Plugin')}</div>
                </div>
                ${statusBadge}
              </div>
              <p class="cmd-card-desc" style="margin-top:0.35rem">${escapeHtml(p.description || '')}</p>
              <div class="viking-meta-line" style="margin-top:0.4rem">
                <code>${escapeHtml(p.filename)}</code> • ${sizeStr} ${authorStr ? `• ${authorStr}` : ''}
              </div>
            </div>
          `;
        })
        .join('');
    }
  }
}

/* --------------------------------------------------------------------------
   SETTINGS & MODIFIERS & DISCORD EMBED SIMULATOR
   -------------------------------------------------------------------------- */
let modConfigsLoadedOnce = false;
function populateSettingsAndModifiers() {
  if (!appState || !appState.settings) return;
  const s = appState.settings;

  const webhookInput = document.getElementById('settingDiscordWebhook');
  if (webhookInput && document.activeElement !== webhookInput) {
    webhookInput.value = s.discordWebhookUrl || '';
  }
  document.getElementById('chkJoin').checked = s.notifyOnJoin !== false;
  document.getElementById('chkLeave').checked = s.notifyOnLeave !== false;
  document.getElementById('chkDeath').checked = s.notifyOnDeath !== false;
  document.getElementById('chkRaid').checked = s.notifyOnRaid !== false;
  document.getElementById('chkBackup').checked = s.notifyOnBackup !== false;
  document.getElementById('settingRconHost').value = s.rconHost || 'valheim-server';
  document.getElementById('settingRconPort').value = s.rconPort || 2458;

  updateServerArgsPreview();
  updateDiscordEmbedPreview();

  const cfgSelect = document.getElementById('modConfigFileSelect');
  const files = appState.mods?.configFiles || [];
  if (cfgSelect && files.length > 0 && !modConfigsLoadedOnce) {
    modConfigsLoadedOnce = true;
    cfgSelect.innerHTML = files
      .map((f) => `<option value="${escapeAttr(f.filename)}">${escapeHtml(f.filename)}</option>`)
      .join('');
    loadSelectedModConfig(files[0].filename);
  }
}

function updateServerArgsPreview() {
  const preset = document.getElementById('modPreset')?.value || 'Normal';
  const combat = document.getElementById('modCombat')?.value || 'default';
  const death = document.getElementById('modDeath')?.value || 'default';
  const resources = document.getElementById('modResources')?.value || 'default';
  const raids = document.getElementById('modRaids')?.value || 'default';
  const portals = document.getElementById('modPortals')?.value || 'default';

  const args = [];
  if (preset !== 'Normal') args.push(`-preset ${preset}`);
  if (combat !== 'default') args.push(`-modifier combat ${combat}`);
  if (death !== 'default') args.push(`-modifier deathpenalty ${death}`);
  if (resources !== 'default') args.push(`-modifier resources ${resources}`);
  if (raids !== 'default') args.push(`-modifier raids ${raids}`);
  if (portals !== 'default') args.push(`-modifier portals ${portals}`);

  const codeEl = document.getElementById('generatedServerArgsCode');
  if (codeEl) {
    codeEl.textContent = `SERVER_ARGS="${args.join(' ')}"`;
  }
  updateDiscordEmbedPreview();
}

function copyGeneratedArgs() {
  const txt = document.getElementById('generatedServerArgsCode')?.textContent || '';
  navigator.clipboard?.writeText(txt);
  playSfx('copy');
  showToast(`📋 Copied ${txt} to clipboard!`);
}

function updateDiscordEmbedPreview() {
  const titleEl = document.getElementById('discordPreviewTitle');
  const descEl = document.getElementById('discordPreviewDesc');
  const vikingEl = document.getElementById('discordPreviewViking');
  const biomeEl = document.getElementById('discordPreviewBiome');
  if (!titleEl || !descEl) return;

  const preset = document.getElementById('modPreset')?.value || 'Normal';
  const worldName = appState?.serverMeta?.worldName || 'Midgard';

  const onlineVikings = appState?.players?.filter((p) => p.online) || [];
  const topViking = onlineVikings[0]?.name || 'Ragnar Lothbrok';
  const topTelemetry = appState?.worldMap?.livePlayers?.[onlineVikings[0]?.steamId];
  const biome = topTelemetry?.biome || 'Mountains';

  titleEl.textContent = `⚔️ Raid Alert: You are being hunted in ${worldName}`;
  descEl.textContent = `A pack of mountain wolves has ambushed the Vikings in ${worldName}! Combat modifier: ${preset}.`;
  if (vikingEl) vikingEl.textContent = topViking;
  if (biomeEl) biomeEl.textContent = biome;
}

async function saveIntegrationSettings(e) {
  e.preventDefault();
  try {
    const body = {
      discordWebhookUrl: document.getElementById('settingDiscordWebhook').value.trim(),
      notifyOnJoin: document.getElementById('chkJoin').checked,
      notifyOnLeave: document.getElementById('chkLeave').checked,
      notifyOnDeath: document.getElementById('chkDeath').checked,
      notifyOnRaid: document.getElementById('chkRaid').checked,
      notifyOnBackup: document.getElementById('chkBackup').checked,
      rconHost: document.getElementById('settingRconHost').value.trim(),
      rconPort: Number(document.getElementById('settingRconPort').value || 2458)
    };
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    showToast('💾 Saved Watchtower & Discord notification settings!');
    playSfx('save');
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

async function testDiscordWebhook() {
  const url = document.getElementById('settingDiscordWebhook').value.trim();
  if (!url) {
    return showToast('⚠️ Enter a Discord Webhook URL first.');
  }
  const res = await fetch('/api/settings/test-discord', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discordWebhookUrl: url })
  });
  const data = await res.json();
  if (data.sent) {
    showToast('✅ Sent test Norse Embed to Discord!');
    playSfx('horn');
  } else {
    showToast(`⚠️ Webhook test failed: ${data.reason || 'Check URL'}`);
  }
}

async function loadSelectedModConfig(filename) {
  if (!filename) return;
  try {
    const res = await fetch(`/api/mods/config/${encodeURIComponent(filename)}`);
    const data = await res.json();
    if (data.ok) {
      document.getElementById('modConfigEditor').value = data.content;
      const badge = document.getElementById('editorCurrentFileBadge');
      if (badge) badge.textContent = filename;
    }
  } catch (_) {}
}

async function saveCurrentModConfig() {
  const filename = document.getElementById('modConfigFileSelect')?.value;
  const content = document.getElementById('modConfigEditor')?.value || '';
  if (!filename) return;
  try {
    const res = await fetch(`/api/mods/config/${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    showToast(`💾 Saved /config/bepinex/config/${filename}`);
    playSfx('save');
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

function handleEditorKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    saveCurrentModConfig();
  }
}

/* --------------------------------------------------------------------------
   GLOBAL COMMAND PALETTE (OMNISearch)
   -------------------------------------------------------------------------- */
function openCommandPalette() {
  const modal = document.getElementById('commandPaletteModal');
  const input = document.getElementById('cmdPaletteInput');
  if (!modal || !input) return;
  modal.classList.remove('hidden');
  input.value = '';
  buildPaletteResults('');
  input.focus();
  playSfx('click');
}

function closeCommandPalette() {
  const modal = document.getElementById('commandPaletteModal');
  if (modal) modal.classList.add('hidden');
}

function handlePaletteBackdropClick(e) {
  if (e.target.id === 'commandPaletteModal') {
    closeCommandPalette();
  }
}

function handlePaletteSearch(val) {
  buildPaletteResults(val);
}

function handlePaletteKeydown(e) {
  const items = document.querySelectorAll('.palette-item');
  if (items.length === 0) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    paletteSelectedIndex = (paletteSelectedIndex + 1) % items.length;
    updatePaletteSelection();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    paletteSelectedIndex = (paletteSelectedIndex - 1 + items.length) % items.length;
    updatePaletteSelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (items[paletteSelectedIndex]) {
      items[paletteSelectedIndex].click();
    }
  } else if (e.key === 'Escape') {
    closeCommandPalette();
  }
}

function updatePaletteSelection() {
  const items = document.querySelectorAll('.palette-item');
  items.forEach((item, idx) => {
    item.classList.toggle('selected', idx === paletteSelectedIndex);
    if (idx === paletteSelectedIndex) {
      item.scrollIntoView({ block: 'nearest' });
    }
  });
}

function buildPaletteResults(query) {
  const container = document.getElementById('cmdPaletteResults');
  if (!container) return;
  const q = (query || '').toLowerCase().trim();

  const candidates = [
    // Tabs
    { cat: 'Navigation', icon: '👁️', title: 'Watchtower Overview', desc: 'KPIs, live Vikings & server telemetry', action: () => switchTab('overview') },
    { cat: 'Navigation', icon: '🗺️', title: 'Live World Map & Health', desc: 'Interactive Yggdrasil Cartography', action: () => switchTab('map') },
    { cat: 'Navigation', icon: '⚔️', title: 'Hall of Vikings & Stats', desc: 'Player roster, sessions, deaths & roles', action: () => switchTab('players') },
    { cat: 'Navigation', icon: '⚡', title: 'Command Deck & Raids', desc: 'RCON terminal, presets & raid launcher', action: () => switchTab('commands') },
    { cat: 'Navigation', icon: '📜', title: 'Access Lists (ACL)', desc: 'Admins, Whitelist & Banned files', action: () => switchTab('acl') },
    { cat: 'Navigation', icon: '🏛️', title: 'Backup Vault & Worlds', desc: 'Hot snapshots & world files', action: () => switchTab('backups') },
    { cat: 'Navigation', icon: '📡', title: 'Live Server Logs', desc: 'Streaming stdout/stderr events', action: () => switchTab('logs') },
    { cat: 'Navigation', icon: '⚙️', title: 'Modifiers & Discord Webhook', desc: 'SERVER_ARGS & alert embeds', action: () => switchTab('settings') },

    // Server Operations
    { cat: 'Server Ops', icon: '💾', title: 'Force World Save', desc: 'Flush active ZDOs to Midgard.db', action: () => triggerQuickSave() },
    { cat: 'Server Ops', icon: '🛡️', title: 'Create Hot Backup Now', desc: 'Run valheim-backup archive', action: () => createNewBackup() },
    { cat: 'Server Ops', icon: '🔄', title: 'Restart Valheim Server', desc: 'Gracefully save & supervisorctl restart', action: () => triggerServerAction('restart') },
    { cat: 'Server Ops', icon: '⬇️', title: 'Check SteamCMD Update', desc: 'Run valheim-updater daemon', action: () => triggerServerAction('update') },
    { cat: 'Server Ops', icon: '🛑', title: 'Stop Active Raid Event', desc: 'Execute stopevent command', action: () => executeDeckCommand('stopevent') },

    // Commands & Presets
    { cat: 'Commands', icon: '☀️', title: 'Clear Skies (env Clear)', desc: 'Dispel fog and rain across the world', action: () => executeDeckCommand('env Clear') },
    { cat: 'Commands', icon: '⛈️', title: 'Thunderstorm (env ThunderStorm)', desc: 'Summon Thor\'s lightning storm', action: () => executeDeckCommand('env ThunderStorm') },
    { cat: 'Commands', icon: '🕛', title: 'Lock High Noon (tod 0.5)', desc: 'Set time of day to midday', action: () => executeDeckCommand('tod 0.5') },
    { cat: 'Commands', icon: '🌙', title: 'Restore Day/Night (tod -1)', desc: 'Unlock natural day cycle', action: () => executeDeckCommand('tod -1') },
    { cat: 'Commands', icon: '🗝️', title: 'List Defeated Bosses (listkeys)', desc: 'View world progression keys', action: () => executeDeckCommand('listkeys') }
  ];

  // Add Known Vikings to candidates
  if (appState && appState.players) {
    appState.players.forEach((p) => {
      candidates.push({
        cat: 'Vikings',
        icon: p.online ? '⛵' : '🛡️',
        title: `${p.name} (${p.online ? 'Online' : 'Offline'})`,
        desc: `SteamID: ${p.steamId} • Playtime: ${formatTotalPlaytime(p.totalPlaytimeSeconds || 0)}`,
        action: () => {
          if (p.online) jumpToVikingOnMap(p.steamId);
          else {
            switchTab('players');
            const searchInput = document.getElementById('playerSearchInput');
            if (searchInput) {
              searchInput.value = p.name;
              renderPlayersTable();
            }
          }
        }
      });
    });
  }

  const filtered = q
    ? candidates.filter((c) => c.title.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q) || c.cat.toLowerCase().includes(q))
    : candidates;

  paletteSelectedIndex = 0;

  if (filtered.length === 0) {
    container.innerHTML = `<div style="padding:1.5rem;text-align:center;color:var(--text-muted)">No matching actions or Vikings found for "${escapeHtml(q)}"</div>`;
    return;
  }

  const groups = {};
  filtered.forEach((item) => {
    if (!groups[item.cat]) groups[item.cat] = [];
    groups[item.cat].push(item);
  });

  let html = '';
  let globalIndex = 0;
  for (const [catName, catItems] of Object.entries(groups)) {
    html += `<div class="palette-category">${escapeHtml(catName)}</div>`;
    catItems.forEach((item) => {
      const idx = globalIndex++;
      html += `
        <div class="palette-item ${idx === 0 ? 'selected' : ''}" data-idx="${idx}" onclick="executePaletteItem(${idx})">
          <div class="palette-item-left">
            <span class="palette-item-icon">${item.icon}</span>
            <div>
              <div class="palette-item-title">${escapeHtml(item.title)}</div>
              <div class="palette-item-desc">${escapeHtml(item.desc)}</div>
            </div>
          </div>
          <span class="palette-item-action">Jump →</span>
        </div>
      `;
    });
  }

  container.innerHTML = html;
  paletteItems = filtered;
}

function executePaletteItem(index) {
  const item = paletteItems[index];
  if (!item) return;
  closeCommandPalette();
  playSfx('click');
  item.action();
}

/* --------------------------------------------------------------------------
   FORMATTING HELPERS
   -------------------------------------------------------------------------- */
function formatRelativeTime(iso) {
  if (!iso) return 'Never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'Never';
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 45) return 'Just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h ago`;
}

function formatDurationFromTimestamp(iso) {
  if (!iso) return '0m';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '0m';
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec > 86400 * 2) {
    const days = Math.floor(diffSec / 86400);
    return `${days}d`;
  }
  const hrs = Math.floor(diffSec / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  return hrs > 0 ? `${hrs}h ${mins}m` : `${Math.max(1, mins)}m`;
}

function formatTotalPlaytime(seconds = 0) {
  const s = Number(seconds) || 0;
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  return `${hrs}h ${mins}m`;
}

function formatShortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatLogTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toTimeString().slice(0, 8);
}

function formatUptime(startedAtIso, state) {
  if (state !== 'running' || !startedAtIso) return 'Offline';
  const t = new Date(startedAtIso).getTime();
  if (Number.isNaN(t)) return 'Offline';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `Up ${d}d ${h}h`;
  if (h > 0) return `Up ${h}h ${m}m`;
  return `Up ${m}m`;
}

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getInitials(name = 'V') {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return String(str ?? '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function showToast(message) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3800);
}

/* ==================== LIVE WORLD MAP & VIKING HEALTH ENGINE ==================== */
let mapZoom = 1.0;
let mapPanX = 0;
let mapPanZ = 0;
let isDraggingMap = false;
let dragStartX = 0;
let dragStartY = 0;
let mapCanvasInitialized = false;
let mapRenderScheduled = false;

function requestMapRedraw() {
  if (mapRenderScheduled) return;
  mapRenderScheduled = true;
  requestAnimationFrame(() => {
    mapRenderScheduled = false;
    drawValheimMap();
  });
}

function toggleMapFullscreen() {
  const panel = document.getElementById('mapCanvasPanel');
  if (!panel) return;
  panel.classList.toggle('fullscreen-map');
  const isFs = panel.classList.contains('fullscreen-map');
  const btn = document.getElementById('btnMapFullscreen');
  if (btn) btn.textContent = isFs ? '✕ Exit Fullscreen' : '⛶ Fullscreen';
  setTimeout(() => {
    const canvas = document.getElementById('valheimMapCanvas');
    if (canvas) {
      if (isFs) {
        canvas.width = window.innerWidth - 60;
        canvas.height = window.innerHeight - 140;
      } else {
        canvas.width = 860;
        canvas.height = 680;
      }
    }
    drawValheimMap();
  }, 50);
  playSfx('click');
}

function zoomMap(factor) {
  mapZoom = Math.max(0.75, Math.min(8.0, mapZoom * factor));
  requestMapRedraw();
  playSfx('click');
}

function centerOnVikings() {
  if (!appState || !appState.worldMap) return;
  const livePlayers = appState.worldMap.livePlayersList || Object.values(appState.worldMap.livePlayers || {});
  const activeWithGps = livePlayers.filter((p) => p.hasGps !== false);
  if (activeWithGps.length === 0) {
    resetMapView();
    return;
  }
  const avgX = activeWithGps.reduce((s, p) => s + (p.x || 0), 0) / activeWithGps.length;
  const avgZ = activeWithGps.reduce((s, p) => s + (p.z || 0), 0) / activeWithGps.length;
  focusMapOnCoords(avgX, avgZ);
  playSfx('click');
}

function initMapCanvasInteraction() {
  if (mapCanvasInitialized) return;
  const canvas = document.getElementById('valheimMapCanvas');
  if (!canvas) return;
  mapCanvasInitialized = true;

  canvas.addEventListener('mousedown', (e) => {
    isDraggingMap = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
  });

  window.addEventListener('mouseup', () => {
    isDraggingMap = false;
  });

  canvas.addEventListener('mouseleave', () => {
    const tooltip = document.getElementById('mapHoverTooltip');
    if (tooltip) tooltip.classList.add('hidden');
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;

    // Convert canvas pixel to Valheim world coordinates (X, Z)
    const worldRadius = 10500;
    const baseRadiusPx = Math.min(canvas.width, canvas.height) * 0.44;
    const cx = canvas.width / 2 + mapPanX;
    const cy = canvas.height / 2 + mapPanZ;
    const wx = Math.round(((px - cx) / (baseRadiusPx * mapZoom)) * worldRadius);
    const wz = Math.round(((cy - py) / (baseRadiusPx * mapZoom)) * worldRadius);

    const readout = document.getElementById('mapCursorReadout');
    if (readout) {
      readout.innerHTML = `<span class="coord-crosshair">⌖</span> X: ${wx}, Z: ${wz} • ${estimateClientBiome(wx, wz)}`;
    }

    if (isDraggingMap) {
      mapPanX += (e.clientX - dragStartX) * scaleX;
      mapPanZ += (e.clientY - dragStartY) * scaleY;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      requestMapRedraw();
    }

    // Marker Hit Testing for Hover Tooltip
    const tooltip = document.getElementById('mapHoverTooltip');
    if (tooltip && appState?.worldMap) {
      let hoveredMarker = null;
      const wm = appState.worldMap;
      const livePlayers = wm.livePlayersList || Object.values(wm.livePlayers || {});
      const toScreen = (x, z) => ({
        x: cx + (x / worldRadius) * (baseRadiusPx * mapZoom),
        y: cy - (z / worldRadius) * (baseRadiusPx * mapZoom)
      });

      for (const lp of livePlayers) {
        if (lp.hasGps === false) continue;
        const pt = toScreen(lp.x, lp.z);
        if (Math.hypot(px - pt.x, py - pt.y) < 20) {
          hoveredMarker = {
            title: `⚔️ ${escapeHtml(lp.name)}`,
            body: `<strong>Biome:</strong> ${escapeHtml(lp.biome)}<br>
                   <strong>Health:</strong> ${lp.hp}/${lp.maxHp} HP<br>
                   <strong>Stamina:</strong> ${lp.stamina}/${lp.maxStamina}<br>
                   <strong>Activity:</strong> ${escapeHtml(lp.activity || 'Exploring')}`
          };
          break;
        }
      }

      if (!hoveredMarker && wm.tombstones) {
        for (const tomb of wm.tombstones) {
          const pt = toScreen(tomb.x, tomb.z);
          if (Math.hypot(px - pt.x, py - pt.y) < 18) {
            hoveredMarker = {
              title: `💀 Tombstone: ${escapeHtml(tomb.player)}`,
              body: `Items dropped: ${tomb.itemsCount || 1}<br>Coordinates: (${tomb.x}, ${tomb.z})`
            };
            break;
          }
        }
      }

      if (!hoveredMarker && wm.portals) {
        for (const p of wm.portals) {
          const pt = toScreen(p.x, p.z);
          if (Math.hypot(px - pt.x, py - pt.y) < 18) {
            hoveredMarker = {
              title: `🌀 Portal: ${escapeHtml(p.tag)}`,
              body: `Biome: ${escapeHtml(p.biome)}<br>Coordinates: (${p.x}, ${p.z})`
            };
            break;
          }
        }
      }

      if (!hoveredMarker && wm.landmarks) {
        for (const lm of wm.landmarks) {
          const pt = toScreen(lm.x, lm.z);
          if (Math.hypot(px - pt.x, py - pt.y) < 18) {
            hoveredMarker = {
              title: `${lm.icon || '📍'} ${escapeHtml(lm.name)}`,
              body: `Status: ${escapeHtml(lm.status)}<br>Coordinates: (${lm.x}, ${lm.z})`
            };
            break;
          }
        }
      }

      if (hoveredMarker) {
        tooltip.classList.remove('hidden');
        tooltip.innerHTML = `<strong>${hoveredMarker.title}</strong><div style="font-size:0.73rem;color:var(--text-secondary);margin-top:0.2rem">${hoveredMarker.body}</div>`;
        const wrapRect = canvas.parentElement.getBoundingClientRect();
        tooltip.style.left = `${e.clientX - wrapRect.left}px`;
        tooltip.style.top = `${e.clientY - wrapRect.top - 12}px`;
      } else {
        tooltip.classList.add('hidden');
      }
    }
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.18 : 0.85;
      mapZoom = Math.max(0.75, Math.min(8.0, mapZoom * factor));
      requestMapRedraw();
    },
    { passive: false }
  );
}

function resetMapView() {
  mapZoom = 1.0;
  mapPanX = 0;
  mapPanZ = 0;
  requestMapRedraw();
  playSfx('click');
}

function focusMapOnCoords(x, z, label = '') {
  switchTab('map');
  const canvas = document.getElementById('valheimMapCanvas');
  if (!canvas) return;
  const worldRadius = 10500;
  const baseRadiusPx = Math.min(canvas.width, canvas.height) * 0.44;
  mapZoom = 2.6;
  mapPanX = -(x / worldRadius) * (baseRadiusPx * mapZoom);
  mapPanZ = (z / worldRadius) * (baseRadiusPx * mapZoom);
  drawValheimMap();
  if (label) {
    showToast(`🗺️ Centered map on ${label} (${x}, ${z})`);
  }
}

function jumpToVikingOnMap(steamId) {
  const lp = appState?.worldMap?.livePlayers?.[steamId];
  if (!lp) return;
  focusMapOnCoords(lp.x, lp.z, lp.name);
}

function estimateClientBiome(x, z) {
  const dist = Math.hypot(x, z);
  if (dist > 10500) return 'World Edge';
  if (dist < 600) return 'Meadows';
  if (cachedBiomeLookup && cachedBiomeLookup.length === TERRAIN_RES * TERRAIN_RES) {
    const px = Math.max(0, Math.min(TERRAIN_RES - 1, Math.round(((x / 10500 + 1) * 0.5) * (TERRAIN_RES - 1))));
    const py = Math.max(0, Math.min(TERRAIN_RES - 1, Math.round(((1 - z / 10500) * 0.5) * (TERRAIN_RES - 1))));
    const bCode = cachedBiomeLookup[py * TERRAIN_RES + px];
    if (dist < 1000 && bCode === 4) return 'Black Forest';
    return BIOME_NAMES_BY_CODE[bCode] || 'Ocean';
  }
  if (z < -7200) return 'Ashlands';
  if (z > 7200) return 'Deep North';
  if (dist < 850) return 'Meadows';
  if (dist < 2100) return 'Black Forest';
  if (dist < 3400) return 'Swamp / Mountains';
  if (dist < 5000) return 'Plains';
  if (dist < 8200) return 'Mistlands';
  return 'Ocean';
}

function renderLiveMapAndVitals() {
  if (!appState || !appState.worldMap) return;
  initMapCanvasInteraction();

  const wm = appState.worldMap;
  ensureValheimTerrainCache(wm);
  const worldLabel = document.getElementById('mapWorldNameLabel');
  const seedLabel = document.getElementById('mapSeedLabel');
  const sourceLabel = document.getElementById('mapTelemetrySourceLabel');
  if (worldLabel) worldLabel.textContent = wm.worldName || 'Midgard';
  if (seedLabel) seedLabel.textContent = wm.seedName || 'Yggdrasil9';
  if (sourceLabel) sourceLabel.textContent = wm.telemetrySource || 'BepInEx ZDO Bridge';

  // Update BepInEx status badge & button text
  const statusBadge = document.getElementById('bepinexStatusBadge');
  const autoBtn = document.getElementById('btnAutoConfigureServer');
  if (statusBadge) {
    if (wm.bepinexTelemetryActive) {
      if (wm.pluginStatus === 'active' || !wm.pluginStatus) {
        statusBadge.textContent = '✅ Plugin Active (2s Live Feed)';
        statusBadge.className = 'role-badge role-admin';
        if (autoBtn && !autoBtn.disabled) {
          autoBtn.textContent = '🔄 Re-Sync / Verify Plugin';
        }
      } else {
        statusBadge.textContent = '⏳ Server Booting World (~45-60s)...';
        statusBadge.className = 'role-badge role-permitted';
      }
    } else {
      statusBadge.textContent = '⚡ Click Auto-Configure to Enable Live GPS/HP';
      statusBadge.className = 'role-badge role-permitted';
    }
  }

  // Render Live Viking Health & Stamina cards
  const vitalsList = document.getElementById('liveVitalsList');
  const livePlayers = wm.livePlayersList || Object.values(wm.livePlayers || {});

  if (vitalsList) {
    if (livePlayers.length === 0) {
      const bootHint =
        wm.bepinexTelemetryActive && wm.pluginStatus && wm.pluginStatus !== 'active'
          ? 'Valheim Server is currently loading your world save (~45-60s). Live player GPS & HP will appear as soon as a Viking joins!'
          : wm.bepinexTelemetryActive
          ? 'BepInEx Live Telemetry is active! Join the server in Valheim to see your live GPS coordinates, Health & Stamina bars.'
          : 'No Vikings currently online in the world.';
      vitalsList.innerHTML = `<div class="viking-meta-line">${escapeHtml(bootHint)}</div>`;
    } else {
      vitalsList.innerHTML = livePlayers
        .map((lp) => {
          const hasGps = lp.hasGps !== false;
          const hpPct = Math.max(5, Math.min(100, Math.round((lp.hp / Math.max(1, lp.maxHp)) * 100)));
          const stamPct = Math.max(5, Math.min(100, Math.round((lp.stamina / Math.max(1, lp.maxStamina)) * 100)));
          const resolvedBiome = hasGps
            ? (Math.hypot(lp.x || 0, lp.z || 0) < 600
                ? 'Meadows'
                : estimateClientBiome(lp.x || 0, lp.z || 0) || lp.biome || 'Meadows')
            : 'Awaiting BepInEx GPS';
          const posText = hasGps
            ? `📍 X: ${lp.x}, Y: ${lp.y || 20}, Z: ${lp.z} • ${escapeHtml(lp.activity || 'Exploring')}`
            : `📡 Awaiting Live GPS (Add BEPINEX=true to docker-compose.yml)`;
          const foodsHtml = (lp.foods || [])
            .map((f) => `<span class="food-chip">🍖 ${escapeHtml(f)}</span>`)
            .join('');

          const isLowHp = hpPct < 25;

          return `
            <div class="vital-card ${isLowHp ? 'low-hp' : ''}">
              <div class="vital-top-row">
                <div>
                  <div class="viking-name-line">
                    <span>⚔️ ${escapeHtml(lp.name)}</span>
                    <span class="role-badge ${hasGps ? 'role-permitted' : 'role-Modded'}">${escapeHtml(resolvedBiome)}</span>
                  </div>
                  <div class="viking-meta-line">
                    ${posText}
                  </div>
                </div>
                ${
                  hasGps
                    ? `<button class="btn btn-xs btn-amber" onclick="focusMapOnCoords(${lp.x}, ${lp.z}, '${escapeAttr(lp.name)}')">🎯 Track</button>`
                    : `<button class="btn btn-xs btn-glass" onclick="showToast('⚠️ Add BEPINEX=true to docker-compose.yml to enable live GPS!')">📡 No GPS</button>`
                }
              </div>

              <div class="vital-bars-grid">
                <div class="vital-bar-wrap">
                  <div class="vital-bar-label">
                    <span class="text-crimson">❤️ Health</span>
                    <span>${lp.hp || 100} / ${lp.maxHp || 100}</span>
                  </div>
                  <div class="vital-bar-track">
                    <div class="vital-bar-fill-hp" style="width: ${hpPct}%"></div>
                  </div>
                </div>

                <div class="vital-bar-wrap">
                  <div class="vital-bar-label">
                    <span class="text-amber">⚡ Stamina</span>
                    <span>${lp.stamina || 100} / ${lp.maxStamina || 100}</span>
                  </div>
                  <div class="vital-bar-track">
                    <div class="vital-bar-fill-stamina" style="width: ${stamPct}%"></div>
                  </div>
                </div>
              </div>

              ${foodsHtml ? `<div class="food-chips-row">${foodsHtml}</div>` : ''}
            </div>
          `;
        })
        .join('');
    }
  }

  // Render Tombstones & Portal Network List
  const poiList = document.getElementById('mapTombstonesAndPortals');
  if (poiList) {
    const tombstones = wm.tombstones || [];
    const portals = wm.portals || [];
    const landmarks = wm.landmarks || [];

    let poiHtml = '';

    if (tombstones.length > 0) {
      poiHtml += tombstones
        .map(
          (t) => `
          <div class="event-item evt-death" style="cursor:pointer" onclick="focusMapOnCoords(${t.x}, ${t.z}, '${escapeAttr(t.player)} Tombstone')">
            <span class="event-icon">💀</span>
            <div class="event-body">
              <div class="event-title">${escapeHtml(t.player)}'s Tombstone (${t.itemsCount || 1} items)</div>
              <div class="event-detail">📍 X: ${t.x}, Z: ${t.z} • ${escapeHtml(t.biome || 'Wilderness')}</div>
            </div>
            <button class="btn btn-xs btn-crimson">Pan →</button>
          </div>
        `
        )
        .join('');
    }

    if (portals.length > 0) {
      poiHtml += portals
        .map(
          (p) => `
          <div class="event-item" style="cursor:pointer" onclick="focusMapOnCoords(${p.x}, ${p.z}, '${escapeAttr(p.tag)} Portal')">
            <span class="event-icon">🌀</span>
            <div class="event-body">
              <div class="event-title">Portal: ${escapeHtml(p.tag)}</div>
              <div class="event-detail">📍 X: ${p.x}, Z: ${p.z} • ${escapeHtml(p.biome || 'Midgard')}</div>
            </div>
            <button class="btn btn-xs btn-frost">Pan →</button>
          </div>
        `
        )
        .join('');
    }

    if (landmarks.length > 0) {
      poiHtml += landmarks
        .slice(0, 4)
        .map(
          (lm) => `
          <div class="event-item" style="cursor:pointer" onclick="focusMapOnCoords(${lm.x}, ${lm.z}, '${escapeAttr(lm.name)}')">
            <span class="event-icon">${lm.icon || '🦌'}</span>
            <div class="event-body">
              <div class="event-title">${escapeHtml(lm.name)}</div>
              <div class="event-detail">${escapeHtml(lm.status)} • (${lm.x}, ${lm.z})</div>
            </div>
            <button class="btn btn-xs btn-glass">Pan →</button>
          </div>
        `
        )
        .join('');
    }

    poiList.innerHTML = poiHtml || `<div class="viking-meta-line">No active death tombstones or portals recorded.</div>`;
  }

  drawValheimMap();
}

/* --------------------------------------------------------------------------
   PROCEDURAL VALHEIM CARTOGRAPHY GENERATOR
   -------------------------------------------------------------------------- */
const TERRAIN_RES = 600;
let cachedTerrainCanvas = null;
let cachedTerrainSeed = null;
let cachedBiomeLookup = null;
let cachedBiomeLabels = [];

function invalidateTerrainCacheAndDraw() {
  cachedTerrainCanvas = null;
  cachedTerrainSeed = null;
  drawValheimMap();
}

function createSeededNoise2D(seedInput) {
  let s = typeof seedInput === 'number' ? seedInput : 84920177;
  const nextRandom = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };

  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(nextRandom() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (t, a, b) => a + t * (b - a);
  const grad = (hash, x, y) => {
    const h = hash & 7;
    const u = h < 4 ? x : y;
    const v = h < 4 ? y : x;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  };

  return function noise2D(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const aa = perm[perm[X] + Y];
    const ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y];
    const bb = perm[perm[X + 1] + Y + 1];
    return lerp(v, lerp(u, grad(aa, xf, yf), grad(ba, xf - 1, yf)), lerp(u, grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1)));
  };
}

let cachedParchmentCanvas = null;
function getParchmentCanvas() {
  if (cachedParchmentCanvas) return cachedParchmentCanvas;
  const pcan = document.createElement('canvas');
  pcan.width = 256;
  pcan.height = 256;
  const pctx = pcan.getContext('2d');
  const imgData = pctx.createImageData(256, 256);
  const pix = imgData.data;
  const pNoise = createSeededNoise2D(1234567);

  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const idx = (y * 256 + x) * 4;
      const n1 = pNoise(x * 0.04, y * 0.04);
      const n2 = pNoise(x * 0.12 + 10, y * 0.12 + 10);
      const val = 186 + n1 * 18 + n2 * 10;
      pix[idx] = Math.max(140, Math.min(220, val * 0.98));
      pix[idx + 1] = Math.max(120, Math.min(200, val * 0.86));
      pix[idx + 2] = Math.max(90, Math.min(170, val * 0.62));
      pix[idx + 3] = 255;
    }
  }
  pctx.putImageData(imgData, 0, 0);
  cachedParchmentCanvas = pcan;
  return pcan;
}

const BIOME_NAMES_BY_CODE = {
  1: 'Meadows',
  2: 'Black Forest',
  3: 'Swamp',
  4: 'Mountains',
  5: 'Plains',
  6: 'Mistlands',
  7: 'Ashlands',
  8: 'Deep North'
};

function decodeBase64ToUint8(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function ensureValheimTerrainCache(wm) {
  const seedKey = `${wm.seedNumeric || wm.seedName || 'default'}-${TERRAIN_RES}`;
  if (cachedTerrainCanvas && cachedTerrainSeed === seedKey) {
    return cachedTerrainCanvas;
  }

  const canvas = document.createElement('canvas');
  canvas.width = TERRAIN_RES;
  canvas.height = TERRAIN_RES;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(TERRAIN_RES, TERRAIN_RES);
  const pixels = imgData.data;

  const noise2D = createSeededNoise2D(wm.seedNumeric || 84920177);
  const fbm = (x, y, octaves = 5, lacunarity = 2.0, gain = 0.5) => {
    let sum = 0;
    let amp = 0.5;
    let freq = 1.0;
    let max = 0;
    for (let i = 0; i < octaves; i++) {
      sum += noise2D(x * freq, y * freq) * amp;
      max += amp;
      freq *= lacunarity;
      amp *= gain;
    }
    return sum / max;
  };

  const heights = new Float32Array(TERRAIN_RES * TERRAIN_RES);
  const biomes = new Uint8Array(TERRAIN_RES * TERRAIN_RES);
  const seaLevel = 0.38;

  let serverHeights = null;
  let serverBiomes = null;
  let serverGridRes = 0;

  if (wm.terrainGrid && wm.terrainGrid.resolution && wm.terrainGrid.heightsB64 && wm.terrainGrid.biomesB64) {
    try {
      serverGridRes = wm.terrainGrid.resolution;
      serverHeights = decodeBase64ToUint8(wm.terrainGrid.heightsB64);
      serverBiomes = decodeBase64ToUint8(wm.terrainGrid.biomesB64);
    } catch (_) {}
  }

  for (let py = 0; py < TERRAIN_RES; py++) {
    for (let px = 0; px < TERRAIN_RES; px++) {
      const idx = py * TERRAIN_RES + px;
      const nx = (px / (TERRAIN_RES - 1)) * 2.0 - 1.0;
      const nz = 1.0 - (py / (TERRAIN_RES - 1)) * 2.0;
      const distNorm = Math.hypot(nx, nz);

      if (distNorm > 1.0) {
        heights[idx] = 0;
        biomes[idx] = 0;
        continue;
      }

      const worldRadius = wm.worldRadius || 10500;
      const wx = nx * worldRadius;
      const wz = nz * worldRadius;
      const worldDist = Math.hypot(wx, wz);

      if (serverHeights && serverBiomes && serverGridRes > 0) {
        const sx = Math.max(0, Math.min(serverGridRes - 1, Math.round((px / (TERRAIN_RES - 1)) * (serverGridRes - 1))));
        const sy = Math.max(0, Math.min(serverGridRes - 1, Math.round((py / (TERRAIN_RES - 1)) * (serverGridRes - 1))));
        const sIdx = sy * serverGridRes + sx;

        heights[idx] = serverHeights[sIdx] / 255.0;
        let bCode = serverBiomes[sIdx];
        if (worldDist < 1000) {
          if (worldDist < 550) bCode = 1;
          else if (worldDist < 1000 && bCode === 4) bCode = 2;
        }
        biomes[idx] = heights[idx] < seaLevel ? 0 : bCode;
        continue;
      }

      const warpX = nx + fbm(nx * 3.2 + 5.1, nz * 3.2 + 1.7, 3) * 0.14;
      const warpZ = nz + fbm(nx * 3.2 + 9.4, nz * 3.2 + 4.8, 3) * 0.14;

      const continentNoise = fbm(warpX * 2.8, warpZ * 2.8, 5, 2.05, 0.52);
      const ridgeNoise = 1.0 - Math.abs(noise2D(warpX * 4.5 + 11.2, warpZ * 4.5 - 7.4));
      const detailNoise = fbm(nx * 14.0, nz * 14.0, 3) * 0.08;

      const startDist = Math.hypot(nx * 1.15, nz * 0.92);
      const riverVal = Math.abs(fbm(warpX * 4.2 + 30.0, warpZ * 4.2 - 18.0, 2));
      const riverCarve = riverVal < 0.028 && startDist > 0.06 ? (0.028 - riverVal) * 4.2 : 0;
      const rimDrop = distNorm > 0.88 ? (distNorm - 0.88) * 2.2 : 0;

      let h = 0.41 + continentNoise * 0.58 + detailNoise - riverCarve - rimDrop;
      if (h > seaLevel + 0.13 && worldDist > 1000) {
        const ridgeScale = Math.min(1.0, (worldDist - 1000) / 600);
        h += Math.pow(ridgeNoise, 2.2) * 0.22 * ridgeScale;
      }

      if (startDist < 0.22) {
        const spawnWeight = Math.min(1.0, (0.22 - startDist) / 0.14);
        const gentleMeadowHeight = 0.47 + continentNoise * 0.12 + detailNoise * 0.6;
        h = h * (1.0 - spawnWeight) + gentleMeadowHeight * spawnWeight;

        const lakeDist = Math.hypot(nx - 0.042, nz + 0.012);
        if (lakeDist < 0.048 && Math.hypot(nx, nz) > 0.028) {
          h -= (0.048 - lakeDist) * 2.8;
        }
      }

      h = Math.max(0.02, Math.min(0.99, h));
      heights[idx] = h;

      if (h < seaLevel) {
        biomes[idx] = 0;
        continue;
      }

      const bNoise1 = fbm(warpX * 2.4 + 41.0, warpZ * 2.4 - 19.0, 4);
      const bNoise2 = fbm(warpX * 3.1 - 23.0, warpZ * 3.1 + 67.0, 4);

      let biome = 1;
      if (worldDist < 600) {
        biome = worldDist > 520 && bNoise1 > 0.18 ? 2 : 1;
      } else if (wz < -7300 + bNoise1 * 650) {
        biome = 7;
      } else if (wz > 7300 + bNoise1 * 650) {
        biome = 8;
      } else if (worldDist >= 1000 && (h > 0.66 || (worldDist > 1400 && h > 0.61))) {
        biome = 4;
      } else if (worldDist < 1000) {
        biome = bNoise1 > -0.02 || h > 0.56 ? 2 : 1;
      } else if (worldDist < 2100) {
        if (bNoise1 < -0.14 && h < 0.49 && worldDist > 1250) biome = 3;
        else if (bNoise1 > -0.02) biome = 2;
        else biome = 1;
      } else if (worldDist < 4800) {
        if (bNoise2 > 0.14 && worldDist > 2600) biome = 5;
        else if (bNoise1 < -0.06 && h < 0.52) biome = 3;
        else if (bNoise1 > 0.04) biome = 2;
        else biome = 1;
      } else if (worldDist < 8200) {
        if (bNoise2 > 0.06 && worldDist > 5600) biome = 6;
        else if (bNoise1 > -0.08) biome = 5;
        else if (h < 0.50) biome = 3;
        else biome = 2;
      } else {
        biome = bNoise2 > -0.05 ? 6 : 5;
      }

      biomes[idx] = biome;
    }
  }

  cachedBiomeLookup = biomes;

  const BIOME_PALETTE = {
    1: [118, 158, 74],
    2: [49, 92, 58],
    3: [84, 66, 48],
    4: [158, 168, 180],
    5: [198, 156, 62],
    6: [106, 70, 142],
    7: [168, 48, 42],
    8: [216, 228, 240]
  };

  const BIOME_BORDER_RGB = {
    1: [163, 230, 53],
    2: [52, 211, 153],
    3: [217, 119, 6],
    4: [255, 255, 255],
    5: [250, 204, 21],
    6: [216, 180, 254],
    7: [248, 113, 113],
    8: [186, 230, 253]
  };

  const regionAccum = {};

  for (let py = 0; py < TERRAIN_RES; py++) {
    for (let px = 0; px < TERRAIN_RES; px++) {
      const idx = py * TERRAIN_RES + px;
      const pIdx = idx * 4;
      const nx = (px / (TERRAIN_RES - 1)) * 2.0 - 1.0;
      const nz = 1.0 - (py / (TERRAIN_RES - 1)) * 2.0;
      const distNorm = Math.hypot(nx, nz);

      if (distNorm > 1.0) {
        pixels[pIdx + 3] = 0;
        continue;
      }

      const h = heights[idx];
      const b = biomes[idx];

      if (b === 0 || h < seaLevel) {
        const depth = Math.max(0, Math.min(1, (seaLevel - h) / seaLevel));
        const wave = noise2D(px * 0.18, py * 0.18) * 6;
        let r, g, bl;
        if (depth < 0.08) {
          const t = depth / 0.08;
          r = 58 * (1 - t) + 32 * t + wave;
          g = 122 * (1 - t) + 84 * t + wave;
          bl = 146 * (1 - t) + 118 * t + wave;
        } else {
          const t = Math.min(1, (depth - 0.08) / 0.75);
          r = 32 * (1 - t) + 14 * t + wave * 0.5;
          g = 84 * (1 - t) + 38 * t + wave * 0.5;
          bl = 118 * (1 - t) + 64 * t + wave * 0.5;
        }
        pixels[pIdx] = Math.max(8, Math.min(255, r));
        pixels[pIdx + 1] = Math.max(18, Math.min(255, g));
        pixels[pIdx + 2] = Math.max(32, Math.min(255, bl));
        pixels[pIdx + 3] = 255;
        continue;
      }

      const hL = px > 0 ? heights[idx - 1] : h;
      const hR = px < TERRAIN_RES - 1 ? heights[idx + 1] : h;
      const hU = py > 0 ? heights[idx - TERRAIN_RES] : h;
      const hD = py < TERRAIN_RES - 1 ? heights[idx + TERRAIN_RES] : h;
      const dx = (hR - hL) * 18.0;
      const dy = (hD - hU) * 18.0;
      const hillshade = Math.max(0.58, Math.min(1.36, 1.02 - dx * 0.65 - dy * 0.65));

      const base = BIOME_PALETTE[b] || BIOME_PALETTE[1];
      let r = base[0];
      let g = base[1];
      let bl = base[2];

      const canopy = noise2D(px * 0.38, py * 0.38);
      const microPatch = noise2D(px * 0.09 + 19.3, py * 0.09 - 11.7);

      if (h < seaLevel + 0.015) {
        r = 198;
        g = 178;
        bl = 136;
      } else if (b === 1) {
        r += microPatch * 18;
        g += microPatch * 22;
        bl += microPatch * 10;
        if (canopy > 0.24 && h > seaLevel + 0.025 && h < 0.56) {
          r *= 0.66;
          g *= 0.72;
          bl *= 0.62;
        }
      } else if (b === 2) {
        r += microPatch * 12;
        g += microPatch * 16;
        bl += microPatch * 12;
        if (canopy > 0.16) {
          r *= 0.58;
          g *= 0.64;
          bl *= 0.54;
        }
      } else if (b === 3) {
        r += microPatch * 14;
        g += microPatch * 10;
        bl += microPatch * 8;
        if (canopy > 0.28) {
          r *= 0.72;
          g *= 0.75;
          bl *= 0.68;
        }
      } else if (b === 4) {
        if (h > 0.68) {
          r = 236 + microPatch * 12;
          g = 242 + microPatch * 10;
          bl = 248 + microPatch * 6;
        } else {
          r = 142 + microPatch * 16;
          g = 148 + microPatch * 16;
          bl = 158 + microPatch * 18;
        }
      } else if (b === 5) {
        r += microPatch * 20;
        g += microPatch * 16;
        bl += microPatch * 10;
      } else if (b === 6) {
        r += microPatch * 16;
        g += microPatch * 14;
        bl += microPatch * 22;
      } else if (b === 7) {
        r += microPatch * 24;
        g += microPatch * 8;
        bl += microPatch * 6;
      } else if (b === 8) {
        r = 228 + microPatch * 12;
        g = 238 + microPatch * 12;
        bl = 246 + microPatch * 8;
      }

      r *= hillshade;
      g *= hillshade;
      bl *= hillshade;

      const showBorders = document.getElementById('toggleBiomeBorders')?.checked !== false;
      if (showBorders) {
        const bL = px > 0 ? biomes[idx - 1] : b;
        const bR = px < TERRAIN_RES - 1 ? biomes[idx + 1] : b;
        const bU = py > 0 ? biomes[idx - TERRAIN_RES] : b;
        const bD = py < TERRAIN_RES - 1 ? biomes[idx + TERRAIN_RES] : b;

        const isBorder = (bL !== b && bL > 0) || (bR !== b && bR > 0) || (bU !== b && bU > 0) || (bD !== b && bD > 0);
        if (isBorder) {
          const borderRgb = BIOME_BORDER_RGB[b] || [255, 255, 255];
          r = r * 0.28 + borderRgb[0] * 0.72;
          g = g * 0.28 + borderRgb[1] * 0.72;
          bl = bl * 0.28 + borderRgb[2] * 0.72;
        }
      }

      const worldRadius = wm.worldRadius || 10500;
      const wx = nx * worldRadius;
      const wz = nz * worldRadius;
      if (b > 0) {
        const cellX = Math.floor(px / 50);
        const cellY = Math.floor(py / 50);
        const key = `${b}-${cellX}-${cellY}`;
        if (!regionAccum[key]) {
          regionAccum[key] = { b, sumX: 0, sumZ: 0, count: 0 };
        }
        regionAccum[key].sumX += wx;
        regionAccum[key].sumZ += wz;
        regionAccum[key].count++;
      }

      pixels[pIdx] = Math.max(0, Math.min(255, Math.round(r)));
      pixels[pIdx + 1] = Math.max(0, Math.min(255, Math.round(g)));
      pixels[pIdx + 2] = Math.max(0, Math.min(255, Math.round(bl)));
      pixels[pIdx + 3] = 255;
    }
  }

  cachedBiomeLabels = Object.values(regionAccum)
    .filter((reg) => reg.count > 450)
    .map((reg) => ({
      name: (BIOME_NAMES_BY_CODE[reg.b] || '').toUpperCase(),
      wx: reg.sumX / reg.count,
      wz: reg.sumZ / reg.count,
      count: reg.count
    }));

  ctx.putImageData(imgData, 0, 0);
  cachedTerrainCanvas = canvas;
  cachedTerrainSeed = seedKey;
  return canvas;
}

function drawValheimMapIcon(ctx, type, name, x, y) {
  ctx.save();
  ctx.translate(x, y);

  if (type === 'spawn') {
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(0, 0, 7.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(0, 6);
    ctx.moveTo(-6, 0);
    ctx.lineTo(6, 0);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.8;
    ctx.stroke();
  } else if (type === 'boss') {
    ctx.fillStyle = '#b91c1c';
    ctx.strokeStyle = '#fef2f2';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(0, 2, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(-3, 0);
    ctx.quadraticCurveTo(-9, -2, -6, -8);
    ctx.quadraticCurveTo(-4, -3, -2, -1);
    ctx.moveTo(3, 0);
    ctx.quadraticCurveTo(9, -2, 6, -8);
    ctx.quadraticCurveTo(4, -3, 2, -1);
    ctx.fill();
    ctx.stroke();
  } else if (type === 'portal' || type === 'home') {
    ctx.fillStyle = type === 'portal' ? '#e0f2fe' : '#f8fafc';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(7, -1);
    ctx.lineTo(5, -1);
    ctx.lineTo(5, 6);
    ctx.lineTo(-5, 6);
    ctx.lineTo(-5, -1);
    ctx.lineTo(-7, -1);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = type === 'portal' ? '#0284c7' : '#1e293b';
    ctx.fillRect(-1.8, 1, 3.6, 5);
  } else if (type === 'tombstone') {
    ctx.fillStyle = '#f8fafc';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-6, -4);
    ctx.lineTo(6, 5);
    ctx.moveTo(6, -4);
    ctx.lineTo(-6, 5);
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 2.4;
    ctx.stroke();

    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(0, -1.5, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(-1.6, -1.8, 1.1, 0, Math.PI * 2);
    ctx.arc(1.6, -1.8, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }

  if (name) {
    ctx.font = '700 10px Cinzel, Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.strokeText(name.toUpperCase(), 0, 16);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(name.toUpperCase(), 0, 16);
  }

  ctx.restore();
}

function drawValheimMap() {
  const canvas = document.getElementById('valheimMapCanvas');
  if (!canvas || !appState || !appState.worldMap) return;
  const ctx = canvas.getContext('2d');
  const wm = appState.worldMap;

  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2 + mapPanX;
  const cy = h / 2 + mapPanZ;
  const worldRadius = wm.worldRadius || 10500;
  const R = Math.min(w, h) * 0.44 * mapZoom;

  const toScreen = (wx, wz) => ({
    x: cx + (wx / worldRadius) * R,
    y: cy - (wz / worldRadius) * R
  });

  const parchmentCanvas = getParchmentCanvas();
  ctx.clearRect(0, 0, w, h);
  const parchPat = ctx.createPattern(parchmentCanvas, 'repeat');
  ctx.fillStyle = parchPat || '#9c845a';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(12, 16, 24, 0.55)';
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();

  const terrainCanvas = ensureValheimTerrainCache(wm);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(terrainCanvas, cx - R, cy - R, R * 2, R * 2);

  const showBorders = document.getElementById('toggleBiomeBorders')?.checked !== false;
  if (showBorders && cachedBiomeLabels.length > 0) {
    ctx.save();
    ctx.font = '700 9.5px Cinzel, Inter, sans-serif';
    ctx.textAlign = 'center';
    for (const lbl of cachedBiomeLabels) {
      if (mapZoom < 1.15 && lbl.count < 850) continue;
      const pt = toScreen(lbl.wx, lbl.wz);
      if (pt.x < 20 || pt.x > w - 20 || pt.y < 20 || pt.y > h - 20) continue;
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = 'rgba(10, 14, 22, 0.85)';
      ctx.strokeText(lbl.name, pt.x, pt.y);
      ctx.fillStyle = 'rgba(254, 249, 195, 0.88)';
      ctx.fillText(lbl.name, pt.x, pt.y);
    }
    ctx.restore();
  }

  const showFog = document.getElementById('toggleFogOfWar')?.checked === true;
  if (showFog) {
    const offCanvas = document.createElement('canvas');
    offCanvas.width = w;
    offCanvas.height = h;
    const fctx = offCanvas.getContext('2d');

    const fPat = fctx.createPattern(parchmentCanvas, 'repeat');
    fctx.fillStyle = fPat || '#baa274';
    fctx.fillRect(0, 0, w, h);

    fctx.globalCompositeOperation = 'destination-out';
    const zones = [...(wm.discoveredZones || [])];
    for (const lp of Object.values(wm.livePlayers || {})) {
      zones.push({ x: lp.x, z: lp.z, radius: 950 });
    }

    for (const z of zones) {
      const pt = toScreen(z.x, z.z);
      const radPx = Math.max(28, ((z.radius || 950) / worldRadius) * R);
      const grad = fctx.createRadialGradient(pt.x, pt.y, radPx * 0.55, pt.x, pt.y, radPx);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(0.75, 'rgba(0,0,0,0.92)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      fctx.fillStyle = grad;
      fctx.beginPath();
      fctx.arc(pt.x, pt.y, radPx, 0, Math.PI * 2);
      fctx.fill();
    }

    ctx.drawImage(offCanvas, 0, 0);
  }

  if (document.getElementById('togglePortals')?.checked !== false) {
    const hub = toScreen(45, 60);
    for (const p of wm.portals || []) {
      const pt = toScreen(p.x, p.z);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(hub.x, hub.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.stroke();
      ctx.restore();

      drawValheimMapIcon(ctx, 'portal', p.tag || 'HOME', pt.x, pt.y);
    }
  }

  if (document.getElementById('toggleBosses')?.checked !== false) {
    for (const lm of wm.landmarks || []) {
      const pt = toScreen(lm.x, lm.z);
      const iconType = lm.type === 'spawn' ? 'spawn' : lm.type === 'trader' ? 'home' : 'boss';
      drawValheimMapIcon(ctx, iconType, lm.name, pt.x, pt.y);
    }
  }

  if (document.getElementById('toggleTombstones')?.checked !== false) {
    for (const tomb of wm.tombstones || []) {
      const pt = toScreen(tomb.x, tomb.z);
      drawValheimMapIcon(ctx, 'tombstone', tomb.player || 'DEATH', pt.x, pt.y);
    }
  }

  const livePlayers = wm.livePlayersList || Object.values(wm.livePlayers || {});
  for (const lp of livePlayers) {
    if (lp.hasGps === false) continue;
    const pt = toScreen(lp.x, lp.z);

    if (Array.isArray(lp.trail) && lp.trail.length > 1) {
      ctx.beginPath();
      lp.trail.forEach((t, idx) => {
        const tpt = toScreen(t.x, t.z);
        if (idx === 0) ctx.moveTo(tpt.x, tpt.y);
        else ctx.lineTo(tpt.x, tpt.y);
      });
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.78)';
      ctx.lineWidth = 2.2;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 13, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(250, 204, 21, 0.25)';
    ctx.fill();

    ctx.save();
    ctx.translate(pt.x, pt.y);
    ctx.rotate(((lp.heading || 0) * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(6, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-6, 6);
    ctx.closePath();
    ctx.fillStyle = '#facc15';
    ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = '#0f172a';
    ctx.stroke();
    ctx.restore();

    const barW = 60;
    const barH = 5;
    const bx = pt.x - barW / 2;
    const by = pt.y - 21;

    ctx.save();
    ctx.font = '700 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
    ctx.strokeText(lp.name, pt.x, by - 4);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(lp.name, pt.x, by - 4);
    ctx.restore();

    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);

    const hpRatio = Math.max(0.08, Math.min(1, (lp.hp || 100) / Math.max(1, lp.maxHp || 100)));
    ctx.fillStyle = hpRatio < 0.45 ? '#ef4444' : '#22c55e';
    ctx.fillRect(bx, by, barW * hpRatio, barH);
  }

  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(217, 179, 114, 0.85)';
  ctx.lineWidth = 3;
  ctx.stroke();
}

async function triggerAutoConfigureServer() {
  const btn = document.getElementById('btnAutoConfigureServer');
  const logBox = document.getElementById('autoConfigOutputLog');
  const badge = document.getElementById('bepinexStatusBadge');

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Configuring & Backing Up (~20-45s)...';
    }
    if (badge) {
      badge.textContent = '⏳ Running Auto-Configuration...';
      badge.className = 'role-badge role-permitted';
    }
    if (logBox) {
      logBox.classList.remove('hidden');
      logBox.textContent =
        '⏳ Step 1/5: Creating mandatory world backup via valheim-backup...\n' +
        '⏳ Step 2/5: Installing BepInEx & WatchtowerMapExporter.dll into valheim-server (takes ~20-45s on first run)...';
    }

    showToast('⚡ Auto-configuring Valheim Server (creating safety backup & installing BepInEx)...');
    playSfx('save');
    const res = await fetch('/api/server/autoconfigure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    if (logBox) {
      logBox.classList.remove('hidden');
      logBox.textContent =
        (data.output ? `${data.output}\n\n` : '') +
        `✅ ${data.message}`;
    }

    if (data.overview) {
      appState = data.overview;
      renderAll();
    }
    showToast(`✅ ${data.message}`);
    playSfx('save');
  } catch (err) {
    if (logBox) {
      logBox.classList.remove('hidden');
      logBox.textContent = `❌ Auto-Configure Error: ${err.message}`;
    }
    showToast(`❌ Auto-configure error: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔄 Re-Sync / Verify Plugin';
    }
  }
}
