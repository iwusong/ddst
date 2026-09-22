#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = process.env.TOKEN || crypto.randomBytes(16).toString('hex');
const MAX_PORT_TRIES = 10;
const MAX_MESSAGES = 50;
let activePort = PORT;

const VIRTUAL_IFACE_RE = /vEthernet|VMware|VirtualBox|Hyper-V|Docker|WSL|Tailscale|ZeroTier|Bluetooth|Npcap|TAP-|tun\d|utun/i;

function ipPriority(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  const m = ip.match(/^172\.(\d+)\./);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return 2;
  }
  return 3;
}

function getLanIps() {
  const candidates = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const isVirtual = VIRTUAL_IFACE_RE.test(name);
    for (const iface of interfaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (iface.address.startsWith('169.254.')) continue;
      candidates.push({ ip: iface.address, virtual: isVirtual });
    }
  }
  candidates.sort((a, b) => {
    if (a.virtual !== b.virtual) return a.virtual ? 1 : -1;
    return ipPriority(a.ip) - ipPriority(b.ip);
  });
  const ips = candidates.map((c) => c.ip);
  return ips.length ? ips : ['127.0.0.1'];
}

const lanIps = getLanIps();
const lanIp = lanIps[0];

function renderHtml() {
  let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf-8');
  html = html.replace('__LAN_IP__', lanIp);
  html = html.replace('__LAN_IPS__', JSON.stringify(lanIps));
  html = html.replace('__PORT__', String(activePort));
  html = html.replace('__TOKEN__', TOKEN);
  return html;
}

function isLocalRequest(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function checkToken(req, urlObj) {
  if (isLocalRequest(req)) return true;
  return urlObj.searchParams.get('t') === TOKEN;
}

const MIME_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, 'http://localhost');
  const url = urlObj.pathname;
  if (url === '/' || url === '/dd') {
    if (!checkToken(req, urlObj)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized: 缺少或无效的访问令牌，请扫描电脑端展示的二维码访问。');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHtml());
    return;
  }

  const safeName = path.basename(url);
  const filePath = path.join(__dirname, 'public', safeName);
  if (safeName && filePath.startsWith(path.join(__dirname, 'public')) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(filePath));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

const wss = new WebSocketServer({ noServer: true });
const messages = [];

server.on('upgrade', (req, socket, head) => {
  const urlObj = new URL(req.url, 'http://localhost');
  if (!checkToken(req, urlObj)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

const HEARTBEAT_INTERVAL = 30000;

const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.isAlive === false) {
      client.terminate();
      return;
    }
    client.isAlive = false;
    client.ping();
  });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => clearInterval(heartbeatTimer));

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}

function broadcastCount() {
  broadcast({ type: 'count', count: wss.clients.size });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ type: 'sync', messages }));
  broadcastCount();

  ws.on('message', (data) => {
    let parsed;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    if (parsed.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (parsed.type) return;
    if (typeof parsed.text !== 'string' || !parsed.text) return;
    messages.push({ text: parsed.text, deviceId: parsed.deviceId, time: parsed.time });
    if (messages.length > MAX_MESSAGES) {
      messages.splice(0, messages.length - MAX_MESSAGES);
    }
    const out = JSON.stringify(parsed);
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(out);
      }
    });
  });

  ws.on('close', () => {
    broadcastCount();
  });
});

function printReady() {
  console.log('');
  console.log('  ddst 已启动');
  console.log('  ─────────────────────────────');
  for (const ip of lanIps) {
    console.log(`  http://${ip}:${activePort}/?t=${TOKEN}`);
  }
  console.log('');
}

let portTry = 0;

function startListening(port) {
  function onError(err) {
    server.removeListener('listening', onListening);
    if (err.code === 'EADDRINUSE' && portTry < MAX_PORT_TRIES) {
      portTry += 1;
      const nextPort = port + 1;
      console.log(`  端口 ${port} 已被占用，改用 ${nextPort} ...`);
      startListening(nextPort);
      return;
    }
    console.error(`  无法监听端口 ${port}：${err.message}`);
    process.exit(1);
  }

  function onListening() {
    server.removeListener('error', onError);
    activePort = server.address().port;
    printReady();
  }

  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port);
}

startListening(PORT);
