// tests/hybrid-retrieval-test.js - BM25+向量 RRF 融合层（2026-08-13 实装）
// 模型依赖项（onnxruntime/model.onnx）缺失时全部降级路径必须可用；
// 真实模型 e2e 仅在模型存在时跑（缺失=环境豁免，与 watch-d18 同款处理）。
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const REAL = path.join(os.homedir(), ".cosmic-phantom");
const NODE = path.join(REAL, "tools", "node", "node.exe");
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-hybrid-"));
const ROOT = path.join(SB, "root");
const MEM = path.join(ROOT, "memories");
let pass = 0, fail = 0;

function check(name, condition, detail = "") {
  if (condition) { pass += 1; console.log(`  [PASS] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name} -- ${detail}`); }
}
function copy(relative) {
  const target = path.join(ROOT, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(REAL, relative), target);
}
function run(script, args) {
  return spawnSync(NODE, [path.join(ROOT, script), ...args, "--root", ROOT], { encoding: "utf8", timeout: 60000 });
}

(async () => {
  try {
    for (const dir of [MEM, path.join(ROOT, "daily"), path.join(ROOT, "distilled"), path.join(ROOT, "embedding-db", "models")]) fs.mkdirSync(dir, { recursive: true });
    for (const file of ["embed-tokenizer.js", "embed.js", "memory-retrieval.js", "memory-cli.js", "skills-sync.js", "link-graph.js", "package.json", "lib/failopen.js"]) copy(file);
    fs.copyFileSync(path.join(REAL, "embedding-db", "models", "vocab.txt"), path.join(ROOT, "embedding-db", "models", "vocab.txt"));
    fs.writeFileSync(path.join(ROOT, ".watch-paused"), "test\n");

    // ---- HT1 分词器（真实 vocab.txt）----
    console.log("=== 分词器 ===");
    const { loadVocab, basicTokenize, wordpiece, tokenize } = await import(pathToFileURL(path.join(ROOT, "embed-tokenizer.js")).href);
    const vocab = loadVocab(path.join(ROOT, "embedding-db", "models", "vocab.txt"));
    check("HT1a vocab 加载（21128 词）", vocab.size === 21128, `vocab=${vocab.size}`);
    check("HT1b 基础切分 CJK 单字 + 字母串", JSON.stringify(basicTokenize("你好world")) === JSON.stringify(["你", "好", "world"]), JSON.stringify(basicTokenize("你好world")));
    check("HT1c WordPiece 长词贪心切分（本 vocab 实际口径）", JSON.stringify(wordpiece("unaffable", vocab)) === JSON.stringify(["u", "##na", "##ff", "##able"]), JSON.stringify(wordpiece("unaffable", vocab)));
    check("HT1d WordPiece ## 续接正确（qq/zz 在 vocab 中）", JSON.stringify(wordpiece("qqqqqqzzzzzz", vocab)) === JSON.stringify(["qq", "##qq", "##qq", "##zz", "##zz", "##zz"]), JSON.stringify(wordpiece("qqqqqqzzzzzz", vocab)));
    const enc = tokenize("你好", vocab);
    check("HT1e 编码 [CLS]…[SEP]", enc.input_ids[0] === vocab.get("[CLS]") && enc.input_ids[enc.input_ids.length - 1] === vocab.get("[SEP]") && enc.attention_mask.every(x => x === 1), JSON.stringify(enc));

    // ---- HT2 RRF 融合数学 ----
    console.log("=== RRF 融合数学 ===");
    const { rrfFuse, cosine } = await import(pathToFileURL(path.join(ROOT, "memory-retrieval.js")).href);
    const fused = rrfFuse(["a", "b"], ["b", "c"], 60);
    const close = (x, y) => Math.abs(x - y) < 1e-9;
    check("HT2a 单路贡献 1/(k+rank+1)", close(fused.get("a"), 1 / 61) && close(fused.get("c"), 1 / 62), JSON.stringify([...fused]));
    check("HT2b 双路命中求和", close(fused.get("b"), 1 / 61 + 1 / 62), `b=${fused.get("b")}`);
    check("HT3a cosine 正交=0 同向=1", cosine([1, 0], [1, 0]) === 1 && cosine([1, 0], [0, 1]) === 0, "");
    check("HT3b cosine 空向量=0", cosine([], []) === 0 && cosine(null, [1]) === 0, "");

    // ---- HT4 buildStore 指纹增量（stub embedFn，无模型）----
    console.log("=== buildStore 指纹增量 ===");
    const { buildStore } = await import(pathToFileURL(path.join(ROOT, "embed.js")).href);
    fs.writeFileSync(path.join(MEM, "h1.md"), "---\nid: h1\ncreated: 2026-08-13T00:00:00Z\nstatus: 🟢当前\ntype: 事件\ntags: [测试]\nscope: global\n---\n[事件·h1] 第一条内容\n", "utf8");
    fs.writeFileSync(path.join(MEM, "h2.md"), "---\nid: h2\ncreated: 2026-08-13T00:00:00Z\nstatus: 🟢当前\ntype: 事件\ntags: [测试]\nscope: global\n---\n[事件·h2] 第二条内容\n", "utf8");
    let calls = 0;
    const stub = async () => { calls += 1; return [1, 0, 0]; };
    const r1 = await buildStore(MEM, stub);
    check("HT4a 首次全量嵌入", r1.embedded === 2 && r1.kept === 0 && calls === 2, JSON.stringify(r1));
    const r2 = await buildStore(MEM, stub);
    check("HT4b 指纹未变全保留（零嵌入调用）", r2.kept === 2 && r2.embedded === 0 && calls === 2, JSON.stringify(r2));
    fs.writeFileSync(path.join(MEM, "h1.md"), "---\nid: h1\ncreated: 2026-08-13T00:00:00Z\nstatus: 🟢当前\ntype: 事件\ntags: [测试]\nscope: global\n---\n[事件·h1] 第一条内容已修改\n", "utf8");
    const r3 = await buildStore(MEM, stub);
    check("HT4c 仅变更文件重嵌入", r3.kept === 1 && r3.embedded === 1 && calls === 3, JSON.stringify(r3));

    // ---- HT5 模型缺失 → hybrid 返回 null（调用方回退纯 BM25）----
    console.log("=== 降级路径 ===");
    const { retrieveMemoriesHybrid, retrieveMemories } = await import(pathToFileURL(path.join(ROOT, "memory-retrieval.js")).href);
    const h = await retrieveMemoriesHybrid("第一条", { memoryDir: MEM, top: 5 });
    check("HT5a 无模型时 hybrid 返回 null", h === null, String(h));
    const lex = retrieveMemories("第一条", { memoryDir: MEM, top: 5 });
    check("HT5b 纯 BM25 照常可用（单字命中：h1 三字命中排前）", lex.results.length === 2 && lex.results[0].id === "h1", JSON.stringify(lex.results.map(x => x.id)));

    // ---- HT6 CLI：默认自动回退 + --bm25-only 逃生开关 ----
    const cli1 = run("memory-cli.js", ["search", "第一条", "--top", "5"]);
    const j1 = JSON.parse(cli1.stdout);
    check("HT6a CLI 无模型自动回退（无 hybrid 标记）", j1.count === 2 && j1.hybrid !== true, JSON.stringify({ count: j1.count, hybrid: j1.hybrid }));
    const cli2 = run("memory-cli.js", ["search", "第一条", "--top", "5", "--bm25-only"]);
    const j2 = JSON.parse(cli2.stdout);
    check("HT6b --bm25-only 逃生开关", j2.count === 2, JSON.stringify(j2.count));

    // ---- HT7 真实模型 e2e（模型存在才跑；缺失=环境豁免）----
    // 注意：对真源生产资产直接跑（只读 query），沙箱根无模型；
    // 2026-08-13 曾误用沙箱根导致永远拿 error 对象（判定条件查真源、执行却指沙箱，已修）。
    if (fs.existsSync(path.join(REAL, "embedding-db", "models", "model.onnx"))) {
      console.log("=== 真实模型 e2e ===");
      const query = (text) => spawnSync(NODE, [path.join(REAL, "embed.js"), "query", text, "--root", REAL], { encoding: "utf8", timeout: 60000 });
      const q1 = query("测试文本甲");
      const q2 = query("测试文本甲");
      const v1 = JSON.parse(q1.stdout), v2 = JSON.parse(q2.stdout);
      const dot = (v1.vector || []).reduce((s, x, i) => s + x * (v2.vector || [])[i], 0);
      check("HT7a 同文本嵌入可复现（dot≈1）", v1.vector && v1.dim === 512 && dot > 0.99, `dim=${v1.dim} dot=${dot}`);
      const q3 = query("完全无关的另一句话，关于外星飞船和恐龙化石");
      const v3 = JSON.parse(q3.stdout);
      const dot2 = (v1.vector || []).reduce((s, x, i) => s + x * (v3.vector || [])[i], 0);
      check("HT7b 无关文本相似度显著更低", dot2 < dot - 0.1, `dot同=${dot} dot异=${dot2}`);
    } else {
      console.log("  [SKIP] HT7 真实模型 e2e —— model.onnx 缺失（环境豁免；ModelScope 下载就位后自动启用）");
    }
  } catch (e) {
    check("HT0 测试执行无异常", false, String(e && e.stack || e).slice(0, 400));
  } finally {
    fs.rmSync(SB, { recursive: true, force: true });
    check("HT8 沙箱已清理", !fs.existsSync(SB), SB);
    console.log(`\n===== hybrid-retrieval-test: ${pass} passed / ${fail} failed =====`);
    process.exit(fail ? 1 : 0);
  }
})();
