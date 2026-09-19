'use client';

import React, { useCallback, useMemo, useState } from 'react';
import { useRequirePermission } from '@/hooks/useRequirePermission';
import { useRouter, useSearchParams } from 'next/navigation';
import { get, post } from '@/lib/api';
import { usePaginatedQuery, useResourceQuery, usePrefetchNextPage, queryKeys, toQueryString, normalizeList, useCreateMutation, invalidateQueryKeys } from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import { useDebouncedSearch } from '@/lib/hooks/useDebouncedValue';
import { PAGE_SIZE_OPTIONS, DEFAULT_PAGE_SIZE } from '@/lib/pagination';
import {
  DataTable,
  Button,
  Input,
  Select,
  Badge,
  Modal,
  Alert,
  LoadingSpinner,
} from '@/components';
import type { Column, SelectOption } from '@/components';
import type {
  SparePart,
  SparePartCreate,
  Category,
  PaginatedResponse,
} from '@/lib/types';
import { formatCurrency, formatQuantity } from '@/lib/currency';

import { formatFieldErrors, validateWithSchema } from '@/lib/validation/errors';
import { sparePartCreateSchema } from '@/lib/validation/schemas';

type StockLevel = 'in_stock' | 'low' | 'out_of_stock';

function getStockBadge(part: SparePart & { total_stock?: number }): React.ReactNode {
  const stock = Number(part.total_stock ?? 0);
  const minLevel = Number(part.min_stock_level ?? 0);
  let variant: 'success' | 'warning' | 'danger';
  let label: string;

  if (stock <= 0) {
    variant = 'danger';
    label = 'Out of Stock';
  } else if (stock <= minLevel) {
    variant = 'warning';
    label = 'Low Stock';
  } else {
    variant = 'success';
    label = 'In Stock';
  }

  return <Badge variant={variant}>{label}</Badge>;
}

