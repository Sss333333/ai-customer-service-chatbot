import React, { useState } from 'react';
import {
  Check,
  Copy,
  Database,
  Loader2,
  ChevronRight,
} from 'lucide-react';
import { cn } from '../utils/cn';

const RUNNING_LABELS = {
  getInformation: 'Querying knowledge base',
  get_product_info: 'Querying NetSuite stock',
  check_order_status: 'Querying NetSuite order',
  check_case_status: 'Querying NetSuite case',
  start_warranty_claim: 'Logging NetSuite support case',
};

const COMPLETED_TITLES = {
  getInformation: 'Knowledge Base (pgvector)',
  get_product_info: 'NetSuite Stock Lookup',
  check_order_status: 'NetSuite Order Lookup',
  check_case_status: 'NetSuite Case Lookup',
  start_warranty_claim: 'NetSuite Case Creation',
};

function extractTargetLabel(toolName, input, output) {
  const inp = input || {};
  if (toolName === 'check_order_status') {
    return output?.order_no || inp.order_number || inp.order_no || '';
  }
  if (toolName === 'get_product_info') {
    return output?.sku || inp.query || inp.sku || '';
  }
  if (toolName === 'check_case_status') {
    return output?.case_no || inp.case_no || '';
  }
  if (toolName === 'start_warranty_claim') {
    return output?.case_number || output?.case_no || inp.case_no || inp.product_code || '';
  }
  if (toolName === 'getInformation') {
    const q = inp.question || (Array.isArray(inp.similarQuestions) ? inp.similarQuestions[0] : '');
    if (!q) return '';
    return q.length > 34 ? `${q.slice(0, 34)}…` : q;
  }
  return '';
}

function summarizeOutcome(toolName, state, output) {
  if (state === 'output-error') {
    return { badge: 'Error', tone: 'warn', detail: 'Tool execution failed.' };
  }
  if (!output) {
    return { badge: 'Completed', tone: 'muted', detail: 'No data returned.' };
  }
  if (output.error) {
    const isNotFound = /not found|no case|未找到/i.test(String(output.error));
    return {
      badge: isNotFound ? 'No match' : 'Unavailable',
      tone: isNotFound ? 'muted' : 'warn',
      detail: String(output.error),
    };
  }
  if (toolName === 'getInformation' && Array.isArray(output)) {
    const count = output.length;
    return {
      badge: count > 0 ? `${count} ${count === 1 ? 'match' : 'matches'}` : '0 matches',
      tone: count > 0 ? 'ok' : 'muted',
      detail:
        count > 0
          ? output
              .slice(0, 3)
              .map((item, i) => `${i + 1}. ${String(item?.name || '').slice(0, 180)}`)
              .join('\n\n')
          : 'No matching SOP entries found in vector database.',
    };
  }
  if (toolName === 'get_product_info') {
    return output.exists
      ? {
          badge: 'Verified',
          tone: 'ok',
          detail: `${output.sku} — ${output.availability || output.status || 'Found'}`,
        }
      : { badge: 'No match', tone: 'muted', detail: output.error || 'SKU not found.' };
  }
  if (toolName === 'check_order_status' && output.order_no) {
    return {
      badge: 'Verified',
      tone: 'ok',
      detail: `${output.order_no} — ${output.status || 'Retrieved'}`,
    };
  }
  if (toolName === 'start_warranty_claim' || toolName === 'check_case_status') {
    const cNo = output.case_number || output.case_no;
    if (output.success === false) {
      return { badge: 'Needs info', tone: 'warn', detail: output.error || 'Pending details.' };
    }
    return {
      badge: cNo || 'Verified',
      tone: 'ok',
      detail: output.message || `${cNo || 'Case'} — ${output.status || 'Retrieved'}`,
    };
  }
  return { badge: 'Completed', tone: 'ok', detail: JSON.stringify(output, null, 2) };
}

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
 * Persistent Database / NetSuite ERP Tool Trace Pill + Structured Rich Cards
 */
