const https = require('https');
const http = require('http');

/**
 * Sends a rich Norse-themed Discord Webhook notification for Valheim server events.
 */
function sendDiscordNotification(webhookUrl, event) {
  if (!webhookUrl || !webhookUrl.startsWith('http')) {
    return Promise.resolve({ sent: false, reason: 'No valid Discord webhook URL configured' });
  }

  const colorMap = {
    join: 0x34d399,    // Emerald green
    leave: 0x94a3b8,   // Slate
    death: 0xf87171,   // Crimson red
    raid: 0xf59e0b,    // Amber gold
    backup: 0x38bdf8,  // Frost cyan
    system: 0xa78bfa   // Mystic violet
  };

  const iconMap = {
    join: '⛵ Viking Arrived in the Tenth World',
    leave: '🏕️ Viking Departed for Valhalla',
    death: '💀 A Viking Has Fallen!',
    raid: '⚔️ Raid Event Triggered!',
    backup: '🛡️ World Backup Archived',
    system: '🔥 Watchtower Server Notice'
  };

  const payload = JSON.stringify({
    username: 'Heimdall Watchtower',
    embeds: [
      {
        title: iconMap[event.type] || '⚡ Valheim Server Event',
        description: event.message || '',
        color: colorMap[event.type] || 0xf59e0b,
        fields: event.fields || [],
        footer: {
          text: `Valheim Watchtower • ${event.serverName || 'Dedicated Server'}`
        },
        timestamp: new Date().toISOString()
      }
    ]
  });

  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    try {
      const urlObj = new URL(webhookUrl);
      const lib = urlObj.protocol === 'https:' ? https : http;
      const req = lib.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: 'POST',
          timeout: 8000,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        },
        (res) => {
          res.on('error', () => done({ sent: false, reason: 'Response stream error' }));
          res.resume();
          res.on('end', () => {
            done({ sent: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode });
          });
        }
      );
      req.on('error', (err) => done({ sent: false, reason: err.message }));
      req.on('timeout', () => {
        try {
          req.destroy();
        } catch (_) {}
        done({ sent: false, reason: 'Discord webhook request timed out' });
      });
      req.write(payload);
      req.end();
    } catch (err) {
      done({ sent: false, reason: err.message });
    }
  });
}

module.exports = {
  sendDiscordNotification
};
