#!/usr/bin/env node
/**
 * embed.js — 本地向量层（2026-08-13 实装）
 *
 * 命令：
 *   embed build [--root R]     批量向量化 memories → embedding-db/vectors.json（文件指纹增量，缓存每次重建）
 *   embed query <text> [--root R]   查询向量（调试用，输出 JSON）
 *   embed fetch [--root R]     检查模型资产并打印获取指引
 *
 * 模型资产（<memoryDir 同级的 embedding-db>/models/）：model.onnx + vocab.txt。
 * 缺失时一切调用显式报"降级 BM25"，绝不 crash（fail-open，零依赖契约：onnxruntime 为可选增强层）。
 *
 * 模型获取路径（2026-08-13 起首选直下，免 python/免转换）：
 *   ① ModelScope 官方镜像 Xenova/bge-small-zh-v1.5 仓：curl -L 下载 onnx/model.onnx
 *      （现成 transformers.js 转好的 fp32，vocab.txt 与真源现有资产同哈希）→ 放入即激活
 *   ② 备用：有网+有 python 机器跑 tools/export-bge-small-zh-onnx.py 转换
 *
 * 纪律：所有可复用函数显式接收 memoryDir（路径从其派生），绝不从 process.argv 猜根——
 * 被 import 时 argv 不可靠，会污染生产目录（2026-08-13 测试阶段实测踩坑，已修）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadVocab, tokenize } from "./embed-tokenizer.js";
import { loadMemoryDocs } from "./memory-retrieval.js";

// 仅当本文件是入口时才跑 CLI（被 import 时绝不能向 stdout 输出任何东西）
const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); }

// embedding-db 与 memories 同级：<memoryDir>/../embedding-db
export function embedDirFromMemoryDir(memoryDir) {
  return join(dirname(resolve(String(memoryDir))), "embedding-db");
}

export function modelAvailable(memoryDir) {
  const d = embedDirFromMemoryDir(memoryDir);
  return existsSync(join(d, "models", "model.onnx")) && existsSync(join(d, "models", "vocab.txt"));
}

// ---- 会话缓存（进程内按模型目录只加载一次）----
const sessionCache = new Map();
const fileHashCache = new Map();

function hashFile(path) {
  try {
    const st = statSync(path);
    const hit = fileHashCache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.sha256;
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    fileHashCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, sha256 });
    return sha256;
  } catch { return null; }
}

/** 模型身份必须随向量库保存；否则换模型后会复用旧向量。 */
export function modelDescriptor(memoryDir) {
  const d = embedDirFromMemoryDir(memoryDir);
  const modelPath = join(d, "models", "model.onnx");
  const vocabPath = join(d, "models", "vocab.txt");
  const modelPresent = existsSync(modelPath);
  return {
    id: process.env.CP_EMBED_MODEL_ID || (modelPresent ? "bge-small-zh-v1.5" : "injected"),
    modelSha256: hashFile(modelPath),
    vocabSha256: hashFile(vocabPath),
    modelPresent,
  };
}

