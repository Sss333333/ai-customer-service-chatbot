import { runSuiteQL } from "../services/netsuite.js";

const _cache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60s cache

const SHIP_SQL = `SELECT so.tranid AS order_no, BUILTIN.DF(so.status) AS order_status,
  f.tranid AS fulfilment_ref, BUILTIN.DF(f.status) AS fulfilment_status,
  f.trandate AS shipped_date, BUILTIN.DF(f.shipmethod) AS carrier,
  f.trackingnumbers AS tracking_no
FROM transaction so
LEFT JOIN NextTransactionLink l ON l.previousdoc = so.id
LEFT JOIN transaction f ON f.id = l.nextdoc AND f.type = 'ItemShip'
WHERE so.type = 'SalesOrd' AND so.tranid = '{order_no}'
ORDER BY f.trandate`;

const LINES_SQL = `SELECT
  tl.linesequencenumber            AS line_no,
  i.itemid                         AS sku,
  i.displayname                    AS product_name,
  ABS(tl.quantity)                 AS qty,
  ABS(NVL(tl.quantityshiprecv, 0)) AS qty_shipped,
  tl.itemtype                      AS line_type
FROM transaction t
JOIN transactionLine tl ON tl.transaction = t.id
LEFT JOIN item i        ON i.id = tl.item
WHERE t.type = 'SalesOrd'
  AND t.tranid = '{order_no}'
  AND tl.mainline = 'F'
  AND tl.taxline = 'F'
  AND tl.itemtype != 'ShipItem'
  AND i.itemid IS NOT NULL
ORDER BY tl.linesequencenumber`;

/**
 * Tool Definition Schema: check_order_status
 */
export const schema = {
  name: "check_order_status",
  description: "Check the delivery, fulfillment, and item processing status of a sales order for trade/retail customers directly from NetSuite ERP.",
  input_schema: {
    type: "object",
    properties: {
      order_number: {
        type: "string",
        description: "The customer order or sales order number (e.g. SO-10001, PO-9876)"
      },
      account_id: {
        type: "string",
        description: "Trade account ID or business name (optional)"
      }
    },
    required: ["order_number"]
  }
};

/**
 * Tool Implementation
 */
export async function execute({ order_number, order_no, order, account_id }) {
  const cleanOrder = String(order_number || order_no || order || "").trim().toUpperCase();

  if (!cleanOrder || !/^[A-Z0-9\-_]{1,30}$/.test(cleanOrder)) {
    return { error: "invalid order number" };
  }

  // Check in-memory cache
  const cached = _cache.get(cleanOrder);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  let ships, lines;
  try {
    const shipQuery = SHIP_SQL.replace("{order_no}", cleanOrder);
    const linesQuery = LINES_SQL.replace("{order_no}", cleanOrder);

    [ships, lines] = await Promise.all([
      runSuiteQL(shipQuery),
      runSuiteQL(linesQuery)
    ]);
  } catch (err) {
    console.error(`[checkOrder] SuiteQL error for order ${cleanOrder}:`, err.message);
    return { error: "NetSuite 暂时无法访问" };
  }

  if (!ships || ships.length === 0) {
    return { error: `未找到订单 ${cleanOrder}` };
  }

  const rawStatus = ships[0]?.order_status || "";
  const status = rawStatus.includes(" : ") ? rawStatus.split(" : ").pop() : rawStatus;

  const items = (lines || []).map(l => ({
    sku: l.sku,
    name: l.product_name,
    qty: parseInt(l.qty || 0, 10),
    shipped_qty: parseInt(l.qty_shipped || 0, 10),
    is_set: l.line_type === "Set"
  }));

  const shipments = ships
    .filter(s => s.fulfilment_ref)
    .map(s => ({
      fulfilment_ref: s.fulfilment_ref,
      status: (s.fulfilment_status || "").includes(" : ")
        ? s.fulfilment_status.split(" : ").pop()
        : (s.fulfilment_status || ""),
      shipped_date: s.shipped_date || "",
      carrier: s.carrier || "",
      tracking_no: s.tracking_no || "No tracking number on file"
    }));

  const result = {
    order_no: cleanOrder,
    status: `Sales Order: ${status}`,
    items,
    shipments
  };

  _cache.set(cleanOrder, { data: result, ts: Date.now() });

  return result;
}
