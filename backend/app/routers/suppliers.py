"""Supplier management router with CRUD, balance, and aging endpoints.

Provides the following endpoints:
- GET    /api/v1/suppliers              - List all suppliers (paginated)
- POST   /api/v1/suppliers              - Create a new supplier
- GET    /api/v1/suppliers/{id}         - Get supplier by ID
- PUT    /api/v1/suppliers/{id}         - Update a supplier
- DELETE /api/v1/suppliers/{id}         - Soft-delete a supplier
- GET    /api/v1/suppliers/{id}/balance - Get supplier balance
- GET    /api/v1/suppliers/{id}/aging   - Get supplier aging analysis

Satisfies Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
"""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.dependencies import CurrentUser, DbSession
from app.middleware.auth import require_roles
from app.services.permission_service import require_permission
from app.models.user import User, UserRole
from app.schemas.auth import ErrorResponse
from app.schemas.supplier import (
    SupplierPaymentRequest,
    SupplierBalanceResponse,
    SupplierCreate,
    SupplierListResponse,
    SupplierResponse,
    SupplierUpdate,
)
from app.services.supplier_service import (
    SupplierNotFoundError,
    SupplierService,
)

router = APIRouter(prefix="/api/v1/suppliers", tags=["Suppliers"])


def _get_supplier_service(db) -> SupplierService:
    """Create a SupplierService instance."""
    return SupplierService(db=db)


# =============================================================================
# Endpoints
# =============================================================================


@router.get(
    "",
    response_model=SupplierListResponse,
    status_code=status.HTTP_200_OK,
    summary="List all suppliers",
    description="Retrieve a paginated list of all active suppliers.",
)
async def list_suppliers(
    db: DbSession,
    current_user: CurrentUser,
    page: int = Query(default=1, ge=1, description="Page number"),
    page_size: int = Query(default=20, ge=1, le=100, description="Items per page"),
    search: Optional[str] = Query(
        default=None, description="Search by name, contact person, phone, or email"
    ),
) -> SupplierListResponse:
    """List all active suppliers with pagination.

    Accessible by Manager and Admin roles only.
    """
    service = _get_supplier_service(db)
    suppliers, total = await service.list_suppliers(
        page=page, page_size=page_size, search=search
    )

    return SupplierListResponse(
        data=[SupplierResponse.model_validate(s) for s in suppliers],
        meta={"page": page, "total": total, "page_size": page_size},
    )


@router.post(
    "",
    response_model=SupplierResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new supplier",
    description="Create a new supplier record. Manager or Admin only.",
    responses={
        400: {"model": ErrorResponse, "description": "Validation error"},
        403: {"model": ErrorResponse, "description": "Insufficient permissions"},
    },
)
async def create_supplier(
    request: SupplierCreate,
    db: DbSession,
    current_user: User = Depends(
        require_permission("purchasing")
    ),
) -> SupplierResponse:
    """Create a new supplier.

    Requirement 8.1: Store supplier profiles with all required attributes.
    """
    service = _get_supplier_service(db)

    supplier = await service.create_supplier(
        data=request,
        created_by=str(current_user.id),
    )
    await db.commit()
    await db.refresh(supplier)
    return SupplierResponse.model_validate(supplier)


@router.get(
    "/{supplier_id}",
    response_model=SupplierResponse,
    status_code=status.HTTP_200_OK,
    summary="Get supplier by ID",
    description="Retrieve a single supplier by its UUID.",
    responses={
        404: {"model": ErrorResponse, "description": "Supplier not found"},
    },
)
async def get_supplier(
    supplier_id: UUID,
    db: DbSession,
    current_user: CurrentUser,
) -> SupplierResponse:
    """Get a single supplier by ID.

    Accessible by Manager and Admin roles.
    """
    service = _get_supplier_service(db)

    try:
        supplier = await service.get_supplier(supplier_id)
        return SupplierResponse.model_validate(supplier)
    except SupplierNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Supplier not found",
        )


@router.put(
    "/{supplier_id}",
    response_model=SupplierResponse,
    status_code=status.HTTP_200_OK,
    summary="Update a supplier",
    description="Update an existing supplier's attributes.",
    responses={
        400: {"model": ErrorResponse, "description": "Validation error"},
        404: {"model": ErrorResponse, "description": "Supplier not found"},
    },
)
async def update_supplier(
    supplier_id: UUID,
    request: SupplierUpdate,
    db: DbSession,
    current_user: User = Depends(
        require_permission("purchasing")
    ),
) -> SupplierResponse:
    """Update a supplier's attributes (partial update).

    Accessible by Manager and Admin roles.
    """
    service = _get_supplier_service(db)

    try:
        supplier = await service.update_supplier(
            supplier_id=supplier_id,
            data=request,
            updated_by=str(current_user.id),
        )
        await db.commit()
        await db.refresh(supplier)
        return SupplierResponse.model_validate(supplier)
    except SupplierNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Supplier not found",
        )


