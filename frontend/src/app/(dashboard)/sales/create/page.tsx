'use client';

/**
 * Create Sale Page
 *
 * Two-panel POS-style layout:
 * - Left: Category tabs + product grid (browse/search items)
 * - Right: Cart (selected line items with quantity/price/discount editing)
 *
 * Features:
 * - Category browsing with item count badges
 * - Cross-category search bar
 * - Per-location stock visibility
 * - Out-of-stock items shown grayed out
 * - Auto-select location (single or last-used)
 *
 * Requirements: 5.1, 5.3, 5.4, 5.6, 5.7
 */

import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { get, post } from '@/lib/api';
import {
  Button,
  Input,
  Select,
  Alert,
  LoadingSpinner,
} from '@/components';
import type { SelectOption } from '@/components';
import type {
  Customer,
  Location,
  SparePart,
  SaleCreate,
  SaleItemCreate,
  Sale,
} from '@/lib/types';
import ExternalItemForm from '@/components/sales/ExternalItemForm';
import { formatCurrency } from '@/lib/currency';

import { formatFieldErrors, validateWithSchema } from '@/lib/validation/errors';
import { saleCreateSchema } from '@/lib/validation/schemas';
import { extractApiError } from '@/lib/validation/errors';
import { useRequirePermission } from '@/hooks/useRequirePermission';

interface LineItem {
  source_type?: 'STOCK' | 'EXTERNAL';
  external_description?: string;
  external_part_number?: string;
  supplier_id?: string;
  supplier_unit_cost?: number;
  supplier_amount_paid?: number;

  id: string;
  spare_part_id: string;
  spare_part_name: string;
  part_number: string;
  quantity: number | '';
  unit_price: number | '';
  discount_amount: number | '';
  line_total: number;
  available_stock?: number;
  cost_price?: number;
}

interface Category {
  id: string;
  name: string;
  spare_parts_count: number;
  children?: Category[];
}

const SALE_PAYMENT_OPTIONS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CREDIT', label: 'Credit' },
];

