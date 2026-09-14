"""
Sale and SaleItem models for the Auto Spare Parts ERP system.

This module defines the Sale and SaleItem models which track sales transactions
including line items, pricing, discounts, and cost of goods sold.

Satisfies Requirement 5.1: THE ERP_System SHALL allow a Salesperson to create a
Sale record selecting an optional Customer, a Location (shop counter), and adding
one or more Sale_Items (spare part, quantity, unit price, optional discount).
"""

import enum
import uuid
from decimal import Decimal
from typing import TYPE_CHECKING, Optional

from sqlalchemy import ForeignKey, Numeric, String, Enum
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import BaseModel, SoftDeleteMixin

if TYPE_CHECKING:
    from app.models.spare_part import SparePart


class SaleStatus(str, enum.Enum):
    """Enumeration of sale lifecycle statuses."""

    DRAFT = "DRAFT"
    CONFIRMED = "CONFIRMED"
    RETURNED = "RETURNED"
    CANCELLED = "CANCELLED"


class PaymentType(str, enum.Enum):
    """Enumeration of payment types for a sale."""

    CASH = "CASH"
    CREDIT = "CREDIT"


class Sale(BaseModel, SoftDeleteMixin):
    """Sale transaction model.

    Represents a sales transaction at a specific location, optionally tied to a
    customer. Sales follow a lifecycle: DRAFT → CONFIRMED → (RETURNED | CANCELLED).

    Satisfies Requirement 5.1: THE ERP_System SHALL allow a Salesperson to create
    a Sale record selecting an optional Customer, a Location (shop counter), and
    adding one or more Sale_Items.

    Columns:
        customer_id    - FK to customers (nullable for walk-in customers)
        location_id    - FK to locations (required, the shop counter)
        invoice_number - Unique invoice reference (nullable, generated on confirm)
        status         - Current sale status (DRAFT, CONFIRMED, RETURNED, CANCELLED)
        payment_type   - Payment method (CASH or CREDIT)
        subtotal       - Sum of line totals before tax
        tax_amount     - Total tax applied
        total_amount   - Final amount (subtotal + tax - discount)
        discount_total - Total discount applied across all line items
        created_by     - FK to users who created this sale

    Relationships:
        items    - Collection of SaleItem line items
        customer - The customer for this sale (optional)
        location - The location where the sale occurred
    """

    __tablename__ = "sales"

    # -------------------------------------------------------------------------
    # Foreign Keys
    # -------------------------------------------------------------------------
    customer_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("customers.id"),
        nullable=True,
        comment="Customer for this sale (NULL for walk-in customers)",
    )

    location_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("locations.id"),
        nullable=False,
        comment="Location (shop counter) where the sale occurred",
    )

    # -------------------------------------------------------------------------
    # Sale Identification
    # -------------------------------------------------------------------------
    invoice_number: Mapped[Optional[str]] = mapped_column(
        String(100),
        unique=True,
        nullable=True,
        comment="Unique invoice number (generated on confirmation)",
    )

    # -------------------------------------------------------------------------
    # Status and Payment
    # -------------------------------------------------------------------------
    status: Mapped[SaleStatus] = mapped_column(
        Enum(SaleStatus, name="sale_status", create_constraint=True),
        nullable=False,
        default=SaleStatus.DRAFT,
        comment="Current sale lifecycle status",
    )

    payment_type: Mapped[PaymentType] = mapped_column(
        Enum(PaymentType, name="payment_type", create_constraint=True),
        nullable=False,
        default=PaymentType.CASH,
        comment="Payment method for this sale",
    )

    # -------------------------------------------------------------------------
    # Financial Totals
    # -------------------------------------------------------------------------
    subtotal: Mapped[Decimal] = mapped_column(
        Numeric(precision=14, scale=2),
        nullable=False,
        default=Decimal("0.00"),
        comment="Sum of all line totals before tax",
    )

    tax_amount: Mapped[Decimal] = mapped_column(
        Numeric(precision=14, scale=2),
        nullable=False,
        default=Decimal("0.00"),
        comment="Total tax amount applied to the sale",
    )

    total_amount: Mapped[Decimal] = mapped_column(
        Numeric(precision=14, scale=2),
        nullable=False,
        default=Decimal("0.00"),
        comment="Final total amount (subtotal + tax)",
    )

    discount_total: Mapped[Decimal] = mapped_column(
        Numeric(precision=14, scale=2),
        nullable=False,
        default=Decimal("0.00"),
        comment="Total discount applied across all line items",
    )

    amount_paid: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(precision=14, scale=2),
        nullable=True,
        default=Decimal("0.00"),
        server_default="0.00",
        comment="Amount paid at checkout (for credit sales, this may be partial)",
    )

    # -------------------------------------------------------------------------
    # Relationships
    # -------------------------------------------------------------------------
    items: Mapped[list["SaleItem"]] = relationship(
        "SaleItem",
        back_populates="sale",
        cascade="all, delete-orphan",
        # Loaded explicitly via selectinload() where needed (sale detail,
        # confirm, return). Not auto-loaded, so the sales LIST endpoint — which
        # only renders header fields — does not over-fetch every sale's line
        # items and their parts on each page.
        lazy="select",
    )

    def __repr__(self) -> str:
        return (
            f"<Sale(id={self.id}, invoice_number='{self.invoice_number}', "
            f"status={self.status}, total_amount={self.total_amount})>"
        )


