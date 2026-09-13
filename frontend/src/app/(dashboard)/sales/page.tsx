'use client';

/**
 * Sales List Page
 *
 * Displays all sales with filtering by status, links to create new sale
 * and view sale details.
 *
 * Requirements: 5.1, 5.3, 5.4
 */

import React, { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePaginatedQuery, usePrefetchNextPage, queryKeys, toQueryString, normalizeList } from '@/lib/queries';
import { useDebouncedSearch } from '@/lib/hooks/useDebouncedValue';
import { PAGE_SIZE_OPTIONS, DEFAULT_PAGE_SIZE } from '@/lib/pagination';
import {
  DataTable,
  Button,
  Input,
  Select,
  Badge,
  Alert,
  LoadingSpinner,
} from '@/components';
import type { Column, SelectOption, BadgeVariant } from '@/components';
import type { Sale, PaginatedResponse, SaleStatus } from '@/lib/types';
import { formatCurrency } from '@/lib/currency';
import { useRequirePermission } from '@/hooks/useRequirePermission';

const STATUS_OPTIONS: SelectOption[] = [
  { value: '', label: 'All Statuses' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'RETURNED', label: 'Returned' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

function getStatusBadge(status: SaleStatus): React.ReactNode {
  const map: Record<SaleStatus, { variant: BadgeVariant; label: string }> = {
    DRAFT: { variant: 'warning', label: 'Draft' },
    CONFIRMED: { variant: 'success', label: 'Confirmed' },
    RETURNED: { variant: 'info', label: 'Returned' },
    CANCELLED: { variant: 'danger', label: 'Cancelled' },
  };
  const { variant, label } = map[status] ?? { variant: 'default' as BadgeVariant, label: status };
  return <Badge variant={variant}>{label}</Badge>;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-NG', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function SalesPage() {
  const { allowed } = useRequirePermission('sales');

  const router = useRouter();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const resetToFirstPage = useCallback(() => setPage(1), []);
  const { search, debouncedSearch, setSearch } = useDebouncedSearch('', {
    onDebouncedChange: resetToFirstPage,
  });
  const {
    search: product,
    debouncedSearch: debouncedProduct,
    setSearch: setProduct,
  } = useDebouncedSearch('', { onDebouncedChange: resetToFirstPage });
  const [sortField, setSortField] = useState('created_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const paramsFor = useCallback(
    (targetPage: number) => ({
      page: targetPage,
      page_size: pageSize,
      status: statusFilter,
      search: debouncedSearch,
      product: debouncedProduct,
      date_from: dateFrom,
      date_to: dateTo,
      sort_by: sortField,
      sort_direction: sortDirection,
    }),
    [pageSize, statusFilter, debouncedSearch, debouncedProduct, dateFrom, dateTo, sortField, sortDirection],
  );

  const salesQuery = usePaginatedQuery<Sale>(
    queryKeys.sales.list(paramsFor(page)),
    `/sales?${toQueryString(paramsFor(page))}`,
  );
  const sales = normalizeList(salesQuery.data).data;
  const isLoading = salesQuery.isLoading;
  const error = salesQuery.error?.message ?? null;
  const totalPages = normalizeList(salesQuery.data).totalPages;

  // Warm the next page so paging does not wait on a round trip.
  usePrefetchNextPage({
    page,
    totalPages,
    isFetching: salesQuery.isFetching,
    keyFor: (targetPage) => queryKeys.sales.list(paramsFor(targetPage)),
    pathFor: (targetPage) => `/sales?${toQueryString(paramsFor(targetPage))}`,
  });

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const columns: Column<Sale>[] = [
    {
      key: 'invoice_number',
      header: 'Invoice #',
      sortable: true,
      render: (item) => (
        <button
          type="button"
          className="text-left text-blue-600 hover:text-blue-800 hover:underline"
          onClick={() => router.push(`/sales/${item.id}`)}
        >
          {item.invoice_number || `DRAFT-${item.id.slice(0, 8)}`}
        </button>
      ),
    },
    {
      key: 'created_at',
      header: 'Date',
      sortable: true,
      render: (item) => <span>{formatDate(item.created_at)}</span>,
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (item) => <span>{item.customer_name ?? 'Walk-in'}</span>,
    },
    {
      key: 'created_by_username',
      header: 'Issued by',
      render: (item) => <span>{item.created_by_username ?? '—'}</span>,
    },
    {
      key: 'total_amount',
      header: 'Total',
      sortable: true,
      render: (item) => (
        <span className="font-medium">{formatCurrency(item.total_amount)}</span>
      ),
    },
    {
      key: 'payment_type',
      header: 'Payment',
      render: (item) => (
        <span className="capitalize">{item.payment_type}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (item) => getStatusBadge(item.status),
    },
  ];

  if (!allowed) return null;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Sales</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage sales, create invoices, and process returns
          </p>
        </div>
        <Button onClick={() => router.push('/sales/create')}>
          Create Sale
        </Button>
      </div>

      {/* Search and filters */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              label="Invoice # or customer"
              placeholder="Invoice number or customer name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search sales by invoice number or customer name"
            />
          </div>
          <div className="flex-1">
            <Input
              label="Product sold"
              placeholder="Part number or name..."
              value={product}
              onChange={(e) => setProduct(e.target.value)}
              aria-label="Search sales by product sold"
            />
          </div>
          <div className="w-full sm:w-48">
            <Select
              label="Status"
              options={STATUS_OPTIONS}
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              aria-label="Filter by status"
            />
          </div>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="w-full sm:w-48">
            <Input
              label="From date"
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(1);
              }}
              aria-label="Filter sales from date"
            />
          </div>
          <div className="w-full sm:w-48">
            <Input
              label="To date"
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPage(1);
              }}
              aria-label="Filter sales to date"
            />
          </div>
          {(dateFrom || dateTo || product) && (
            <div className="w-full sm:w-auto">
              <Button
                variant="secondary"
                onClick={() => {
                  setDateFrom('');
                  setDateTo('');
                  setProduct('');
                  setPage(1);
                }}
              >
                Clear filters
              </Button>
            </div>
          )}
          <div className="w-full sm:ml-auto sm:w-40">
            <Select
              label="Rows per page"
              options={PAGE_SIZE_OPTIONS}
              value={String(pageSize)}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
              aria-label="Rows per page"
            />
          </div>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <Alert variant="error">{error}</Alert>
      )}

      {/* Data table */}
      <DataTable
        columns={columns}
        data={sales}
        label="Sales"
        virtualize
        isLoading={isLoading}
        currentPage={page}
        totalPages={totalPages}
        onPageChange={setPage}
        sortField={sortField}
        sortDirection={sortDirection}
        onSort={handleSort}
        emptyMessage="No sales found. Create your first sale to get started."
      />
    </div>
  );
}
