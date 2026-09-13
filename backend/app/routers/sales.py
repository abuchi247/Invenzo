"""Sales router for sales transaction endpoints.

Provides the following endpoints:
- GET    /api/v1/sales              - List sales (paginated, filterable by status)
- POST   /api/v1/sales              - Create a sale in DRAFT status
- GET    /api/v1/sales/{id}         - Get sale by ID
- POST   /api/v1/sales/{id}/confirm - Confirm a sale (validate stock, consume FIFO)
- POST   /api/v1/sales/{id}/return  - Process a sales return (Manager, Admin)

Satisfies Requirements: 5.1, 5.3, 5.4
"""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import CurrentUser, DbSession
from app.middleware.auth import require_roles
from app.services.permission_service import require_permission
from app.models.sale import Sale, SaleStatus, PaymentType
from app.models.user import User, UserRole
from app.schemas.auth import ErrorResponse
from app.schemas.sale import (
    SaleCreate,
    SaleListResponse,
    SaleResponse,
    SaleReturnRequest,
    SaleSummaryResponse,
)
from app.services.sales_service import (
    InsufficientStockError,
    InvalidSaleStatusError,
    ReturnQuantityExceededError,
    SaleHasNoItemsError,
    SaleNotFoundError,
    SalesService,
)
from app.services.credit_ledger_service import CreditLimitExceededError
from app.models.sale import SaleItem

router = APIRouter(prefix="/api/v1/sales", tags=["Sales"])


def _get_sales_service(db: AsyncSession, user_id: UUID) -> SalesService:
    """Create a SalesService instance."""
    return SalesService(db=db, user_id=user_id)


# =============================================================================
# Endpoints
# =============================================================================