@router.delete(
    "/{supplier_id}",
    response_model=SupplierResponse,
    status_code=status.HTTP_200_OK,
    summary="Delete a supplier",
    description="Soft-delete a supplier. Manager or Admin only.",
    responses={
        403: {"model": ErrorResponse, "description": "Insufficient permissions"},
        404: {"model": ErrorResponse, "description": "Supplier not found"},
    },
)
async def delete_supplier(
    supplier_id: UUID,
    db: DbSession,
    current_user: User = Depends(
        require_permission("purchasing")
    ),
) -> SupplierResponse:
    """Soft-delete a supplier.

    Only Managers and Admins can delete suppliers.
    """
    service = _get_supplier_service(db)

    try:
        supplier = await service.delete_supplier(
            supplier_id=supplier_id,
            deleted_by=str(current_user.id),
        )
        await db.commit()
        return SupplierResponse.model_validate(supplier)
    except SupplierNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Supplier not found",
        )


@router.get(
    "/{supplier_id}/balance",
    response_model=SupplierBalanceResponse,
    status_code=status.HTTP_200_OK,
    summary="Get supplier balance",
    description="Get the current outstanding balance for a supplier.",
    responses={
        404: {"model": ErrorResponse, "description": "Supplier not found"},
    },
)
async def get_supplier_balance(
    supplier_id: UUID,
    db: DbSession,
    current_user: CurrentUser,
) -> SupplierBalanceResponse:
    """Get the current outstanding balance for a supplier.

    Requirement 8.3: Calculate the current supplier balance as the sum
    of all purchase and payment entries for that supplier.

    Accessible by Manager and Admin roles.
    """
    service = _get_supplier_service(db)

    try:
        supplier = await service.get_supplier(supplier_id)
        balance = await service.calculate_balance(supplier_id)
        aging = await service.calculate_aging(supplier_id)

        return SupplierBalanceResponse(
            supplier_id=supplier.id,
            supplier_name=supplier.name,
            total_balance=balance,
            aging=aging,
        )
    except SupplierNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Supplier not found",
        )


@router.get(
    "/{supplier_id}/aging",
    response_model=SupplierBalanceResponse,
    status_code=status.HTTP_200_OK,
    summary="Get supplier aging analysis",
    description="Get aging analysis for a supplier's outstanding balance.",
    responses={
        404: {"model": ErrorResponse, "description": "Supplier not found"},
    },
)
async def get_supplier_aging(
    supplier_id: UUID,
    db: DbSession,
    current_user: CurrentUser,
) -> SupplierBalanceResponse:
    """Get aging analysis for a supplier's outstanding balance.

    Requirement 8.4: Calculate supplier aging analysis categorizing
    outstanding amounts into current, 1-30 days, 31-60 days, 61-90 days,
    and over 90 days overdue.

    Accessible by Manager and Admin roles.
    """
    service = _get_supplier_service(db)

    try:
        supplier = await service.get_supplier(supplier_id)
        balance = await service.calculate_balance(supplier_id)
        aging = await service.calculate_aging(supplier_id)

        return SupplierBalanceResponse(
            supplier_id=supplier.id,
            supplier_name=supplier.name,
            total_balance=balance,
            aging=aging,
        )
    except SupplierNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Supplier not found",
        )


