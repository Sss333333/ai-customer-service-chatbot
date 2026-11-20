import dotenv from "dotenv";
dotenv.config();

import { runSuiteQL } from "../src/services/netsuite.js";

const LOW_STOCK_THRESHOLD = 5;
const _cache = new Map();
const CACHE_TTL_MS = 60 * 1000;

const PRODUCT_SQL = `
SELECT
  i.itemid AS sku, i.displayname AS name,
  BUILTIN.DF(i.cseg_custom_brand) AS brand,
  BUILTIN.DF(i.class) AS class,
  BUILTIN.DF(i.custitem_custom_sub_category) AS sub_category,
  i.custitem_custom_part_colour AS colour,
  i.custitem_custom_part_side AS style,
  i.custitem_packship_itm_pack_length AS len_mm,
  i.custitem_packship_itm_pack_width  AS wid_mm,
  i.custitem_packship_itm_pack_height AS hgt_mm,
  i.custitem_custom_item_rrp AS rrp,
  NVL(i.custitem_custom_nsw_available, 0) AS nsw_qty,
  NVL(i.custitem_custom_qld_available, 0) AS qld_qty,
  NVL(i.custitem_custom_vic_available, 0) AS vic_qty,
  CASE WHEN i.isinactive = 'T' THEN 'Inactive'
       WHEN i.custitem_custom_discontinued = 'T' THEN 'Discontinued'
       ELSE 'Current' END AS status
FROM item i
WHERE UPPER(i.itemid) = '{sku}'
`;

function getStockLabel(qty) {
  const q = Number(qty) || 0;
  if (q <= 0) return "out of stock";
  return q <= LOW_STOCK_THRESHOLD ? "low stock" : "in stock";
}

function getOverallStock(nsw, qld, vic) {
  const total = (Number(nsw) || 0) + (Number(qld) || 0) + (Number(vic) || 0);
  const label = getStockLabel(total);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export async function getProductInfo(input) {
  const sku = String(input || "").trim().toUpperCase();
  if (!/^[A-Z0-9\-_.]{1,60}$/.test(sku)) {
    return { error: "invalid sku" };
  }

  const hit = _cache.get(sku);
  if (hit && Date.now() - hit.timestamp < CACHE_TTL_MS) {
    return hit.data;
  }

  let rows;
  try {
    const formattedSql = PRODUCT_SQL.replace("{sku}", sku.replace(/'/g, "''"));
    rows = await runSuiteQL(formattedSql);
  } catch (err) {
    return { error: `NetSuite 查询异常: ${err.message}` };
  }

  if (!rows || rows.length === 0) {
    return { error: `未找到产品 ${sku}` };
  }

  const p = rows[0];
  const nsw = parseInt(p.nsw_qty, 10) || 0;
  const qld = parseInt(p.qld_qty, 10) || 0;
  const vic = parseInt(p.vic_qty, 10) || 0;

  const classCategory = [p.class, p.sub_category].filter(Boolean).join(" — ") || null;
  const dimensions = (p.len_mm && p.wid_mm && p.hgt_mm)
    ? `${p.len_mm}mm (L) x ${p.wid_mm}mm (W) x ${p.hgt_mm}mm (H)`
    : null;
  const rrpFormatted = (p.rrp !== null && p.rrp !== undefined && p.rrp !== "")
    ? `$${parseFloat(p.rrp).toLocaleString("en-AU", { maximumFractionDigits: 0 })}`
    : null;

  const result = {
    exists: true,
    sku: p.sku,
    name: p.name,
    brand: p.brand || null,
    class_category: classCategory,
    colour: p.colour || null,
    style: p.style || null,
    packed_dimensions: dimensions,
    rrp: rrpFormatted,
    availability: `${getOverallStock(nsw, qld, vic)} overall (NSW: ${getStockLabel(nsw)}; QLD: ${getStockLabel(qld)}; VIC: ${getStockLabel(vic)})`,
    status: p.status,
    stock_by_state: { nsw, qld, vic }
  };

  _cache.set(sku, { timestamp: Date.now(), data: result });
  return result;
}

async function run() {
  console.log("=== Testing getProductInfo with 109.795.00.1 ===");
  const res1 = await getProductInfo("109.795.00.1");
  console.log(JSON.stringify(res1, null, 2));

  console.log("\n=== Testing getProductInfo with IAWFPRLVA ===");
  const res2 = await getProductInfo("IAWFPRLVA");
  console.log(JSON.stringify(res2, null, 2));

  console.log("\n=== Testing getProductInfo with invalid SKU ===");
  const res3 = await getProductInfo("INVALID_SKU_99999");
  console.log(JSON.stringify(res3, null, 2));
}

run();