@router.get(
    "",
    response_model=SaleListResponse,
    status_code=status.HTTP_200_OK,
    summary="List sales",
    description="Retrieve a paginated list of sales, optionally filtered by status. Accessible by Salesperson, Manager, and Admin.",
)
async def list_sales(
    db: DbSession,
    current_user: CurrentUser,
    page: int = Query(default=1, ge=1, description="Page number"),
    page_size: int = Query(default=20, ge=1, le=100, description="Items per page"),
    status_filter: Optional[str] = Query(
        default=None,
        alias="status",
        description="Filter by sale status (DRAFT, CONFIRMED, RETURNED, CANCELLED)",
    ),
    search: Optional[str] = Query(
        default=None,
        description="Search by invoice number or customer name (partial, case-insensitive)",
    ),
    date_from: Optional[str] = Query(
        default=None,
        description="Include sales on/after this date (YYYY-MM-DD, inclusive)",
    ),
    date_to: Optional[str] = Query(
        default=None,
        description="Include sales on/before this date (YYYY-MM-DD, inclusive)",
    ),
    product: Optional[str] = Query(
        default=None,
        description="Only sales containing a matching product (part number or name)",
    ),
    sort_by: Optional[str] = Query(
        default="created_at",
        description="Sort field: created_at, total_amount, or invoice_number",
    ),
    sort_direction: Optional[str] = Query(
        default="desc",
        description="Sort direction: asc or desc",
    ),
) -> SaleListResponse:
    """List sales with status, date-range, product, and text filters.

    Accessible by Salesperson, Manager, and Admin roles.
    """
    from datetime import datetime, timezone, timedelta
    from app.models.sale import SaleItem
    from app.models.spare_part import SparePart
    from app.models.customer import Customer

    def _apply_filters(stmt):
        """Apply the shared WHERE clauses to a count or data statement."""
        stmt = stmt.filter(Sale.deleted_at.is_(None))
        if status_filter:
            stmt = stmt.filter(Sale.status == status_filter)
        if search and search.strip():
            like = f"%{search.strip()}%"
            matching_customer = (
                select(Customer.id)
                .where(Customer.id == Sale.customer_id, Customer.name.ilike(like))
                .exists()
            )
            matches = [Sale.invoice_number.ilike(like), matching_customer]
            # The UI labels sales without a customer as "Walk-in". Include that
            # label in text search, accepting spaces and hyphens interchangeably.
            normalized = search.strip().casefold().replace("-", "").replace(" ", "")
            if normalized and normalized in "walkin":
                matches.append(Sale.customer_id.is_(None))
            stmt = stmt.filter(or_(*matches))
        # Date range on created_at. date_to is inclusive of the whole day.
        if date_from:
            try:
                start = datetime.strptime(date_from, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                stmt = stmt.filter(Sale.created_at >= start)
            except ValueError:
                pass
        if date_to:
            try:
                end = datetime.strptime(date_to, "%Y-%m-%d").replace(
                    tzinfo=timezone.utc
                ) + timedelta(days=1)
                stmt = stmt.filter(Sale.created_at < end)
            except ValueError:
                pass
        # "Goods sold" — sales that contain a line item matching the product.
        if product:
            like = f"%{product.strip()}%"
            product_subq = (
                select(SaleItem.id)
                .join(SparePart, SparePart.id == SaleItem.spare_part_id)
                .filter(
                    SaleItem.sale_id == Sale.id,
                    or_(
                        SparePart.part_number.ilike(like),
                        SparePart.name.ilike(like),
                    ),
                )
            )
            stmt = stmt.filter(product_subq.exists())
        return stmt

    # Count query — exclude soft-deleted sales, apply the same filters.
    count_stmt = _apply_filters(select(func.count()).select_from(Sale))
    count_result = await db.execute(count_stmt)
    total = count_result.scalar() or 0

    # Sorting — whitelist the column, default to created_at desc.
    sort_columns = {
        "created_at": Sale.created_at,
        "total_amount": Sale.total_amount,
        "invoice_number": Sale.invoice_number,
    }
    sort_col = sort_columns.get(sort_by or "created_at", Sale.created_at)
    order_by = sort_col.asc() if (sort_direction or "desc").lower() == "asc" else sort_col.desc()

    # Data query — exclude soft-deleted sales, apply filters + sort + paging.
    offset = (page - 1) * page_size
    data_stmt = _apply_filters(select(Sale)).order_by(order_by).offset(offset).limit(page_size)

    result = await db.execute(data_stmt)
    sales = list(result.scalars().all())

    # Enrich with customer names
    from app.models.customer import Customer
    customer_ids = list({s.customer_id for s in sales if s.customer_id})
    customer_map: dict = {}
    if customer_ids:
        cust_stmt = select(Customer.id, Customer.name).filter(Customer.id.in_(customer_ids))
        cust_result = await db.execute(cust_stmt)
        customer_map = {row.id: row.name for row in cust_result.all()}

    # Enrich with issuing-user names (created_by is a UUID string). Batch-resolve.
    from app.models.user import User
    creator_ids = set()
    for s in sales:
        if s.created_by:
            try:
                creator_ids.add(UUID(str(s.created_by)))
            except (ValueError, TypeError):
                pass
    username_map: dict = {}
    if creator_ids:
        user_stmt = select(User.id, User.username).filter(User.id.in_(creator_ids))
        user_result = await db.execute(user_stmt)
        username_map = {row.id: row.username for row in user_result.all()}

    data = []
    for s in sales:
        resp = SaleSummaryResponse.model_validate(s)
        resp.customer_name = customer_map.get(s.customer_id) if s.customer_id else None
        if s.created_by:
            try:
                resp.created_by_username = username_map.get(UUID(str(s.created_by)))
            except (ValueError, TypeError):
                resp.created_by_username = None
        data.append(resp)

    return SaleListResponse(
        data=data,
        meta={"page": page, "total": total, "page_size": page_size},
    )


@router.post(
    "",
    response_model=SaleResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a sale",
    description="Create a new sale in DRAFT status. Salesperson, Manager, or Admin only.",
    responses={
        400: {"model": ErrorResponse, "description": "Validation error"},
        403: {"model": ErrorResponse, "description": "Insufficient permissions"},
    },
)
async def create_sale(
    request: SaleCreate,
    db: DbSession,
    current_user: User = Depends(
        require_permission("sales")
    ),
) -> SaleResponse:
    """Create a new sale in DRAFT status.

    Requirements:
    - 5.1: Create a sale with customer, location, line items, payment type
    """
    # Block credit sales for suspended/closed customer accounts
    if request.payment_type.upper() == 'CREDIT' and request.customer_id:
        from app.models.customer import Customer
        cust_result = await db.execute(select(Customer).filter_by(id=request.customer_id))
        customer = cust_result.scalar_one_or_none()
        if customer and customer.account_status != 'active':
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Credit sales not allowed for suspended or closed customer accounts. Use cash payment instead.",
            )

    service = _get_sales_service(db, current_user.id)

    # Prepare items for the service
    items = None
    if request.items:
        items = [
            {
                "spare_part_id": item.spare_part_id,
                "quantity": item.quantity,
                "unit_price": item.unit_price,
                "discount_amount": item.discount_amount,
            }
            for item in request.items
        ]

    sale = await service.create_sale(
        customer_id=request.customer_id,
        location_id=request.location_id,
        payment_type=PaymentType(request.payment_type),
        items=items,
        amount_paid=request.amount_paid,
    )
    await db.commit()
    # Re-fetch with items + spare_part eager-loaded so serializing the response
    # never triggers a lazy load (raises MissingGreenlet in async SQLAlchemy).
    sale = await service._get_sale_with_items(sale.id)
    return SaleResponse.model_validate(sale)


