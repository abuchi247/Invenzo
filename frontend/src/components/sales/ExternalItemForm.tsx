'use client';

import { useEffect, useState } from 'react';
import { Button, Input } from '@/components';
import { get, post } from '@/lib/api';
import { formatCurrency } from '@/lib/currency';

export interface ExternalCartItem {
  id: string;
  spare_part_id: string;
  spare_part_name: string;
  part_number: string;
  source_type: 'EXTERNAL';
  external_description: string;
  external_part_number?: string;
  supplier_id: string;
  supplier_unit_cost: number;
  supplier_amount_paid: number;
  quantity: number;
  unit_price: number;
  discount_amount: number;
  line_total: number;
}

export default function ExternalItemForm({ onAdd }: { onAdd: (item: ExternalCartItem) => void }) {
  const [open, setOpen] = useState(false);
  const [supplierName, setSupplierName] = useState('');
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string; account_status: string }>>([]);
  const [supplierId, setSupplierId] = useState('');
  const [description, setDescription] = useState('');
  const [partNumber, setPartNumber] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [cost, setCost] = useState('');
  const [price, setPrice] = useState('');
  const [paid, setPaid] = useState('0');
  const [error, setError] = useState('');
  const [isCreatingSupplier, setIsCreatingSupplier] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const timer = setTimeout(() => {
      get<{ data: typeof suppliers }>(`/suppliers?page_size=100&search=${encodeURIComponent(supplierName)}`)
        .then(res => { if (active) setSuppliers(res.data.filter(s => s.account_status === 'active')); })
        .catch(() => { if (active) setError('Could not load suppliers. Try again.'); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [open, supplierName]);
  const selectSupplier = (supplier: { id: string; name: string }) => {
    setSupplierId(supplier.id);
    setSupplierName(supplier.name);
    setError('');
  };
  const add = async () => {
    const qty = Number(quantity), unitCost = Number(cost), unitPrice = Number(price), amountPaid = Number(paid);
    if (!description.trim() || !supplierName.trim() || ![qty, unitCost, unitPrice].every(n => Number.isFinite(n) && n > 0) || !Number.isFinite(amountPaid) || amountPaid < 0 || amountPaid > qty * unitCost) {
      setError('Enter an item name, supplier, positive quantity and prices. Supplier payment cannot exceed the cost.');
      return;
    }
    const exactMatch = suppliers.find(s => s.name.localeCompare(supplierName.trim(), undefined, { sensitivity: 'accent' }) === 0);
    let selectedSupplierId = supplierId || exactMatch?.id;
    try {
      if (!selectedSupplierId) {
        setIsCreatingSupplier(true);
        const supplier = await post<{ id: string; name: string }>('/suppliers', { name: supplierName.trim() });
        selectedSupplierId = supplier.id;
      }
      onAdd({ id: crypto.randomUUID(), spare_part_id: '', spare_part_name: description.trim(), part_number: partNumber.trim(), source_type: 'EXTERNAL', external_description: description.trim(), external_part_number: partNumber.trim() || undefined, supplier_id: selectedSupplierId, supplier_unit_cost: unitCost, supplier_amount_paid: amountPaid, quantity: qty, unit_price: unitPrice, discount_amount: 0, line_total: qty * unitPrice });
      setDescription(''); setPartNumber(''); setSupplierName(''); setSupplierId(''); setQuantity('1'); setCost(''); setPrice(''); setPaid('0'); setError(''); setOpen(false);
    } catch {
      setError('Could not create this supplier. Please try again or select an existing supplier.');
    } finally {
      setIsCreatingSupplier(false);
    }
  };
  return <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
    <Button variant="secondary" onClick={() => setOpen(!open)}>{open ? 'Close external item form' : 'Add externally sourced item'}</Button>
    {open && <div className="mt-3 space-y-3">
      <p className="text-sm text-gray-600">For an item obtained from another supplier at an agreed cost. It will not change your stock. Record later supplier payments on the supplier account.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Item name" maxLength={255} value={description} onChange={e => setDescription(e.target.value)} required />
        <Input label="Part number (optional)" maxLength={100} value={partNumber} onChange={e => setPartNumber(e.target.value)} />
        <div className="sm:col-span-2">
          <Input label="Supplier" value={supplierName} onChange={e => { setSupplierName(e.target.value); setSupplierId(''); }} helperText="Choose a matching supplier, or enter a new name to create it when you add the item." required />
          {supplierName.trim() && suppliers.length > 0 && <div className="mt-2 flex flex-wrap gap-2" aria-label="Matching suppliers">
            {suppliers.map(supplier => <button key={supplier.id} type="button" onClick={() => selectSupplier(supplier)} className={`rounded-md border px-3 py-1.5 text-sm ${supplier.id === supplierId ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background hover:bg-muted'}`}>
              {supplier.name}
            </button>)}
          </div>}
        </div>
        <Input label="Quantity" type="number" min="0.01" step="0.01" value={quantity} onChange={e => setQuantity(e.target.value)} />
        <Input label="Supplier cost per unit" type="number" min="0.01" step="0.01" value={cost} onChange={e => setCost(e.target.value)} />
        <Input label="Selling price per unit" type="number" min="0.01" step="0.01" value={price} onChange={e => setPrice(e.target.value)} />
        <Input label="Supplier payment already made" type="number" min="0" step="0.01" value={paid} onChange={e => setPaid(e.target.value)} />
      </div>
      <p className="text-sm">Margin before other expenses: {formatCurrency((Number(price) - Number(cost)) * Number(quantity))}</p>
      <p className="text-xs text-gray-600">A new supplier name is saved automatically when you add the item. Supplier payment is recorded when the sale is confirmed.</p>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <Button onClick={add} isLoading={isCreatingSupplier}>Add to sale</Button>
    </div>}
  </div>;
}
