"""Pydantic schemas for report endpoints.

Provides response models for sales, inventory, customer, supplier,
and financial summary reports.

Satisfies Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, Field


# =============================================================================
# Sales Report Schemas
# =============================================================================


class SalesReportRowSchema(BaseModel):
    """A single row in the sales report."""

    sale_id: UUID
    invoice_number: Optional[str] = None
    sale_date: datetime
    customer_name: Optional[str] = None
    location_id: UUID
    location_name: Optional[str] = None
    salesperson_name: Optional[str] = None
    total_amount: Decimal
    discount_total: Decimal
    tax_amount: Decimal
    cost_of_goods_sold: Decimal
    gross_margin: Decimal


class SalesReportResponse(BaseModel):
    """Sales report response with rows and summary."""

    start_date: date
    end_date: date
    location_id: Optional[UUID] = None
    salesperson_id: Optional[UUID] = None
    customer_id: Optional[UUID] = None
    category_id: Optional[UUID] = None
    rows: list[SalesReportRowSchema] = Field(default_factory=list)
    total_sales: Decimal = Decimal("0.00")
    total_cogs: Decimal = Decimal("0.00")
    total_gross_margin: Decimal = Decimal("0.00")
    total_discount: Decimal = Decimal("0.00")
    sale_count: int = 0


# =============================================================================
# Inventory Report Schemas
# =============================================================================


class InventoryReportRowSchema(BaseModel):
    """A single row in the inventory report."""

    spare_part_id: UUID
    part_number: str
    name: str
    brand: Optional[str] = None
    category_id: Optional[UUID] = None
    category_name: Optional[str] = None
    location_id: Optional[UUID] = None
    location_name: Optional[str] = None
    current_quantity: Decimal
    unit_cost: Decimal
    stock_value: Decimal
    min_stock_level: Decimal
    is_below_reorder: bool
    last_movement_date: Optional[datetime] = None


class InventoryReportResponse(BaseModel):
    """Inventory report response with rows and summary."""

    location_id: Optional[UUID] = None
    category_id: Optional[UUID] = None
    rows: list[InventoryReportRowSchema] = Field(default_factory=list)
    total_stock_value: Decimal = Decimal("0.00")
    below_reorder_count: int = 0
    slow_moving_count: int = 0
    total_items: int = 0


# =============================================================================
# Customer Report Schemas
# =============================================================================


class CustomerReportRowSchema(BaseModel):
    """A single row in the customer report."""

    customer_id: UUID
    customer_name: str
    total_purchases: Decimal
    purchase_count: int
    outstanding_balance: Decimal
    current: Decimal = Decimal("0.00")
    days_30: Decimal = Decimal("0.00")
    days_60: Decimal = Decimal("0.00")
    days_90: Decimal = Decimal("0.00")
    days_120_plus: Decimal = Decimal("0.00")


class CustomerReportResponse(BaseModel):
    """Customer report response with rows and summary."""

    start_date: date
    end_date: date
    customer_id: Optional[UUID] = None
    rows: list[CustomerReportRowSchema] = Field(default_factory=list)
    total_outstanding: Decimal = Decimal("0.00")
    total_purchases: Decimal = Decimal("0.00")
    customer_count: int = 0


# =============================================================================
# Supplier Report Schemas
# =============================================================================


class SupplierReportRowSchema(BaseModel):
    """A single row in the supplier report."""

    supplier_id: UUID
    supplier_name: str
    total_purchases: Decimal
    purchase_count: int
    outstanding_balance: Decimal
    current: Decimal = Decimal("0.00")
    days_30: Decimal = Decimal("0.00")
    days_60: Decimal = Decimal("0.00")
    days_90: Decimal = Decimal("0.00")
    days_120_plus: Decimal = Decimal("0.00")


class SupplierReportResponse(BaseModel):
    """Supplier report response with rows and summary."""

    start_date: date
    end_date: date
    supplier_id: Optional[UUID] = None
    rows: list[SupplierReportRowSchema] = Field(default_factory=list)
    total_outstanding: Decimal = Decimal("0.00")
    total_purchases: Decimal = Decimal("0.00")
    supplier_count: int = 0


# =============================================================================
# Financial Summary Schemas
# =============================================================================


class FinancialSummaryResponse(BaseModel):
    """Financial summary report response."""

    start_date: date
    end_date: date
    total_sales_revenue: Decimal = Decimal("0.00")
    cost_of_goods_sold: Decimal = Decimal("0.00")
    gross_margin: Decimal = Decimal("0.00")
    gross_margin_percentage: Decimal = Decimal("0.00")
    accounts_receivable: Decimal = Decimal("0.00")
    accounts_payable: Decimal = Decimal("0.00")
    sale_count: int = 0
    purchase_count: int = 0


# =============================================================================
# Dashboard Schemas
# =============================================================================


class TopSellingProductSchema(BaseModel):
    """A top selling product item."""

    # External sale items intentionally have no inventory record.
    spare_part_id: Optional[str] = None
    part_name: str
    part_number: Optional[str] = None
    total_quantity_sold: str


class DashboardKPIResponse(BaseModel):
    """Dashboard KPI response with role-based content."""

    total_sales_today: str
    total_sales_month: str
    outstanding_receivables: Optional[str] = None
    low_stock_count: Optional[int] = None
    pending_po_count: Optional[int] = None
    top_selling_products: Optional[list[TopSellingProductSchema]] = None
