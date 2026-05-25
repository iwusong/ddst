const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

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

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const msg = data.toString();
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(msg);
      }
    });
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ClipSync 已启动');
  console.log('  ─────────────────────────────');
  for (const ip of lanIps) {
    console.log(`  http://${ip}:${PORT}`);
  }
  console.log('');
});
