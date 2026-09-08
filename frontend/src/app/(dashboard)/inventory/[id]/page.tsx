'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRequirePermission } from '@/hooks/useRequirePermission';
import { useRouter, useParams } from 'next/navigation';
import { get, put, post, del } from '@/lib/api';
import {
  Button,
  Input,
  Select,
  Badge,
  Alert,
  LoadingSpinner,
  Modal,
} from '@/components';
import type { SelectOption } from '@/components';
import type { SparePart, SparePartUpdate, Category } from '@/lib/types';
import { formatCurrency, formatQuantity } from '@/lib/currency';
import { extractApiError } from '@/lib/validation/errors';

export default function InventoryDetailPage() {
  const { allowed } = useRequirePermission('inventory');

  const router = useRouter();
  const params = useParams();
  const partId = params.id as string;

  const [part, setPart] = useState<SparePart & { total_stock?: number } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);

  // Edit state
  const [showEditModal, setShowEditModal] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editData, setEditData] = useState<SparePartUpdate>({});

  // Stock adjustment state
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [isAdjusting, setIsAdjusting] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [adjustData, setAdjustData] = useState<{
    location_id: string;
    quantity: number | '';
    reason: string;
  }>({
    location_id: '',
    quantity: '',
    reason: 'Initial stock entry',
  });
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);

  // Delete state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Movement history state
  interface MovementItem {
    id: string;
    location_id: string;
    location_name: string | null;
    quantity_change: number;
    movement_type: string;
    reference_type: string;
    reference_id: string;
    created_by: string;
    created_by_username: string | null;
    created_at: string;
  }
  const [movements, setMovements] = useState<MovementItem[]>([]);
  const [movementsLoading, setMovementsLoading] = useState(false);
  const [movementsPage, setMovementsPage] = useState(1);
  const [movementsTotalPages, setMovementsTotalPages] = useState(1);

  // Cost layers state
  interface CostLayerItem {
    id: string;
    location_id: string;
    location_name: string | null;
    unit_cost: number;
    original_quantity: number;
    remaining_quantity: number;
    source_type: string;
    created_at: string;
  }
  const [costLayers, setCostLayers] = useState<CostLayerItem[]>([]);
  const [costLayersLoading, setCostLayersLoading] = useState(false);
  const [costLayersPage, setCostLayersPage] = useState(1);
  const [costLayersTotalPages, setCostLayersTotalPages] = useState(1);

  // Purchase history state
  interface PurchaseHistoryItem {
    id: string;
    date: string;
    supplier_name: string | null;
    quantity: number;
    unit_cost: number;
    total_cost: number;
    location_name: string | null;
  }
  interface PurchaseHistoryData {
    spare_part_id: string;
    data: PurchaseHistoryItem[];
    average_cost: number;
    latest_cost: number;
    total_purchased: number;
  }
  const [purchaseHistory, setPurchaseHistory] = useState<PurchaseHistoryData | null>(null);
  const [purchaseHistoryLoading, setPurchaseHistoryLoading] = useState(false);

  const fetchPart = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await get<SparePart & { total_stock?: number }>(`/spare-parts/${partId}`);
      setPart(response);
    } catch (err: unknown) {
      const message = extractApiError(err, 'Failed to load spare part');
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [partId]);

  const fetchCategories = useCallback(async () => {
    try {
      const response = await get<{ data: Array<Category & { children?: Category[] }>; meta: { page: number; total: number; page_size: number } }>('/categories?page_size=500');
      const flat: Category[] = [];
      const flatten = (items: Array<Category & { children?: Category[] }>) => {
        for (const item of items) {
          flat.push(item);
          if (item.children && item.children.length > 0) {
            flatten(item.children as Array<Category & { children?: Category[] }>);
          }
        }
      };
      flatten(response.data);
      setCategories(flat);
    } catch {
      // Optional
    }
  }, []);

  const fetchLocations = useCallback(async () => {
    try {
      const response = await get<{ data: Array<{ id: string; name: string }>; meta: { page: number; total: number; page_size: number } }>('/locations?page_size=100');
      setLocations(response.data);
    } catch {
      // Optional
    }
  }, []);

  const fetchMovements = useCallback(async () => {
    setMovementsLoading(true);
    try {
      const response = await get<{ data: MovementItem[]; meta: { page: number; total: number; page_size: number } }>(
        `/stock/movements/${partId}?page=${movementsPage}&page_size=10`
      );
      setMovements(response.data);
      setMovementsTotalPages(Math.ceil((response.meta.total || 0) / 10));
    } catch {
      // Non-critical
    } finally {
      setMovementsLoading(false);
    }
  }, [partId, movementsPage]);

  const fetchCostLayers = useCallback(async () => {
    setCostLayersLoading(true);
    try {
      const response = await get<{ data: CostLayerItem[]; meta: { page: number; total: number; page_size: number } }>(
        `/stock/cost-layers/${partId}?page=${costLayersPage}&page_size=10`
      );
      setCostLayers(response.data);
      setCostLayersTotalPages(Math.ceil((response.meta.total || 0) / 10));
    } catch {
      // Non-critical
    } finally {
      setCostLayersLoading(false);
    }
  }, [partId, costLayersPage]);

  useEffect(() => {
    fetchPart();
    fetchCategories();
    fetchLocations();
  }, [fetchPart, fetchCategories, fetchLocations]);

  useEffect(() => {
    fetchMovements();
  }, [fetchMovements]);

  useEffect(() => {
    fetchCostLayers();
  }, [fetchCostLayers]);

  // Fetch purchase history
  useEffect(() => {
    async function fetchPurchaseHistory() {
      setPurchaseHistoryLoading(true);
      try {
        const data = await get<PurchaseHistoryData>(`/stock/purchase-history/${partId}`);
        setPurchaseHistory(data);
      } catch {
        setPurchaseHistory(null);
      } finally {
        setPurchaseHistoryLoading(false);
      }
    }
    fetchPurchaseHistory();
  }, [partId]);

  const handleEdit = () => {
    if (!part) return;
    setEditData({
      part_number: part.part_number,
      name: part.name,
      description: part.description,
      brand: part.brand,
      category_id: part.category_id,
      unit_of_measure: part.unit_of_measure,
      cost_price: part.cost_price,
      selling_price: part.selling_price,
      min_stock_level: part.min_stock_level,
      max_stock_level: part.max_stock_level,
      reorder_quantity: part.reorder_quantity,
    });
    setEditError(null);
    setShowEditModal(true);
  };

  const handleSave = async () => {
    setIsEditing(true);
    setEditError(null);
    try {
      const payload = {
        ...editData,
        cost_price: editData.cost_price ?? 0,
        selling_price: editData.selling_price ?? 0,
        min_stock_level: editData.min_stock_level ?? 0,
        max_stock_level: editData.max_stock_level ?? 0,
        reorder_quantity: editData.reorder_quantity ?? 0,
      };
      await put(`/spare-parts/${partId}`, payload);
      setShowEditModal(false);
      fetchPart();
    } catch (err: unknown) {
      let message = 'Failed to update spare part';
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { data?: { detail?: string | Array<{ msg: string; loc: string[] }> } } };
        const detail = axiosErr.response?.data?.detail;
        if (typeof detail === 'string') {
          message = detail;
        } else if (Array.isArray(detail) && detail.length > 0) {
          message = detail.map((d) => `${d.loc?.[d.loc.length - 1] || 'field'}: ${d.msg}`).join(', ');
        }
      } else if (err instanceof Error) {
        message = err.message;
      }
      setEditError(message);
    } finally {
      setIsEditing(false);
    }
  };

  const handleStockAdjust = async () => {
    setIsAdjusting(true);
    setAdjustError(null);
    try {
      await post('/stock/adjust', {
        spare_part_id: partId,
        location_id: adjustData.location_id,
        quantity: adjustData.quantity === '' ? 0 : adjustData.quantity,
        reason: adjustData.reason,
      });
      setShowAdjustModal(false);
      setAdjustData({ location_id: '', quantity: '', reason: 'Initial stock entry' });
      fetchPart();
    } catch (err: unknown) {
      let message = 'Failed to adjust stock';
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { data?: { detail?: string | Array<{ msg: string; loc: string[] }> } } };
        const detail = axiosErr.response?.data?.detail;
        if (typeof detail === 'string') {
          message = detail;
        } else if (Array.isArray(detail) && detail.length > 0) {
          message = detail.map((d) => `${d.loc?.[d.loc.length - 1] || 'field'}: ${d.msg}`).join(', ');
        }
      } else if (err instanceof Error) {
        message = err.message;
      }
      setAdjustError(message);
    } finally {
      setIsAdjusting(false);
    }
  };

  const getCategoryName = (categoryId?: string) => {
    if (!categoryId) return '—';
    const cat = categories.find((c) => c.id === categoryId);
    return cat?.name || '—';
  };

  const closeDeleteModal = useCallback(() => {
    setShowDeleteModal(false);
    setDeleteError(null);
  }, []);
  const closeEditModal = useCallback(() => {
    setShowEditModal(false);
    setEditError(null);
  }, []);
  const closeAdjustModal = useCallback(() => {
    setShowAdjustModal(false);
    setAdjustError(null);
  }, []);

  const handleDelete = async () => {
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await del(`/spare-parts/${partId}`);
      router.push('/inventory');
    } catch (err: unknown) {
      let message = 'Failed to delete spare part';
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { data?: { detail?: string } } };
        if (typeof axiosErr.response?.data?.detail === 'string') {
          message = axiosErr.response.data.detail;
        }
      } else if (err instanceof Error) {
        message = err.message;
      }
      setDeleteError(message);
    } finally {
      setIsDeleting(false);
    }
  };

  const categoryOptions: SelectOption[] = [
    { value: '', label: 'No category' },
    ...categories.map((c) => ({ value: c.id, label: c.name })),
  ];

  if (!allowed) return null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error || !part) {
    return (
      <div className="space-y-4">
        <Button variant="secondary" onClick={() => router.back()}>
          ← Back to Inventory
        </Button>
        <Alert variant="error">{error || 'Part not found'}</Alert>
      </div>
    );
  }

  const stockLevel = Number(part.total_stock ?? 0);
  const minLevel = Number(part.min_stock_level ?? 0);
  const stockStatus = stockLevel <= 0 ? 'out_of_stock' : stockLevel <= minLevel ? 'low' : 'in_stock';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={() => router.back()}>
            ← Back
          </Button>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900 truncate">{part.name}</h1>
            <p className="text-sm text-gray-500">Part # {part.part_number}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setShowAdjustModal(true)}>
            Adjust Stock
          </Button>
          <Button onClick={handleEdit}>Edit Part</Button>
          <Button variant="danger" onClick={() => setShowDeleteModal(true)}>
            Delete
          </Button>
        </div>
      </div>

      {/* Detail cards */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Basic Info */}
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Basic Information</h2>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-sm text-gray-500">Part Number</dt>
              <dd className="text-sm font-medium text-gray-900">{part.part_number}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-gray-500">Barcode</dt>
              <dd className="text-sm font-medium text-gray-900">{part.barcode || '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-gray-500">Brand</dt>
              <dd className="text-sm font-medium text-gray-900">{part.brand}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-gray-500">Category</dt>
              <dd className="text-sm font-medium text-gray-900">{getCategoryName(part.category_id)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-gray-500">Unit of Measure</dt>
              <dd className="text-sm font-medium text-gray-900">{part.unit_of_measure}</dd>
            </div>
            {part.description && (
              <div className="pt-2 border-t">
                <dt className="text-sm text-gray-500 mb-1">Description</dt>
                <dd className="text-sm text-gray-900">{part.description}</dd>
              </div>
            )}
          </dl>
        </div>

        {/* Pricing & Stock */}
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Pricing & Stock</h2>
          {part.price_review_needed && (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-amber-600 text-lg">⚠</span>
                  <div>
                    <p className="text-sm font-medium text-amber-800">Price Review Needed</p>
                    <p className="text-xs text-amber-600">
                      Cost increased and profit margin is thin. Consider updating the selling price, then save to clear this alert.
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await post(`/spare-parts/${partId}/dismiss-price-review`);
                        fetchPart();
                      } catch { /* ignore */ }
                    }}
                    className="rounded px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
                  >
                    Dismiss
                  </button>
                  <button
                    type="button"
                    onClick={handleEdit}
                    className="rounded bg-amber-600 px-2 py-1 text-xs font-medium text-white hover:bg-amber-700"
                  >
                    Update Price
                  </button>
                </div>
              </div>
            </div>
          )}
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-sm text-gray-500">Cost Price</dt>
              <dd className="text-sm font-medium text-gray-900">{formatCurrency(part.cost_price)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-gray-500">Selling Price</dt>
              <dd className="text-sm font-medium text-gray-900">{formatCurrency(part.selling_price)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-gray-500">Margin</dt>
              <dd className="text-sm font-medium text-gray-900">
                {part.cost_price > 0
                  ? `${(((part.selling_price - part.cost_price) / part.cost_price) * 100).toFixed(1)}%`
                  : '—'}
              </dd>
            </div>
            <div className="flex justify-between items-center pt-2 border-t">
              <dt className="text-sm text-gray-500">Current Stock</dt>
              <dd className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-900">{formatQuantity(stockLevel)}</span>
                <Badge
                  variant={stockStatus === 'in_stock' ? 'success' : stockStatus === 'low' ? 'warning' : 'danger'}
                >
                  {stockStatus === 'in_stock' ? 'In Stock' : stockStatus === 'low' ? 'Low Stock' : 'Out of Stock'}
                </Badge>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-gray-500">Min Stock Level</dt>
              <dd className="text-sm font-medium text-gray-900">{formatQuantity(part.min_stock_level)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-gray-500">Max Stock Level</dt>
              <dd className="text-sm font-medium text-gray-900">{formatQuantity(part.max_stock_level)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-gray-500">Reorder Quantity</dt>
              <dd className="text-sm font-medium text-gray-900">{formatQuantity(part.reorder_quantity)}</dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Stock by Location */}
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Stock by Location</h2>
        <StockByLocation partId={partId} />
      </div>

      {/* Metadata */}
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Record Info</h2>
        <dl className="flex gap-8">
          <div>
            <dt className="text-sm text-gray-500">Created</dt>
            <dd className="text-sm font-medium text-gray-900">
              {new Date(part.created_at).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500">Last Updated</dt>
            <dd className="text-sm font-medium text-gray-900">
              {new Date(part.updated_at).toLocaleString()}
            </dd>
          </div>
        </dl>
      </div>

      {/* Purchase History */}
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Purchase History</h2>
        {purchaseHistoryLoading ? (
          <div className="flex justify-center py-4">
            <LoadingSpinner size="md" />
          </div>
        ) : !purchaseHistory || purchaseHistory.data.length === 0 ? (
          <p className="text-sm text-gray-500">No purchase records yet. Records will appear after goods are received via GRN.</p>
        ) : (
          <>
            {/* Summary stats */}
            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-md bg-gray-50 p-3">
                <p className="text-xs text-gray-500">Latest Cost</p>
                <p className="text-lg font-semibold text-gray-900">{formatCurrency(purchaseHistory.latest_cost)}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-3">
                <p className="text-xs text-gray-500">Average Cost</p>
                <p className="text-lg font-semibold text-gray-900">{formatCurrency(purchaseHistory.average_cost)}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-3">
                <p className="text-xs text-gray-500">Total Purchased</p>
                <p className="text-lg font-semibold text-gray-900">{purchaseHistory.total_purchased} units</p>
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Date</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Supplier</th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Qty</th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Unit Cost</th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Total</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Location</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {purchaseHistory.data.map((entry) => (
                    <tr key={entry.id}>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">
                        {entry.date ? new Date(entry.date).toLocaleDateString() : '—'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">
                        {entry.supplier_name || '—'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-right text-gray-900">
                        {entry.quantity}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-right text-gray-900">
                        {formatCurrency(entry.unit_cost)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-right font-medium text-gray-900">
                        {formatCurrency(entry.total_cost)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">
                        {entry.location_name || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Movement History */}
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Movement History</h2>
        {movementsLoading ? (
          <div className="flex justify-center py-4">
            <LoadingSpinner size="md" />
          </div>
        ) : movements.length === 0 ? (
          <p className="text-sm text-gray-500">No stock movements recorded yet.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Date</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Location</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Type</th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Quantity</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">By</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Reference</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {movements.map((m) => (
                    <tr key={m.id}>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">
                        {new Date(m.created_at).toLocaleDateString()}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">
                        {m.location_name || '—'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm">
                        <Badge variant={
                          m.movement_type === 'PURCHASE' ? 'success' :
                          m.movement_type === 'SALE' ? 'danger' :
                          m.movement_type === 'ADJUSTMENT' ? 'warning' :
                          'default'
                        }>
                          {m.movement_type}
                        </Badge>
                      </td>
                      <td className={`whitespace-nowrap px-4 py-3 text-sm text-right font-medium ${
                        m.quantity_change >= 0 ? 'text-green-600' : 'text-red-600'
                      }`}>
                        {m.quantity_change >= 0 ? '+' : ''}{m.quantity_change}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-700">
                        {m.created_by_username || '—'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">
                        {m.reference_type}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {movementsTotalPages > 1 && (
              <div className="mt-4 flex items-center justify-between">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setMovementsPage((p) => Math.max(1, p - 1))}
                  disabled={movementsPage <= 1}
                >
                  Previous
                </Button>
                <span className="text-sm text-gray-500">
                  Page {movementsPage} of {movementsTotalPages}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setMovementsPage((p) => Math.min(movementsTotalPages, p + 1))}
                  disabled={movementsPage >= movementsTotalPages}
                >
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Cost Layers */}
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Cost Layers (FIFO)</h2>
        {costLayersLoading ? (
          <div className="flex justify-center py-4">
            <LoadingSpinner size="md" />
          </div>
        ) : costLayers.length === 0 ? (
          <p className="text-sm text-gray-500">No active cost layers.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Date</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Location</th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Unit Cost</th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Original Qty</th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Remaining Qty</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {costLayers.map((cl) => (
                    <tr key={cl.id}>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">
                        {new Date(cl.created_at).toLocaleDateString()}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">
                        {cl.location_name || '—'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-right text-gray-900">
                        {formatCurrency(cl.unit_cost)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-right text-gray-900">
                        {formatQuantity(cl.original_quantity)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-right text-gray-900">
                        {formatQuantity(cl.remaining_quantity)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">
                        {cl.source_type}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {costLayersTotalPages > 1 && (
              <div className="mt-4 flex items-center justify-between">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setCostLayersPage((p) => Math.max(1, p - 1))}
                  disabled={costLayersPage <= 1}
                >
                  Previous
                </Button>
                <span className="text-sm text-gray-500">
                  Page {costLayersPage} of {costLayersTotalPages}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setCostLayersPage((p) => Math.min(costLayersTotalPages, p + 1))}
                  disabled={costLayersPage >= costLayersTotalPages}
                >
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={showDeleteModal}
        onClose={closeDeleteModal}
        title="Delete Spare Part"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => { setShowDeleteModal(false); setDeleteError(null); }}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} isLoading={isDeleting}>
              Delete
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {deleteError && (
            <Alert variant="error" onClose={() => setDeleteError(null)}>
              {deleteError}
            </Alert>
          )}
          <p className="text-sm text-gray-700">
            Are you sure you want to delete this part? This action cannot be easily undone.
          </p>
          <p className="text-sm font-medium text-gray-900">{part.name} ({part.part_number})</p>
        </div>
      </Modal>

      {/* Edit Modal */}
      <Modal
        isOpen={showEditModal}
        onClose={closeEditModal}
        title="Edit Spare Part"
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => { setShowEditModal(false); setEditError(null); }}>
              Cancel
            </Button>
            <Button onClick={handleSave} isLoading={isEditing}>
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
              label="Part Number"
              value={editData.part_number || ''}
              onChange={(e) => setEditData({ ...editData, part_number: e.target.value })}
              required
              placeholder="e.g. BRK-00012"
              helperText="Must be unique. Changing it updates the part's identifier everywhere it appears."
            />
            <Input
              label="Name"
              value={editData.name || ''}
              onChange={(e) => setEditData({ ...editData, name: e.target.value })}
              required
              placeholder="e.g. Front Brake Pad Set"
            />
            <Input
              label="Brand"
              value={editData.brand || ''}
              onChange={(e) => setEditData({ ...editData, brand: e.target.value })}
              required
              placeholder="e.g. Bosch"
            />
            <Select
              label="Category"
              options={categoryOptions}
              value={editData.category_id || ''}
              onChange={(e) => setEditData({ ...editData, category_id: e.target.value || undefined })}
            />
            <Input
              label="Unit of Measure"
              value={editData.unit_of_measure || ''}
              onChange={(e) => setEditData({ ...editData, unit_of_measure: e.target.value })}
              required
              placeholder="e.g. pcs, set, litre"
            />
            <Input
              label="Cost Price"
              type="number"
              min={0}
              step={0.01}
              value={editData.cost_price ?? ''}
              onChange={(e) => setEditData({ ...editData, cost_price: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
              required
              placeholder="e.g. 25.00"
            />
            <Input
              label="Selling Price"
              type="number"
              min={0}
              step={0.01}
              value={editData.selling_price ?? ''}
              onChange={(e) => setEditData({ ...editData, selling_price: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
              required
              placeholder="e.g. 45.00"
            />
            <Input
              label="Min Stock Level"
              type="number"
              min={0}
              value={editData.min_stock_level ?? ''}
              onChange={(e) => setEditData({ ...editData, min_stock_level: e.target.value === '' ? undefined : parseInt(e.target.value) })}
              placeholder="e.g. 10"
            />
            <Input
              label="Max Stock Level"
              type="number"
              min={0}
              value={editData.max_stock_level ?? ''}
              onChange={(e) => setEditData({ ...editData, max_stock_level: e.target.value === '' ? undefined : parseInt(e.target.value) })}
              placeholder="e.g. 100"
            />
            <Input
              label="Reorder Quantity"
              type="number"
              min={0}
              value={editData.reorder_quantity ?? ''}
              onChange={(e) => setEditData({ ...editData, reorder_quantity: e.target.value === '' ? undefined : parseInt(e.target.value) })}
              placeholder="e.g. 20"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
            <textarea
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              rows={3}
              value={editData.description || ''}
              onChange={(e) => setEditData({ ...editData, description: e.target.value || undefined })}
              placeholder="e.g. OEM quality front brake pad set for Toyota Corolla 2018-2023"
            />
          </div>
        </div>
      </Modal>

      {/* Stock Adjustment Modal */}
      <Modal
        isOpen={showAdjustModal}
        onClose={closeAdjustModal}
        title="Adjust Stock"
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => { setShowAdjustModal(false); setAdjustError(null); }}>
              Cancel
            </Button>
            <Button
              onClick={handleStockAdjust}
              isLoading={isAdjusting}
              disabled={!adjustData.location_id || adjustData.quantity === '' || adjustData.quantity === 0}
            >
              Apply Adjustment
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {adjustError && (
            <Alert variant="error" onClose={() => setAdjustError(null)}>
              {adjustError}
            </Alert>
          )}
          <p className="text-sm text-gray-500">
            Add or remove stock for <strong>{part.name}</strong>. Use a positive number to add stock, negative to remove.
          </p>
          <Select
            label="Location"
            options={[
              { value: '', label: 'Select a location' },
              ...locations.map((l) => ({ value: l.id, label: l.name })),
            ]}
            value={adjustData.location_id}
            onChange={(e) => setAdjustData({ ...adjustData, location_id: e.target.value })}
            required
          />
          <Input
            label="Quantity"
            type="number"
            value={adjustData.quantity}
            onChange={(e) => setAdjustData({ ...adjustData, quantity: e.target.value === '' ? '' : parseInt(e.target.value) })}
            required
            placeholder="e.g. 50 (positive to add, negative to remove)"
          />
          <Input
            label="Reason"
            value={adjustData.reason}
            onChange={(e) => setAdjustData({ ...adjustData, reason: e.target.value })}
            placeholder="e.g. Initial stock entry, Physical count correction"
          />
        </div>
      </Modal>
    </div>
  );
}

// Stock by Location sub-component
function StockByLocation({ partId }: { partId: string }) {
  const [items, setItems] = useState<Array<{ location_id: string; location_name: string | null; current_quantity: number }>>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetch() {
      try {
        const response = await get<{ spare_part_id: string; data: Array<{ location_id: string; location_name: string | null; current_quantity: number }> }>(
          `/stock/by-part/${partId}`
        );
        setItems(response.data);
      } catch {
        setItems([]);
      } finally {
        setIsLoading(false);
      }
    }
    fetch();
  }, [partId]);

  if (isLoading) {
    return <p className="text-sm text-gray-500">Loading...</p>;
  }

  if (items.length === 0) {
    return <p className="text-sm text-gray-500">No stock at any location.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Location</th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Quantity</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {items.map((item) => (
            <tr key={item.location_id}>
              <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900">
                {item.location_name || '—'}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-sm text-right font-medium text-gray-900">
                {formatQuantity(item.current_quantity)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
