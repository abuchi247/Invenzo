"""Pydantic schemas for sales endpoints.

Defines request/response models for sales transactions including
creating sales, confirming sales, and processing returns.

Satisfies Requirements: 5.1, 5.3, 5.4
"""

from datetime import datetime
from decimal import Decimal
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


# =============================================================================
# Request Schemas
# =============================================================================


class SaleItemCreate(BaseModel):
    """A single line item when creating a sale.

    Requirement 5.1: Line items with spare_part, quantity, and optional discount.
    """

    spare_part_id: UUID = Field(
        ...,
        description="UUID of the spare part to sell",
    )
    quantity: Decimal = Field(
        ...,
        gt=0,
        description="Quantity to sell (must be greater than 0)",
        examples=["2.00"],
    )
    unit_price: Decimal = Field(
        ...,
        gt=0,
        description="Unit price for the item",
        examples=["150.00"],
    )
    discount_amount: Decimal = Field(
        default=Decimal("0.00"),
        ge=0,
        description="Discount amount for this line item (default 0)",
        examples=["0.00"],
    )

    @field_validator("quantity")
    @classmethod
    def validate_quantity(cls, v: Decimal) -> Decimal:
        """Ensure quantity is positive."""
        if v <= 0:
            raise ValueError("Quantity must be greater than zero")
        return v

    @field_validator("unit_price")
    @classmethod
    def validate_unit_price(cls, v: Decimal) -> Decimal:
        """Ensure unit price is positive."""
        if v <= 0:
            raise ValueError("Unit price must be greater than zero")
        return v


class SaleCreate(BaseModel):
    """Request body for POST /api/v1/sales (create a sale in DRAFT status).

    Requirement 5.1: Create a sale with customer, location, line items, and payment type.
    """

    customer_id: Optional[UUID] = Field(
        default=None,
        description="UUID of the customer (NULL for walk-in customers)",
    )
    location_id: UUID = Field(
        ...,
        description="UUID of the selling location",
    )
    payment_type: str = Field(
        default="CASH",
        description="Payment type: CASH or CREDIT",
        examples=["CASH", "CREDIT"],
    )
    amount_paid: Optional[Decimal] = Field(
        default=None,
        ge=0,
        description="Amount paid at checkout. For credit sales, this can be a partial payment. Defaults to full amount for cash, 0 for credit.",
    )
    items: list[SaleItemCreate] = Field(
        default_factory=list,
        description="List of line items for the sale",
    )

    @field_validator("payment_type")
    @classmethod
    def validate_payment_type(cls, v: str) -> str:
        """Validate payment type is CASH or CREDIT."""
        v = v.upper()
        if v not in ("CASH", "CREDIT"):
            raise ValueError("Payment type must be CASH or CREDIT")
        return v


class ReturnItemSpec(BaseModel):
    """Specification of a single item to return."""

    sale_item_id: UUID = Field(
        ...,
        description="UUID of the sale item to return",
    )
    quantity: Decimal = Field(
        ...,
        gt=0,
        description="Quantity to return",
        examples=["1.00"],
    )
    reason: Optional[str] = Field(
        default=None,
        max_length=500,
        description="Reason for the return (e.g. 'Wrong part', 'Defective')",
        examples=["Customer received wrong part"],
    )

    @field_validator("quantity")
    @classmethod
    def validate_quantity(cls, v: Decimal) -> Decimal:
        """Ensure quantity is positive."""
        if v <= 0:
            raise ValueError("Return quantity must be greater than zero")
        return v


class SaleReturnRequest(BaseModel):
    """Request body for POST /api/v1/sales/{id}/return.

    If items is empty or not provided, all items are returned in full.
    """

    items: Optional[list[ReturnItemSpec]] = Field(
        default=None,
        description="Specific items to return. If not provided, all items are returned in full.",
    )

    return_location_id: Optional[UUID] = Field(
        default=None,
        description="Location to return items to. Defaults to the original sale location if not specified.",
    )


# =============================================================================
# Response Schemas
# =============================================================================


class SparePartBrief(BaseModel):
    """Brief spare part info for embedding in sale items."""
    id: UUID
    name: str
    part_number: str
    brand: Optional[str] = None

    model_config = {"from_attributes": True}


