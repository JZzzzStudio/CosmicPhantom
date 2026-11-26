// dates.js — T05：日期语义与来源轴（2026-11-19）
// 依据 dsh-memu-memory：
//   · `MM-DD` 每年复发（生日类）；`YYYY-MM-DD` 只在前一天与当天各响一次
//   · 相对日期（今天/明天/后天/昨天）在**写入时**按场景时间结算成绝对日期
// 纪律：纯函数、零依赖、可单测。不做时区魔法——一律按传入基准日的本地日期计算。

export const SOURCE_KINDS = ["user_said", "assistant_said", "told", "imagined", "inferred", "tool"];

/** 解析日期规格：annual（年复一年）| oneoff（一次性）| none */
export function parseDateSpec(input) {
  const s = String(input || "").trim();
  if (!s) return { kind: "none", value: null };
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const ok = validYmd(+m[1], +m[2], +m[3]);
    return ok ? { kind: "oneoff", value: s } : { kind: "invalid", value: s };
  }
  m = s.match(/^(\d{2})-(\d{2})$/);
  if (m) {
    const ok = validYmd(2024, +m[1], +m[2]); // 闰年做基准，允许 02-29
    return ok ? { kind: "annual", value: s } : { kind: "invalid", value: s };
  }
  return { kind: "none", value: null };
}

function validYmd(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const REL = { "今天": 0, "今日": 0, "明天": 1, "明日": 1, "后天": 2, "大后天": 3, "昨天": -1, "前天": -2 };

/** 把文本里的相对日期按基准时刻结算成绝对日期（YYYY-MM-DD）；无相对词返回 null */
export function resolveRelative(text, baseISO) {
  const s = String(text || "");
  const base = baseISO ? new Date(baseISO) : new Date();
  if (Number.isNaN(base.getTime())) return null;
  for (const [word, delta] of Object.entries(REL)) {
    if (!s.includes(word)) continue;
    const d = new Date(base.getTime());
    d.setDate(d.getDate() + delta);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return null;
}

/** 一次性日期是否该在今天提醒（前一天与当天各响一次） */
export function shouldFireOneoff(spec, todayYmd) {
  const p = parseDateSpec(spec);
  if (p.kind !== "oneoff") return false;
  const t = new Date(todayYmd + "T00:00:00Z");
  const d = new Date(p.value + "T00:00:00Z");
  const diff = Math.round((d - t) / 86400000);
  return diff === 0 || diff === 1;
}

/** 年复一年日期是否命中今天（按 MM-DD 比对） */
export function shouldFireAnnual(spec, todayYmd) {
  const p = parseDateSpec(spec);
  if (p.kind !== "annual") return false;
  return String(todayYmd).slice(5) === p.value;
}