export function cardsDigest(docs) {
  const items = (docs || []).map(doc => ({
    id: doc.meta?.id || basename(doc.path),
    fp: createHash("sha256").update(String(doc.raw ?? "")).digest("hex"),
  })).sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

export function vectorStoreCompatible(memoryDir, store) {
  if (!store || store.schemaVersion !== 2 || !store.modelMeta) return { ok: false, reason: "missing-metadata" };
  const expected = modelDescriptor(memoryDir);
  const actual = store.modelMeta;
  if (actual.id !== expected.id || actual.modelSha256 !== expected.modelSha256 || actual.vocabSha256 !== expected.vocabSha256) {
    return { ok: false, reason: "model-mismatch", expected, actual };
  }
  return { ok: true, expected, actual };
}

async function getSession(memoryDir) {
  const dir = embedDirFromMemoryDir(memoryDir);
  if (!modelAvailable(memoryDir)) return null;
  if (sessionCache.has(dir)) return sessionCache.get(dir);
  let ort;
  try { ({ default: ort } = await import("onnxruntime-node")); } catch { return null; }
  const session = await ort.InferenceSession.create(join(dir, "models", "model.onnx"), { executionProviders: ["cpu"] });
  const vocab = loadVocab(join(dir, "models", "vocab.txt"));
  const entry = { session, vocab, ort };
  sessionCache.set(dir, entry);
  return entry;
}

/**
 * 单条文本 → L2 归一化向量（mean pooling over attention_mask）。
 * 模型/onnxruntime 缺失、任何异常 → null（fail-open）。
 */
export async function embedText(text, memoryDir) {
  try {
    const entry = await getSession(memoryDir);
    if (!entry) return null;
    const tok = tokenize(text, entry.vocab);
    // BERT 系输入均为 int64 张量；BigInt64Array.from 不能直接吃数字数组（规范抛错），须先 map(BigInt)
    const L = tok.input_ids.length;
    const int64 = (arr) => new entry.ort.Tensor("int64", BigInt64Array.from(arr.map(v => BigInt(v))), [1, L]);
    const feed = {};
    for (const name of entry.session.inputNames) {
      if (name === "input_ids") feed[name] = int64(tok.input_ids);
      else if (name === "attention_mask") feed[name] = int64(tok.attention_mask);
      else if (name === "token_type_ids") feed[name] = int64(tok.input_ids.map(() => 0));
      else feed[name] = int64(new Array(L).fill(0));
    }
    const results = await entry.session.run(feed);
    const hidden = results[entry.session.outputNames[0]]; // [1, T, D]
    const { data: d, dims } = hidden;
    const T = dims.length === 3 ? dims[1] : d.length;
    const D = dims.length === 3 ? dims[2] : 1;
    // mean pooling + L2（sentence-transformers 对 BGE 的标准后处理）
    let normSum = 0;
    const vec = new Array(D).fill(0);
    for (let t = 0; t < T; t += 1) {
      const w = tok.attention_mask[t] ?? 1;
      if (!w) continue;
      normSum += w;
      for (let k = 0; k < D; k += 1) vec[k] += d[t * D + k] * w;
    }
    if (normSum <= 0) return null;
    let l2 = 0;
    for (let k = 0; k < D; k += 1) { vec[k] /= normSum; l2 += vec[k] * vec[k]; }
    l2 = Math.sqrt(l2) || 1;
    for (let k = 0; k < D; k += 1) vec[k] /= l2;
    return vec;
  } catch { return null; }
}

// ---- 向量库（embedding-db/vectors.json）----
export function storePathFor(memoryDir) {
  return join(embedDirFromMemoryDir(memoryDir), "vectors.json");
}

export function loadVectorStore(memoryDir) {
  try {
    const p = storePathFor(memoryDir);
    if (!existsSync(p)) return null;
    const store = JSON.parse(readFileSync(p, "utf8"));
    if (store && store.entries && typeof store.entries === "object") return store;
    return null;
  } catch { return null; }
}

export function fingerprint(raw) {
  return createHash("sha256").update(String(raw ?? "")).digest("hex").slice(0, 16);
}

/**
 * 指纹增量重建：embedFn(doc) → 向量；指纹未变的条目直接复用。
 * embedFn 可注入（测试用 stub，规避真实模型）。
 */
export async function buildStore(memoryDir, embedFn, options = {}) {
  const docs = loadMemoryDocs(memoryDir);
  const modelMeta = options.modelMeta || modelDescriptor(memoryDir);
  const existing = loadVectorStore(memoryDir) || {};
  const reusable = existing.schemaVersion === 2 && existing.modelMeta
    && existing.modelMeta.id === modelMeta.id
    && existing.modelMeta.modelSha256 === modelMeta.modelSha256
    && existing.modelMeta.vocabSha256 === modelMeta.vocabSha256;
  let kept = 0, embedded = 0;
  const entries = {};
  for (const doc of docs) {
    const id = doc.meta?.id || basename(doc.path);
    const fp = fingerprint(doc.raw);
    const prev = reusable ? existing.entries?.[id] : null;
    if (prev && prev.fp === fp && Array.isArray(prev.v) && prev.v.length) { entries[id] = prev; kept += 1; continue; }
    const v = await embedFn(doc);
    if (!v) continue;   // 单条失败继续，但结果明确标 partial
    entries[id] = { fp, v };
    embedded += 1;
  }
  const firstVec = Object.values(entries).find(e => e.v);
  // 记录生成向量库的运行环境（票 31：跨机复现要能对上是哪个 onnxruntime 跑的）
  let runtimeVersion = null;
  try { runtimeVersion = JSON.parse(readFileSync(new URL("./node_modules/onnxruntime-node/package.json", import.meta.url), "utf8")).version; } catch {}
  const missing = docs.length - kept - embedded;
  const store = {
    schemaVersion: 2,
    model: modelMeta.id,
    modelMeta,
    cardsDigest: cardsDigest(docs),
    coverage: { total: docs.length, embedded: Object.keys(entries).length, missing },
    dim: firstVec ? firstVec.v.length : (reusable ? existing.dim : 0),
    updatedAt: new Date().toISOString(),
    runtimeVersion: runtimeVersion || existing.runtimeVersion || null,
    entries,
  };
  const dir = embedDirFromMemoryDir(memoryDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(storePathFor(memoryDir), JSON.stringify(store));
  return { total: docs.length, kept, embedded, missing, ready: missing === 0 && Object.keys(entries).length === docs.length, reusedModel: reusable };
}

// ---- CLI（仅入口执行）----
const rootArgIndex = process.argv.indexOf("--root");
const ROOT = (rootArgIndex >= 0 && process.argv[rootArgIndex + 1]) || join(homedir(), ".cosmic-phantom");
const MEM_DIR = join(ROOT, "memories");
const cmd = process.argv[2];
const arg3 = process.argv[3];

if (isMain && cmd === "query" && arg3) {
  embedText(arg3, MEM_DIR).then(v => { if (!v) { console.error(JSON.stringify({ error: "模型缺失或推理失败（当前降级纯 BM25 检索）", hint: "检查 embedding-db/models/model.onnx 与 node_modules/onnxruntime-node" })); process.exitCode = 2; return; } out({ model: "bge-small-zh-v1.5", dim: v.length, vector: v.map(x => +x.toFixed(6)) }); });
} else if (isMain && cmd === "build") {
  if (!modelAvailable(MEM_DIR)) {
    out({ error: "模型资产缺失（embedding-db/models/model.onnx 不存在）。获取路径：curl -L 下载 ModelScope 镜像 Xenova/bge-small-zh-v1.5 仓的 onnx/model.onnx 放进该目录（备用：有网机器跑 tools/export-bge-small-zh-onnx.py）；未到位前检索自动降级纯 BM25。" });
  } else {
    buildStore(MEM_DIR, async (doc) => embedText(doc.body, MEM_DIR)).then(r => out({ built: true, ...r, store: storePathFor(MEM_DIR) }))
      .catch(e => out({ built: false, error: String(e.message || e) }));
  }
} else if (isMain && cmd === "fetch") {
  const dir = embedDirFromMemoryDir(MEM_DIR);
  const present = {
    "model.onnx": existsSync(join(dir, "models", "model.onnx")),
    "vocab.txt": existsSync(join(dir, "models", "vocab.txt")),
    "config.json": existsSync(join(dir, "models", "config.json")),
    store: existsSync(storePathFor(MEM_DIR)) ? statSync(storePathFor(MEM_DIR)).size : 0,
  };
  out({
    present,
    active: modelAvailable(MEM_DIR),
    guidance: modelAvailable(MEM_DIR)
      ? "模型就绪：embed build 后检索自动启用混合排序（BM25+向量 RRF）"
      : "模型未就绪（检索自动降级纯 BM25）。获取路径：curl -L 下载 ModelScope 镜像 Xenova/bge-small-zh-v1.5 仓的 onnx/model.onnx 放进 embedding-db/models/（备用：有网机器跑 tools/export-bge-small-zh-onnx.py 转换）。",
  });
} else if (isMain) {
  out({ usage: "embed build|query <text>|fetch [--root R]" });
}
