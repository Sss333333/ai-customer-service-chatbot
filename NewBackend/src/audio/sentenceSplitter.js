/**
 * 流式切句工具：把 LLM 逐步增长的文本切成适合 TTS 的短句。
 *
 * 规则：
 *  - 强断点：。！？!?；;…和换行
 *  - 英文句号：后面跟空白才算断句（避免切开 URL、小数、"1." 列表序号）
 *  - 弱断点（，、：以及后跟空格的 , :）：只用于第一句（尽快出声）或超长句
 *  - 有效字符太少的片段（如单独的 "嗯。"）会并入下一句
 */

const HARD_BREAK = new Set(["。", "！", "？", "!", "?", "；", ";", "…", "\n"]);
const SOFT_BREAK = new Set(["，", ",", "、", "：", ":"]);
const CJK_SOFT = new Set(["，", "、", "："]);
const CLOSERS = new Set(['"', "'", "”", "’", "）", ")", "】", "]", "》", "」", "』"]);
const SPEAKABLE = /[\p{L}\p{N}]/u;

const MIN_CHARS = 2;
const FIRST_SOFT_MIN = 8;
const MAX_CHARS = 120;

function speakableLength(s) {
  const m = s.match(/[\p{L}\p{N}]/gu);
  return m ? m.length : 0;
}

/**
 * @param {string} text 当前完整文本（流式增长中）
 * @param {number} startOffset 上次已消费到的位置
 * @param {{ final?: boolean, firstChunk?: boolean }} opts
 * @returns {{ sentences: string[], nextOffset: number }}
 */
export function extractSentences(text, startOffset = 0, { final = false, firstChunk = false } = {}) {
  const sentences = [];
  const len = text.length;
  let segStart = Math.min(Math.max(startOffset, 0), len);

  const emit = (end) => {
    const seg = text.slice(segStart, end).trim();
    if (!SPEAKABLE.test(seg)) {
      segStart = end;
      return;
    }
    if (speakableLength(seg) < MIN_CHARS) return;
    sentences.push(seg);
    segStart = end;
  };

  for (let i = segStart; i < len; i++) {
    const c = text[i];
    const next = text[i + 1];
    let boundary = false;

    if (HARD_BREAK.has(c)) {
      boundary = true;
    } else if (c === ".") {
      if (next === undefined) boundary = final;
      else boundary = /\s/.test(next) && !/\d/.test(text[i - 1] || "");
    } else if (SOFT_BREAK.has(c)) {
      const softOk = CJK_SOFT.has(c) || (next !== undefined && /\s/.test(next));
      if (softOk) {
        const curLen = speakableLength(text.slice(segStart, i));
        const isFirst = firstChunk && sentences.length === 0;
        boundary = (isFirst && curLen >= FIRST_SOFT_MIN) || curLen >= MAX_CHARS;
      }
    } else if (/\s/.test(c)) {
      boundary = speakableLength(text.slice(segStart, i)) >= MAX_CHARS;
    }

    if (!boundary) continue;

    let end = i + 1;
    while (end < len && text[end] !== "\n" && (CLOSERS.has(text[end]) || HARD_BREAK.has(text[end]))) {
      end++;
    }
    emit(end);
    i = end - 1;
  }

  if (final) {
    const rest = text.slice(segStart).trim();
    if (SPEAKABLE.test(rest)) sentences.push(rest);
    segStart = len;
  }

  return { sentences, nextOffset: segStart };
}