@router.get(
    "/{sale_id}",
    response_model=SaleResponse,
    status_code=status.HTTP_200_OK,
    summary="Get sale by ID",
    description="Retrieve a single sale by its UUID.",
    responses={
        404: {"model": ErrorResponse, "description": "Sale not found"},
    },
)
async def get_sale(
    sale_id: UUID,
    db: DbSession,
    current_user: User = Depends(
        require_permission("sales")
    ),
) -> SaleResponse:
    """Get a single sale by its ID.

    Accessible by Salesperson, Manager, and Admin roles.
    Includes returned_quantity per item from the movement ledger.
    """
    from sqlalchemy.orm import selectinload
    from sqlalchemy import func as sa_func
    from app.models.inventory_movement_ledger import InventoryMovementLedger, MovementType

    stmt = (
        select(Sale)
        .filter_by(id=sale_id)
        .options(selectinload(Sale.items).selectinload(SaleItem.spare_part))
    )
    result = await db.execute(stmt)
    sale = result.scalar_one_or_none()

    if sale is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Sale not found",
        )

    # Query returned quantities per spare_part_id from the ledger
    return_stmt = (
        select(
            InventoryMovementLedger.spare_part_id,
            sa_func.sum(InventoryMovementLedger.quantity_change).label("total_returned"),
        )
        .filter(
            InventoryMovementLedger.reference_id == sale_id,
            InventoryMovementLedger.reference_type == "sale",
            InventoryMovementLedger.movement_type == MovementType.RETURN.value,
        )
        .group_by(InventoryMovementLedger.spare_part_id)
    )
    return_result = await db.execute(return_stmt)
    returned_map = {row.spare_part_id: row.total_returned for row in return_result}

    # Build response with returned_quantity
    from app.schemas.sale import SaleItemResponse, SaleResponse as SR
    items_response = []
    for item in sale.items:
        item_resp = SaleItemResponse.model_validate(item)
        item_resp.returned_quantity = returned_map.get(item.spare_part_id, 0)
        items_response.append(item_resp)

    resp = SaleResponse.model_validate(sale)
    resp.items = items_response

    # Add customer name
    if sale.customer_id:
        from app.models.customer import Customer
        cust_result = await db.execute(select(Customer.name).filter_by(id=sale.customer_id))
        cust_name = cust_result.scalar_one_or_none()
        resp.customer_name = cust_name

    # Resolve who issued the sale (created_by is a UUID string) to a username
    if sale.created_by:
        from app.models.user import User
        try:
            creator_uuid = UUID(str(sale.created_by))
        except (ValueError, TypeError):
            creator_uuid = None
        if creator_uuid is not None:
            uname_result = await db.execute(
                select(User.username).filter_by(id=creator_uuid)
            )
            resp.created_by_username = uname_result.scalar_one_or_none()

    return resp


