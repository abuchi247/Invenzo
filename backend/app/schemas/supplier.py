"""Pydantic schemas for supplier management endpoints.

Defines request/response models for supplier CRUD operations.

Satisfies Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
"""

from datetime import datetime
from decimal import Decimal
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.models.supplier import SupplierAccountStatus


# =============================================================================
# Request Schemas
# =============================================================================


class SupplierCreate(BaseModel):
    """Request body for POST /api/v1/suppliers (create a new supplier)."""

    name: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Supplier name",
        examples=["AutoParts Global Ltd"],
    )
    contact_person: Optional[str] = Field(
        default=None,
        max_length=255,
        description="Contact person name",
        examples=["John Doe"],
    )
    phone: Optional[str] = Field(
        default=None,
        max_length=50,
        description="Supplier phone number",
        examples=["+234 801 234 5678"],
    )
    email: Optional[str] = Field(
        default=None,
        max_length=255,
        description="Supplier email address",
        examples=["sales@autopartsglobal.com"],
    )
    address: Optional[str] = Field(
        default=None,
        max_length=2000,
        description="Supplier full address",
        examples=["456 Industrial Avenue, Lagos, Nigeria"],
    )
    tax_id: Optional[str] = Field(
        default=None,
        max_length=100,
        description="Tax identification number",
        examples=["TIN-87654321"],
    )
    payment_terms: Optional[str] = Field(
        default=None,
        max_length=100,
        description="Payment terms e.g. Net 30, Net 60",
        examples=["Net 30"],
    )
    account_status: Optional[str] = Field(
        default=SupplierAccountStatus.ACTIVE.value,
        description="Account status: active, suspended, or closed",
        examples=["active"],
    )

    @field_validator("account_status")
    @classmethod
    def validate_account_status(cls, v: Optional[str]) -> str:
        if v is None:
            return SupplierAccountStatus.ACTIVE.value
        valid_statuses = [s.value for s in SupplierAccountStatus]
        if v not in valid_statuses:
            raise ValueError(
                f"Invalid account status '{v}'. Must be one of: {valid_statuses}"
            )
        return v


class SupplierUpdate(BaseModel):
    """Request body for PUT /api/v1/suppliers/{id} (partial update)."""

    name: Optional[str] = Field(
        default=None,
        min_length=1,
        max_length=255,
        description="Supplier name",
    )
    contact_person: Optional[str] = Field(
        default=None,
        max_length=255,
        description="Contact person name",
    )
    phone: Optional[str] = Field(
        default=None,
        max_length=50,
        description="Supplier phone number",
    )
    email: Optional[str] = Field(
        default=None,
        max_length=255,
        description="Supplier email address",
    )
    address: Optional[str] = Field(
        default=None,
        max_length=2000,
        description="Supplier full address",
    )
    tax_id: Optional[str] = Field(
        default=None,
        max_length=100,
        description="Tax identification number",
    )
    payment_terms: Optional[str] = Field(
        default=None,
        max_length=100,
        description="Payment terms",
    )
    account_status: Optional[str] = Field(
        default=None,
        description="Account status: active, suspended, or closed",
    )

    @field_validator("account_status")
    @classmethod
    def validate_account_status(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        valid_statuses = [s.value for s in SupplierAccountStatus]
        if v not in valid_statuses:
            raise ValueError(
                f"Invalid account status '{v}'. Must be one of: {valid_statuses}"
            )
        return v


# =============================================================================
# Response Schemas
# =============================================================================


class SupplierResponse(BaseModel):
    """Response body for a single supplier."""

    id: UUID = Field(..., description="Supplier UUID")
    name: str = Field(..., description="Supplier name")
    contact_person: Optional[str] = Field(default=None, description="Contact person")
    phone: Optional[str] = Field(default=None, description="Phone number")
    email: Optional[str] = Field(default=None, description="Email address")
    address: Optional[str] = Field(default=None, description="Full address")
    tax_id: Optional[str] = Field(default=None, description="Tax ID")
    payment_terms: Optional[str] = Field(default=None, description="Payment terms")
    account_status: str = Field(..., description="Account status")
    created_at: Optional[datetime] = Field(default=None, description="Created timestamp")
    updated_at: Optional[datetime] = Field(default=None, description="Updated timestamp")
    created_by: Optional[str] = Field(default=None, description="Created by user")
    updated_by: Optional[str] = Field(default=None, description="Updated by user")

    model_config = {"from_attributes": True}


class SupplierListResponse(BaseModel):
    """Response body for supplier list with pagination metadata."""

    data: list[SupplierResponse] = Field(..., description="List of suppliers")
    meta: dict = Field(
        default_factory=lambda: {"page": 1, "total": 0},
        description="Pagination metadata",
    )


class SupplierBalanceResponse(BaseModel):
    """Response body for supplier balance information."""

    supplier_id: UUID = Field(..., description="Supplier UUID")
    supplier_name: str = Field(..., description="Supplier name")
    total_balance: Decimal = Field(..., description="Total outstanding balance")
    aging: dict = Field(
        default_factory=dict,
        description="Aging analysis breakdown",
    )

    model_config = {"from_attributes": True}


class SupplierPaymentRequest(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    reference_id: UUID
    notes: Optional[str] = Field(default=None, max_length=1000)