export function ToolResultCard({ toolName, state, input, output }) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = state !== 'output-available' && state !== 'output-error';
  const targetLabel = extractTargetLabel(toolName, input, output);

  if (isRunning) {
    return (
      <div className="inline-flex max-w-full items-center gap-2 rounded-xl border border-[#E5E4DF] bg-white px-3.5 py-2 text-[12.5px] text-[#18181B] shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
        <Loader2 className="size-3.5 flex-none animate-spin text-[#18181B]" />
        <span className="font-medium">
          {RUNNING_LABELS[toolName] || `Running ${toolName}`}
        </span>
        {targetLabel && (
          <>
            <span className="text-[#C7C3BC]">·</span>
            <span className="truncate font-mono text-[12px] text-[#57534E]">
              {targetLabel}
            </span>
          </>
        )}
        <span className="animate-pulse text-[#8C8881]">…</span>
      </div>
    );
  }

  const summary = summarizeOutcome(toolName, state, output);
  const title = COMPLETED_TITLES[toolName] || toolName;

  return (
    <div className="flex w-full flex-col items-start gap-2">
      {/* Persistent Expandable Database / ERP Query Trace Pill */}
      <div className="max-w-full rounded-xl border border-[#ECEAE4] bg-[#F8F7F4] text-xs text-[#57534E] transition-all">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex max-w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left select-none hover:text-[#18181B]"
        >
          <Database className="size-3.5 flex-none text-[#57534E]" />
          <span className="font-medium text-[#27272A]">{title}</span>
          {targetLabel && (
            <>
              <span className="text-[#C7C3BC]">·</span>
              <span className="max-w-[180px] truncate font-mono text-[11.5px] text-[#57534E]">
                {targetLabel}
              </span>
            </>
          )}
          <span className="text-[#C7C3BC]">·</span>
          <span className="inline-flex items-center gap-1.5 font-medium">
            <span
              className={cn(
                'size-1.5 rounded-full',
                summary.tone === 'ok'
                  ? 'bg-emerald-500'
                  : summary.tone === 'warn'
                    ? 'bg-amber-500'
                    : 'bg-[#A8A29E]'
              )}
            />
            <span
              className={cn(
                summary.tone === 'ok'
                  ? 'text-[#18181B]'
                  : summary.tone === 'warn'
                    ? 'text-amber-800'
                    : 'text-[#78716C]'
              )}
            >
              {summary.badge}
            </span>
          </span>
          <ChevronRight
            className={cn(
              'size-3.5 flex-none text-[#8C8881] transition-transform duration-150',
              expanded && 'rotate-90'
            )}
          />
        </button>

        {expanded && (
          <div className="max-h-48 overflow-y-auto border-t border-[#E7E5E4] px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed text-[#57534E] whitespace-pre-wrap">
            {input && Object.keys(input).length > 0 && (
              <div className="mb-1.5 text-[#78716C]">
                Query: {JSON.stringify(input)}
              </div>
            )}
            <div>{summary.detail}</div>
          </div>
        )}
      </div>

      {/* 1. Structured Order & Dispatch Card (when order found) */}
      {toolName === 'check_order_status' && output && !output.error && output.order_no && (() => {
        const primaryShipment = Array.isArray(output.shipments) ? output.shipments[0] : null;
        const cleanStatus =
          String(output.status || '').replace(/^Sales Order:\s*/i, '') || 'Processing';
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
      })()}

      {/* 2. Structured Product & Live State Stock Card (when SKU found) */}
      {toolName === 'get_product_info' && output && !output.error && output.exists && output.sku && (() => {
        const stock = output.stock_by_state || {};
        const nsw = formatStateStock(stock.nsw);
        const qld = formatStateStock(stock.qld);
        const vic = formatStateStock(stock.vic);

        return (
          <div className="w-full overflow-hidden rounded-2xl border border-[#E5E4DF] bg-white shadow-[0_1px_4px_rgba(0,0,0,0.03)]">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
              <div className="min-w-0">
                <span className="text-[14px] font-semibold text-[#18181B]">{output.sku}</span>
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
      })()}

      {/* 3. Structured Support Case Card (when case created or found) */}
      {(toolName === 'start_warranty_claim' || toolName === 'check_case_status') &&
        output &&
        !output.error &&
        (output.case_number || output.case_no) && (() => {
          const caseNo = output.case_number || output.case_no;
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
        })()}
    </div>
  );
}