@router.put(
    "/{sale_id}",
    response_model=SaleResponse,
    status_code=status.HTTP_200_OK,
    summary="Update a draft sale",
    description="Update a sale that is still in DRAFT status. Allows changing customer, payment type, and line items.",
    responses={
        400: {"model": ErrorResponse, "description": "Sale is not in DRAFT status"},
        404: {"model": ErrorResponse, "description": "Sale not found"},
    },
)
async def update_sale(
    sale_id: UUID,
    request: SaleCreate,
    db: DbSession,
    current_user: User = Depends(
        require_permission("sales")
    ),
) -> SaleResponse:
    """Update a draft sale's customer, payment type, and line items.

    Only DRAFT sales can be edited. Once confirmed, a sale is immutable.
    """
    from decimal import Decimal

    # Block credit sales for suspended/closed customer accounts
    if request.payment_type.upper() == 'CREDIT' and request.customer_id:
        from app.models.customer import Customer
        cust_result = await db.execute(select(Customer).filter_by(id=request.customer_id))
        customer = cust_result.scalar_one_or_none()
        if customer and customer.account_status != 'active':
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Credit sales not allowed for suspended or closed customer accounts. Use cash payment instead.",
            )

    stmt = select(Sale).filter_by(id=sale_id)
    result = await db.execute(stmt)
    sale = result.scalar_one_or_none()

    if sale is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Sale not found",
        )

    if sale.status not in (SaleStatus.DRAFT, SaleStatus.DRAFT.value):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only draft sales can be edited",
        )

    # Update basic fields
    if request.customer_id is not None:
        sale.customer_id = request.customer_id
    sale.location_id = request.location_id
    sale.payment_type = request.payment_type

    # Remove existing line items
    existing_items_stmt = select(SaleItem).filter_by(sale_id=sale_id)
    existing_result = await db.execute(existing_items_stmt)
    for item in existing_result.scalars().all():
        await db.delete(item)

    # Add new line items
    subtotal = Decimal("0")
    discount_total = Decimal("0")
    if request.items:
        for item_data in request.items:
            line_total = Decimal(str(item_data.quantity)) * Decimal(str(item_data.unit_price)) - Decimal(str(item_data.discount_amount or 0))
            new_item = SaleItem(
                sale_id=sale_id,
                spare_part_id=item_data.spare_part_id,
                quantity=item_data.quantity,
                unit_price=Decimal(str(item_data.unit_price)),
                discount_amount=Decimal(str(item_data.discount_amount or 0)),
                line_total=line_total,
            )
            db.add(new_item)
            subtotal += line_total
            discount_total += Decimal(str(item_data.discount_amount or 0))

    sale.subtotal = subtotal
    sale.discount_total = discount_total
    sale.total_amount = subtotal
    sale.amount_paid = Decimal(str(request.amount_paid)) if request.amount_paid else Decimal("0.00")
    sale.updated_by = str(current_user.id)

    await db.commit()

    # Re-fetch with eager loading for the response
    from sqlalchemy.orm import selectinload
    stmt = (
        select(Sale)
        .filter_by(id=sale_id)
        .options(selectinload(Sale.items).selectinload(SaleItem.spare_part))
    )
    result = await db.execute(stmt)
    sale = result.scalar_one()

    return SaleResponse.model_validate(sale)


@router.post(
    "/{sale_id}/confirm",
    response_model=SaleResponse,
    status_code=status.HTTP_200_OK,
    summary="Confirm a sale",
    description="Confirm a DRAFT sale: validates stock, consumes FIFO layers, records ledger entries. Salesperson, Manager, or Admin.",
    responses={
        400: {"model": ErrorResponse, "description": "Invalid state or no items"},
        403: {"model": ErrorResponse, "description": "Insufficient permissions"},
        404: {"model": ErrorResponse, "description": "Sale not found"},
        409: {"model": ErrorResponse, "description": "Insufficient stock"},
    },
)
async def confirm_sale(
    sale_id: UUID,
    db: DbSession,
    current_user: User = Depends(
        require_permission("sales")
    ),
) -> SaleResponse:
    """Confirm a sale, deducting stock and calculating COGS.

    Requirements:
    - 5.2: Reduce stock at selling location via ledger entries
    - 5.3: Cash sale marked as fully paid
    - 5.6: Reject if quantity exceeds available stock
    - 5.9: Pessimistic lock on stock records
    - 5.10: Stock validation and deduction in same transaction
    """
    service = _get_sales_service(db, current_user.id)

    try:
        sale = await service.confirm_sale(sale_id=sale_id)
        await db.commit()
        # Re-fetch with items + spare_part eager-loaded so serializing the
        # response never triggers a lazy load (which raises MissingGreenlet in
        # async SQLAlchemy). db.refresh only reloads the sale's own columns.
        sale = await service._get_sale_with_items(sale_id)
        return SaleResponse.model_validate(sale)
    except SaleNotFoundError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )
    except InvalidSaleStatusError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except SaleHasNoItemsError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except InsufficientStockError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(e),
        )
    except CreditLimitExceededError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


