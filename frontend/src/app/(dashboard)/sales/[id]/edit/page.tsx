'use client';

/**
 * Edit Draft Sale Page
 *
 * Loads an existing draft sale and allows editing customer, location, payment type,
 * and line items. Supports save (PUT) and save & confirm workflows.
 * Redirects away if the sale is not in draft status.
 *
 * Requirements: 5.1, 5.3, 5.4, 5.6, 5.7
 */

import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { get, post, put } from '@/lib/api';
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
}

const SALE_PAYMENT_OPTIONS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CREDIT', label: 'Credit' },
];

export default function EditSalePage() {
  const { allowed } = useRequirePermission('sales');

  const router = useRouter();
  const params = useParams();
  const saleId = params.id as string;

  // Loading state for initial data fetch
  const [isLoading, setIsLoading] = useState(true);

  // Form state
  const [customerId, setCustomerId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [paymentType, setPaymentType] = useState<string>('CASH');
  const [amountPaid, setAmountPaid] = useState<number | ''>('');
  const [lineItems, setLineItems] = useState<LineItem[]>([]);

  // Reference data
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);

  // Part search
  const [partSearch, setPartSearch] = useState('');
  const [partResults, setPartResults] = useState<SparePart[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showPartDropdown, setShowPartDropdown] = useState(false);

  // Actions
  const [isSaving, setIsSaving] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Fetch reference data and sale data
  useEffect(() => {
    async function fetchData() {
      try {
        const [customersRes, locationsRes, sale] = await Promise.all([
          get<{ data: Customer[]; meta: { page: number; total: number; page_size: number } }>('/customers'),
          get<{ data: Location[]; meta: { page: number; total: number; page_size: number } }>('/locations'),
          get<Sale>(`/sales/${saleId}`),
        ]);
        setCustomers(customersRes.data.filter((c: Customer) => c.account_status !== 'closed'));
        setLocations(locationsRes.data);

        // Redirect if not draft
        if (sale.status !== 'DRAFT') {
          router.replace(`/sales/${saleId}`);
          return;
        }

        // Pre-populate form fields
        setCustomerId(sale.customer_id || '');
        setLocationId(sale.location_id);
        setPaymentType(sale.payment_type.toUpperCase());
        if (sale.amount_paid && sale.amount_paid > 0) {
          setAmountPaid(sale.amount_paid);
        }

        // Map sale items to line items
        if (sale.items && sale.items.length > 0) {
          const mappedItems: LineItem[] = sale.items.map((item) => ({
            id: item.id || crypto.randomUUID(),
            spare_part_id: item.spare_part_id || '',
            source_type: item.source_type,
            external_description: item.external_description,
            external_part_number: item.external_part_number,
            supplier_id: item.supplier_id,
            supplier_unit_cost: item.supplier_unit_cost,
            supplier_amount_paid: item.supplier_amount_paid,
            spare_part_name: item.external_description || item.spare_part?.name || 'Unknown Part',
            part_number: item.external_part_number || item.spare_part?.part_number || '',
            quantity: item.quantity,
            unit_price: item.unit_price,
            discount_amount: item.discount_amount || '',
            line_total: item.line_total,
          }));
          setLineItems(mappedItems);
        }
      } catch {
        setError('Failed to load sale data.');
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  }, [saleId, router]);

  // Part search with debounce
  useEffect(() => {
    if (!partSearch || partSearch.length < 2) {
      setPartResults([]);
      setShowPartDropdown(false);
      return;
    }

    const timeout = setTimeout(async () => {
      setIsSearching(true);
      try {
        const searchParams = new URLSearchParams();
        searchParams.set('search', partSearch);
        searchParams.set('page_size', '10');
        const response = await get<{ data: SparePart[]; meta: { page: number; total: number; page_size: number } }>(
          `/spare-parts?${searchParams.toString()}`
        );
        setPartResults(response.data);
        setShowPartDropdown(true);
      } catch {
        setPartResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => clearTimeout(timeout);
  }, [partSearch]);

  const addLineItem = (part: SparePart) => {
    // Don't add duplicate
    if (lineItems.some((li) => li.spare_part_id === part.id)) {
      setPartSearch('');
      setShowPartDropdown(false);
      return;
    }

    const newItem: LineItem = {
      id: crypto.randomUUID(),
      spare_part_id: part.id,
      spare_part_name: part.name,
      part_number: part.part_number,
      quantity: 1,
      unit_price: part.selling_price,
      discount_amount: '',
      line_total: part.selling_price,
    };

    setLineItems([...lineItems, newItem]);
    setPartSearch('');
    setShowPartDropdown(false);
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

  const handleSave = async () => {
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
      const payload = buildSalePayload();
      await put<Sale>(`/sales/${saleId}`, payload);
      setSuccess('Sale updated successfully.');
      setTimeout(() => {
        router.push(`/sales/${saleId}`);
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
      // First update the sale
      const payload = buildSalePayload();
      await put<Sale>(`/sales/${saleId}`, payload);

      // Then confirm it
      await post<Sale>(`/sales/${saleId}/confirm`);
      setSuccess('Sale confirmed successfully. Inventory and supplier balances have been updated.');
      setTimeout(() => {
        router.push(`/sales/${saleId}`);
      }, 1000);
    } catch (err: unknown) {
      const message = extractApiError(err, 'Failed to confirm sale.');
      setError(message);
    } finally {
      setIsConfirming(false);
    }
  };

  const customerOptions = useMemo(
    () => [
      { value: '', label: 'Walk-in (Cash)' },
      ...customers.map((c: { id: string; name: string }) => ({ value: c.id, label: c.name })),
    ],
    [customers]
  );

  const locationOptions = useMemo(
    () => locations.map((l: { id: string; name: string }) => ({ value: l.id, label: l.name })),
    [locations]
  );

  const paymentOptions = SALE_PAYMENT_OPTIONS;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!allowed) return null;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Edit Draft Sale</h1>
          <p className="mt-1 text-sm text-gray-500">
            Update line items and save or confirm to deduct stock
          </p>
        </div>
        <Button variant="secondary" onClick={() => router.push(`/sales/${saleId}`)}>
          Back to Sale
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

      {/* Sale details form */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 sm:p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Sale Details</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
            onChange={(e) => setLocationId(e.target.value)}
            required
          />
          <Select
            label="Payment Type"
            options={paymentOptions}
            value={paymentType}
            onChange={(e) => setPaymentType(e.target.value)}
          />
        </div>

        {/* Amount Paid at Checkout (only for credit sales) */}
        {paymentType === 'CREDIT' && (
          <div className="mt-4 max-w-xs">
            <Input
              label="Amount Paid at Checkout"
              type="number"
              min={0}
              max={totalAmount > 0 ? totalAmount : undefined}
              step={0.01}
              value={amountPaid}
              onChange={(e) => setAmountPaid(e.target.value === '' ? '' : parseFloat(e.target.value))}
              placeholder="0.00 (optional — leave empty if fully on credit)"
              helperText={totalAmount > 0 ? `Balance due: ${formatCurrency(Math.max(0, totalAmount - (Number(amountPaid) || 0)))}` : undefined}
              error={Number(amountPaid) > totalAmount && totalAmount > 0 ? `Cannot exceed total (${formatCurrency(totalAmount)})` : undefined}
            />
          </div>
        )}
      </div>

      {/* Line items */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 sm:p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Line Items</h2>

        {/* Part search */}
        <div className="relative mb-4">
          <Input
            label="Search Parts"
            placeholder="Type part name, number, or barcode to search..."
            value={partSearch}
            onChange={(e) => setPartSearch(e.target.value)}
            onFocus={() => partResults.length > 0 && setShowPartDropdown(true)}
            aria-label="Search parts to add"
          />
          {isSearching && (
            <div className="absolute right-3 top-9">
              <LoadingSpinner size="sm" />
            </div>
          )}

          {/* Search results dropdown */}
          {showPartDropdown && partResults.length > 0 && (
            <div className="absolute z-10 mt-1 w-full rounded-md border border-gray-200 bg-white shadow-lg">
              <ul className="max-h-60 overflow-y-auto py-1">
                {partResults.map((part) => (
                  <li key={part.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-4 py-2 text-left text-sm hover:bg-gray-50"
                      onClick={() => addLineItem(part)}
                    >
                      <div>
                        <span className="font-medium text-gray-900">{part.name}</span>
                        <span className="ml-2 text-gray-500">({part.part_number})</span>
                      </div>
                      <span className="text-gray-600">
                        {formatCurrency(part.selling_price)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {showPartDropdown && partResults.length === 0 && partSearch.length >= 2 && !isSearching && (
            <div className="absolute z-10 mt-1 w-full rounded-md border border-gray-200 bg-white p-3 shadow-lg">
              <p className="text-sm text-gray-500">No parts found matching &quot;{partSearch}&quot;</p>
            </div>
          )}
        </div>

        {/* Line items table */}
        {lineItems.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Part
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Qty
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Unit Price
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Discount
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                    Line Total
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {lineItems.map((item) => (
                  <tr key={item.id}>
                    <td className="whitespace-nowrap px-4 py-3 text-sm">
                      <div>
                        <p className="font-medium text-gray-900">{item.spare_part_name}{item.source_type === 'EXTERNAL' && <span className="ml-2 text-xs text-blue-700">External</span>}</p>
                        <p className="text-gray-500">{item.part_number}</p>
                          {item.source_type === 'EXTERNAL' && <div className="mt-1 text-xs text-blue-800">
                            <p>Supplier cost: {formatCurrency(Number(item.supplier_unit_cost) * Number(item.quantity || 0))}</p>
                            <p>Supplier payment: {formatCurrency(Number(item.supplier_amount_paid || 0))}</p>
                            <p>To change the supplying store or cost, remove and re-add this item.</p>
                          </div>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number"
                        min={1}
                        className="w-20 rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        value={item.quantity}
                        onChange={(e) =>
                          updateLineItem(item.id, 'quantity', e.target.value === '' ? '' : Math.max(1, parseInt(e.target.value) || 1))
                        }
                        aria-label={`Quantity for ${item.spare_part_name}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        className="w-28 rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        value={item.unit_price}
                        onChange={(e) =>
                          updateLineItem(item.id, 'unit_price', e.target.value === '' ? '' : parseFloat(e.target.value))
                        }
                        aria-label={`Unit price for ${item.spare_part_name}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        className="w-28 rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        value={item.discount_amount}
                        onChange={(e) =>
                          updateLineItem(item.id, 'discount_amount', e.target.value === '' ? '' : parseFloat(e.target.value))
                        }
                        aria-label={`Discount for ${item.spare_part_name}`}
                      />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-medium text-gray-900">
                      {formatCurrency(item.line_total)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => removeLineItem(item.id)}
                        className="text-red-600 hover:text-red-800 text-sm font-medium"
                        aria-label={`Remove ${item.spare_part_name}`}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-md border-2 border-dashed border-gray-300 p-8 text-center">
            <p className="text-sm text-gray-500">
              No items added yet. Search for parts above to add line items.
            </p>
          </div>
        )}

        {/* Totals */}
        {lineItems.length > 0 && (
          <div className="mt-4 flex justify-end">
            <div className="w-full max-w-xs space-y-2 rounded-md bg-gray-50 p-4">
              <div className="flex justify-between text-sm text-gray-600">
                <span>Subtotal:</span>
                <span>
                  {formatCurrency(subtotal)}
                </span>
              </div>
              <div className="flex justify-between text-sm text-gray-600">
                <span>Discount:</span>
                <span className="text-red-600">
                  -{formatCurrency(discountTotal)}
                </span>
              </div>
              <div className="flex justify-between border-t border-gray-200 pt-2 text-base font-semibold text-gray-900">
                <span>Total:</span>
                <span>
                  {formatCurrency(totalAmount)}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-end gap-3">
        <Button
          variant="secondary"
          onClick={() => router.push(`/sales/${saleId}`)}
        >
          Cancel
        </Button>
        <Button
          variant="secondary"
          onClick={handleSave}
          isLoading={isSaving}
          disabled={isConfirming}
        >
          Save
        </Button>
        <Button
          onClick={handleSaveAndConfirm}
          isLoading={isConfirming}
          disabled={isSaving}
        >
          Save &amp; Confirm
        </Button>
      </div>
    </div>
  );
}
