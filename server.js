const http = require('http');
const fs = require('fs');
const path = require('path');
const root = __dirname;
const port = 8123;
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg',
  '.vtt': 'text/vtt; charset=utf-8', '.srt': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav'
};
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(root, p);
  if (!fp.startsWith(root)) { res.writeHead(403); res.end('403'); return; }
  let stat;
  try { stat = fs.statSync(fp); } catch (e) { res.writeHead(404); res.end('404'); return; }
  const total = stat.size;
  const type = types[path.extname(fp).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= total) end = total - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); res.end(); return; }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(fp, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Length': total,
    'Accept-Ranges': 'bytes',
    'Content-Type': type,
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(fp).pipe(res);
}).listen(port, '127.0.0.1', () => console.log('serving on http://127.0.0.1:' + port));