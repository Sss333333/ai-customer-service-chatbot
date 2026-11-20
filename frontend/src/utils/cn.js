import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 Tailwind CSS 类名（参考 ai-sdk-preview-rag-study/lib/utils.ts）
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
