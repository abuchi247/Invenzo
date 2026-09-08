'use client';

/**
 * Sale Detail Page
 *
 * Shows sale information, line items, and provides:
 * - Confirm button (if DRAFT) with stock validation feedback
 * - Return button (if CONFIRMED) with item selection for returns
 *
 * Requirements: 5.1, 5.3, 5.6, 5.7, 5.8
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { get, post } from '@/lib/api';
import {
  Button,
  Badge,
  Alert,
  Modal,
  Select,
  LoadingSpinner,
} from '@/components';
import type { BadgeVariant, SelectOption } from '@/components';
import type { Sale, SaleItem, SaleStatus, SaleReturnRequest } from '@/lib/types';
import { formatCurrency } from '@/lib/currency';
import { extractApiError } from '@/lib/validation/errors';
import { useRequirePermission } from '@/hooks/useRequirePermission';
import { useAuth } from '@/hooks/useAuth';
import { usePermissions } from '@/hooks/usePermissions';

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
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface ReturnItem {
  sale_item_id: string;
  quantity: number | '';
  max_quantity: number;
  part_name: string;
  reason: string;
  selected: boolean;
}

export default function SaleDetailPage() {
  const { allowed } = useRequirePermission('sales');
  const { hasRole } = useAuth();
  const { can } = usePermissions();

  const router = useRouter();
  const params = useParams();
  const saleId = params.id as string;

  const [sale, setSale] = useState<Sale | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Confirm state
  const [isConfirming, setIsConfirming] = useState(false);

  // Cancel state
  const [isCancelling, setIsCancelling] = useState(false);

  // Return state
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [returnItems, setReturnItems] = useState<ReturnItem[]>([]);
  const [isReturning, setIsReturning] = useState(false);
  const [returnError, setReturnError] = useState<string | null>(null);
  const [returnLocationId, setReturnLocationId] = useState('');
  const [returnLocations, setReturnLocations] = useState<Array<{ id: string; name: string }>>([]);

  // Invoice state
  const [isGeneratingInvoice, setIsGeneratingInvoice] = useState(false);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [invoiceFormat, setInvoiceFormat] = useState<'A4' | 'THERMAL'>('A4');

  const closeReturnModal = useCallback(() => {
    setShowReturnModal(false);
  }, []);

  // Fetch locations for return-to picker when modal opens
  useEffect(() => {
    if (!showReturnModal) return;
    async function fetchLocations() {
      try {
        const res = await get<{ data: Array<{ id: string; name: string }> }>('/locations');
        setReturnLocations(res.data);
        // Default to the sale's original location
        if (sale?.location_id) {
          setReturnLocationId(sale.location_id);
        }
      } catch {
        // Non-critical
      }
    }
    fetchLocations();
  }, [showReturnModal, sale?.location_id]);

  const fetchSale = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await get<Sale>(`/sales/${saleId}`);
      setSale(response);
    } catch (err: unknown) {
      const message = extractApiError(err, 'Failed to load sale details');
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [saleId]);

  useEffect(() => {
    fetchSale();
  }, [fetchSale]);

  // Check if invoice exists for this sale
  useEffect(() => {
    if (sale?.status === 'CONFIRMED' || sale?.status === 'RETURNED') {
      get<{ id: string }>(`/invoices/by-sale/${saleId}?format=${invoiceFormat}`)
        .then((inv) => setInvoiceId(inv.id))
        .catch(() => setInvoiceId(null));
    }
  }, [sale?.status, saleId, invoiceFormat]);

  const handleGenerateInvoice = async (overwrite = false) => {
    setIsGeneratingInvoice(true);
    setError(null);
    try {
      const result = await post<{ id: string }>('/invoices/generate', {
        sale_id: saleId,
        format: invoiceFormat,
        overwrite,
      });
      setInvoiceId(result.id);
      setSuccess(`Invoice ${overwrite ? 'regenerated' : 'generated'} successfully (${invoiceFormat} format)`);
    } catch (err: unknown) {
      let message = 'Failed to generate invoice';
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { data?: { detail?: string } } };
        if (typeof axiosErr.response?.data?.detail === 'string') {
          message = axiosErr.response.data.detail;
        }
      }
      setError(message);
    } finally {
      setIsGeneratingInvoice(false);
    }
  };


  const handleDownloadPdf = async () => {
    if (!invoiceId) return;
    try {
      // Use the authenticated API client to fetch the PDF as a blob
      const { default: api } = await import('@/lib/api');
      const response = await api.get(`/invoices/${invoiceId}/pdf`, {
        responseType: 'blob',
      });
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      // Clean up the blob URL after a delay
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch {
      setError('Failed to download invoice PDF');
    }
  };

  const handleConfirm = async () => {
    setIsConfirming(true);
    setError(null);
    try {
      await post<Sale>(`/sales/${saleId}/confirm`);
      setSuccess('Sale confirmed successfully. Stock has been deducted.');
      fetchSale();
    } catch (err: unknown) {
      const message = extractApiError(err, 'Failed to confirm sale.');
      setError(message);
    } finally {
      setIsConfirming(false);
    }
  };

  const handleCancel = async () => {
    if (!confirm('Are you sure you want to cancel this sale? This cannot be undone.')) return;
    setIsCancelling(true);
    setError(null);
    try {
      await post<Sale>(`/sales/${saleId}/cancel`, {});
      setSuccess('Sale cancelled.');
      fetchSale();
    } catch (err: unknown) {
      const message =
        err && typeof err === 'object' && 'response' in err
          ? ((err as { response?: { data?: { detail?: string } } }).response?.data?.detail ?? 'Failed to cancel sale.')
          : 'Failed to cancel sale.';
      setError(message);
    } finally {
      setIsCancelling(false);
    }
  };

  const openReturnModal = () => {
    if (!sale?.items) return;
    const items: ReturnItem[] = sale.items
      .filter((item) => {
        const returned = Number(item.returned_quantity || 0);
        const remaining = Number(item.quantity) - returned;
        return remaining > 0;
      })
      .map((item) => {
        const returned = Number(item.returned_quantity || 0);
        const remaining = Number(item.quantity) - returned;
        return {
          sale_item_id: item.id,
          quantity: remaining,
          max_quantity: remaining,
          part_name: item.spare_part?.name || `Item ${item.id.slice(0, 8)}`,
          reason: '',
          selected: false,
        };
      });
    setReturnItems(items);
    setReturnError(null);
    setShowReturnModal(true);
  };

  const toggleReturnItem = (index: number) => {
    setReturnItems((items) =>
      items.map((item, i) =>
        i === index ? { ...item, selected: !item.selected } : item
      )
    );
  };

  const updateReturnQuantity = (index: number, qty: number | '') => {
    setReturnItems((items) =>
      items.map((item, i) =>
        i === index ? { ...item, quantity: qty === '' ? '' : Math.min(Math.max(1, qty), item.max_quantity) } : item
      )
    );
  };

  const updateReturnReason = (index: number, reason: string) => {
    setReturnItems((items) =>
      items.map((item, i) =>
        i === index ? { ...item, reason } : item
      )
    );
  };

  const handleReturn = async () => {
    const selectedItems = returnItems.filter((item) => item.selected);
    if (selectedItems.length === 0) {
      setReturnError('Please select at least one item to return.');
      return;
    }

    setIsReturning(true);
    setReturnError(null);
    try {
      const payload: SaleReturnRequest = {
        items: selectedItems.map((item) => ({
          sale_item_id: item.sale_item_id,
          quantity: item.quantity || 1,
          reason: item.reason || undefined,
        })),
        return_location_id: returnLocationId && returnLocationId !== sale?.location_id
          ? returnLocationId
          : undefined,
      };
      await post<Sale>(`/sales/${saleId}/return`, payload);
      setShowReturnModal(false);
      setSuccess('Return processed successfully. Stock has been restored.');
      fetchSale();
    } catch (err: unknown) {
      const message = extractApiError(err, 'Failed to process return.');
      setReturnError(message);
    } finally {
      setIsReturning(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error && !sale) {
    return (
      <div className="p-6">
        <Alert variant="error">{error}</Alert>
        <div className="mt-4">
          <Button variant="secondary" onClick={() => router.push('/sales')}>
            Back to Sales
          </Button>
        </div>
      </div>
    );
  }

  if (!sale) return null;

  if (!allowed) return null;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            Sale {sale.invoice_number || `DRAFT-${sale.id.slice(0, 8)}`}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Created {formatDate(sale.created_at)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {sale.status === 'DRAFT' && (
            <Button
              variant="secondary"
              onClick={() => router.push(`/sales/${saleId}/edit`)}
            >
              Edit Items
            </Button>
          )}
          {sale.status === 'DRAFT' && (
            <Button
              onClick={handleConfirm}
              isLoading={isConfirming}
            >
              Confirm Sale
            </Button>
          )}
          {sale.status === 'DRAFT' && (
            <Button
              variant="danger"
              onClick={handleCancel}
              isLoading={isCancelling}
            >
              Cancel Sale
            </Button>
          )}
          {sale.status === 'CONFIRMED' && can('sales_returns') && (
            <Button
              variant="danger"
              onClick={openReturnModal}
            >
              Process Return
            </Button>
          )}
          <Button variant="secondary" onClick={() => router.push('/sales')}>
            Back to Sales
          </Button>
        </div>
      </div>

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

      {/* Sale info card */}
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Sale Information</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-sm font-medium text-gray-500">Status</p>
            <div className="mt-1">{getStatusBadge(sale.status)}</div>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-500">Customer</p>
            <p className="mt-1 text-sm text-gray-900">
              {sale.customer_name ?? 'Walk-in'}
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-500">Payment Type</p>
            <p className="mt-1 text-sm capitalize text-gray-900">{sale.payment_type}</p>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-500">Invoice Number</p>
            <p className="mt-1 text-sm text-gray-900">
              {sale.invoice_number || 'Not assigned (draft)'}
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-500">Issued by</p>
            <p className="mt-1 text-sm text-gray-900">
              {sale.created_by_username ?? '—'}
            </p>
          </div>
        </div>
      </div>

      {/* Line items */}
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Line Items</h2>
        {sale.items && sale.items.length > 0 ? (
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
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {sale.items.map((item) => (
                  <tr key={item.id}>
                    <td className="whitespace-nowrap px-4 py-3 text-sm">
                      <p className="font-medium text-gray-900">
                        {item.spare_part?.name ?? `Part ${item.spare_part_id.slice(0, 8)}`}
                      </p>
                      {item.spare_part?.part_number && (
                        <p className="text-gray-500">{item.spare_part.part_number}</p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">
                      {item.quantity}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">
                      {formatCurrency(item.unit_price)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">
                      {item.discount_amount > 0
                        ? formatCurrency(item.discount_amount)
                        : '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-medium text-gray-900">
                      {formatCurrency(item.line_total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-gray-500">No line items.</p>
        )}

        {/* Totals */}
        <div className="mt-4 flex justify-end">
          <div className="w-full max-w-xs space-y-2 rounded-md bg-gray-50 p-4">
            <div className="flex justify-between text-sm text-gray-600">
              <span>Subtotal:</span>
              <span>{formatCurrency(sale.subtotal)}</span>
            </div>
            {sale.discount_total > 0 && (
              <div className="flex justify-between text-sm text-gray-600">
                <span>Discount:</span>
                <span className="text-red-600">-{formatCurrency(sale.discount_total)}</span>
              </div>
            )}
            {sale.tax_amount > 0 && (
              <div className="flex justify-between text-sm text-gray-600">
                <span>Tax:</span>
                <span>{formatCurrency(sale.tax_amount)}</span>
              </div>
            )}
            <div className="flex justify-between border-t border-gray-200 pt-2 text-base font-semibold text-gray-900">
              <span>Total:</span>
              <span>{formatCurrency(sale.total_amount)}</span>
            </div>
            {sale.payment_type === 'CREDIT' && (
              <>
                <div className="flex justify-between text-sm text-gray-600">
                  <span>Paid at Checkout:</span>
                  <span>{formatCurrency(sale.amount_paid || 0)}</span>
                </div>
                {(() => {
                  const totalReturned = sale.items?.reduce((sum, item) => {
                    const returned = Number(item.returned_quantity || 0);
                    return sum + returned * Number(item.unit_price);
                  }, 0) ?? 0;
                  const netOwed = Number(sale.total_amount) - Number(sale.amount_paid || 0) - totalReturned;
                  return (
                    <>
                      {totalReturned > 0 && (
                        <div className="flex justify-between text-sm text-green-600">
                          <span>Returned:</span>
                          <span>-{formatCurrency(totalReturned)}</span>
                        </div>
                      )}
                      <div className="flex justify-between text-sm font-semibold text-red-600">
                        <span>Balance on this sale:</span>
                        <span>{formatCurrency(Math.max(0, netOwed))}</span>
                      </div>
                    </>
                  );
                })()}
                <p className="text-xs text-gray-400 mt-1">
                  See the customer&apos;s Credit Ledger for their total account balance.
                </p>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Return Summary - show if any items have been returned */}
      {sale.items && sale.items.some((item) => Number(item.returned_quantity || 0) > 0) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 sm:p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-amber-900">Return Summary</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-amber-200">
              <thead className="bg-amber-100/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-amber-700">Part</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-amber-700">Sold</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-amber-700">Returned</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-amber-700">Kept</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-amber-700">Refund Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-amber-100">
                {sale.items.filter((item) => Number(item.returned_quantity || 0) > 0).map((item) => {
                  const returned = Number(item.returned_quantity || 0);
                  const sold = Number(item.quantity);
                  const kept = sold - returned;
                  const unitPrice = Number(item.unit_price);
                  const refund = returned * unitPrice;
                  return (
                    <tr key={item.id}>
                      <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900">
                        {item.spare_part?.name || 'Unknown Part'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-right text-gray-700">{sold}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-right text-red-600 font-medium">{returned}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-right text-gray-700">{kept}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-right text-red-600 font-medium">
                        {formatCurrency(refund)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex justify-end">
            <div className="w-full max-w-xs space-y-2 rounded-md bg-white p-4 border border-amber-200">
              {(() => {
                const goodsReturnedValue = sale.items.reduce((sum, item) => {
                  const returned = Number(item.returned_quantity || 0);
                  return sum + returned * Number(item.unit_price);
                }, 0);
                const amountPaid = Number(sale.amount_paid || 0);
                const totalAmount = Number(sale.total_amount);
                // Cash refund = min(amount paid, goods returned value)
                const cashRefund = Math.min(amountPaid, goodsReturnedValue);
                // Credit reversed = goods returned value - cash refund
                const creditReversed = goodsReturnedValue - cashRefund;
                // Net value of goods kept
                const netSaleValue = totalAmount - goodsReturnedValue;
                // Outstanding balance = what customer still owes (only for credit)
                const outstandingBalance = Math.max(0, netSaleValue - amountPaid);

                return (
                  <>
                    <div className="flex justify-between text-sm text-gray-600">
                      <span>Goods Returned Value:</span>
                      <span>{formatCurrency(goodsReturnedValue)}</span>
                    </div>
                    {cashRefund > 0 && (
                      <div className="flex justify-between text-sm text-green-700 font-medium">
                        <span>Cash Refund to Customer:</span>
                        <span>{formatCurrency(cashRefund)}</span>
                      </div>
                    )}
                    {creditReversed > 0 && (
                      <div className="flex justify-between text-sm text-blue-700">
                        <span>Credit Balance Reversed:</span>
                        <span>{formatCurrency(creditReversed)}</span>
                      </div>
                    )}
                    <div className="flex justify-between border-t border-amber-200 pt-2 text-base font-semibold text-gray-900">
                      <span>Net Sale Value:</span>
                      <span>{formatCurrency(Math.max(0, netSaleValue))}</span>
                    </div>
                    {outstandingBalance > 0 && (
                      <div className="flex justify-between text-sm text-red-700 font-medium mt-1">
                        <span>Outstanding Balance:</span>
                        <span>{formatCurrency(outstandingBalance)}</span>
                      </div>
                    )}
                    {amountPaid >= netSaleValue && netSaleValue > 0 && (
                      <div className="flex justify-between text-sm text-green-700 mt-1">
                        <span>Status:</span>
                        <span>Fully Paid</span>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Invoice Section */}
      {(sale.status === 'CONFIRMED' || sale.status === 'RETURNED') && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 sm:p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Invoice</h2>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="w-full sm:w-48">
              <Select
                label="Format"
                options={[
                  { value: 'A4', label: 'A4 (Full page)' },
                  { value: 'THERMAL', label: 'Thermal (80mm receipt)' },
                ] as SelectOption[]}
                value={invoiceFormat}
                onChange={(e) => setInvoiceFormat(e.target.value as 'A4' | 'THERMAL')}
              />
            </div>
            {invoiceId ? (
              <div className="flex gap-2">
                <Button onClick={handleDownloadPdf}>
                  Download PDF
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => handleGenerateInvoice(true)}
                  isLoading={isGeneratingInvoice}
                >
                  Regenerate
                </Button>
              </div>
            ) : (
              <Button onClick={() => handleGenerateInvoice(false)} isLoading={isGeneratingInvoice}>
                Generate Invoice
              </Button>
            )}
          </div>
          {(sale.status === 'RETURNED' || (sale.items && sale.items.some((item) => Number(item.returned_quantity || 0) > 0))) && (
            <div className="mt-3 flex items-center gap-3">
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    const { default: apiClient } = await import('@/lib/api');
                    const response = await apiClient.post(`/invoices/credit-note/${saleId}`, {}, {
                      responseType: 'blob',
                    });
                    const blob = new Blob([response.data], { type: 'application/pdf' });
                    const url = URL.createObjectURL(blob);
                    window.open(url, '_blank');
                    setTimeout(() => URL.revokeObjectURL(url), 30000);
                  } catch {
                    setError('Failed to generate credit note');
                  }
                }}
              >
                Download Credit Note
              </Button>
              <span className="text-sm text-gray-500">Printable refund document for this return</span>
            </div>
          )}
        </div>
      )}

      {/* Return Modal */}
      <Modal
        isOpen={showReturnModal}
        onClose={closeReturnModal}
        title="Process Return"
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={closeReturnModal}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleReturn}
              isLoading={isReturning}
            >
              Process Return
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {returnError && (
            <Alert variant="error" onClose={() => setReturnError(null)}>
              {returnError}
            </Alert>
          )}
          <p className="text-sm text-gray-600">
            Select items to return and specify the quantity for each.
          </p>
          {returnLocations.length > 1 && (
            <Select
              label="Return to Location"
              options={[
                ...returnLocations.map((loc) => ({
                  value: loc.id,
                  label: loc.id === sale?.location_id ? `${loc.name} (original)` : loc.name,
                })),
              ]}
              value={returnLocationId}
              onChange={(e) => setReturnLocationId(e.target.value)}
            />
          )}
          <div className="max-h-80 overflow-y-auto space-y-3">
            {returnItems.map((item, index) => (
              <div
                key={item.sale_item_id}
                className={`rounded-md border p-3 ${
                  item.selected ? 'border-blue-300 bg-blue-50' : 'border-gray-200'
                }`}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={item.selected}
                    onChange={() => toggleReturnItem(index)}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    aria-label={`Select ${item.part_name} for return`}
                  />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-900">{item.part_name}</p>
                    <p className="text-xs text-gray-500">
                      Max returnable: {item.max_quantity}
                    </p>
                  </div>
                  {item.selected && (
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-500">Qty:</label>
                      <input
                        type="number"
                        min={1}
                        max={item.max_quantity}
                        value={item.quantity}
                        onChange={(e) =>
                          updateReturnQuantity(index, e.target.value === '' ? '' : parseInt(e.target.value) || 1)
                        }
                        className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        aria-label={`Return quantity for ${item.part_name}`}
                      />
                    </div>
                  )}
                </div>
                {item.selected && (
                  <div className="mt-2 ml-7">
                    <input
                      type="text"
                      placeholder="Reason for return (optional)"
                      value={item.reason}
                      onChange={(e) => updateReturnReason(index, e.target.value)}
                      className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      aria-label={`Return reason for ${item.part_name}`}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}
