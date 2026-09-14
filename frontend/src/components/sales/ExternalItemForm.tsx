'use client';

import { useEffect, useState } from 'react';
import { Button, Input, Select } from '@/components';
import { get } from '@/lib/api';
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
  const [search, setSearch] = useState('');
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string; account_status: string }>>([]);
  const [supplierId, setSupplierId] = useState('');
  const [description, setDescription] = useState('');
  const [partNumber, setPartNumber] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [cost, setCost] = useState('');
  const [price, setPrice] = useState('');
  const [paid, setPaid] = useState('0');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let active = true;
    const timer = setTimeout(() => {
      get<{ data: typeof suppliers }>(`/suppliers?page_size=100&search=${encodeURIComponent(search)}`)
        .then(res => { if (active) setSuppliers(res.data.filter(s => s.account_status === 'active')); })
        .catch(() => { if (active) setError('Could not load suppliers. Try again.'); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [open, search]);
  const add = () => {
    const qty = Number(quantity), unitCost = Number(cost), unitPrice = Number(price), amountPaid = Number(paid);
    if (!description.trim() || !supplierId || ![qty, unitCost, unitPrice].every(n => Number.isFinite(n) && n > 0) || !Number.isFinite(amountPaid) || amountPaid < 0 || amountPaid > qty * unitCost) {
      setError('Enter an item name, supplier, positive quantity and prices. Supplier payment cannot exceed the cost.');
      return;
    }
    onAdd({ id: crypto.randomUUID(), spare_part_id: '', spare_part_name: description.trim(), part_number: partNumber.trim(), source_type: 'EXTERNAL', external_description: description.trim(), external_part_number: partNumber.trim() || undefined, supplier_id: supplierId, supplier_unit_cost: unitCost, supplier_amount_paid: amountPaid, quantity: qty, unit_price: unitPrice, discount_amount: 0, line_total: qty * unitPrice });
    setDescription(''); setPartNumber(''); setQuantity('1'); setCost(''); setPrice(''); setPaid('0'); setError(''); setOpen(false);
  };
  return <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
    <Button variant="secondary" onClick={() => setOpen(!open)}>{open ? 'Close external item form' : 'Add externally sourced item'}</Button>
    {open && <div className="mt-3 space-y-3">
      <p className="text-sm text-gray-600">For an item obtained from another store at an agreed cost. It will not change your stock. Record later supplier payments on the supplier account.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Item name" maxLength={255} value={description} onChange={e => setDescription(e.target.value)} required />
        <Input label="Part number (optional)" maxLength={100} value={partNumber} onChange={e => setPartNumber(e.target.value)} />
        <Input label="Search suppliers" value={search} onChange={e => { setSearch(e.target.value); setSupplierId(''); }} />
        <Select label="Supplying store" value={supplierId} onChange={e => setSupplierId(e.target.value)} options={[{value:'', label:'Select supplier…'}, ...suppliers.map(s => ({value:s.id, label:s.name}))]} required />
        <Input label="Quantity" type="number" min="0.01" step="0.01" value={quantity} onChange={e => setQuantity(e.target.value)} />
        <Input label="Supplier cost per unit" type="number" min="0.01" step="0.01" value={cost} onChange={e => setCost(e.target.value)} />
        <Input label="Selling price per unit" type="number" min="0.01" step="0.01" value={price} onChange={e => setPrice(e.target.value)} />
        <Input label="Supplier payment already made" type="number" min="0" step="0.01" value={paid} onChange={e => setPaid(e.target.value)} />
      </div>
      <p className="text-sm">Margin before other expenses: {formatCurrency((Number(price) - Number(cost)) * Number(quantity))}</p>
      <p className="text-xs text-gray-600">Missing supplier? Add the store under Suppliers first. Supplier payment is recorded when the sale is confirmed.</p>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <Button onClick={add}>Add to sale</Button>
    </div>}
  </div>;
}
