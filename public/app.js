let appState = null;
let allLogs = [];
let activeEventFilter = 'all';
let activeLogFilter = 'all';

document.addEventListener('DOMContentLoaded', () => {
  fetchOverview();
  fetchLogs();
  connectSSE();

  // Copy Crossplay join code button
  const copyBtn = document.getElementById('copyJoinCodeBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const code = document.getElementById('headerJoinCode').textContent;
      navigator.clipboard?.writeText(code);
      showToast(`🔑 Copied PlayFab Crossplay Join Code: ${code}`);
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

  es.addEventListener('log', (e) => {
    try {
      const entry = JSON.parse(e.data);
      allLogs.push(entry);
      if (allLogs.length > 400) allLogs.shift();
      renderLogStream();
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
          appState.worldMap = payload.worldMap;
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
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tabId}`);
  });
  if (tabId === 'map') {
    setTimeout(() => drawValheimMap(), 30);
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
  populateSettingsAndModifiers();
  renderLiveMapAndVitals();
}

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
    statusText.textContent = 'ONLINE • RUNNING';
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
    container.mode === 'docker' ? '🐳 Docker Socket Connected' : '⚡ Interactive Preview Mode';

  // Counters
  document.getElementById('navOnlineCounter').textContent = onlinePlayers.length;
  document.getElementById('navBackupCounter').textContent = (backups || []).length;

  // KPI 1: Online Vikings
  document.getElementById('kpiOnlineCount').textContent = onlinePlayers.length;
  document.getElementById('kpiOnlineNames').textContent =
    onlinePlayers.length > 0
      ? onlinePlayers.map((p) => p.name).join(', ')
      : 'No Vikings currently connected';

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
          <div class="event-detail">No Vikings are currently logged in. Click "+ Simulate Join" above to test live player detection.</div>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = onlinePlayers
    .map((p) => {
      const isAdmin = adminIds.has(p.steamId);
      const isPermitted = permittedIds.has(p.steamId);
      const sessionDuration = formatDurationFromTimestamp(p.currentSessionStart);
      const totalHours = ((p.totalPlaytimeSeconds || 0) / 3600).toFixed(1);
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
                ? `<button class="btn btn-xs btn-glass" onclick="jumpToVikingOnMap('${escapeAttr(p.steamId)}')" title="Track Viking on Live Map">🗺️ Locate</button>`
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
    `${services.length} Supervisor Programs Managed`;

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

function setEventFilter(filter, btn) {
  activeEventFilter = filter;
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

function renderPlayersTable() {
  const tbody = document.getElementById('vikingRosterBody');
  if (!tbody || !appState) return;

  const query = (document.getElementById('playerSearchInput')?.value || '').toLowerCase().trim();
  const filter = document.getElementById('playerFilterSelect')?.value || 'all';

  const adminIds = new Set((appState.accessLists?.admins || []).map((a) => a.steamId));
  const permittedIds = new Set((appState.accessLists?.permitted || []).map((a) => a.steamId));
  const bannedIds = new Set((appState.accessLists?.banned || []).map((a) => a.steamId));

  const filtered = (appState.players || []).filter((p) => {
    if (query && !p.name.toLowerCase().includes(query) && !p.steamId.includes(query)) return false;
    if (filter === 'online' && !p.online) return false;
    if (filter === 'offline' && p.online) return false;
    if (filter === 'admin' && !adminIds.has(p.steamId)) return false;
    return true;
  });

  tbody.innerHTML = filtered
    .map((p) => {
      const isAdmin = adminIds.has(p.steamId);
      const isPermitted = permittedIds.has(p.steamId);
      const isBanned = bannedIds.has(p.steamId);
      const initials = getInitials(p.name);

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
            <strong class="text-amber">${formatTotalPlaytime(p.totalPlaytimeSeconds)}</strong>
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
        </div>
        <button class="btn btn-xs btn-amber" onclick="executeDeckCommand('randomevent ${escapeAttr(code)}')">
          ⚔️ Trigger (${escapeHtml(code)})
        </button>
      </div>
    `
    )
    .join('');

  const raids = appState.raids || [];
  if (historyList) {
    historyList.innerHTML = raids.length
      ? raids
          .slice(0, 6)
          .map(
            (r) => `
          <div class="event-item evt-raid" style="margin-bottom:0.45rem">
            <span class="event-icon">${r.icon || '⚔️'}</span>
            <div class="event-body">
              <div class="event-title">${escapeHtml(r.name)}</div>
              <div class="event-detail">Code: ${escapeHtml(r.code)} • Biome: ${escapeHtml(r.biome || 'Midgard')}</div>
            </div>
            <span class="event-time">${formatRelativeTime(r.timestamp)}</span>
          </div>
        `
          )
          .join('')
      : `<div class="viking-meta-line">No raids recorded yet.</div>`;
  }
}

function renderAclColumns() {
  if (!appState || !appState.accessLists) return;
  const { admins, permitted, banned } = appState.accessLists;

  // Populate known players select dropdown
  const select = document.getElementById('aclKnownPlayerSelect');
  if (select) {
    const currentVal = select.value;
    select.innerHTML =
      `<option value="">— Pick from Known Vikings or enter manually —</option>` +
      (appState.players || [])
        .map((p) => `<option value="${escapeAttr(p.steamId)}|${escapeAttr(p.name)}">${escapeHtml(p.name)} (${escapeHtml(p.steamId)})</option>`)
        .join('');
    select.value = currentVal;
  }

  const renderList = (items, listType, countId, listId) => {
    document.getElementById(countId).textContent = items.length;
    const container = document.getElementById(listId);
    if (items.length === 0) {
      container.innerHTML = `<div class="viking-meta-line">No entries in ${listType} list.</div>`;
      return;
    }
    container.innerHTML = items
      .map(
        (item) => `
        <div class="acl-entry">
          <div>
            <div class="viking-name-line">${escapeHtml(item.name || 'Viking')}</div>
            <div class="viking-meta-line">${escapeHtml(item.steamId)}</div>
          </div>
          <button class="btn btn-xs btn-crimson" onclick="quickAclAction('${listType}', 'remove', '${escapeAttr(item.steamId)}', '${escapeAttr(item.name)}')">
            Remove
          </button>
        </div>
      `
      )
      .join('');
  };

  renderList(admins || [], 'admins', 'aclAdminsCount', 'aclAdminsList');
  renderList(permitted || [], 'permitted', 'aclPermittedCount', 'aclPermittedList');
  renderList(banned || [], 'banned', 'aclBannedCount', 'aclBannedList');
}

function populateAclFromKnownPlayer(val) {
  if (!val) return;
  const [steamId, name] = val.split('|');
  document.getElementById('aclSteamIdInput').value = steamId || '';
  document.getElementById('aclNameInput').value = name || '';
}

async function handleAclSubmit(e) {
  e.preventDefault();
  const steamId = document.getElementById('aclSteamIdInput').value.trim();
  const name = document.getElementById('aclNameInput').value.trim();
  const listType = document.getElementById('aclListTypeSelect').value;
  if (!steamId) return;

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
  } catch (err) {
    showToast(`❌ ACL Error: ${err.message}`);
  }
}

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

function setLogFilter(cat, btn) {
  activeLogFilter = cat;
  document.querySelectorAll('#logCategoryPills .pill').forEach((p) => p.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderLogStream();
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
    .slice(-200)
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

  viewer.scrollTop = viewer.scrollHeight;
}

async function triggerServerAction(action) {
  try {
    showToast(`⏳ Executing server action: ${action.toUpperCase()}...`);
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
  } catch (err) {
    showToast(`❌ Command error: ${err.message}`);
  }
}

async function handleTerminalSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('terminalCommandInput');
  const cmd = input.value.trim();
  if (!cmd) return;
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

function clearTerminalOutput() {
  const term = document.getElementById('terminalHistory');
  if (term) {
    term.innerHTML = `<div class="term-line term-sys">Terminal cleared. Ready for commands.</div>`;
  }
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
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

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
}

function copyGeneratedArgs() {
  const txt = document.getElementById('generatedServerArgsCode')?.textContent || '';
  navigator.clipboard?.writeText(txt);
  showToast(`📋 Copied ${txt} to clipboard!`);
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
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

/* Formatting Helpers */
function formatRelativeTime(iso) {
  if (!iso) return 'Never';
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
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
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  const hrs = Math.floor(diffSec / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  return hrs > 0 ? `${hrs}h ${mins}m` : `${Math.max(1, mins)}m`;
}

function formatTotalPlaytime(seconds = 0) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hrs}h ${mins}m`;
}

function formatShortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
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
  return d.toTimeString().slice(0, 8);
}

function formatUptime(startedAtIso, state) {
  if (state !== 'running' || !startedAtIso) return 'Offline';
  const sec = Math.max(0, Math.floor((Date.now() - new Date(startedAtIso).getTime()) / 1000));
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
      readout.textContent = `X: ${wx}, Z: ${wz} • ${estimateClientBiome(wx, wz)}`;
    }

    if (isDraggingMap) {
      mapPanX += (e.clientX - dragStartX) * scaleX;
      mapPanZ += (e.clientY - dragStartY) * scaleY;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      drawValheimMap();
    }
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.16 : 0.86;
      mapZoom = Math.max(0.65, Math.min(5.0, mapZoom * factor));
      drawValheimMap();
    },
    { passive: false }
  );
}

function resetMapView() {
  mapZoom = 1.0;
  mapPanX = 0;
  mapPanZ = 0;
  drawValheimMap();
}

function focusMapOnCoords(x, z, label = '') {
  switchTab('map');
  const canvas = document.getElementById('valheimMapCanvas');
  if (!canvas) return;
  const worldRadius = 10500;
  const baseRadiusPx = Math.min(canvas.width, canvas.height) * 0.44;
  mapZoom = 2.1;
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
          const hpPct = Math.max(5, Math.min(100, Math.round((lp.hp / Math.max(1, lp.maxHp)) * 100)));
          const stamPct = Math.max(5, Math.min(100, Math.round((lp.stamina / Math.max(1, lp.maxStamina)) * 100)));
          const foodsHtml = (lp.foods || [])
            .map((f) => `<span class="food-chip">🍖 ${escapeHtml(f)}</span>`)
            .join('');

          return `
            <div class="vital-card">
              <div class="vital-top-row">
                <div>
                  <div class="viking-name-line">
                    <span>⚔️ ${escapeHtml(lp.name)}</span>
                    <span class="role-badge role-permitted">${escapeHtml(lp.biome)}</span>
                  </div>
                  <div class="viking-meta-line">
                    📍 X: ${lp.x}, Y: ${lp.y || 20}, Z: ${lp.z} • ${escapeHtml(lp.activity || 'Exploring')}
                  </div>
                </div>
                <button class="btn btn-xs btn-amber" onclick="focusMapOnCoords(${lp.x}, ${lp.z}, '${escapeAttr(lp.name)}')">
                  🎯 Track
                </button>
              </div>

              <div class="vital-bars-grid">
                <div class="vital-bar-wrap">
                  <div class="vital-bar-label">
                    <span class="text-crimson">❤️ Health</span>
                    <strong>${lp.hp} / ${lp.maxHp} HP</strong>
                  </div>
                  <div class="vital-bar-track">
                    <div class="vital-bar-fill-hp" style="width:${hpPct}%"></div>
                  </div>
                </div>

                <div class="vital-bar-wrap">
                  <div class="vital-bar-label">
                    <span class="text-amber">⚡ Stamina</span>
                    <strong>${lp.stamina} / ${lp.maxStamina}</strong>
                  </div>
                  <div class="vital-bar-track">
                    <div class="vital-bar-fill-stamina" style="width:${stamPct}%"></div>
                  </div>
                </div>
              </div>

              <div class="food-chips-row">
                ${foodsHtml}
              </div>
            </div>
          `;
        })
        .join('');
    }
  }

  // Render Death Tombstones & Portals list
  const poiContainer = document.getElementById('mapTombstonesAndPortals');
  if (poiContainer) {
    const tombs = (wm.tombstones || []).map(
      (t) => `
      <div class="acl-entry">
        <div>
          <div class="viking-name-line">💀 ${escapeHtml(t.player)}'s Tombstone</div>
          <div class="viking-meta-line">${escapeHtml(t.biome)} (${t.x}, ${t.z}) • ${t.itemsCount || 20} items • ${formatRelativeTime(t.createdAt)}</div>
        </div>
        <button class="btn btn-xs btn-crimson" onclick="focusMapOnCoords(${t.x}, ${t.z}, '${escapeAttr(t.player)} Tombstone')">
          Locate
        </button>
      </div>
    `
    );

    const portals = (wm.portals || []).map(
      (p) => `
      <div class="acl-entry">
        <div>
          <div class="viking-name-line">🌀 Portal: "${escapeHtml(p.tag)}"</div>
          <div class="viking-meta-line">${escapeHtml(p.biome)} (${p.x}, ${p.z})</div>
        </div>
        <button class="btn btn-xs btn-frost" onclick="focusMapOnCoords(${p.x}, ${p.z}, 'Portal ${escapeAttr(p.tag)}')">
          View
        </button>
      </div>
    `
    );

    poiContainer.innerHTML = [...tombs, ...portals].join('');
  }

  drawValheimMap();
}

function generateSeedContinents(seedNumeric) {
  let s = (Number(seedNumeric) || 84920177) >>> 0;
  if (s === 0) s = 84920177;
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const landmasses = [
    // Central Starting Island (Meadows & Black Forest around 0,0)
    { wx: 0, wz: 0, rx: 920 + rand() * 320, rz: 740 + rand() * 260, rot: (rand() - 0.5) * 1.2, color: '#38a169' },
    { wx: (rand() - 0.5) * 1100, wz: (rand() - 0.5) * 1100, rx: 720 + rand() * 250, rz: 520 + rand() * 200, rot: (rand() - 0.5) * 1.5, color: '#166534' }
  ];

  // Inner Ring (Black Forest / Swamp / Mountains)
  const innerColors = ['#166534', '#5c3a21', '#cbd5e1', '#38a169', '#5c3a21'];
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 + (rand() - 0.5) * 0.55;
    const dist = 1600 + rand() * 1400;
    landmasses.push({
      wx: Math.cos(angle) * dist,
      wz: Math.sin(angle) * dist,
      rx: 750 + rand() * 480,
      rz: 520 + rand() * 340,
      rot: (rand() - 0.5) * Math.PI,
      color: innerColors[i % innerColors.length]
    });
  }

  // Outer Ring (Plains & Mistlands)
  const outerColors = ['#ca8a04', '#6b21a8', '#ca8a04', '#7e22ce', '#ca8a04', '#6b21a8'];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 + (rand() - 0.5) * 0.45;
    const dist = 3600 + rand() * 2600;
    landmasses.push({
      wx: Math.cos(angle) * dist,
      wz: Math.sin(angle) * dist,
      rx: 950 + rand() * 620,
      rz: 640 + rand() * 420,
      rot: (rand() - 0.5) * Math.PI,
      color: outerColors[i % outerColors.length]
    });
  }

  // Deep North & Ashlands Caps
  landmasses.push(
    { wx: (rand() - 0.5) * 600, wz: 8550, rx: 5600, rz: 1600, rot: 0, color: '#e2e8f0' },
    { wx: (rand() - 0.5) * 600, wz: -8450, rx: 5500, rz: 1550, rot: 0, color: '#991b1b' }
  );

  return landmasses;
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

  // 1. Deep Ocean Abyss Background
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#040811';
  ctx.fillRect(0, 0, w, h);

  // Save & clip to circular Valheim world disc
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();

  // Ocean radial gradient inside world disc
  const oceanGrad = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R);
  oceanGrad.addColorStop(0, '#0c2744');
  oceanGrad.addColorStop(0.7, '#081b33');
  oceanGrad.addColorStop(1, '#051020');
  ctx.fillStyle = oceanGrad;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

  // 2. Render Procedural Valheim Continents & Biomes (seeded from .fwl seedNumeric)
  const landmasses = generateSeedContinents(wm.seedNumeric);

  for (const land of landmasses) {
    const pt = toScreen(land.wx, land.wz);
    const srx = (land.rx / worldRadius) * R;
    const srz = (land.rz / worldRadius) * R;
    ctx.save();
    ctx.translate(pt.x, pt.y);
    ctx.rotate(land.rot);
    ctx.beginPath();
    ctx.ellipse(0, 0, srx, srz, 0, 0, Math.PI * 2);
    ctx.fillStyle = land.color;
    ctx.globalAlpha = 0.78;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.stroke();
    ctx.restore();
  }

  // Subtle Cartography Coordinate Grid Rings
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
  ctx.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach((frac) => {
    ctx.beginPath();
    ctx.arc(cx, cy, R * frac, 0, Math.PI * 2);
    ctx.stroke();
  });

  // 3. Shared Fog-of-War Overlay (if enabled)
  const showFog = document.getElementById('toggleFogOfWar')?.checked !== false;
  if (showFog) {
    const offCanvas = document.createElement('canvas');
    offCanvas.width = w;
    offCanvas.height = h;
    const fctx = offCanvas.getContext('2d');

    // Fill parchment/dark fog
    fctx.fillStyle = 'rgba(6, 9, 15, 0.84)';
    fctx.fillRect(0, 0, w, h);

    // Punch out discovered zones + active player exploration radii
    fctx.globalCompositeOperation = 'destination-out';
    const zones = [...(wm.discoveredZones || [])];
    for (const lp of Object.values(wm.livePlayers || {})) {
      zones.push({ x: lp.x, z: lp.z, radius: 750 });
    }

    for (const z of zones) {
      const pt = toScreen(z.x, z.z);
      const radPx = Math.max(18, ((z.radius || 750) / worldRadius) * R);
      const grad = fctx.createRadialGradient(pt.x, pt.y, radPx * 0.35, pt.x, pt.y, radPx);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      fctx.fillStyle = grad;
      fctx.beginPath();
      fctx.arc(pt.x, pt.y, radPx, 0, Math.PI * 2);
      fctx.fill();
    }

    ctx.drawImage(offCanvas, 0, 0);

    // Draw subtle golden exploration boundary rings
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.18)';
    ctx.setLineDash([4, 4]);
    for (const z of wm.discoveredZones || []) {
      const pt = toScreen(z.x, z.z);
      const radPx = ((z.radius || 750) / worldRadius) * R;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, radPx * 0.85, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // 4. Portal Network Layer
  if (document.getElementById('togglePortals')?.checked !== false) {
    const hub = toScreen(45, 60);
    for (const p of wm.portals || []) {
      const pt = toScreen(p.x, p.z);
      // Draw Bifrost portal beam to hub
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(hub.x, hub.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 5]);
      ctx.stroke();
      ctx.restore();

      // Portal node
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = '#38bdf8';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  // 5. Boss Altars, Traders & Sacrificial Stones
  if (document.getElementById('toggleBosses')?.checked !== false) {
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    for (const lm of wm.landmarks || []) {
      const pt = toScreen(lm.x, lm.z);
      ctx.fillText(lm.icon || '📍', pt.x, pt.y + 4);
      if (mapZoom >= 1.15 || lm.type === 'spawn') {
        ctx.fillStyle = 'rgba(254, 243, 199, 0.88)';
        ctx.font = '600 10px Inter, sans-serif';
        ctx.fillText(lm.name, pt.x, pt.y - 9);
      }
    }
  }

  // 6. Active Death Tombstones
  if (document.getElementById('toggleTombstones')?.checked !== false) {
    for (const tomb of wm.tombstones || []) {
      const pt = toScreen(tomb.x, tomb.z);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.32)';
      ctx.fill();
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('💀', pt.x, pt.y + 4);
    }
  }

  // 7. Live Vikings (Movement Trails + Radar Pulse + Live HP Bar + Nameplate)
  const livePlayers = wm.livePlayersList || Object.values(wm.livePlayers || {});
  for (const lp of livePlayers) {
    const pt = toScreen(lp.x, lp.z);

    // Draw breadcrumb movement trail
    if (Array.isArray(lp.trail) && lp.trail.length > 1) {
      ctx.beginPath();
      lp.trail.forEach((t, idx) => {
        const tpt = toScreen(t.x, t.z);
        if (idx === 0) ctx.moveTo(tpt.x, tpt.y);
        else ctx.lineTo(tpt.x, tpt.y);
      });
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.65)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Glowing radar halo
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 13, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(52, 211, 153, 0.22)';
    ctx.fill();

    // Viking position pin
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#34d399';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    // Floating Nameplate + Live Health Bar above player
    const barW = 58;
    const barH = 5;
    const bx = pt.x - barW / 2;
    const by = pt.y - 20;

    // Name
    ctx.font = '700 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(lp.name, pt.x, by - 4);

    // HP Bar Track
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);

    // HP Bar Fill
    const hpRatio = Math.max(0.08, Math.min(1, (lp.hp || 100) / Math.max(1, lp.maxHp || 100)));
    ctx.fillStyle = hpRatio < 0.45 ? '#ef4444' : '#22c55e';
    ctx.fillRect(bx, by, barW * hpRatio, barH);
  }

  ctx.restore();

  // Outer World Rim Border
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.65)';
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
