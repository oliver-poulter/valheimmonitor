const net = require('net');
const dgram = require('dgram');
const http = require('http');

const SERVERDATA_AUTH = 3;
const SERVERDATA_EXECCOMMAND = 2;

/**
 * Executes a single Source RCON command over TCP (used by BepInEx Valheim RCON plugins).
 */
function executeRconCommand({ host, port = 2458, password = '', command, timeout = 4000 }) {
  return new Promise((resolve, reject) => {
    if (!password) {
      return reject(new Error('RCON_PASS is not configured. Set RCON_PASS or use Supervisor/ACL commands.'));
    }

    const client = new net.Socket();
    let authenticated = false;
    let responseBuffer = '';
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      try {
        client.destroy();
      } catch (_) {}
      if (err) reject(err);
      else resolve(result);
    };

    client.setTimeout(timeout, () => {
      finish(new Error(`RCON connection timed out (${host}:${port})`));
    });

    function createPacket(id, type, body) {
      const bodyBuf = Buffer.from(body, 'utf8');
      const length = bodyBuf.length + 10;
      const buf = Buffer.alloc(length + 4);
      buf.writeInt32LE(length, 0);
      buf.writeInt32LE(id, 4);
      buf.writeInt32LE(type, 8);
      bodyBuf.copy(buf, 12);
      buf.writeInt16LE(0, 12 + bodyBuf.length);
      return buf;
    }

    client.connect(Number(port), host, () => {
      client.write(createPacket(1, SERVERDATA_AUTH, password));
    });

    client.on('data', (data) => {
      if (data.length < 12) return;
      const id = data.readInt32LE(4);
      const body = data.toString('utf8', 12, data.length - 2);

      if (!authenticated) {
        if (id === -1) {
          return finish(new Error('RCON authentication failed (invalid password)'));
        }
        authenticated = true;
        client.write(createPacket(2, SERVERDATA_EXECCOMMAND, command));
      } else if (id === 2) {
        responseBuffer += body;
        setTimeout(() => finish(null, responseBuffer.trim() || 'Command executed successfully (no output).'), 150);
      }
    });

    client.on('error', (err) => {
      finish(new Error(`RCON unavailable on ${host}:${port} (${err.code || err.message})`));
    });
  });
}

/**
 * Queries lloesche/valheim-server's built-in status.json HTTP server if STATUS_HTTP=true
 */
function fetchStatusJson({ host, port = 80, timeout = 2000 }) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/status.json', timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Queries Steam A2S_INFO directly over UDP (default port 2457 for Valheim)
 */
function queryA2SInfo({ host, port = 2457, timeout = 2000 }) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

    const done = (val) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch (_) {}
      resolve(val);
    };

    const timer = setTimeout(() => done(null), timeout);

    const buildRequest = (challengeBuf = null) => {
      const header = Buffer.from([
        0xff, 0xff, 0xff, 0xff, 0x54,
        ...Buffer.from('Source Engine Query\0', 'ascii')
      ]);
      return challengeBuf ? Buffer.concat([header, challengeBuf]) : header;
    };

    socket.on('message', (msg) => {
      if (msg.length < 5) return done(null);
      const type = msg[4];
      // Challenge response (0x41 'A')
      if (type === 0x41 && msg.length >= 9) {
        const challenge = msg.subarray(5, 9);
        socket.send(buildRequest(challenge), port, host);
        return;
      }
      // A2S_INFO response (0x49 'I')
      if (type === 0x49) {
        clearTimeout(timer);
        try {
          let offset = 6; // skip header (4) + type (1) + protocol (1)
          const readString = () => {
            const end = msg.indexOf(0x00, offset);
            if (end === -1) return '';
            const str = msg.toString('utf8', offset, end);
            offset = end + 1;
            return str;
          };
          const serverName = readString();
          const map = readString();
          const folder = readString();
          const game = readString();
          offset += 2; // appId (short)
          const players = msg[offset++];
          const maxPlayers = msg[offset++];
          const bots = msg[offset++];
          const serverType = String.fromCharCode(msg[offset++]);
          const environment = String.fromCharCode(msg[offset++]);
          const visibility = msg[offset++];
          const vac = msg[offset++];
          const version = readString();
          done({
            serverName,
            map,
            folder,
            game,
            players,
            maxPlayers,
            bots,
            serverType,
            environment,
            passwordProtected: visibility === 1,
            vac: vac === 1,
            version
          });
        } catch (_) {
          done(null);
        }
      }
    });

    socket.on('error', () => {
      clearTimeout(timer);
      done(null);
    });

    socket.send(buildRequest(), port, host);
  });
}

module.exports = {
  executeRconCommand,
  fetchStatusJson,
  queryA2SInfo
};
