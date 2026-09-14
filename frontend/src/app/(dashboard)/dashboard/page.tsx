'use client';

/**
 * Dashboard Page with Role-Based KPI Widgets
 *
 * Displays key performance indicators based on the authenticated user's role.
 * Auto-refreshes data every 5 minutes.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4
 */

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { useResourceQuery, queryKeys } from '@/lib/queries';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { Alert } from '@/components/Alert';
import { formatCurrency } from '@/lib/currency';
import type { DashboardKPIs, ProfitSummary } from '@/lib/types';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Charting code is only needed once stock-value data is available, so it is
// requested separately from the initial dashboard bundle.
// Requirements: 19.2
const StockValueBarChart = dynamic(
  () => import('@/components/charts/StockValueBarChart').then((mod) => mod.StockValueBarChart),
  { ssr: false, loading: () => <div className="h-24" aria-hidden="true" /> },
);

export default function DashboardPage() {
  const { user } = useAuth();
  const kpisQuery = useResourceQuery<DashboardKPIs>(queryKeys.dashboard.kpis(), '/dashboard/kpis', { refetchInterval: REFRESH_INTERVAL_MS });
  const stockValueQuery = useResourceQuery<{ grand_total: number; locations: Array<{ location_id: string; location_name: string; total_value: number; total_items: number }> }>(queryKeys.dashboard.stockValue(), '/dashboard/stock-value', { refetchInterval: REFRESH_INTERVAL_MS });
  const kpis = kpisQuery.data;
  const stockValue = stockValueQuery.data;
  const isLoading = kpisQuery.isLoading;
  const error = kpisQuery.error?.message ?? null;
  const lastUpdated = kpisQuery.dataUpdatedAt ? new Date(kpisQuery.dataUpdatedAt) : null;

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Alert variant="error" title="Error loading dashboard">
          {error}
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-[28px] font-bold text-[#333]">Dashboard</h1>
          <p className="text-sm text-[#666]">
            Welcome back, {user?.username ?? 'User'}
          </p>
        </div>
        {lastUpdated && (
          <p className="text-xs text-gray-400">
            Last updated: {lastUpdated.toLocaleTimeString()}
          </p>
        )}
      </div>

      {/* KPI Cards Grid */}
      <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        {kpis?.total_sales_today != null && (
          <KPICard
            title="Total Sales Today"
            value={formatCurrency(kpis.total_sales_today)}
            borderColor="#2196F3"
            href={`/reports?type=sales&start_date=${new Date().toISOString().split('T')[0]}&end_date=${new Date().toISOString().split('T')[0]}`}
          />
        )}

        {kpis?.total_sales_month != null && (
          <KPICard
            title="Sales This Month"
            value={formatCurrency(kpis.total_sales_month)}
            borderColor="#4CAF50"
            href={`/reports?type=sales&start_date=${new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0]}&end_date=${new Date().toISOString().split('T')[0]}`}
          />
        )}

        {kpis?.outstanding_receivables != null && (
          <KPICard
            title="Outstanding Receivables"
            value={formatCurrency(kpis.outstanding_receivables)}
            borderColor="#FF9800"
            href="/customers"
          />
        )}

        {kpis?.low_stock_count != null && (
          <KPICard
            title="Low Stock Items"
            value={kpis.low_stock_count.toString()}
            borderColor="#f44336"
            href="/inventory"
          />
        )}

        {kpis?.pending_po_count != null && (
          <KPICard
            title="Pending Purchase Orders"
            value={kpis.pending_po_count.toString()}
            borderColor="#9C27B0"
            href="/purchases"
          />
        )}
      </div>

      {/* Profit Summary — Admin and Manager only */}
      <ProfitSummaryWidget />

      {/* Stock Value by Location */}
      {stockValue && stockValue.locations.length > 0 && (
        <div className="rounded-lg bg-white p-4 sm:p-6 shadow-[0_2px_4px_rgba(0,0,0,0.1)]">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-[#333]">
              Stock Value by Location
            </h2>
            <span className="text-lg font-bold text-[#333]">
              {formatCurrency(stockValue.grand_total)}
            </span>
          </div>
          <div className="mb-4">
            <StockValueBarChart data={stockValue.locations} />
          </div>
          <div className="space-y-3">
            {stockValue.locations.map((loc) => (
              <div key={loc.location_id} className="flex items-center justify-between rounded-md border border-gray-100 p-3">
                <div>
                  <p className="text-sm font-medium text-gray-900">{loc.location_name}</p>
                  <p className="text-xs text-gray-500">{Math.round(loc.total_items)} items in stock</p>
                </div>
                <span className="text-sm font-bold text-gray-900">
                  {formatCurrency(loc.total_value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top Selling Products */}
      <TopProductsWidget />

      {/* Top Customers */}
      <TopCustomersWidget />
    </div>
  );
}

// --- Profit Summary Widget (Admin / Manager only) ---

function ProfitSummaryWidget() {
  const { hasRole } = useAuth();
  const [period, setPeriod] = useState('1m');

  // Only fetch when the user actually has access — avoids a 403 in the console
  // for Salespersons and Storekeepers.
  const canView = hasRole(['admin', 'manager']);

  const query = useResourceQuery<ProfitSummary>(
    queryKeys.dashboard.profitSummary(period),
    `/dashboard/profit-summary?period=${period}`,
    { enabled: canView, staleTime: 5 * 60 * 1000 },
  );

  // Not visible to this role — render nothing.
  if (!canView) return null;

  const data = query.data;
  const isLoading = query.isLoading;
  const isError = query.isError;

  // ── Margin colour: green ≥ 20%, amber 10–19%, red < 10%
  const marginColour =
    (data?.margin_pct ?? 0) >= 20
      ? 'text-green-600'
      : (data?.margin_pct ?? 0) >= 10
      ? 'text-amber-600'
      : 'text-red-600';

  return (
    <div className="rounded-lg bg-white p-4 sm:p-6 shadow-[0_2px_4px_rgba(0,0,0,0.1)]">
      {/* Header row */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-5">
        <div>
          <h2 className="text-base font-semibold text-[#333]">Profit Summary</h2>
          {data && (
            <p className="mt-0.5 text-xs text-gray-500">{data.period_label}</p>
          )}
        </div>
        <PeriodFilter value={period} onChange={setPeriod} />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8">
          <LoadingSpinner />
        </div>
      ) : isError ? (
        <p className="text-sm text-red-600 text-center py-4">
          Failed to load profit data.
        </p>
      ) : !data ? null : (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-5">
            <ProfitMetric
              label="Revenue"
              value={formatCurrency(data.total_revenue)}
              colour="text-gray-900"
              sub={`${data.sale_count} sale${data.sale_count !== 1 ? 's' : ''}`}
            />
            <ProfitMetric
              label="Cost of Goods"
              value={formatCurrency(data.total_cogs)}
              colour="text-gray-700"
            />
            <ProfitMetric
              label="Gross Profit"
              value={formatCurrency(data.gross_margin)}
              colour={data.gross_margin >= 0 ? 'text-green-700' : 'text-red-600'}
            />
            <ProfitMetric
              label="Margin"
              value={`${data.margin_pct.toFixed(1)}%`}
              colour={marginColour}
              sub={
                data.margin_pct >= 20
                  ? 'Healthy'
                  : data.margin_pct >= 10
                  ? 'Moderate'
                  : 'Low'
              }
            />
          </div>

          {/* Waterfall bar */}
          {data.total_revenue > 0 && (
            <div className="space-y-2">
              <WaterfallBar
                label="Revenue"
                value={data.total_revenue}
                max={data.total_revenue}
                colour="bg-blue-500"
              />
              <WaterfallBar
                label="COGS"
                value={data.total_cogs}
                max={data.total_revenue}
                colour="bg-orange-400"
              />
              <WaterfallBar
                label="Gross Profit"
                value={Math.max(0, data.gross_margin)}
                max={data.total_revenue}
                colour="bg-emerald-500"
              />
            </div>
          )}

          {/* Link to full financial report */}
          <div className="mt-5 flex justify-end">
            <a
              href={`/reports?type=financial`}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[#667eea] hover:underline"
            >
              View full Financial Report
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </a>
          </div>
        </>
      )}
    </div>
  );
}

interface ProfitMetricProps {
  label: string;
  value: string;
  colour: string;
  sub?: string;
}
function ProfitMetric({ label, value, colour, sub }: ProfitMetricProps) {
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-3">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-lg font-bold leading-tight ${colour}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

interface WaterfallBarProps {
  label: string;
  value: number;
  max: number;
  colour: string;
}
function WaterfallBar({ label, value, max, colour }: WaterfallBarProps) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-xs text-gray-500 text-right">{label}</span>
      <div className="flex-1 h-5 rounded-full bg-gray-100 overflow-hidden">
        <div
          className={`h-full rounded-full ${colour} transition-all duration-500`}
          style={{ width: `${pct}%` }}
          role="presentation"
        />
      </div>
      <span className="w-24 shrink-0 text-xs font-medium text-gray-700 text-right">
        {formatCurrency(value)}
      </span>
    </div>
  );
}

// --- Helper Components ---

const PERIOD_OPTIONS = [
  { value: '1m', label: 'This Month' },
  { value: '3m', label: '3 Months' },
  { value: '6m', label: '6 Months' },
  { value: '1y', label: '1 Year' },
  { value: 'all', label: 'All Time' },
];

function PeriodFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-1">
      {PERIOD_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
            value === opt.value
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function TopProductsWidget() {
  const [period, setPeriod] = useState('all');
  const query = useResourceQuery<{ data: Array<{ spare_part_id: string | null; part_name: string; part_number: string | null; total_quantity_sold: number; total_revenue: number }> }>(queryKeys.dashboard.topProducts(period), `/dashboard/top-products?period=${period}`);
  const data = query.data?.data ?? [];
  const isLoading = query.isLoading;

  return (
    <div className="rounded-lg bg-white p-4 sm:p-6 shadow-[0_2px_4px_rgba(0,0,0,0.1)]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
        <h2 className="text-base font-semibold text-[#333]">Top 5 Products</h2>
        <PeriodFilter value={period} onChange={setPeriod} />
      </div>
      {isLoading ? (
        <div className="flex justify-center py-6"><LoadingSpinner /></div>
      ) : data.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-4">No sales data for this period</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead>
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#666]">#</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#666]">Product</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-[#666]">Qty Sold</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-[#666]">Revenue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.map((item, i) => (
                <tr key={`${item.spare_part_id || "external"}:${item.part_name}:${item.part_number || ""}`} className="hover:bg-gray-50 transition-colors">
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">{i + 1}</td>
                  <td className="px-4 py-3 text-sm">
                    <p className="font-medium text-gray-900">{item.part_name}</p>
                    <p className="text-xs text-gray-500">{item.part_number}</p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-medium text-gray-900">
                    {item.total_quantity_sold.toLocaleString()}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-sm text-gray-700">
                    {formatCurrency(item.total_revenue)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TopCustomersWidget() {
  const [period, setPeriod] = useState('all');
  const query = useResourceQuery<{ data: Array<{ customer_id: string; customer_name: string; customer_phone: string; total_spent: number; order_count: number }> }>(queryKeys.dashboard.topCustomers(period), `/dashboard/top-customers?period=${period}`);
  const data = query.data?.data ?? [];
  const isLoading = query.isLoading;

  return (
    <div className="rounded-lg bg-white p-4 sm:p-6 shadow-[0_2px_4px_rgba(0,0,0,0.1)]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
        <h2 className="text-base font-semibold text-[#333]">Top 5 Customers</h2>
        <PeriodFilter value={period} onChange={setPeriod} />
      </div>
      {isLoading ? (
        <div className="flex justify-center py-6"><LoadingSpinner /></div>
      ) : data.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-4">No customer data for this period</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead>
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#666]">#</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#666]">Customer</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-[#666]">Orders</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-[#666]">Total Spent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.map((item, i) => (
                <tr key={item.customer_id} className="hover:bg-gray-50 transition-colors">
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">{i + 1}</td>
                  <td className="px-4 py-3 text-sm">
                    <p className="font-medium text-gray-900">{item.customer_name}</p>
                    {item.customer_phone && <p className="text-xs text-gray-500">{item.customer_phone}</p>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-sm text-gray-700">
                    {item.order_count}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-medium text-gray-900">
                    {formatCurrency(item.total_spent)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface KPICardProps {
  title: string;
  value: string;
  borderColor: string;
  href?: string;
}

function KPICard({ title, value, borderColor, href }: KPICardProps) {
  const router = useRouter();

  return (
    <div
      className={`bg-white rounded-lg p-5 shadow-[0_2px_4px_rgba(0,0,0,0.1)] transition-all duration-200 hover:-translate-y-[2px] hover:shadow-[0_4px_8px_rgba(0,0,0,0.15)] ${href ? 'cursor-pointer' : 'cursor-default'}`}
      style={{ borderLeft: `4px solid ${borderColor}` }}
      onClick={() => href && router.push(href)}
      role={href ? 'link' : undefined}
      tabIndex={href ? 0 : undefined}
      onKeyDown={(e) => href && e.key === 'Enter' && router.push(href)}
    >
      <p className="text-[14px] font-medium text-[#666] uppercase tracking-[0.5px] m-0 mb-2">
        {title}
      </p>
      <p className="text-[32px] font-bold text-[#333] m-0 leading-tight">
        {value}
      </p>
    </div>
  );
}
