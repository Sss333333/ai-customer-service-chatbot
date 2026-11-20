import "dotenv/config";
import { findRelevantContent } from "../src/rag/embeddingAndRecall.js";
import { execute as executeGetInformation } from "../src/tools/getInformation.js";
import { closeDb } from "../src/rag/index.js";

// ANSI 颜色辅助
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  bgCyan: "\x1b[46m\x1b[30m",
  bgGreen: "\x1b[42m\x1b[30m"
};

function formatSimilarity(sim) {
  const percent = (sim * 100).toFixed(1) + "%";
  if (sim >= 0.45) return `${c.green}${sim.toFixed(3)} (${percent}) [高置信度]${c.reset}`;
  if (sim >= 0.35) return `${c.yellow}${sim.toFixed(3)} (${percent}) [中置信度]${c.reset}`;
  return `${c.dim}${sim.toFixed(3)} (${percent}) [边界匹配]${c.reset}`;
}

/**
 * 格式化输出单条 SOP 知识切片
 */
function printResultCard(item, index) {
  const raw = item.name || "";
  console.log(`\n  ${c.cyan}[#${index + 1}]${c.reset} 相似度: ${formatSimilarity(item.similarity)}`);

  // 尝试按结构化字段解析
  const catMatch = raw.match(/【售后 SOP - ([^】]+)】/);
  const issueMatch = raw.match(/问题\/现象: (.*?)(?=\s*\|)/);
  const docsMatch = raw.match(/需提供资料: (.*?)(?=\s*\|)/);
  const criteriaMatch = raw.match(/判定标准与处理: (.*?)(?=\s*(?:\[人工|\[后续|$))/);
  const laborMatch = raw.match(/\[人工: (.*?)\]/);
  const extraMatch = raw.match(/\[后续: (.*?)\]/);

  if (catMatch || issueMatch) {
    if (catMatch) console.log(`      ${c.bold}品类/类别:${c.reset} ${catMatch[1]}`);
    if (issueMatch) console.log(`      ${c.bold}故障问题:${c.reset} ${issueMatch[1]}`);
    if (criteriaMatch) console.log(`      ${c.bold}判定标准:${c.reset} ${criteriaMatch[1]}`);
    if (docsMatch) console.log(`      ${c.dim}索取资料: ${docsMatch[1]}${c.reset}`);
    if (laborMatch) console.log(`      ${c.dim}人工保修: ${laborMatch[1]}${c.reset}`);
    if (extraMatch) console.log(`      ${c.dim}后续处理: ${extraMatch[1]}${c.reset}`);
  } else {
    // 纯文本展示
    console.log(`      ${raw.replace(/\n/g, "\n      ")}`);
  }
}

/**
 * 运行单次查询测试
 */
async function runSingleTest(query) {
  console.log(`\n${c.bgCyan} 🔍 RAG 向量检索单次测试 ${c.reset}`);
  console.log(`${c.bold}提问内容:${c.reset} "${query}"`);
  console.log(`${c.dim}正在连接 Supabase (OpenRouter 2048-d 向量)...${c.reset}`);

  const start = Date.now();
  const results = await findRelevantContent(query);
  const elapsed = Date.now() - start;

  console.log(`\n⚡ 检索耗时: ${c.bold}${elapsed}ms${c.reset} | 命中切片数: ${c.bold}${results.length}${c.reset}`);

  if (results.length === 0) {
    console.log(`\n${c.yellow}⚠️ 未检索到相似度 > 0.3 的知识切片。建议检查关键词或调低阈值。${c.reset}`);
    return;
  }

  results.forEach((item, idx) => printResultCard(item, idx));
}

/**
 * 预设全量回归测试集（8 个核心场景）
 */
const BENCHMARK_SUITE = [
  {
    title: "镜子安装后崩边 (已安装免赔原则)",
    query: "镜子安装上墙后发现边角磕碰崩了一小块，能申请免费换新吗？",
    expectedKeywords: ["chip", "免赔", "已安装", "不赔"]
  },
  {
    title: "抽屉推拉卡顿 (黑色保护套排查)",
    query: "新装好的浴室柜抽屉拉不动，非常卡，怎么排查？",
    expectedKeywords: ["black sleeve", "黑色保护套", "抽拉不顺"]
  },
  {
    title: "运输破损 72 小时时效",
    query: "昨天刚收到的镜柜，开箱发现玻璃碎了，这属于理赔范围吗？",
    expectedKeywords: ["72", "破损", "采购订单", "运输"]
  },
  {
    title: "马桶冲水水花飞溅",
    query: "买的马桶一冲水水花就溅到外面地上，怎么解决？",
    expectedKeywords: ["toilet", "冲水时水溅出来", "防溅", "配件"]
  },
  {
    title: "人工保修 1 年时效限制",
    query: "买了一年半的龙头一直在漏水，能安排师傅免费上门维修吗？",
    expectedKeywords: ["1 年", "人工", "配件"]
  },
  {
    title: "镜子雷达与触控故障排查",
    query: "镜子触控和手扫雷达都不亮了，怎么测试是开关坏了还是电磁干扰？",
    expectedKeywords: ["雷达", "sensor faulty", "排查", "拔掉插头"]
  },
  {
    title: "抽屉对不齐与互相撞击",
    query: "浴室柜两个抽屉关上时会撞到一起，高低线条对不齐",
    expectedKeywords: ["互相撞击", "线条对不齐", "调节", "偏心螺丝"]
  },
  {
    title: "涉水五金件漏水 Watermark 凭证",
    query: "花洒角阀漏水报障需要拍照提供哪些凭证？",
    expectedKeywords: ["Watermark", "水龙头", "除马桶外所有水件", "leaking"]
  }
];

/**
 * 运行批量评测套件
 */
async function runBatchBenchmark() {
  console.log(`\n${c.bgGreen} 📊 运行售后 RAG 全量场景回归评测 (8 组用例) ${c.reset}\n`);

  let passed = 0;
  let totalTime = 0;

  for (let i = 0; i < BENCHMARK_SUITE.length; i++) {
    const tc = BENCHMARK_SUITE[i];
    const start = Date.now();
    const results = await findRelevantContent(tc.query);
    const duration = Date.now() - start;
    totalTime += duration;

    const topHit = results[0];
    const topText = (topHit?.name || "").toLowerCase();
    const isHit = results.length > 0 && tc.expectedKeywords.some((kw) => topText.includes(kw.toLowerCase()));

    const statusTag = isHit ? `${c.green}[PASS]${c.reset}` : `${c.red}[FAIL]${c.reset}`;
    const topSim = topHit ? `${(topHit.similarity * 100).toFixed(1)}%` : "0%";

    console.log(`${statusTag} 用例 ${i + 1}: ${tc.title}`);
    console.log(`       提问: "${tc.query}"`);
    console.log(`       Top 1 相似度: ${c.bold}${topSim}${c.reset} | 耗时: ${duration}ms | 召回总数: ${results.length}`);

    if (topHit) {
      const summary = topHit.name.slice(0, 100).replace(/\n/g, " ");
      console.log(`       首条摘要: ${c.dim}${summary}...${c.reset}`);
    }

    if (isHit) {
      passed++;
    } else {
      console.log(`       ${c.red}⚠️ 期望包含关键词: [${tc.expectedKeywords.join(", ")}]${c.reset}`);
    }
    console.log("");
  }

  const avgTime = Math.round(totalTime / BENCHMARK_SUITE.length);
  const passRate = ((passed / BENCHMARK_SUITE.length) * 100).toFixed(0);

  console.log("------------------------------------------------------------");
  console.log(
    `🎯 评测总结: 通过率 ${c.bold}${passed}/${BENCHMARK_SUITE.length} (${passRate}%)${c.reset} | 平均检索耗时: ${c.bold}${avgTime}ms${c.reset}`
  );
  console.log("------------------------------------------------------------\n");
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const query = args.join(" ").trim();

  try {
    if (query) {
      await runSingleTest(query);
    } else {
      await runBatchBenchmark();
      console.log(`${c.dim}💡 提示: 你也可以传入自定义问题进行单次测试:${c.reset}`);
      console.log(`   ${c.cyan}npm run rag:test "镜子崩边如何理赔"${c.reset}\n`);
    }
  } catch (err) {
    console.error(`\n${c.red}❌ 检索测试失败:${c.reset}`, err);
    process.exit(1);
  } finally {
    await closeDb();
  }
}

main();
