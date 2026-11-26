// lib/binary-vec.js — 向量二值化（票 09）
// 做法：每个维度按符号取 1 位（>=0 → 1），512 维 = 64 字节/卡；检索用汉明距离（异或后数 1 的个数）。
// 保留余弦路径：这只是可选加速层，默认仍走浮点余弦。
import { createHash } from 'node:crypto';

export function toBinary(vec) {
  const bytes = new Uint8Array(Math.ceil(vec.length / 8));
  for (let i = 0; i < vec.length; i += 1) {
    if (vec[i] >= 0) bytes[i >> 3] |= 1 << (7 - (i % 8));
  }
  return bytes;
}

export function hamming(a, b) {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    let x = a[i] ^ b[i];
    while (x) { x &= x - 1; d += 1; }
  }
  return d;
}

export function buildBinaryStore(store) {
  const entries = {};
  let dim = store.dim || 0;
  for (const [id, e] of Object.entries(store.entries || {})) {
    if (!Array.isArray(e.v) || !e.v.length) continue;
    dim = dim || e.v.length;
    entries[id] = { fp: e.fp, b: Buffer.from(toBinary(e.v)).toString('base64') };
  }
  const payload = { model: store.model, dim, bits: Object.keys(entries).length, entries };
  const canonical = JSON.stringify(payload);
  return { payload, sha256: createHash('sha256').update(canonical).digest('hex').slice(0, 16), bytes: Buffer.byteLength(canonical) };
}

export function decodeBinary(b64) { return new Uint8Array(Buffer.from(b64, 'base64')); }