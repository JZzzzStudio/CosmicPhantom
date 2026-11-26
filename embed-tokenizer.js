/**
 * embed-tokenizer.js — 纯 JS BERT WordPiece 分词器（2026-08-13 实装）
 *
 * bge-small-zh 用 BERT tokenizer（vocab.txt 驱动）。零第三方依赖：
 * - 基础切分：CJK 单字成 token；连续字母数字为一个 word；其余字符为分隔符
 * - WordPiece：单词内最长前缀匹配，非首子词加 "##"；整词无匹配 → [UNK]
 * 行为对齐 transformers 的 BertTokenizer（do_lower_case=true，中文场景足够）。
 */
import { readFileSync } from "node:fs";

export function loadVocab(vocabPath) {
  const raw = readFileSync(vocabPath, "utf8").replace(/^\uFEFF/, "");
  const vocab = new Map();
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const token = lines[i];
    if (token) vocab.set(token, i);
  }
  return vocab;
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const ALNUM = /[a-z0-9]/;

// 基础切分：小写 + CJK 单字 / 字母数字串
export function basicTokenize(text) {
  const s = String(text ?? "").toLowerCase();
  const out = [];
  let buf = "";
  const flush = () => { if (buf) { out.push(buf); buf = ""; } };
  for (const ch of s) {
    if (CJK.test(ch)) { flush(); out.push(ch); }
    else if (ALNUM.test(ch)) { buf += ch; }
    else flush();
  }
  flush();
  return out;
}

// WordPiece 最长匹配（## 续接）
export function wordpiece(word, vocab, maxInputCharsPerWord = 100) {
  const chars = Array.from(word);
  if (!chars.length) return [];
  if (chars.length > maxInputCharsPerWord) return ["[UNK]"];
  const subs = [];
  let start = 0;
  while (start < chars.length) {
    let end = chars.length;
    let cur = null;
    while (start < end) {
      const piece = (start > 0 ? "##" : "") + chars.slice(start, end).join("");
      if (vocab.has(piece)) { cur = piece; break; }
      end -= 1;
    }
    if (cur === null) return ["[UNK]"];
    subs.push(cur);
    start = end;
  }
  return subs;
}

// 完整编码：[CLS] tokens [SEP] → { input_ids, attention_mask }（截断 maxLen）
export function tokenize(text, vocab, maxLen = 512) {
  const pieces = ["[CLS]"];
  for (const word of basicTokenize(text)) pieces.push(...wordpiece(word, vocab));
  pieces.push("[SEP]");
  if (pieces.length > maxLen) pieces.length = maxLen;
  const inputIds = pieces.map(p => vocab.has(p) ? vocab.get(p) : (vocab.get("[UNK]") ?? 100));
  return {
    input_ids: inputIds,
    attention_mask: inputIds.map(() => 1),
  };
}
