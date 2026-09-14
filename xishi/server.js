const http = require('http');
const fs = require('fs');
const path = require('path');
const root = 'c:\\Users\\17133\\Desktop\\xishi';
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
http.createServer((req, res) => {
  let f = path.join(root, req.url === '/' ? 'index.html' : req.url);
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'text/plain; charset=utf-8' });
    res.end(data);
  });
}).listen(8765, () => console.log('Serving on http://localhost:8765'));
