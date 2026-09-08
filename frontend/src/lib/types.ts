/**
 * TypeScript interfaces matching backend Pydantic schemas.
 * These provide type safety for all API interactions.
 */

// --- Common ---

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    page: number;
    page_size: number;
    total: number;
    total_pages?: number;
  };
}

export interface ApiResponse<T> {
  data: T;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// --- Auth ---

export type UserRole = 'admin' | 'manager' | 'salesperson' | 'storekeeper';

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  /** Present only during the non-browser compatibility window. */
  refresh_token?: string;
  token_type: string;
  user?: UserProfile;
  /** When true, the user must change their password before accessing the system. */
  password_change_required?: boolean;
  /** Scoped token for the force-change-password endpoint (present when password_change_required is true). */
  password_change_token?: string;
  message?: string;
}

export interface ForceChangePasswordRequest {
  password_change_token: string;
  new_password: string;
}

export interface ForceChangePasswordResponse {
  access_token: string;
  token_type: string;
}

/** Non-browser clients may still send a body token during the migration. */
export interface RefreshRequest {
  refresh_token?: string;
}

export interface RefreshResponse {
  access_token: string;
  /** Browser responses should omit this because it is held in a cookie. */
  refresh_token?: string;
  token_type: string;
}

export interface PasswordResetRequest {
  email: string;
}

export interface PasswordChangeRequest {
  current_password: string;
  new_password: string;
}

// --- Users ---