@router.post(
    "/{sale_id}/return",
    response_model=SaleResponse,
    status_code=status.HTTP_200_OK,
    summary="Process a sales return",
    description="Process a return for a confirmed sale. Creates new cost layers and reverses inventory. Manager or Admin only.",
    responses={
        400: {"model": ErrorResponse, "description": "Invalid sale state"},
        403: {"model": ErrorResponse, "description": "Insufficient permissions"},
        404: {"model": ErrorResponse, "description": "Sale not found"},
    },
)
async def return_sale(
    sale_id: UUID,
    db: DbSession,
    current_user: CurrentUser,
    request: Optional[SaleReturnRequest] = None,
) -> SaleResponse:
    """Process a sales return.

    Requirements:
    - 5.8: Support sales returns reversing inventory and financial entries
    - 5.12: Return creates new cost layer using original sale item's unit cost
    - 5.13: Cost layer timestamp = return processing date
    - 5.14: Never modify or re-open previously consumed/closed cost layers
    """
    # Dynamic permission check — uses configurable role_permissions table
    from app.services.permission_service import check_permission
    if not await check_permission(db, current_user.role, "sales_returns"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to process returns. Contact your Admin to enable this.",
        )

    service = _get_sales_service(db, current_user.id)

    # Build return_items list for the service
    return_items = None
    if request and request.items:
        return_items = [
            {
                "sale_item_id": item.sale_item_id,
                "quantity": item.quantity,
                "reason": item.reason,
            }
            for item in request.items
        ]

    try:
        sale = await service.return_sale(
            sale_id=sale_id,
            returned_by=current_user.id,
            return_items=return_items,
            return_location_id=request.return_location_id if request else None,
        )

        # Record return reasons in the audit trail for accountability
        if return_items:
            from app.models.audit_trail import AuditTrail, ActionType
            reasons_summary = "; ".join(
                f"{item['quantity']}x item {str(item['sale_item_id'])[:8]}: {item['reason']}"
                for item in return_items
                if item.get("reason")
            )
            if reasons_summary:
                audit = AuditTrail(
                    action_type=ActionType.UPDATE.value if hasattr(ActionType.UPDATE, 'value') else "UPDATE",
                    entity_type="sale_return",
                    entity_id=sale_id,
                    user_id=str(current_user.id),
                    new_values={"reasons": reasons_summary, "sale_id": str(sale_id)},
                )
                db.add(audit)

        await db.commit()
        # Re-fetch with items + spare_part eager-loaded so serializing the
        # response never triggers a lazy load (raises MissingGreenlet in async
        # SQLAlchemy). db.refresh only reloads the sale's own columns.
        sale = await service._get_sale_with_items(sale_id)
        return SaleResponse.model_validate(sale)
    except SaleNotFoundError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )
    except (InvalidSaleStatusError, ReturnQuantityExceededError) as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


@router.post(
    "/{sale_id}/cancel",
    response_model=SaleResponse,
    status_code=status.HTTP_200_OK,
    summary="Cancel a draft sale",
    description="Cancel a sale that is still in DRAFT status. Cannot cancel confirmed sales.",
    responses={
        400: {"model": ErrorResponse, "description": "Sale is not in DRAFT status"},
        404: {"model": ErrorResponse, "description": "Sale not found"},
    },
)
async def cancel_sale(
    sale_id: UUID,
    db: DbSession,
    current_user: User = Depends(
        require_permission("sales")
    ),
) -> SaleResponse:
    """Cancel a draft sale.

    Only DRAFT sales can be cancelled. Confirmed sales must use the return flow.
    """
    from sqlalchemy.orm import selectinload

    stmt = (
        select(Sale)
        .filter_by(id=sale_id)
        .options(selectinload(Sale.items).selectinload(SaleItem.spare_part))
    )
    result = await db.execute(stmt)
    sale = result.scalar_one_or_none()

    if sale is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Sale not found",
        )

    if sale.status not in (SaleStatus.DRAFT, SaleStatus.DRAFT.value):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only draft sales can be cancelled. Use returns for confirmed sales.",
        )

    sale.status = SaleStatus.CANCELLED
    sale.updated_by = str(current_user.id)
    await db.commit()

    return SaleResponse.model_validate(sale)
