import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ExternalItemForm from './ExternalItemForm';
import { saleCreateSchema } from '@/lib/validation/schemas';
vi.mock('@/lib/api', () => ({get: vi.fn().mockResolvedValue({data: [{id: '00000000-0000-4000-8000-000000000001', name: 'Neighbour shop', account_status: 'active'}]})}));

describe('External item checkout', () => {
  it('keeps supplier cost and payment through checkout validation without requiring stock', async () => {
    const add = vi.fn(); render(<ExternalItemForm onAdd={add} />);
    fireEvent.click(screen.getByText('Add externally sourced item'));
    await screen.findByText('Neighbour shop');
    fireEvent.change(screen.getByLabelText(/Item name/), {target: {value: 'Brake assembly'}});
    fireEvent.change(screen.getByLabelText(/Supplying store/), {target: {value: '00000000-0000-4000-8000-000000000001'}});
    fireEvent.change(screen.getByLabelText('Supplier cost per unit'), {target: {value: '40'}});
    fireEvent.change(screen.getByLabelText('Selling price per unit'), {target: {value: '50'}});
    fireEvent.change(screen.getByLabelText('Supplier payment already made'), {target: {value: '20'}});
    fireEvent.click(screen.getByText('Add to sale'));
    expect(add).toHaveBeenCalledOnce();
    const item = add.mock.calls[0][0];
    const result = saleCreateSchema.parse({location_id: '00000000-0000-4000-8000-000000000002', payment_type: 'CASH', items: [{...item, spare_part_id: undefined}]});
    expect(result.items[0]).toMatchObject({source_type: 'EXTERNAL', supplier_unit_cost: 40, supplier_amount_paid: 20, external_description: 'Brake assembly'});
  });
  it('rejects supplier payments above the agreed cost', () => {
    const result = saleCreateSchema.safeParse({location_id: '00000000-0000-4000-8000-000000000002', payment_type: 'CASH', items: [{source_type: 'EXTERNAL', external_description: 'Part', supplier_id: '00000000-0000-4000-8000-000000000001', supplier_unit_cost: 40, supplier_amount_paid: 41, quantity: 1, unit_price: 50}]});
    expect(result.success).toBe(false);
  });
});
