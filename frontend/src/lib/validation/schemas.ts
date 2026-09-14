import { z } from 'zod';

const uuid = z.string().uuid('Enter a valid identifier');
const requiredText = (max: number, label: string) =>
  z.string({ required_error: `${label} is required` }).trim().min(1, `${label} is required`).max(max, `${label} must be ${max} characters or fewer`);
const optionalText = (max: number) =>
  z.preprocess((value) => value === '' ? undefined : value, z.string().max(max).optional());
const nonNegativeNumber = z.coerce.number().finite().min(0, 'Must be zero or greater');
const positiveNumber = z.coerce.number().finite().gt(0, 'Must be greater than zero');
const optionalNonNegativeNumber = z.preprocess(
  (value) => value === '' || value === undefined ? undefined : value,
  z.number().finite().min(0, 'Must be zero or greater').optional(),
);

export const userCreateSchema = z.object({
  username: requiredText(150, 'Username').min(3, 'Username must be at least 3 characters'),
  email: z.string().trim().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['admin', 'manager', 'salesperson', 'storekeeper']),
  is_active: z.boolean().optional(),
});

export const userUpdateSchema = z.object({
  username: requiredText(150, 'Username').min(3).optional(),
  email: z.string().trim().email('Enter a valid email address').optional(),
  role: z.enum(['admin', 'manager', 'salesperson', 'storekeeper']).optional(),
  is_active: z.boolean().optional(),
});

export const sparePartCreateSchema = z.object({
  part_number: requiredText(100, 'Part number'),
  barcode: optionalText(255),
  name: requiredText(500, 'Name'),
  description: optionalText(2000),
  brand: optionalText(255),
  // Category is required — every part belongs to a category, and the backend
  // enforces a NOT NULL category_id.
  category_id: z.preprocess(
    (value) => value === '' ? undefined : value,
    uuid.refine((v) => Boolean(v), { message: 'Category is required' }),
  ),
  subcategory_id: z.preprocess((value) => value === '' ? undefined : value, uuid.optional()),
  vehicle_compatibility: z.array(z.string()).optional(),
  unit_of_measure: z.string().max(50).default('PCS'),
  cost_price: nonNegativeNumber,
  selling_price: nonNegativeNumber,
  min_stock_level: nonNegativeNumber.default(0),
  max_stock_level: nonNegativeNumber.default(0),
  reorder_quantity: nonNegativeNumber.default(0),
}).refine(
  (data) => data.selling_price >= data.cost_price,
  {
    message: 'Selling price cannot be lower than cost price',
    path: ['selling_price'],
  }
);

export const sparePartUpdateSchema = z.object({
  part_number: requiredText(100, 'Part number'),
  barcode: optionalText(255),
  name: requiredText(500, 'Name'),
  description: optionalText(2000),
  brand: optionalText(255),
  category_id: z.preprocess((value) => value === '' ? undefined : value, uuid.optional()),
  subcategory_id: z.preprocess((value) => value === '' ? undefined : value, uuid.optional()),
  vehicle_compatibility: z.array(z.string()).optional(),
  unit_of_measure: z.string().max(50).optional(),
  cost_price: nonNegativeNumber.optional(),
  selling_price: nonNegativeNumber.optional(),
  min_stock_level: nonNegativeNumber.optional(),
  max_stock_level: nonNegativeNumber.optional(),
  reorder_quantity: nonNegativeNumber.optional(),
}).partial().refine(
  (data) => {
    if (data.selling_price != null && data.cost_price != null) {
      return data.selling_price >= data.cost_price;
    }
    return true;
  },
  {
    message: 'Selling price cannot be lower than cost price',
    path: ['selling_price'],
  }
);

export const saleItemCreateSchema = z.object({
  spare_part_id: uuid.nullish(),
  source_type: z.enum(['STOCK', 'EXTERNAL']).default('STOCK'),
  external_description: z.string().trim().max(255).optional(),
  external_part_number: z.string().max(100).optional(),
  supplier_id: uuid.optional(),
  supplier_unit_cost: positiveNumber.optional(),
  supplier_amount_paid: nonNegativeNumber.default(0),
  quantity: positiveNumber,
  unit_price: positiveNumber,
  discount_amount: nonNegativeNumber.default(0),
}).superRefine((item, ctx) => {
  if (item.discount_amount > item.quantity * item.unit_price) ctx.addIssue({code: 'custom', message: 'Discount cannot exceed line amount', path: ['discount_amount']});
  if (item.source_type === 'EXTERNAL') {
    if (!item.external_description || !item.supplier_id || !item.supplier_unit_cost) ctx.addIssue({code: 'custom', message: 'External items require a description, supplier and cost'});
    if (item.supplier_amount_paid > item.quantity * (item.supplier_unit_cost || 0)) ctx.addIssue({code: 'custom', message: 'Supplier payment exceeds cost'});
  } else if (!item.spare_part_id) ctx.addIssue({code: 'custom', message: 'Select a stock product', path: ['spare_part_id']});
});

export const saleCreateSchema = z.object({
  customer_id: z.preprocess((value) => value === '' ? undefined : value, uuid.optional()),
  location_id: uuid,
  payment_type: z.enum(['CASH', 'CREDIT']),
  amount_paid: optionalNonNegativeNumber,
  items: z.array(saleItemCreateSchema).default([]),
});

export const purchaseOrderItemCreateSchema = z.object({
  spare_part_id: uuid,
  quantity_ordered: positiveNumber,
  unit_cost: positiveNumber,
});

export const purchaseOrderCreateSchema = z.object({
  supplier_id: uuid,
  notes: optionalText(2000),
  items: z.array(purchaseOrderItemCreateSchema).min(1, 'Add at least one item'),
});

export const customerCreateSchema = z.object({
  name: requiredText(255, 'Name'),
  phone: optionalText(50),
  email: optionalText(255),
  address: optionalText(2000),
  tax_id: optionalText(100),
  credit_limit: nonNegativeNumber.default(0),
  account_status: z.enum(['active', 'suspended', 'closed']).optional(),
});

export const customerUpdateSchema = customerCreateSchema.partial();

export const supplierCreateSchema = z.object({
  name: requiredText(255, 'Name'),
  contact_person: optionalText(255),
  phone: optionalText(50),
  email: optionalText(255),
  address: optionalText(2000),
  tax_id: optionalText(100),
  payment_terms: optionalText(100),
  account_status: z.enum(['active', 'suspended', 'closed']).optional(),
});

export const supplierUpdateSchema = supplierCreateSchema.partial();

export const transferCreateSchema = z.object({
  spare_part_id: uuid,
  source_location_id: uuid,
  destination_location_id: uuid,
  quantity: positiveNumber,
}).superRefine((value, context) => {
  if (value.source_location_id === value.destination_location_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['destination_location_id'], message: 'Choose a different destination location' });
  }
});

export const transferCancelSchema = z.object({
  reason: requiredText(1000, 'Cancellation reason'),
});

export type UserCreateValues = z.infer<typeof userCreateSchema>;
export type UserUpdateValues = z.infer<typeof userUpdateSchema>;
export type SparePartCreateValues = z.infer<typeof sparePartCreateSchema>;
export type SaleCreateValues = z.infer<typeof saleCreateSchema>;
export type PurchaseOrderCreateValues = z.infer<typeof purchaseOrderCreateSchema>;
export type CustomerCreateValues = z.infer<typeof customerCreateSchema>;
export type SupplierCreateValues = z.infer<typeof supplierCreateSchema>;
export type TransferCreateValues = z.infer<typeof transferCreateSchema>;