export default function CreateSalePage() {
  const { allowed } = useRequirePermission('sales');
  const router = useRouter();

  // Form state
  const [customerId, setCustomerId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [paymentType, setPaymentType] = useState<string>('CASH');
  const [amountPaid, setAmountPaid] = useState<number | ''>('');
  const [lineItems, setLineItems] = useState<LineItem[]>([]);

  // Reference data
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);

  // Category browsing
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('');
  const [catalogProducts, setCatalogProducts] = useState<SparePart[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogPage, setCatalogPage] = useState(1);
  const catalogPageSize = 12;

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Actions
  const [isSaving, setIsSaving] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Fetch reference data (customers, locations, categories)
  useEffect(() => {
    async function fetchData() {
      try {
        const [customersRes, locationsRes, categoriesRes] = await Promise.all([
          get<{ data: Customer[]; meta: { page: number; total: number; page_size: number } }>('/customers'),
          get<{ data: Location[]; meta: { page: number; total: number; page_size: number } }>('/locations'),
          get<{ data: Category[]; meta: { page: number; total: number; page_size: number } }>('/categories?parent_only=true&page_size=100'),
        ]);
        setCustomers(customersRes.data.filter((c: Customer) => c.account_status !== 'closed'));
        const locs = locationsRes.data;
        setLocations(locs);
        setCategories(categoriesRes.data);

        // Auto-select location
        if (locs.length === 1) {
          setLocationId(locs[0].id);
        } else if (locs.length > 1) {
          const lastUsed = localStorage.getItem('lastSaleLocationId');
          if (lastUsed && locs.some((l: Location) => l.id === lastUsed)) {
            setLocationId(lastUsed);
          }
        }
      } catch {
        // Non-critical
      }
    }
    fetchData();
  }, []);

  // Fetch products when category, location, search, or page changes
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);

    searchTimeout.current = setTimeout(async () => {
      setCatalogLoading(true);
      try {
        const params = new URLSearchParams();
        params.set('page', String(catalogPage));
        params.set('page_size', String(catalogPageSize));
        params.set('include_zero_stock', 'true');
        if (selectedCategoryId) params.set('category_id', selectedCategoryId);
        if (locationId) params.set('location_id', locationId);
        if (searchQuery.length >= 2) params.set('search', searchQuery);

        const response = await get<{ data: SparePart[]; meta: { page: number; total: number; page_size: number } }>(
          `/spare-parts?${params.toString()}`
        );
        setCatalogProducts(response.data);
        setCatalogTotal(response.meta.total);
      } catch {
        setCatalogProducts([]);
      } finally {
        setCatalogLoading(false);
      }
    }, searchQuery ? 300 : 0);

    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
    };
  }, [selectedCategoryId, locationId, searchQuery, catalogPage]);

  // Reset page when category or search changes
  useEffect(() => {
    setCatalogPage(1);
  }, [selectedCategoryId, searchQuery, locationId]);

  const addLineItem = (part: SparePart) => {
    // Don't add duplicate
    if (lineItems.some((li) => li.spare_part_id === part.id)) return;

    const stock = part.total_stock ?? 0;
    const newItem: LineItem = {
      id: crypto.randomUUID(),
      spare_part_id: part.id,
      spare_part_name: part.name,
      part_number: part.part_number,
      quantity: 1,
      unit_price: part.selling_price,
      discount_amount: '',
      line_total: part.selling_price,
      available_stock: stock,
      cost_price: part.cost_price,
    };

    setLineItems([...lineItems, newItem]);
  };

  const updateLineItem = (id: string, field: keyof LineItem, value: number | '') => {
    setLineItems((items) =>
      items.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, [field]: value };
        updated.line_total =
          (updated.quantity || 0) * (updated.unit_price || 0) - (updated.discount_amount || 0);
        return updated;
      })
    );
  };

  const removeLineItem = (id: string) => {
    setLineItems((items) => items.filter((item) => item.id !== id));
  };

  // Totals
  const subtotal = lineItems.reduce((sum, item) => sum + (item.quantity || 0) * (item.unit_price || 0), 0);
  const discountTotal = lineItems.reduce((sum, item) => sum + (item.discount_amount || 0), 0);
  const totalAmount = subtotal - discountTotal;

  const buildSalePayload = (): SaleCreate => ({
    customer_id: customerId || undefined,
    location_id: locationId,
    payment_type: paymentType as SaleCreate['payment_type'],
    amount_paid: paymentType === 'CREDIT' && amountPaid ? Number(amountPaid) : undefined,
    items: lineItems.map((li): SaleItemCreate => ({
      spare_part_id: li.spare_part_id || undefined,
      source_type: li.source_type || 'STOCK',
      external_description: li.external_description,
      external_part_number: li.external_part_number,
      supplier_id: li.supplier_id,
      supplier_unit_cost: li.supplier_unit_cost,
      supplier_amount_paid: li.supplier_amount_paid || 0,
      quantity: li.quantity || 1,
      unit_price: li.unit_price || 0,
      discount_amount: (li.discount_amount || 0) || undefined,
    })),
  });

  const validateSalePayload = (): SaleCreate | null => {
    const validation = validateWithSchema(saleCreateSchema, buildSalePayload());
    if (!validation.data) {
      setError(formatFieldErrors(validation.errors));
      return null;
    }
    return validation.data as unknown as SaleCreate;
  };

  const handleSaveDraft = async () => {
    if (!locationId) {
      setError('Please select a location.');
      return;
    }
    if (lineItems.length === 0) {
      setError('Please add at least one line item.');
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const payload = validateSalePayload();
      if (!payload) return;
      const sale = await post<Sale>('/sales', payload);
      setSuccess('Sale saved as draft successfully.');
      setTimeout(() => {
        router.push(`/sales/${sale.id}`);
      }, 1000);
    } catch (err: unknown) {
      const message = extractApiError(err, 'Failed to save sale');
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveAndConfirm = async () => {
    if (!locationId) {
      setError('Please select a location.');
      return;
    }
    if (lineItems.length === 0) {
      setError('Please add at least one line item.');
      return;
    }

    setIsConfirming(true);
    setError(null);
    try {
      const payload = validateSalePayload();
      if (!payload) return;
      const sale = await post<Sale>('/sales', payload);
      const saleId = sale.id;

      try {
        await post<Sale>(`/sales/${saleId}/confirm`);
        setSuccess('Sale confirmed successfully. Inventory and supplier balances have been updated.');
        setTimeout(() => {
          router.push(`/sales/${saleId}`);
        }, 1000);
      } catch (confirmErr: unknown) {
        const message = extractApiError(confirmErr, 'Failed to confirm sale. Saved as draft instead.');
        setError(message);
        setTimeout(() => {
          router.push(`/sales/${saleId}`);
        }, 2000);
      }
    } catch (err: unknown) {
      const message = extractApiError(err, 'Failed to create sale.');
      setError(message);
    } finally {
      setIsConfirming(false);
    }
  };

  const customerOptions = useMemo(
    () => [
      { value: '', label: 'Walk-in (Cash)' },
      ...customers.map((c) => ({ value: c.id, label: c.name })),
    ],
    [customers]
  );

  const locationOptions = useMemo(
    () => [
      { value: '', label: 'Select location...' },
      ...locations.map((l) => ({ value: l.id, label: l.name })),
    ],
    [locations]
  );

  const totalPages = Math.ceil(catalogTotal / catalogPageSize);

  const selectedLocationName = useMemo(
    () => locations.find((l) => l.id === locationId)?.name || '',
    [locations, locationId]
  );

  // Format stock quantity: strip trailing zeros (43.0000 → 43, 2.5000 → 2.5)
  const formatStock = (val: number) => {
    const num = Number(val);
    return Number.isInteger(num) ? num.toString() : num.toFixed(1);
  };

  if (!allowed) return null;

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Create Sale</h1>
          <p className="mt-1 text-sm text-gray-500">
            Browse products by category or search, then add to cart
          </p>
        </div>
        <Button variant="secondary" onClick={() => router.push('/sales')}>
          Back to Sales
        </Button>
      </div>

      <ExternalItemForm onAdd={item => setLineItems(items => [...items, item])} />

      {/* Alerts */}
      {error && (
        <Alert variant="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert variant="success" onClose={() => setSuccess(null)}>
          {success}
        </Alert>
      )}

      {/* Sale details (compact) */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Select
            label="Customer"
            options={customerOptions}
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
          />
          <Select
            label="Location"
            options={locationOptions}
            value={locationId}
            onChange={(e) => {
              setLocationId(e.target.value);
              if (e.target.value) {
                localStorage.setItem('lastSaleLocationId', e.target.value);
              }
            }}
            required
          />
          <Select
            label="Payment Type"
            options={SALE_PAYMENT_OPTIONS}
            value={paymentType}
            onChange={(e) => setPaymentType(e.target.value)}
          />
          {paymentType === 'CREDIT' && (
            <Input
              label="Amount Paid"
              type="number"
              min={0}
              step={0.01}
              value={amountPaid}
              onChange={(e) => setAmountPaid(e.target.value === '' ? '' : parseFloat(e.target.value))}
              placeholder="0.00 (optional)"
            />
          )}
        </div>
      </div>

      {/* Mobile cart summary bar (fixed at bottom on small screens) */}
      {lineItems.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-gray-200 bg-white px-4 py-3 shadow-lg lg:hidden">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-gray-900">{formatCurrency(totalAmount)}</p>
              <p className="text-xs text-gray-500">{lineItems.length} item{lineItems.length > 1 ? 's' : ''} in cart</p>
            </div>
            <a href="#cart-section" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
              View Cart
            </a>
          </div>
        </div>
      )}

      {/* Two-panel layout: Product catalog + Cart */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 pb-20 lg:pb-0">
        {/* LEFT: Product catalog (2/3 width on desktop) */}
        <div className="lg:col-span-2 rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
          {/* Search bar */}
          <div className="border-b border-gray-200 p-3">
            <input
              type="text"
              placeholder="Search by name, part number, or barcode..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              aria-label="Search products"
            />
            {selectedLocationName && (
              <p className="mt-1.5 text-xs text-gray-500">
                Showing stock at: <span className="font-medium text-gray-700">{selectedLocationName}</span>
              </p>
            )}
            {!locationId && (
              <p className="mt-1.5 text-xs text-amber-600">
                Select a location above to see location-specific stock levels
              </p>
            )}
          </div>

          {/* Category tabs */}
          <div className="border-b border-gray-200 overflow-x-auto">
            <div className="flex min-w-max px-2">
              <button
                type="button"
                onClick={() => setSelectedCategoryId('')}
                className={`whitespace-nowrap px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                  !selectedCategoryId
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                All Items
              </button>
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setSelectedCategoryId(cat.id)}
                  className={`whitespace-nowrap px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                    selectedCategoryId === cat.id || (cat.children?.some((c) => c.id === selectedCategoryId))
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  {cat.name}
                  {cat.spare_parts_count > 0 && (
                    <span className="ml-1 inline-flex items-center rounded-full bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                      {cat.spare_parts_count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Subcategory pills (when a parent category with children is selected) */}
          {(() => {
            const parentCat = categories.find((c) => c.id === selectedCategoryId);
            if (!parentCat?.children?.length) return null;
            return (
              <div className="border-b border-gray-100 px-3 py-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setSelectedCategoryId(parentCat.id)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                    selectedCategoryId === parentCat.id
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  All {parentCat.name}
                </button>
                {parentCat.children.map((sub) => (
                  <button
                    key={sub.id}
                    type="button"
                    onClick={() => setSelectedCategoryId(sub.id)}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                      selectedCategoryId === sub.id
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {sub.name}
                  </button>
                ))}
              </div>
            );
          })()}

          {/* Product grid */}
          <div className="p-3">
            {catalogLoading ? (
              <div className="flex items-center justify-center py-12">
                <LoadingSpinner size="md" />
              </div>
            ) : catalogProducts.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-sm text-gray-500">
                  {searchQuery
                    ? `No products found for "${searchQuery}"`
                    : 'No products in this category'}
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
                  {catalogProducts.map((product) => {
                    const stock = product.total_stock ?? 0;
                    const isOutOfStock = stock <= 0;
                    const isInCart = lineItems.some((li) => li.spare_part_id === product.id);

                    return (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => !isInCart && addLineItem(product)}
                        disabled={isOutOfStock || isInCart}
                        className={`relative flex flex-col rounded-lg border p-3 text-left transition-all ${
                          isInCart
                            ? 'border-blue-300 bg-blue-50 opacity-75'
                            : isOutOfStock
                            ? 'border-gray-200 bg-gray-50 opacity-50 cursor-not-allowed'
                            : 'border-gray-200 bg-white hover:border-blue-300 hover:shadow-sm cursor-pointer'
                        }`}
                        aria-label={`Add ${product.name} to cart`}
                      >
                        {/* Stock badge */}
                        <span
                          className={`absolute top-2 right-2 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            isOutOfStock
                              ? 'bg-red-100 text-red-700'
                              : stock <= (product.min_stock_level || 0)
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-green-100 text-green-700'
                          }`}
                        >
                          {isOutOfStock
                            ? 'Out of stock'
                            : locationId
                            ? `${formatStock(stock)} here`
                            : `${formatStock(stock)} total`}
                        </span>

                        {/* In-cart indicator */}
                        {isInCart && (
                          <span className="absolute bottom-2 right-2 inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                            ✓ Added
                          </span>
                        )}

                        {/* Product info */}
                        <p className="text-sm font-medium text-gray-900 pr-20 leading-tight">
                          {product.name}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">{product.part_number}</p>
                        <div className="mt-auto pt-2 flex items-center justify-between">
                          <span className="text-sm font-semibold text-gray-900">
                            {formatCurrency(product.selling_price)}
                          </span>
                          {product.brand && (
                            <span className="text-xs text-gray-400 truncate ml-2">{product.brand}</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-3">
                    <p className="text-xs text-gray-500">
                      Showing {(catalogPage - 1) * catalogPageSize + 1}–{Math.min(catalogPage * catalogPageSize, catalogTotal)} of {catalogTotal}
                    </p>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        disabled={catalogPage <= 1}
                        onClick={() => setCatalogPage((p) => Math.max(1, p - 1))}
                        className="rounded px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Previous
                      </button>
                      <span className="px-2 py-1 text-xs text-gray-500">
                        {catalogPage} / {totalPages}
                      </span>
                      <button
                        type="button"
                        disabled={catalogPage >= totalPages}
                        onClick={() => setCatalogPage((p) => Math.min(totalPages, p + 1))}
                        className="rounded px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* RIGHT: Cart (1/3 width on desktop) */}
        <div id="cart-section" className="rounded-lg border border-gray-200 bg-white shadow-sm flex flex-col lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-120px)]">
          <div className="border-b border-gray-200 px-4 py-3">
            <h2 className="text-base font-semibold text-gray-900">
              Cart
              {lineItems.length > 0 && (
                <span className="ml-2 inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                  {lineItems.length}
                </span>
              )}
            </h2>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-2 min-h-0">
            {lineItems.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-sm text-gray-500">
                  Click items from the catalog to add them here
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {lineItems.map((item) => {
                  const exceedsStock = item.available_stock !== undefined && (item.quantity || 0) > item.available_stock;
                  return (
                    <div
                      key={item.id}
                      className={`rounded-md border p-3 ${exceedsStock ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-gray-900 truncate">{item.spare_part_name}{item.source_type === 'EXTERNAL' && <span className="ml-2 text-xs text-blue-700">External</span>}</p>
                          <p className="text-xs text-gray-500">{item.part_number}</p>
                          {item.source_type === 'EXTERNAL' && <div className="mt-1 text-xs text-blue-800">
                            <p>Supplier cost: {formatCurrency(Number(item.supplier_unit_cost) * Number(item.quantity || 0))}</p>
                            <p>Supplier payment: {formatCurrency(Number(item.supplier_amount_paid || 0))}</p>
                            <p>To change the supplying store or cost, remove and re-add this item.</p>
                          </div>}
                          {item.available_stock !== undefined && (
                            <p className={`text-xs mt-0.5 ${item.available_stock <= 0 ? 'text-red-600' : 'text-green-600'}`}>
                              Stock: {formatStock(item.available_stock)}
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeLineItem(item.id)}
                          className="ml-2 text-gray-400 hover:text-red-600"
                          aria-label={`Remove ${item.spare_part_name}`}
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2">
                        <div>
                          <label className="text-xs text-gray-500">Qty</label>
                          <input
                            type="number"
                            min={1}
                            className={`w-full rounded border px-2 py-1 text-sm ${exceedsStock ? 'border-red-400' : 'border-gray-300'} focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500`}
                            value={item.quantity}
                            onChange={(e) =>
                              updateLineItem(item.id, 'quantity', e.target.value === '' ? '' : Math.max(1, parseInt(e.target.value) || 1))
                            }
                            aria-label={`Quantity for ${item.spare_part_name}`}
                          />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500">Price</label>
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            className={`w-full rounded border px-2 py-1 text-sm ${item.cost_price && (item.unit_price || 0) < item.cost_price ? 'border-amber-400' : 'border-gray-300'} focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500`}
                            value={item.unit_price}
                            onChange={(e) =>
                              updateLineItem(item.id, 'unit_price', e.target.value === '' ? '' : parseFloat(e.target.value))
                            }
                            aria-label={`Unit price for ${item.spare_part_name}`}
                          />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500">Disc.</label>
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            value={item.discount_amount}
                            onChange={(e) =>
                              updateLineItem(item.id, 'discount_amount', e.target.value === '' ? '' : parseFloat(e.target.value))
                            }
                            aria-label={`Discount for ${item.spare_part_name}`}
                          />
                        </div>
                      </div>
                      {exceedsStock && (
                        <p className="text-xs text-red-600 mt-1">Exceeds available stock</p>
                      )}
                      {item.cost_price && (item.unit_price || 0) < item.cost_price && (
                        <p className="text-xs text-amber-600 mt-1">Below cost ({formatCurrency(item.cost_price)})</p>
                      )}
                      <div className="mt-1 text-right text-sm font-medium text-gray-900">
                        {formatCurrency(item.line_total)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Totals and actions */}
          {lineItems.length > 0 && (
            <div className="border-t border-gray-200 px-4 py-3 space-y-2">
              <div className="flex justify-between text-sm text-gray-600">
                <span>Subtotal:</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              {discountTotal > 0 && (
                <div className="flex justify-between text-sm text-gray-600">
                  <span>Discount:</span>
                  <span className="text-red-600">-{formatCurrency(discountTotal)}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-gray-200 pt-2 text-base font-bold text-gray-900">
                <span>Total:</span>
                <span>{formatCurrency(totalAmount)}</span>
              </div>
              {paymentType === 'CREDIT' && amountPaid && (
                <div className="flex justify-between text-sm text-gray-500">
                  <span>Balance due:</span>
                  <span>{formatCurrency(Math.max(0, totalAmount - Number(amountPaid)))}</span>
                </div>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div className="border-t border-gray-200 px-4 py-3 space-y-2">
            <Button
              className="w-full"
              onClick={handleSaveAndConfirm}
              isLoading={isConfirming}
              disabled={isSaving || lineItems.length === 0}
            >
              Confirm Sale
            </Button>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={handleSaveDraft}
                isLoading={isSaving}
                disabled={isConfirming || lineItems.length === 0}
              >
                Save Draft
              </Button>
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => router.push('/sales')}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