class SaleItem(BaseModel):
    """Sale line item model.

    Represents an individual item within a sale transaction, tracking the
    spare part sold, quantity, pricing, discount, and cost of goods sold.

    Satisfies Requirement 5.1: Sale_Items include spare part, quantity,
    unit price, and optional discount.

    Columns:
        sale_id            - FK to the parent sale
        spare_part_id      - FK to the spare part being sold
        quantity           - Quantity sold
        unit_price         - Price per unit at time of sale
        discount_amount    - Discount applied to this line item (default 0)
        line_total         - Calculated total: (quantity * unit_price) - discount_amount
        cost_of_goods_sold - COGS from FIFO layers (nullable, filled on confirm)

    Relationships:
        sale       - The parent sale transaction
        spare_part - The spare part being sold
    """

    __tablename__ = "sale_items"

    # -------------------------------------------------------------------------
    # Foreign Keys
    # -------------------------------------------------------------------------
    sale_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sales.id"),
        nullable=False,
        comment="Parent sale transaction",
    )

    spare_part_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("spare_parts.id"),
        nullable=True,
        comment="The spare part being sold",
    )

    # -------------------------------------------------------------------------
    # Quantity and Pricing
    # -------------------------------------------------------------------------
    source_type: Mapped[str] = mapped_column(String(20), nullable=False, default="STOCK", server_default="STOCK")
    external_description: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    external_part_number: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    supplier_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("suppliers.id"), nullable=True)
    supplier_unit_cost: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 2), nullable=True)
    supplier_amount_paid: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=Decimal("0"), server_default="0")
    external_returned_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0"), server_default="0")
    supplier_returned_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0"), server_default="0")

    quantity: Mapped[Decimal] = mapped_column(
        Numeric(precision=12, scale=2),
        nullable=False,
        comment="Quantity of the spare part sold",
    )

    unit_price: Mapped[Decimal] = mapped_column(
        Numeric(precision=12, scale=2),
        nullable=False,
        comment="Unit price at time of sale",
    )

    discount_amount: Mapped[Decimal] = mapped_column(
        Numeric(precision=12, scale=2),
        nullable=False,
        default=Decimal("0.00"),
        comment="Discount amount applied to this line item",
    )

    line_total: Mapped[Decimal] = mapped_column(
        Numeric(precision=14, scale=2),
        nullable=False,
        default=Decimal("0.00"),
        comment="Line total: (quantity * unit_price) - discount_amount",
    )

    cost_of_goods_sold: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(precision=14, scale=2),
        nullable=True,
        comment="Cost of goods sold from FIFO layers (filled on confirmation)",
    )

    # -------------------------------------------------------------------------
    # Relationships
    # -------------------------------------------------------------------------
    sale: Mapped["Sale"] = relationship(
        "Sale",
        back_populates="items",
        lazy="select",
    )

    spare_part: Mapped[Optional["SparePart"]] = relationship(
        "SparePart",
        # Loaded explicitly via selectinload() on the sale detail endpoint.
        lazy="select",
    )

    def __repr__(self) -> str:
        return (
            f"<SaleItem(id={self.id}, sale_id={self.sale_id}, "
            f"spare_part_id={self.spare_part_id}, quantity={self.quantity}, "
            f"line_total={self.line_total})>"
        )
