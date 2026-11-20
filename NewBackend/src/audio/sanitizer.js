const MD_LINK_REGEX = /\[([^\]]*)\]\([^)]*\)/g;
const MD_CODE_REGEX = /`([^`]*)`/g;
const MD_BOLD_ITALIC_REGEX = /\*{1,3}|_{1,3}/g;
const MD_HEADER_REGEX = /^#{1,6}\s+/gm;
const MD_LIST_REGEX = /^\s*[-*+]\s+/gm;
const MD_NUM_LIST_REGEX = /^\s*\d+\.\s+/gm;

// 常用 Emoji 正则
const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}]/gu;

/**
 * 清洗大模型输出文本，提取纯自然口语发音文字
 * @param {string} text 
 * @returns {string}
 */
export function sanitizeTextForTTS(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  let cleaned = text;
  // 1. 过滤 Markdown 语法
  cleaned = cleaned.replace(MD_LINK_REGEX, '$1');
  cleaned = cleaned.replace(MD_CODE_REGEX, '$1');
  cleaned = cleaned.replace(MD_BOLD_ITALIC_REGEX, '');
  cleaned = cleaned.replace(MD_HEADER_REGEX, '');
  cleaned = cleaned.replace(MD_LIST_REGEX, '');
  cleaned = cleaned.replace(MD_NUM_LIST_REGEX, '');

  // 2. 过滤 Emoji
  cleaned = cleaned.replace(EMOJI_REGEX, '');

  return cleaned.trim();
}