export interface UserProfile {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserCreate {
  username: string;
  email: string;
  password: string;
  role: UserRole;
}

export interface UserUpdate {
  email?: string;
  role?: UserRole;
  is_active?: boolean;
}

// --- Locations ---

export type LocationType = 'warehouse' | 'shop' | 'transit';

export interface Location {
  id: string;
  name: string;
  type: LocationType;
  address: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// --- Categories ---

export interface Category {
  id: string;
  name: string;
  description?: string;
  parent_id?: string;
  created_at: string;
  updated_at: string;
}

// --- Spare Parts ---

export interface SparePart {
  id: string;
  part_number: string;
  barcode?: string;
  name: string;
  description?: string;
  brand: string;
  category_id?: string;
  subcategory_id?: string;
  vehicle_compatibility?: Record<string, unknown>;
  unit_of_measure: string;
  cost_price: number;
  selling_price: number;
  min_stock_level: number;
  max_stock_level: number;
  reorder_quantity: number;
  price_review_needed?: boolean;
  total_stock?: number;
  created_at: string;
  updated_at: string;
}

export interface SparePartCreate {
  part_number: string;
  barcode?: string;
  name: string;
  description?: string;
  brand: string;
  category_id?: string;
  subcategory_id?: string;
  vehicle_compatibility?: Record<string, unknown>;
  unit_of_measure: string;
  cost_price: number;
  selling_price: number;
  min_stock_level: number;
  max_stock_level: number;
  reorder_quantity: number;
}

export interface SparePartUpdate {
  part_number?: string;
  name?: string;
  description?: string;
  brand?: string;
  category_id?: string;
  subcategory_id?: string;
  vehicle_compatibility?: Record<string, unknown>;
  unit_of_measure?: string;
  cost_price?: number;
  selling_price?: number;
  min_stock_level?: number;
  max_stock_level?: number;
  reorder_quantity?: number;
}

// --- Stock ---

export interface StockStatus {
  id: string;
  spare_part_id: string;
  location_id: string;
  current_quantity: number;
  last_reconciled_at: string;
  spare_part?: SparePart;
  location?: Location;
}

export type MovementType =
  | 'sale'
  | 'purchase_receipt'
  | 'transfer_out'
  | 'transfer_in'
  | 'transfer_in_transit'
  | 'transfer_received'
  | 'adjustment'
  | 'return';

export interface InventoryMovement {
  id: string;
  spare_part_id: string;
  location_id: string;
  quantity_change: number;
  movement_type: MovementType;
  reference_type: string;
  reference_id: string;
  unit_cost: number;
  created_by: string;
  created_at: string;
}

// --- Cost Layers ---

export interface CostLayer {
  id: string;
  spare_part_id: string;
  location_id: string;
  unit_cost: number;
  original_quantity: number;
  remaining_quantity: number;
  source_type: string;
  source_reference_id: string;
  created_at: string;
}

// --- Customers ---

export type AccountStatus = 'active' | 'suspended' | 'closed';

export interface Customer {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  tax_id?: string;
  credit_limit: number;
  account_status: AccountStatus;
  created_at: string;
  updated_at: string;
}

export interface CustomerCreate {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  tax_id?: string;
  credit_limit: number;
}

export interface CustomerUpdate {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  tax_id?: string;
  credit_limit?: number;
  account_status?: AccountStatus;
}

// --- Customer Credit Ledger ---

export type CreditTransactionType = 'sale' | 'payment' | 'adjustment' | 'return';

export interface CustomerCreditEntry {
  id: string;
  customer_id: string;
  transaction_type: CreditTransactionType;
  amount: number;
  reference_type: string;
  reference_id: string;
  notes?: string;
  created_by: string;
  created_at: string;
}

export interface AgingBucket {
  current: number;
  days_30: number;
  days_60: number;
  days_90: number;
  over_90: number;
  total: number;
}

// --- Suppliers ---

export interface Supplier {
  id: string;
  name: string;
  contact_person?: string;
  phone?: string;
  email?: string;
  address?: string;
  tax_id?: string;
  payment_terms?: string;
  account_status: AccountStatus;
  created_at: string;
  updated_at: string;
}

export interface SupplierCreate {
  name: string;
  contact_person?: string;
  phone?: string;
  email?: string;
  address?: string;
  tax_id?: string;
  payment_terms?: string;
}

export interface SupplierUpdate {
  name?: string;
  contact_person?: string;
  phone?: string;
  email?: string;
  address?: string;
  tax_id?: string;
  payment_terms?: string;
  account_status?: AccountStatus;
}

// --- Sales ---

export type SaleStatus = 'DRAFT' | 'CONFIRMED' | 'RETURNED' | 'CANCELLED';
export type PaymentType = 'CASH' | 'CREDIT';

export interface Sale {
  id: string;
  customer_id?: string;
  location_id: string;
  invoice_number?: string;
  status: SaleStatus;
  payment_type: PaymentType;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  discount_total: number;
  amount_paid?: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  items?: SaleItem[];
  customer?: Customer;
  customer_name?: string;
  created_by_username?: string;
}

export interface SaleItem {
  id: string;
  sale_id: string;
  spare_part_id: string;
  quantity: number;
  unit_price: number;
  discount_amount: number;
  line_total: number;
  cost_of_goods_sold?: number;
  returned_quantity?: number;
  spare_part?: SparePart;
}

export interface SaleCreate {
  customer_id?: string;
  location_id: string;
  payment_type: PaymentType;
  amount_paid?: number;
  items: SaleItemCreate[];
}

export interface SaleItemCreate {
  spare_part_id: string;
  quantity: number;
  unit_price: number;
  discount_amount?: number;
}

export interface SaleReturnRequest {
  items: Array<{
    sale_item_id: string;
    quantity: number;
    reason?: string;
  }>;
  return_location_id?: string;
}

// --- Purchase Orders ---

export type PurchaseOrderStatus =
  | 'draft'
  | 'approved'
  | 'ordered'
  | 'partially_received'
  | 'received'
  | 'cancelled';

export interface PurchaseOrder {
  id: string;
  supplier_id: string;
  status: PurchaseOrderStatus;
  total_amount: number;
  notes?: string;
  created_by: string;
  approved_by?: string;
  approved_at?: string;
  created_at: string;
  updated_at: string;
  items?: PurchaseOrderItem[];
  supplier?: Supplier;
}

export interface PurchaseOrderItem {
  id: string;
  purchase_order_id: string;
  spare_part_id: string;
  quantity_ordered: number;
  quantity_received: number;
  unit_cost: number;
  spare_part?: SparePart;
}

export interface PurchaseOrderCreate {
  supplier_id: string;
  notes?: string;
  items: PurchaseOrderItemCreate[];
}

export interface PurchaseOrderItemCreate {
  spare_part_id: string;
  quantity_ordered: number;
  unit_cost: number;
}

// --- Goods Receipt Notes ---

export interface GoodsReceiptNote {
  id: string;
  purchase_order_id: string;
  location_id: string;
  received_by: string;
  received_at: string;
  notes?: string;
  created_at: string;
  items?: GRNItem[];
}

export interface GRNItem {
  id: string;
  grn_id: string;
  po_item_id: string;
  spare_part_id: string;
  quantity_received: number;
  unit_cost: number;
}

export interface GRNCreate {
  purchase_order_id: string;
  location_id: string;
  notes?: string;
  items: GRNItemCreate[];
}

export interface GRNItemCreate {
  po_item_id: string;
  spare_part_id: string;
  quantity_received: number;
  unit_cost: number;
}

// --- Transfers ---

export type TransferStatus = 'pending' | 'approved' | 'in_transit' | 'received' | 'cancelled';

export interface Transfer {
  id: string;
  spare_part_id: string;
  source_location_id: string;
  destination_location_id: string;
  quantity: number;
  status: TransferStatus;
  consumed_layer_details?: Record<string, unknown>[];
  requested_by: string;
  approved_by?: string;
  received_by?: string;
  approved_at?: string;
  received_at?: string;
  cancellation_reason?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
  updated_by?: string;
  spare_part?: SparePart;
  spare_part_name?: string;
  spare_part_number?: string;
  source_location?: Location;
  source_location_name?: string;
  destination_location?: Location;
  destination_location_name?: string;
}

export interface TransferCreate {
  spare_part_id: string;
  source_location_id: string;
  destination_location_id: string;
  quantity: number;
}

// --- Audits ---

export type AuditType = 'cycle_count' | 'full_stock_count';
// 'initiated' is the status the backend assigns a freshly created audit session
// (before any counts are entered); the audit pages treat it as a live/open state.
export type AuditStatus = 'initiated' | 'in_progress' | 'pending_approval' | 'completed' | 'cancelled';

export interface AuditSession {
  id: string;
  location_id: string;
  location_name?: string;
  audit_type: AuditType;
  status: AuditStatus;
  snapshot_timestamp: string;
  initiated_by: string;
  approved_by?: string;
  completed_at?: string;
  created_at: string;
}

export interface AuditSnapshotItem {
  id: string;
  session_id: string;
  spare_part_id: string;
  part_name?: string;
  part_number?: string;
  snapshot_quantity: number;
}

export interface AuditCount {
  id: string;
  session_id: string;
  spare_part_id: string;
  counted_quantity: number;
  variance: number;
  counted_by: string;
  counted_at: string;
}

export interface AuditCountSubmit {
  spare_part_id: string;
  counted_quantity: number;
}

// --- Notifications ---

export type NotificationType =
  | 'low_stock'
  | 'credit_limit_exceeded'
  | 'overdue_customer'
  | 'overdue_supplier'
  | 'pending_approval'
  | 'system';

export interface Notification {
  id: string;
  user_id: string;
  notification_type: NotificationType;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  is_read: boolean;
  created_at: string;
  read_at?: string;
  resolved_status?: string;
}

// --- Dashboard ---

export interface DashboardKPIs {
  total_sales_today: string | number;
  total_sales_month: string | number;
  outstanding_receivables: string | number;
  low_stock_count: number;
  pending_po_count: number;
  top_selling_products: Array<{
    spare_part_id: string;
    part_name: string;
    part_number: string;
    total_quantity_sold: string | number;
  }> | null;
}

export interface ProfitSummary {
  period: string;
  period_label: string;
  total_revenue: number;
  total_cogs: number;
  gross_margin: number;
  margin_pct: number;
  sale_count: number;
}

// --- Reports ---

export type ReportType = 'sales' | 'inventory' | 'customer' | 'supplier' | 'financial';

export interface ReportRequest {
  type: ReportType;
  start_date: string;
  end_date: string;
  location_id?: string;
  format?: 'pdf' | 'csv';
}

// --- Audit Trail ---

export interface AuditTrailEntry {
  id: string;
  user_id: string;
  action_type: string;
  entity_type: string;
  entity_id: string;
  old_values?: Record<string, unknown>;
  new_values?: Record<string, unknown>;
  ip_address: string;
  created_at: string;
}

// --- Invoices ---

export type InvoiceFormat = 'a4' | 'thermal';

export interface Invoice {
  id: string;
  sale_id: string;
  invoice_number: string;
  format: InvoiceFormat;
  created_at: string;
}