export default function InventoryPage() {
  const { allowed } = useRequirePermission('inventory');

  const router = useRouter();
  const searchParams = useSearchParams();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const resetToFirstPage = useCallback(() => setPage(1), []);
  const { search, debouncedSearch, setSearch } = useDebouncedSearch('', {
    onDebouncedChange: resetToFirstPage,
  });
  const [brandFilter, setBrandFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(searchParams.get('low_stock') === 'true');
  const [locationFilter, setLocationFilter] = useState(searchParams.get('location') || '');
  const [sortField, setSortField] = useState('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const partsParamsFor = useCallback(
    (targetPage: number) => ({
      page: targetPage,
      page_size: pageSize,
      search: debouncedSearch,
      brand: brandFilter,
      category_id: categoryFilter,
      low_stock: lowStockOnly ? 'true' : undefined,
      location_id: locationFilter,
      sort_by: sortField,
      sort_direction: sortDirection,
    }),
    [pageSize, debouncedSearch, brandFilter, categoryFilter, lowStockOnly, locationFilter, sortField, sortDirection],
  );
  const partsQuery = usePaginatedQuery<SparePart & { total_stock?: number }>(
    queryKeys.inventory.list(partsParamsFor(page)),
    `/spare-parts?${toQueryString(partsParamsFor(page))}`,
  );
  const categoriesQuery = useResourceQuery<{ data: Array<Category & { children?: Category[] }> }>(queryKeys.categories.all, '/categories?page_size=500');
  const brandsQuery = useResourceQuery<{ data: string[] }>(['spare-parts', 'brands'], '/spare-parts/brands');
  const locationsQuery = useResourceQuery<{ data: Array<{ id: string; name: string }> }>(queryKeys.locations.all, '/locations?page_size=100');
  const createPart = useCreateMutation<SparePartCreate, { id: string }>('/spare-parts', [queryKeys.inventory.all, queryKeys.dashboard.all]);
  const queryClient = useQueryClient();

  // ── More useState hooks — kept here (after query hooks) but before derived
  // non-hook values to maintain strict Rules-of-Hooks ordering ─────────────
  const [newPart, setNewPart] = useState<SparePartCreate>({ part_number: '', name: '', brand: '', unit_of_measure: 'pcs', cost_price: '' as unknown as number, selling_price: '' as unknown as number, min_stock_level: '' as unknown as number, max_stock_level: 0, reorder_quantity: 0 });
  const [initialStockLocation, setInitialStockLocation] = useState('');
  const [initialStockQty, setInitialStockQty] = useState<number | ''>('');
  const [showBarcodeModal, setShowBarcodeModal] = useState(false);
  const [barcodeInput, setBarcodeInput] = useState('');
  const [barcodeLoading, setBarcodeLoading] = useState(false);
  const [barcodeError, setBarcodeError] = useState<string | null>(null);

  // ── Derived values (non-hooks, after all hooks) ──────────────────────────
  const parts = normalizeList(partsQuery.data).data;
  const totalPages = normalizeList(partsQuery.data).totalPages;
  const isLoading = partsQuery.isLoading;
  const error = partsQuery.error?.message ?? null;
  const categories: Category[] = (categoriesQuery.data?.data ?? []).flatMap((item) => [item, ...(item.children ?? [])]);
  const brands = useMemo(() => brandsQuery.data?.data ?? [], [brandsQuery.data]);
  const locations = useMemo(() => locationsQuery.data?.data ?? [], [locationsQuery.data]);

  const openCreateModal = async () => {
    setShowCreateModal(true);
    try { const result = await get<{ part_number: string }>('/spare-parts/next-part-number'); setNewPart((prev) => ({ ...prev, part_number: result.part_number })); } catch { /* manual entry remains available */ }
  };
  const handleCategoryChange = async (categoryId: string) => {
    setNewPart((prev) => ({ ...prev, category_id: categoryId || undefined }));
    try { const result = await get<{ part_number: string }>(categoryId ? `/spare-parts/next-part-number?category_id=${categoryId}` : '/spare-parts/next-part-number'); setNewPart((prev) => ({ ...prev, part_number: result.part_number })); } catch { /* retain current number */ }
  };

  // Warm the next page of parts so paging feels immediate.
  usePrefetchNextPage({
    page,
    totalPages,
    isFetching: partsQuery.isFetching,
    keyFor: (targetPage) => queryKeys.inventory.list(partsParamsFor(targetPage)),
    pathFor: (targetPage) => `/spare-parts?${toQueryString(partsParamsFor(targetPage))}`,
  });

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const handleCreatePart = () => {
    const payload = { ...newPart, cost_price: Number(newPart.cost_price) || 0, selling_price: Number(newPart.selling_price) || 0, min_stock_level: Number(newPart.min_stock_level) || 0, max_stock_level: Number(newPart.max_stock_level) || 0, reorder_quantity: Number(newPart.reorder_quantity) || 0 };
    const validation = validateWithSchema(sparePartCreateSchema, payload);
    if (!validation.data) {
      setCreateError(formatFieldErrors(validation.errors));
      return;
    }
    setCreateError(null);
    createPart.mutate(validation.data as SparePartCreate, {
      onError: (err) => setCreateError(err.message),
      onSuccess: async (created: { id: string }) => {
        if (initialStockLocation && initialStockQty && Number(initialStockQty) > 0) {
          try {
            await post('/stock/adjust', { spare_part_id: created.id, location_id: initialStockLocation, quantity: Number(initialStockQty), reason: 'Initial stock on part creation' });
            // Re-invalidate inventory cache after stock was added — the first
            // invalidation from useCreateMutation fires before this POST completes.
            await invalidateQueryKeys(queryClient, [queryKeys.inventory.all]);
          } catch { /* part remains created */ }
        }
        setShowCreateModal(false);
        setNewPart({ part_number: '', name: '', brand: '', unit_of_measure: 'pcs', cost_price: '' as unknown as number, selling_price: '' as unknown as number, min_stock_level: '' as unknown as number, max_stock_level: 0, reorder_quantity: 0 });
        setInitialStockLocation(''); setInitialStockQty('');
      },
    });
  };

  const handleBarcodeLookup = async () => {
    if (!barcodeInput.trim()) return;
    setBarcodeLoading(true);
    setBarcodeError(null);
    try {
      const response = await get<{ spare_part_id: string }>(`/barcodes/lookup?barcode=${encodeURIComponent(barcodeInput.trim())}`);
      setShowBarcodeModal(false);
      setBarcodeInput('');
      router.push(`/inventory/${response.spare_part_id}`);
    } catch (err: unknown) {
      let message = 'No spare part found with this barcode';
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { data?: { detail?: string } } };
        if (typeof axiosErr.response?.data?.detail === 'string') {
          message = axiosErr.response.data.detail;
        }
      } else if (err instanceof Error) {
        message = err.message;
      }
      setBarcodeError(message);
    } finally {
      setBarcodeLoading(false);
    }
  };

  const categoryOptions = useMemo(
    () => [
      { value: '', label: 'All Categories' },
      ...categories.map((c) => ({ value: c.id, label: c.name })),
    ],
    [categories]
  );

  const brandOptions = useMemo(
    () => [
      { value: '', label: 'All Brands' },
      ...brands.map((b) => ({ value: b, label: b })),
    ],
    [brands]
  );

  const locationOptions = useMemo(
    () => [
      { value: '', label: 'All Locations' },
      ...locations.map((l) => ({ value: l.id, label: l.name })),
    ],
    [locations]
  );
  const stockOptions: SelectOption[] = [
    { value: '', label: 'All stock levels' },
    { value: 'low', label: 'Low stock only' },
  ];

  const closeCreateModal = useCallback(() => {
    setShowCreateModal(false);
  }, []);

  const closeBarcodeModal = useCallback(() => {
    setShowBarcodeModal(false);
    setBarcodeError(null);
    setBarcodeInput('');
  }, []);

  const columns: Column<SparePart & { total_stock?: number }>[] = [
    {
      key: 'part_number',
      header: 'Part #',
      sortable: true,
    },
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      render: (item) => (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="text-left text-blue-600 hover:text-blue-800 hover:underline"
            onClick={() => router.push(`/inventory/${item.id}`)}
          >
            {item.name}
          </button>
          {item.price_review_needed && (
            <span className="inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700" title="Selling price needs review — margin eroded">
              ⚠ Price
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'brand',
      header: 'Brand',
      sortable: true,
    },
    {
      key: 'category_id',
      header: 'Category',
      render: (item) => {
        if (!item.category_id) return <span className="text-gray-400">—</span>;
        const cat = categories.find((c) => c.id === item.category_id);
        return <span>{cat?.name || '—'}</span>;
      },
    },
    {
      key: 'total_stock',
      header: 'Stock',
      sortable: true,
      render: (item) => <span>{formatQuantity(item.total_stock ?? 0)}</span>,
    },
    {
      key: 'selling_price',
      header: 'Price',
      sortable: true,
      render: (item) => (
        <span className="font-medium">
          {formatCurrency(item.selling_price)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (item) => getStockBadge(item),
    },
  ];

  if (!allowed) return null;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Inventory</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage your spare parts inventory
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setShowBarcodeModal(true)}>
            Barcode Lookup
          </Button>
          <Button onClick={openCreateModal}>Add Part</Button>
        </div>
      </div>

      {/* Search and filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input
            placeholder="Search by name, part number, or barcode..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search spare parts"
          />
        </div>
        <div className="w-full sm:w-48">
          <Select
            options={brandOptions}
            value={brandFilter}
            onChange={(e) => {
              setBrandFilter(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by brand"
          />
        </div>
        <div className="w-full sm:w-48">
          <Select
            options={categoryOptions}
            value={categoryFilter}
            onChange={(e) => {
              setCategoryFilter(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by category"
          />
        </div>
        <div className="w-full sm:w-48">
          <Select
            options={stockOptions}
            value={lowStockOnly ? 'low' : ''}
            onChange={(e) => {
              setLowStockOnly(e.target.value === 'low');
              setPage(1);
            }}
            aria-label="Filter by stock level"
          />
        </div>
        <div className="w-full sm:w-48">
          <Select
            options={locationOptions}
            value={locationFilter}
            onChange={(e) => {
              setLocationFilter(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by location"
          />
        </div>
        <div className="w-full sm:w-40">
          <Select
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

      {/* Error display */}
      {error && (
        <Alert variant="error">{error}</Alert>
      )}

      {/* Data table */}
      <DataTable
        columns={columns}
        data={parts}
        label="Spare parts"
        virtualize
        isLoading={isLoading}
        currentPage={page}
        totalPages={totalPages}
        onPageChange={setPage}
        sortField={sortField}
        sortDirection={sortDirection}
        onSort={handleSort}
        emptyMessage="No spare parts found. Add your first part to get started."
      />

      {/* Create Part Modal */}
      <Modal
        isOpen={showCreateModal}
        onClose={closeCreateModal}
        title="Add New Spare Part"
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={closeCreateModal}>
              Cancel
            </Button>
            <Button onClick={handleCreatePart} isLoading={createPart.isPending}>
              Create Part
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {createError && (
            <Alert variant="error" onClose={() => setCreateError(null)}>
              {createError}
            </Alert>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Part Number"
              value={newPart.part_number}
              onChange={(e) =>
                setNewPart({ ...newPart, part_number: e.target.value })
              }
              required
              placeholder="e.g. ASM-00001"
              helperText="Auto-generated. You can edit to use your own."
            />
            <Input
              label="Barcode"
              value={newPart.barcode || ''}
              onChange={(e) =>
                setNewPart({ ...newPart, barcode: e.target.value || undefined })
              }
              placeholder="e.g. 6901234567890"
            />
            <Input
              label="Name"
              value={newPart.name}
              onChange={(e) =>
                setNewPart({ ...newPart, name: e.target.value })
              }
              required
              placeholder="e.g. Front Brake Pad Set"
            />
            <Input
              label="Brand"
              value={newPart.brand}
              onChange={(e) =>
                setNewPart({ ...newPart, brand: e.target.value })
              }
              required
              placeholder="e.g. Bosch"
            />
            <Select
              label="Category"
              options={[
                { value: '', label: 'Select category (optional)' },
                ...categories.map((c) => ({ value: c.id, label: c.name })),
              ]}
              value={newPart.category_id || ''}
              onChange={(e) => handleCategoryChange(e.target.value)}
            />
            <Select
              label="Unit of Measure"
              options={[
                { value: 'pcs', label: 'Pieces (pcs)' },
                { value: 'set', label: 'Set' },
                { value: 'pair', label: 'Pair' },
                { value: 'litre', label: 'Litre' },
                { value: 'kg', label: 'Kilogram (kg)' },
                { value: 'metre', label: 'Metre' },
                { value: 'box', label: 'Box' },
                { value: 'pack', label: 'Pack' },
                { value: 'roll', label: 'Roll' },
                { value: 'bottle', label: 'Bottle' },
              ]}
              value={newPart.unit_of_measure}
              onChange={(e) =>
                setNewPart({ ...newPart, unit_of_measure: e.target.value })
              }
              required
            />
            <Input
              label="Cost Price"
              type="number"
              min={0}
              step={0.01}
              value={newPart.cost_price === ('' as unknown as number) ? '' : newPart.cost_price}
              onChange={(e) =>
                setNewPart({ ...newPart, cost_price: e.target.value === '' ? ('' as unknown as number) : parseFloat(e.target.value) })
              }
              required
              placeholder="e.g. 5000"
            />
            <Input
              label="Selling Price"
              type="number"
              min={0}
              step={0.01}
              value={newPart.selling_price === ('' as unknown as number) ? '' : newPart.selling_price}
              onChange={(e) =>
                setNewPart({ ...newPart, selling_price: e.target.value === '' ? ('' as unknown as number) : parseFloat(e.target.value) })
              }
              required
              placeholder="e.g. 8000"
            />
            <Input
              label="Min Stock Level"
              type="number"
              min={0}
              value={newPart.min_stock_level === ('' as unknown as number) ? '' : newPart.min_stock_level}
              onChange={(e) =>
                setNewPart({ ...newPart, min_stock_level: e.target.value === '' ? ('' as unknown as number) : parseInt(e.target.value) })
              }
              placeholder="e.g. 10"
              helperText="Get alerted when stock drops below this"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Description
            </label>
            <textarea
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-0"
              rows={3}
              value={newPart.description || ''}
              onChange={(e) =>
                setNewPart({ ...newPart, description: e.target.value || undefined })
              }
              placeholder="e.g. OEM quality front brake pad set for Toyota Corolla 2018-2023"
            />
          </div>

          {/* Initial Stock */}
          <div className="border-t border-gray-200 pt-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-1">Initial Stock (optional)</h3>
            <p className="text-xs text-gray-500 mb-3">Add stock immediately when creating this part. You can also add stock later from the part detail page.</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Select
                label="Location"
                options={[
                  { value: '', label: 'Select location' },
                  ...locations.map((l) => ({ value: l.id, label: l.name })),
                ]}
                value={initialStockLocation}
                onChange={(e) => setInitialStockLocation(e.target.value)}
              />
              <Input
                label="Quantity"
                type="number"
                min={0}
                value={initialStockQty}
                onChange={(e) => setInitialStockQty(e.target.value === '' ? '' : parseInt(e.target.value))}
                placeholder="e.g. 50"
                helperText="How many do you currently have?"
              />
            </div>
          </div>
        </div>
      </Modal>

      {/* Barcode Lookup Modal */}
      <Modal
        isOpen={showBarcodeModal}
        onClose={closeBarcodeModal}
        title="Barcode Lookup"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={closeBarcodeModal}>
              Cancel
            </Button>
            <Button
              onClick={handleBarcodeLookup}
              isLoading={barcodeLoading}
              disabled={!barcodeInput.trim()}
            >
              Look Up
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {barcodeError && (
            <Alert variant="error" onClose={() => setBarcodeError(null)}>
              {barcodeError}
            </Alert>
          )}
          <p className="text-sm text-gray-500">
            Enter or scan a barcode to find the associated spare part.
          </p>
          <Input
            label="Barcode"
            value={barcodeInput}
            onChange={(e) => setBarcodeInput(e.target.value)}
            placeholder="e.g. ASM-00001 or 6901234567890"
            required
            onKeyDown={(e) => {
              if (e.key === 'Enter' && barcodeInput.trim()) {
                handleBarcodeLookup();
              }
            }}
          />
        </div>
      </Modal>
    </div>
  );
}
