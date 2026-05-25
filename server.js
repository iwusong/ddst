#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_MESSAGES = 50;

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
  html = html.replace('__PORT__', String(PORT));
  return html;
}

const server = http.createServer((req, res) => {
  const url = req.url;
  if (url === '/' || url === '/dd') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHtml());
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
    const raw = data.toString();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed.type) return;
    messages.push({ text: parsed.text, deviceId: parsed.deviceId, time: parsed.time });
    if (messages.length > MAX_MESSAGES) {
      messages.splice(0, messages.length - MAX_MESSAGES);
    }
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(raw);
      }
    });
  });

  ws.on('close', () => {
    broadcastCount();
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ddst 已启动');
  console.log('  ─────────────────────────────');
  for (const ip of lanIps) {
    console.log(`  http://${ip}:${PORT}`);
  }
  console.log('');
});
