#!/usr/bin/env node
// hf-download.cjs — 经本地代理下载 HuggingFace 数据集文件，并校验 LFS sha256
// 背景：本机代理做 TLS 拦截（Node 默认不信任其根证书），因此这里显式关闭证书校验，
//       但**下载后用调用方提供的 sha256 校验完整性**（sha256 来自浏览器可信通道取得的 LFS oid）。
// 用法：node tools/hf-download.cjs <url> <outFile> [expectedSha256] [proxyHost:port]
const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');

const [url, outFile, expectSha, proxyArg] = process.argv.slice(2);
if (!url || !outFile) { console.error('usage: hf-download.cjs <url> <out> [sha256] [host:port]'); process.exit(2); }
const [pHost, pPort] = (proxyArg || '127.0.0.1:7890').split(':');
const u = new URL(url);
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function connectProxy() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(pPort), pHost, () => {
      sock.write(`CONNECT ${u.hostname}:443 HTTP/1.1\r\nHost: ${u.hostname}:443\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
    });
    let head = '';
    const onData = (d) => {
      head += d.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      sock.removeListener('data', onData);
      if (!/^HTTP\/1\.[01] 200/i.test(head)) return reject(new Error('CONNECT failed: ' + head.slice(0, 120)));
      const t = tls.connect({ socket: sock, servername: u.hostname, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
      t.once('secureConnect', () => resolve(t));
      t.once('error', reject);
    };
    sock.on('data', onData);
    sock.once('error', reject);
  });
}

(async () => {
  const socket = await connectProxy();
  const req = https.request({
    createConnection: () => socket,
    host: u.hostname,
    path: u.pathname + u.search,
    method: 'GET',
    headers: (() => {
      const tmp = outFile + '.part';
      const start = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
      const h = { Host: u.hostname, 'User-Agent': 'cp-downloader', Accept: '*/*' };
      if (start > 0) h.Range = 'bytes=' + start + '-';
      return h;
    })(),
  }, (res) => {
    if (res.statusCode !== 200) { console.error('HTTP ' + res.statusCode); process.exit(1); }
    const total = Number(res.headers['content-length'] || 0);
    const tmp = outFile + '.part';
    fs.mkdirSync(require('node:path').dirname(outFile), { recursive: true });
    const resume = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
    const out = fs.createWriteStream(tmp, { flags: resume > 0 ? 'a' : 'w' });
    let got = resume, lastPct = -1;
    res.on('data', (c) => {
      got += c.length;
      if (total) {
        const pct = Math.floor((got / total) * 100);
        if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; process.stdout.write(`  ${pct}% (${(got / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)\n`); }
      }
    });
    res.pipe(out);
    out.on('finish', () => {
      out.close(() => {
        fs.renameSync(tmp, outFile);
        if (expectSha) {
          const h = crypto.createHash('sha256').update(fs.readFileSync(outFile)).digest('hex');
          const ok = h === expectSha;
          console.log(JSON.stringify({ ok, bytes: got, sha256: h, expected: expectSha }, null, 2));
          process.exit(ok ? 0 : 3);
        } else {
          console.log(JSON.stringify({ ok: true, bytes: got, note: 'sha256 未提供，未校验' }, null, 2));
          process.exit(0);
        }
      });
    });
  });
  req.on('error', (e) => { console.error('下载失败: ' + e.message); process.exit(1); });
  req.end();
})().catch((e) => { console.error('失败: ' + (e && e.message)); process.exit(1); });