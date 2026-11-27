import React, { useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { cn } from '../utils/cn';

const TOOL_LABELS = {
  getInformation: 'Searching warranty knowledge base…',
  get_product_info: 'Checking live warehouse stock…',
  check_order_status: 'Checking order & dispatch status…',
  check_case_status: 'Checking support case status…',
  start_warranty_claim: 'Logging support case in NetSuite…',
};

function CopyInlineButton({ value, label }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;

  const handleCopy = () => {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[13px] font-medium text-[#18181B] transition-colors hover:bg-[#F4F3EF]"
      title={`Copy ${label || value}`}
    >
      <span>{value}</span>
      {copied ? (
        <Check className="size-3 text-emerald-600" />
      ) : (
        <Copy className="size-3 text-[#8C8881]" />
      )}
    </button>
  );
}

function formatStateStock(qty) {
  const n = Number(qty) || 0;
  if (n <= 0) return { text: 'Out of stock', muted: true };
  if (n <= 5) return { text: `${n} low stock`, muted: false };
  return { text: `${n} in stock`, muted: false };
}

/**
 * Minimalist hairline structured data cards for NetSuite ERP tool outputs
 */
export function ToolResultCard({ toolName, state, output }) {
  const isRunning = state !== 'output-available' && state !== 'output-error';

  if (isRunning) {
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-[#E7E5E4] bg-white px-3.5 py-1.5 text-[12.5px] text-[#78716C] shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        <Loader2 className="size-3.5 animate-spin text-[#18181B]" />
        <span>{TOOL_LABELS[toolName] || `Running ${toolName}…`}</span>
      </div>
    );
  }

  if (state === 'output-error' || !output || output.error) {
    return null;
  }

  // 1. Order & Dispatch Card (check_order_status)
  if (toolName === 'check_order_status' && output.order_no) {
    const primaryShipment = Array.isArray(output.shipments) ? output.shipments[0] : null;
    const cleanStatus = String(output.status || '').replace(/^Sales Order:\s*/i, '') || 'Processing';
    const carrier = primaryShipment?.carrier;
    const trackingNo =
      primaryShipment?.tracking_no &&
      primaryShipment.tracking_no !== 'No tracking number on file'
        ? primaryShipment.tracking_no
        : null;

    return (
      <div className="w-full overflow-hidden rounded-2xl border border-[#E5E4DF] bg-white shadow-[0_1px_4px_rgba(0,0,0,0.03)]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-[14px] text-[#18181B]">
          <span className="font-semibold">Order {output.order_no}</span>
          <span className="text-[#A8A29E]">·</span>
          <span className="text-[#44403C]">
            {carrier ? `Shipped via ${carrier}` : cleanStatus}
          </span>
          {trackingNo && (
            <>
              <span className="text-[#A8A29E]">·</span>
              <span className="inline-flex items-center gap-1 text-[#44403C]">
                <span>Tracking</span>
                <CopyInlineButton value={trackingNo} label="tracking number" />
              </span>
            </>
          )}
        </div>

        {Array.isArray(output.items) && output.items.length > 0 && (
          <div className="border-t border-[#ECEAE4] bg-[#FAF9F7] px-4 py-2.5 text-[13px] text-[#57534E]">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {output.items.slice(0, 4).map((item, idx) => (
                <span key={item.sku || idx} className="inline-flex items-center gap-1.5">
                  <span className="font-medium text-[#18181B]">{item.sku}</span>
                  <span className="text-[#78716C]">
                    ({item.shipped_qty ?? 0}/{item.qty ?? 0} shipped)
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // 2. Product & Live State Stock Card (get_product_info)
  if (toolName === 'get_product_info' && output.exists && output.sku) {
    const stock = output.stock_by_state || {};
    const nsw = formatStateStock(stock.nsw);
    const qld = formatStateStock(stock.qld);
    const vic = formatStateStock(stock.vic);

    return (
      <div className="w-full overflow-hidden rounded-2xl border border-[#E5E4DF] bg-white shadow-[0_1px_4px_rgba(0,0,0,0.03)]">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
          <div className="min-w-0">
            <span className="font-semibold text-[14px] text-[#18181B]">{output.sku}</span>
            {output.name && (
              <span className="ml-2 text-[13.5px] text-[#57534E]">{output.name}</span>
            )}
          </div>
          {output.rrp && (
            <span className="text-[13.5px] font-semibold text-[#18181B]">
              {output.rrp} <span className="font-normal text-[#8C8881]">RRP</span>
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-[#ECEAE4] px-4 py-2.5 text-[13.5px]">
          <span>
            <strong className="font-semibold text-[#18181B]">NSW:</strong>{' '}
            <span className={cn(nsw.muted ? 'text-[#8C8881]' : 'text-[#44403C]')}>
              {nsw.text}
            </span>
          </span>
          <span className="text-[#C7C3BC]">·</span>
          <span>
            <strong className="font-semibold text-[#18181B]">QLD:</strong>{' '}
            <span className={cn(qld.muted ? 'text-[#8C8881]' : 'text-[#44403C]')}>
              {qld.text}
            </span>
          </span>
          <span className="text-[#C7C3BC]">·</span>
          <span>
            <strong className="font-semibold text-[#18181B]">VIC:</strong>{' '}
            <span className={cn(vic.muted ? 'text-[#8C8881]' : 'text-[#44403C]')}>
              {vic.text}
            </span>
          </span>
        </div>
      </div>
    );
  }

  // 3. Support Case Created / Case Status Lookup (start_warranty_claim | check_case_status)
  const caseNo = output.case_number || output.case_no;
  if (
    (toolName === 'start_warranty_claim' || toolName === 'check_case_status') &&
    caseNo
  ) {
    return (
      <div className="w-full overflow-hidden rounded-2xl border border-[#E5E4DF] bg-white shadow-[0_1px_4px_rgba(0,0,0,0.03)]">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-[14px]">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-emerald-500" />
            <span className="font-semibold text-[#18181B]">Support Case</span>
            <CopyInlineButton value={caseNo} label="case number" />
          </div>
          <span className="rounded-full border border-[#E5E4DF] bg-[#FAF9F7] px-2.5 py-0.5 text-[12px] font-medium text-[#44403C]">
            {output.status || 'Logged'}
          </span>
        </div>
        {(output.issue ||
          (Array.isArray(output.outstanding_items) &&
            output.outstanding_items.length > 0)) && (
          <div className="border-t border-[#ECEAE4] px-4 py-2.5 text-[13px] text-[#57534E]">
            {output.issue && <div>{output.issue}</div>}
            {Array.isArray(output.outstanding_items) &&
              output.outstanding_items.length > 0 && (
                <div className="mt-1 text-[#78716C]">
                  Pending: {output.outstanding_items.join(', ')}
                </div>
              )}
          </div>
        )}
      </div>
    );
  }

  return null;
}