@router.get(
    "/{supplier_id}/payment-schedule",
    status_code=status.HTTP_200_OK,
    summary="Get supplier payment schedule",
    description="Returns upcoming and overdue payment entries for a supplier.",
    responses={
        404: {"model": ErrorResponse, "description": "Supplier not found"},
    },
)
async def get_supplier_payment_schedule(
    supplier_id: UUID,
    db: DbSession,
    current_user: CurrentUser,
) -> dict:
    """Get payment schedule for a supplier — upcoming and overdue payments.

    Returns PURCHASE ledger entries that have a payment_due_date set,
    grouped into overdue (past due) and upcoming (future due), with
    payment status derived from the running balance.
    """
    from datetime import datetime, timezone
    from decimal import Decimal
    from sqlalchemy import select, and_
    from app.models.supplier_ledger import SupplierLedger, SupplierTransactionType

    service = _get_supplier_service(db)
    try:
        supplier = await service.get_supplier(supplier_id)
    except SupplierNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Supplier not found",
        )

    now = datetime.now(timezone.utc)

    # Get all PURCHASE entries with a due date for this supplier
    stmt = (
        select(SupplierLedger)
        .filter(
            SupplierLedger.supplier_id == supplier_id,
            SupplierLedger.amount > Decimal("0"),
        )
        .order_by(SupplierLedger.created_at.asc(), SupplierLedger.id)
    )
    result = await db.execute(stmt)
    entries = result.scalars().all()

    # Get total payments made (credits)
    payments_stmt = (
        select(
            SupplierLedger.amount,
        )
        .filter(
            SupplierLedger.supplier_id == supplier_id,
            SupplierLedger.amount < Decimal("0"),
        )
        .order_by(SupplierLedger.created_at.asc())
    )
    payments_result = await db.execute(payments_stmt)
    total_paid = abs(sum((row[0] for row in payments_result.all()), Decimal("0")))

    # Apply payments to entries in FIFO order to determine which are still outstanding
    overdue = []
    upcoming = []
    remaining_credits = total_paid

    for entry in entries:
        outstanding = entry.amount
        if remaining_credits > Decimal("0"):
            apply = min(outstanding, remaining_credits)
            outstanding -= apply
            remaining_credits -= apply

        if outstanding <= Decimal("0"):
            continue  # Fully paid

        if entry.payment_due_date is None:
            continue
        due_date = entry.payment_due_date
        if due_date.tzinfo is None:
            due_date = due_date.replace(tzinfo=timezone.utc)

        item = {
            "id": str(entry.id),
            "amount": float(entry.amount),
            "outstanding": float(outstanding),
            "due_date": entry.payment_due_date.isoformat(),
            "created_at": entry.created_at.isoformat(),
            "notes": entry.notes,
            "days_overdue": max(0, (now - due_date).days) if due_date < now else 0,
            "days_until_due": max(0, (due_date - now).days) if due_date >= now else 0,
            "status": "overdue" if due_date < now else "upcoming",
        }

        if due_date < now:
            overdue.append(item)
        else:
            upcoming.append(item)

    return {
        "supplier_id": str(supplier_id),
        "supplier_name": supplier.name,
        "payment_terms": supplier.payment_terms,
        "overdue": overdue,
        "upcoming": upcoming,
        "total_overdue": sum(item["outstanding"] for item in overdue),
        "total_upcoming": sum(item["outstanding"] for item in upcoming),
    }


@router.get("/{supplier_id}/ledger")
async def get_supplier_ledger(
    supplier_id: UUID, db: DbSession,
    current_user: User = Depends(require_permission("purchasing")),
    page: int = Query(default=1, ge=1),
) -> dict:
    from sqlalchemy import select
    from app.models.supplier_ledger import SupplierLedger
    entries = (await db.execute(select(SupplierLedger).where(SupplierLedger.supplier_id == supplier_id)
        .order_by(SupplierLedger.created_at.desc(), SupplierLedger.id).offset((page - 1) * 50).limit(50))).scalars().all()
    return {"data": [{"id": str(e.id), "created_at": e.created_at.isoformat(), "transaction_type": e.transaction_type,
        "amount": str(e.amount), "reference_type": e.reference_type, "notes": e.notes} for e in entries]}


@router.post("/{supplier_id}/payments")
async def record_supplier_payment(
    supplier_id: UUID, request: "SupplierPaymentRequest", db: DbSession,
    current_user: User = Depends(require_permission("purchasing")),
) -> dict:
    from sqlalchemy import select
    from app.models.supplier import Supplier
    from app.models.supplier_ledger import SupplierLedger
    supplier = await db.scalar(select(Supplier).where(Supplier.id == supplier_id, Supplier.deleted_at.is_(None)).with_for_update())
    if supplier is None:
        raise HTTPException(404, "Supplier not found")
    # Stable client reference makes retrying an uncertain response safe.
    existing = await db.scalar(select(SupplierLedger).where(SupplierLedger.supplier_id == supplier_id,
        SupplierLedger.reference_type == "payment", SupplierLedger.reference_id == request.reference_id))
    if existing:
        if existing.amount != -request.amount or existing.notes != request.notes:
            raise HTTPException(409, "Payment reference has already been used with different details")
        return {"id": str(existing.id)}
    entry = await _get_supplier_service(db).record_payment(supplier_id, request.amount, request.reference_id, current_user.id, request.notes)
    await db.commit()
    return {"id": str(entry.id)}