class SaleItemResponse(BaseModel):
    """Response body for a single sale line item."""

    id: UUID = Field(..., description="Sale item UUID")
    sale_id: UUID = Field(..., description="Parent sale UUID")
    spare_part_id: UUID = Field(..., description="Spare part UUID")
    quantity: Decimal = Field(..., description="Quantity sold")
    unit_price: Decimal = Field(..., description="Unit price at time of sale")
    discount_amount: Decimal = Field(..., description="Discount applied")
    line_total: Decimal = Field(..., description="Line total: (qty * price) - discount")
    cost_of_goods_sold: Optional[Decimal] = Field(
        default=None, description="COGS from FIFO layers (filled on confirm)"
    )
    returned_quantity: Decimal = Field(
        default=Decimal("0"), description="Total quantity already returned for this item"
    )
    spare_part: Optional[SparePartBrief] = Field(default=None, description="Spare part details")
    created_at: Optional[datetime] = Field(default=None, description="Created timestamp")

    model_config = {"from_attributes": True}


class SaleResponse(BaseModel):
    """Response body for a single sale transaction."""

    id: UUID = Field(..., description="Sale UUID")
    customer_id: Optional[UUID] = Field(default=None, description="Customer UUID")
    customer_name: Optional[str] = Field(default=None, description="Customer name")
    location_id: UUID = Field(..., description="Selling location UUID")
    invoice_number: Optional[str] = Field(
        default=None, description="Invoice number (generated on confirm)"
    )
    status: str = Field(..., description="Sale status (DRAFT, CONFIRMED, RETURNED, CANCELLED)")
    payment_type: str = Field(..., description="Payment type (CASH, CREDIT)")
    subtotal: Decimal = Field(..., description="Subtotal before tax")
    tax_amount: Decimal = Field(..., description="Tax amount")
    total_amount: Decimal = Field(..., description="Total amount")
    discount_total: Decimal = Field(..., description="Total discount")
    amount_paid: Optional[Decimal] = Field(default=Decimal("0.00"), description="Amount paid at checkout")
    items: list[SaleItemResponse] = Field(
        default_factory=list, description="Sale line items"
    )
    created_at: Optional[datetime] = Field(default=None, description="Created timestamp")
    updated_at: Optional[datetime] = Field(default=None, description="Updated timestamp")
    created_by: Optional[str] = Field(default=None, description="Created by user (UUID)")
    created_by_username: Optional[str] = Field(
        default=None, description="Username of the user who issued the sale"
    )
    updated_by: Optional[str] = Field(default=None, description="Updated by user")

    model_config = {"from_attributes": True}


class SaleSummaryResponse(BaseModel):
    """Lightweight sale row for list views — excludes line items.

    The sales list only renders header fields, so line items are intentionally
    omitted to avoid over-fetching every sale's items (and their parts) per page.
    """

    id: UUID = Field(..., description="Sale UUID")
    customer_id: Optional[UUID] = Field(default=None, description="Customer UUID")
    customer_name: Optional[str] = Field(default=None, description="Customer name")
    location_id: UUID = Field(..., description="Selling location UUID")
    invoice_number: Optional[str] = Field(default=None, description="Invoice number")
    status: str = Field(..., description="Sale status")
    payment_type: str = Field(..., description="Payment type")
    subtotal: Decimal = Field(..., description="Subtotal before tax")
    tax_amount: Decimal = Field(..., description="Tax amount")
    total_amount: Decimal = Field(..., description="Total amount")
    discount_total: Decimal = Field(..., description="Total discount")
    amount_paid: Optional[Decimal] = Field(default=Decimal("0.00"), description="Amount paid")
    created_at: Optional[datetime] = Field(default=None, description="Created timestamp")
    updated_at: Optional[datetime] = Field(default=None, description="Updated timestamp")
    created_by_username: Optional[str] = Field(
        default=None, description="Username of the user who issued the sale"
    )

    model_config = {"from_attributes": True}


class SaleListResponse(BaseModel):
    """Response body for sale list with pagination metadata."""

    data: list[SaleSummaryResponse] = Field(..., description="List of sales")
    meta: dict = Field(
        default_factory=lambda: {"page": 1, "total": 0},
        description="Pagination metadata",
    )
