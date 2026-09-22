#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PORT_TRIES = 10;
const MAX_MESSAGES = 50;
let activePort = PORT;

function getLanIps() {
  const ips = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips.length ? ips : ['127.0.0.1'];
}

const lanIps = getLanIps();
const lanIp = lanIps[0];

function renderHtml() {
  let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf-8');
  html = html.replace('__LAN_IP__', lanIp);
  html = html.replace('__PORT__', String(activePort));
  return html;
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
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/dd') {
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

const wss = new WebSocketServer({ server });
const messages = [];

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
    console.log(`  http://${ip}:${activePort}`);
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
