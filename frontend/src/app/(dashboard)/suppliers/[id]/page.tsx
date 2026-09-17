'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { get, put, post } from '@/lib/api';
import {
  Button,
  Input,
  Select,
  Badge,
  Modal,
  Alert,
  LoadingSpinner,
} from '@/components';
import type { SelectOption } from '@/components';
import type {
  Supplier,
  SupplierUpdate,
  PurchaseOrder,
  PaginatedResponse,
  AccountStatus,
} from '@/lib/types';
import { formatCurrency } from '@/lib/currency';
import { extractApiError } from '@/lib/validation/errors';
import { useRequirePermission } from '@/hooks/useRequirePermission';

interface SupplierBalance {
  supplier_id: string;
  supplier_name: string;
  total_balance: number | string;
  aging: Record<string, number>;
}

function getStatusBadge(status: AccountStatus): React.ReactNode {
  const variants: Record<AccountStatus, 'success' | 'warning' | 'danger'> = {
    active: 'success',
    suspended: 'warning',
    closed: 'danger',
  };
  const labels: Record<AccountStatus, string> = {
    active: 'Active',
    suspended: 'Suspended',
    closed: 'Closed',
  };
  return <Badge variant={variants[status]}>{labels[status]}</Badge>;
}

function getPOStatusBadge(status: string): React.ReactNode {
  const normalized = status.toLowerCase();
  const variantMap: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'default'> = {
    draft: 'default',
    approved: 'info',
    ordered: 'info',
    partially_received: 'warning',
    received: 'success',
    cancelled: 'danger',
  };
  const variant = variantMap[normalized] || 'default';
  const label = normalized.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return <Badge variant={variant}>{label}</Badge>;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function SupplierDetailPage() {
  const { allowed } = useRequirePermission('purchasing');

  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  // Supplier state
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [isPaying, setIsPaying] = useState(false);
  const [ledger, setLedger] = useState<Array<{id: string; created_at: string; transaction_type: string; amount: string; reference_type: string; notes?: string}>>([]);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [ledgerError, setLedgerError] = useState('');
  const fetchLedger = useCallback(async () => {
    try { setLedger((await get<{data: typeof ledger}>(`/suppliers/${id}/ledger?page=${ledgerPage}`)).data); setLedgerError(''); }
    catch { setLedgerError('Could not load supplier transactions.'); }
  }, [id, ledgerPage]);
  useEffect(() => { fetchLedger(); }, [fetchLedger]);

  // Balance state
  const [balance, setBalance] = useState<SupplierBalance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(true);

  // Payment schedule state
  interface PaymentEntry {
    id: string;
    amount: number;
    outstanding: number;
    due_date: string;
    created_at: string;
    notes: string | null;
    days_overdue: number;
    days_until_due: number;
    status: 'overdue' | 'upcoming';
  }
  interface PaymentSchedule {
    supplier_id: string;
    supplier_name: string;
    payment_terms: string | null;
    overdue: PaymentEntry[];
    upcoming: PaymentEntry[];
    total_overdue: number;
    total_upcoming: number;
  }
  const [paymentSchedule, setPaymentSchedule] = useState<PaymentSchedule | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(true);

  // Purchase orders state
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [posLoading, setPosLoading] = useState(true);

  // Edit modal state
  const [showEditModal, setShowEditModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<SupplierUpdate>({});

  const closeEditModal = useCallback(() => {
    setShowEditModal(false);
    setEditError(null);
  }, []);

  const fetchSupplier = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await get<Supplier>(`/suppliers/${id}`);
      setSupplier(data);
    } catch (err: unknown) {
      const message = extractApiError(err, 'Failed to load supplier');
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  const fetchBalance = useCallback(async () => {
    setBalanceLoading(true);
    try {
      const data = await get<SupplierBalance>(`/suppliers/${id}/balance`);
      setBalance(data);
    } catch {
      // Balance endpoint may not be available for all suppliers
      setBalance(null);
    } finally {
      setBalanceLoading(false);
    }
  }, [id]);

  const fetchPurchaseOrders = useCallback(async () => {
    setPosLoading(true);
    try {
      const response = await get<PaginatedResponse<PurchaseOrder>>(
        `/purchase-orders?supplier_id=${id}`
      );
      setPurchaseOrders(response.data);
    } catch {
      setPurchaseOrders([]);
    } finally {
      setPosLoading(false);
    }
  }, [id]);

  const fetchPaymentSchedule = useCallback(async () => {
    setScheduleLoading(true);
    try {
      const data = await get<PaymentSchedule>(`/suppliers/${id}/payment-schedule`);
      setPaymentSchedule(data);
    } catch {
      setPaymentSchedule(null);
    } finally {
      setScheduleLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchSupplier();
    fetchBalance();
    fetchPurchaseOrders();
    fetchPaymentSchedule();
  }, [fetchSupplier, fetchBalance, fetchPurchaseOrders, fetchPaymentSchedule]);

  const openEditModal = () => {
    if (!supplier) return;
    setEditForm({
      name: supplier.name,
      contact_person: supplier.contact_person || '',
      phone: supplier.phone || '',
      email: supplier.email || '',
      address: supplier.address || '',
      tax_id: supplier.tax_id || '',
      payment_terms: supplier.payment_terms || '',
      account_status: supplier.account_status,
    });
    setEditError(null);
    setShowEditModal(true);
  };

  const handleSave = async () => {
    setIsSaving(true);
    setEditError(null);
    try {
      const updated = await put<Supplier>(`/suppliers/${id}`, editForm);
      setSupplier(updated);
      setShowEditModal(false);
    } catch (err: unknown) {
      const message = extractApiError(err, 'Failed to update supplier');
      setEditError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const statusOptions: SelectOption[] = [
    { value: 'active', label: 'Active' },
    { value: 'suspended', label: 'Suspended' },
    { value: 'closed', label: 'Closed' },
  ];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoadingSpinner />
      </div>
    );
  }

  if (error || !supplier) {
    return (
      <div className="space-y-4 px-4 sm:px-0">
        <Alert variant="error">{error || 'Supplier not found'}</Alert>
        <Button variant="secondary" onClick={() => router.push('/suppliers')}>
          Back to Suppliers
        </Button>
      </div>
    );
  }

  if (!allowed) return null;

  return (
    <div className="space-y-6 px-4 sm:px-0">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => router.push('/suppliers')}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
            aria-label="Back to suppliers"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{supplier.name}</h1>
            <div className="mt-1 flex items-center gap-2">
              {getStatusBadge(supplier.account_status)}
              <span className="text-sm text-gray-500">
                Added {formatDate(supplier.created_at)}
              </span>
            </div>
          </div>
        </div>
        <Button onClick={openEditModal}>Edit Supplier</Button>
      </div>

      {/* Profile Card + Balance */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Supplier Profile Card */}
        <div className="lg:col-span-2 rounded-lg border border-gray-200 bg-white p-4 sm:p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Supplier Details</h2>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-medium text-gray-500">Name</dt>
              <dd className="mt-1 text-sm text-gray-900">{supplier.name}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Contact Person</dt>
              <dd className="mt-1 text-sm text-gray-900">{supplier.contact_person || '—'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Phone</dt>
              <dd className="mt-1 text-sm text-gray-900">{supplier.phone || '—'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Email</dt>
              <dd className="mt-1 text-sm text-gray-900">{supplier.email || '—'}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-sm font-medium text-gray-500">Address</dt>
              <dd className="mt-1 text-sm text-gray-900">{supplier.address || '—'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Tax ID</dt>
              <dd className="mt-1 text-sm text-gray-900">{supplier.tax_id || '—'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Payment Terms</dt>
              <dd className="mt-1 text-sm text-gray-900">{supplier.payment_terms || '—'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Account Status</dt>
              <dd className="mt-1">{getStatusBadge(supplier.account_status)}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Created</dt>
              <dd className="mt-1 text-sm text-gray-900">{formatDate(supplier.created_at)}</dd>
            </div>
          </dl>
        </div>

        {/* Balance Card */}
        <div className="rounded-lg border border-gray-200 bg-white p-4 sm:p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Balance</h2>
          {balanceLoading ? (
            <div className="flex items-center justify-center py-8">
              <LoadingSpinner />
            </div>
          ) : balance ? (
            <div className="text-center">
              <p className="text-3xl font-bold text-gray-900">
                {formatCurrency(balance.total_balance)}
              </p>
              <p className="mt-1 text-sm text-gray-500">
                Outstanding balance
              </p>
            </div>
          ) : (
            <p className="text-sm text-gray-500 text-center py-8">
              Balance information unavailable
            </p>
          )}
        </div>
      </div>

      <div className="rounded-lg border bg-white p-4 space-y-3">
        <h2 className="font-semibold">Supplier payments and transactions</h2>
        <p className="text-sm text-gray-600">Record money already paid to this store. This updates the supplier balance separately from customer payments.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Payment amount" type="number" min="0.01" step="0.01" value={paymentAmount} disabled={isPaying} onChange={e => {setPaymentAmount(e.target.value); setPaymentReference('');}} />
          <Input label="Payment reference / notes" maxLength={1000} value={paymentNotes} disabled={isPaying} onChange={e => {setPaymentNotes(e.target.value); setPaymentReference('');}} />
        </div>
        <Button isLoading={isPaying} disabled={!(Number(paymentAmount) > 0)} onClick={async () => {
          setIsPaying(true); setError(null);
          const reference = paymentReference || crypto.randomUUID(); setPaymentReference(reference);
          try {
            await post(`/suppliers/${id}/payments`, {amount: Number(paymentAmount), reference_id: reference, notes: paymentNotes || null});
            setPaymentAmount(''); setPaymentNotes(''); setPaymentReference('');
            await Promise.all([fetchBalance(), fetchPaymentSchedule(), fetchLedger()]);
          } catch (err) {setError(extractApiError(err, 'Could not record payment'));}
          finally {setIsPaying(false);}
        }}>Record supplier payment</Button>
        {ledgerError && <p role="alert" className="text-red-700">{ledgerError}</p>}
        <div className="overflow-x-auto"><table className="w-full text-sm text-left">
          <thead><tr><th className="py-2">Date</th><th>Type</th><th>Details</th><th className="text-right">Amount</th></tr></thead>
          <tbody>{ledger.map(entry => <tr key={entry.id} className="border-t"><td className="py-2">{formatDate(entry.created_at)}</td><td>{entry.transaction_type}</td><td>{entry.notes || entry.reference_type}</td><td className="text-right">{formatCurrency(Number(entry.amount))}</td></tr>)}</tbody>
        </table></div>
        {!ledger.length && !ledgerError && <p className="text-sm text-gray-500">No transactions on this page.</p>}
        <div className="flex gap-2"><Button variant="secondary" disabled={ledgerPage === 1} onClick={() => setLedgerPage(p => p - 1)}>Previous</Button><Button variant="secondary" disabled={ledger.length < 50} onClick={() => setLedgerPage(p => p + 1)}>Next</Button></div>
      </div>

      {/* Payment Schedule */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 sm:p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Payment Schedule</h2>
        {scheduleLoading ? (
          <div className="flex items-center justify-center py-8">
            <LoadingSpinner />
          </div>
        ) : !paymentSchedule || (paymentSchedule.overdue.length === 0 && paymentSchedule.upcoming.length === 0) ? (
          <p className="text-sm text-gray-500 text-center py-8">
            No scheduled payments. Payments will appear here after goods are received.
          </p>
        ) : (
          <div className="space-y-4">
            {/* Summary */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {paymentSchedule.total_overdue > 0 && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3">
                  <p className="text-sm font-medium text-red-800">Overdue</p>
                  <p className="text-xl font-bold text-red-700">{formatCurrency(paymentSchedule.total_overdue)}</p>
                  <p className="text-xs text-red-600">{paymentSchedule.overdue.length} payment{paymentSchedule.overdue.length > 1 ? 's' : ''}</p>
                </div>
              )}
              {paymentSchedule.total_upcoming > 0 && (
                <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
                  <p className="text-sm font-medium text-blue-800">Upcoming</p>
                  <p className="text-xl font-bold text-blue-700">{formatCurrency(paymentSchedule.total_upcoming)}</p>
                  <p className="text-xs text-blue-600">{paymentSchedule.upcoming.length} payment{paymentSchedule.upcoming.length > 1 ? 's' : ''}</p>
                </div>
              )}
            </div>

            {/* Overdue entries */}
            {paymentSchedule.overdue.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-red-700 mb-2">Overdue Payments</h3>
                <div className="space-y-2">
                  {paymentSchedule.overdue.map((entry) => (
                    <div key={entry.id} className="flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-3 py-2">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{formatCurrency(entry.outstanding)}</p>
                        <p className="text-xs text-gray-500">Due: {formatDate(entry.due_date)}</p>
                      </div>
                      <Badge variant="danger">{entry.days_overdue}d overdue</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Upcoming entries */}
            {paymentSchedule.upcoming.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-blue-700 mb-2">Upcoming Payments</h3>
                <div className="space-y-2">
                  {paymentSchedule.upcoming.map((entry) => (
                    <div key={entry.id} className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{formatCurrency(entry.outstanding)}</p>
                        <p className="text-xs text-gray-500">Due: {formatDate(entry.due_date)}</p>
                      </div>
                      <Badge variant="info">In {entry.days_until_due}d</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Purchase Orders */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 sm:p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Purchase Orders</h2>
        {posLoading ? (
          <div className="flex items-center justify-center py-8">
            <LoadingSpinner />
          </div>
        ) : purchaseOrders.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-8">
            No purchase orders found for this supplier.
          </p>
        ) : (
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    ID
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Total
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Notes
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {purchaseOrders.map((po) => (
                  <tr key={po.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm text-gray-900 font-medium whitespace-nowrap">
                      {po.id.slice(0, 8)}...
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {getPOStatusBadge(po.status)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900 whitespace-nowrap">
                      {formatCurrency(po.total_amount)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500 max-w-[200px] truncate">
                      {po.notes || '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">
                      {formatDate(po.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit Supplier Modal */}
      <Modal
        isOpen={showEditModal}
        onClose={closeEditModal}
        title="Edit Supplier"
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={closeEditModal}>
              Cancel
            </Button>
            <Button onClick={handleSave} isLoading={isSaving}>
              Save Changes
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {editError && (
            <Alert variant="error" onClose={() => setEditError(null)}>
              {editError}
            </Alert>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Name"
              value={editForm.name || ''}
              onChange={(e) =>
                setEditForm({ ...editForm, name: e.target.value })
              }
              required
            />
            <Input
              label="Contact Person"
              value={editForm.contact_person || ''}
              onChange={(e) =>
                setEditForm({ ...editForm, contact_person: e.target.value || undefined })
              }
            />
            <Input
              label="Phone"
              value={editForm.phone || ''}
              onChange={(e) =>
                setEditForm({ ...editForm, phone: e.target.value || undefined })
              }
            />
            <Input
              label="Email"
              type="email"
              value={editForm.email || ''}
              onChange={(e) =>
                setEditForm({ ...editForm, email: e.target.value || undefined })
              }
            />
            <Input
              label="Tax ID"
              value={editForm.tax_id || ''}
              onChange={(e) =>
                setEditForm({ ...editForm, tax_id: e.target.value || undefined })
              }
            />
            <Select
              label="Payment Terms"
              options={[
                { value: '', label: 'Select payment terms' },
                { value: 'COD', label: 'COD — Cash on Delivery' },
                { value: 'Net 7', label: 'Net 7 — Pay within 7 days' },
                { value: 'Net 14', label: 'Net 14 — Pay within 14 days' },
                { value: 'Net 30', label: 'Net 30 — Pay within 30 days' },
                { value: 'Net 60', label: 'Net 60 — Pay within 60 days' },
                { value: 'Net 90', label: 'Net 90 — Pay within 90 days' },
                { value: 'Prepaid', label: 'Prepaid — Pay before delivery' },
              ]}
              value={editForm.payment_terms || ''}
              onChange={(e) =>
                setEditForm({ ...editForm, payment_terms: e.target.value || undefined })
              }
            />
            <Select
              label="Account Status"
              options={statusOptions}
              value={editForm.account_status || 'active'}
              onChange={(e) =>
                setEditForm({ ...editForm, account_status: e.target.value as AccountStatus })
              }
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Address
            </label>
            <textarea
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-0"
              rows={3}
              value={editForm.address || ''}
              onChange={(e) =>
                setEditForm({ ...editForm, address: e.target.value || undefined })
              }
              placeholder="Supplier address..."
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
