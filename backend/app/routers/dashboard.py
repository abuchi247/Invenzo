"""Dashboard router for KPI widget endpoints.

Provides the following endpoint:
- GET /api/v1/dashboard/kpis - Get dashboard KPIs (role-based content)

All authenticated users can access this endpoint. The returned KPIs
are filtered based on the user's role:
- Salesperson: sees only sales KPIs
- Storekeeper: sees sales + inventory KPIs
- Manager/Admin: sees all KPIs

Satisfies Requirements: 13.1, 13.2, 13.4
"""

from fastapi import APIRouter, Depends, status

from app.dependencies import CurrentUser, DbSession
from app.middleware.auth import get_current_user, require_roles
from app.models.user import User, UserRole
from app.services.permission_service import require_permission
from app.schemas.report import DashboardKPIResponse, TopSellingProductSchema
from app.services.dashboard_service import DashboardService

router = APIRouter(prefix="/api/v1/dashboard", tags=["Dashboard"])


@router.get(
    "/kpis",
    response_model=DashboardKPIResponse,
    status_code=status.HTTP_200_OK,
    summary="Get dashboard KPIs",
    description="Retrieve role-based KPI data for the dashboard. All authenticated users can access this endpoint.",
)
async def get_dashboard_kpis(
    db: DbSession,
    current_user: CurrentUser,
) -> DashboardKPIResponse:
    """Get dashboard KPI data based on user role.

    Requirements:
    - 13.1: KPI widgets for sales, receivables, stock, POs, top products
    - 13.2: All KPI data loads within 3 seconds
    - 13.4: Role-based KPI visibility
    """
    service = DashboardService(db=db)
    kpi_data = await service.get_kpis(user_role=current_user.role)

    # Convert KPIData to response schema
    kpi_dict = kpi_data.to_dict()

    # Build top selling products list if present
    top_products = None
    if kpi_dict.get("top_selling_products"):
        top_products = [
            TopSellingProductSchema(
                spare_part_id=p["spare_part_id"],
                part_name=p["part_name"],
                part_number=p["part_number"],
                total_quantity_sold=p["total_quantity_sold"],
            )
            for p in kpi_dict["top_selling_products"]
        ]

    return DashboardKPIResponse(
        total_sales_today=kpi_dict["total_sales_today"],
        total_sales_month=kpi_dict["total_sales_month"],
        outstanding_receivables=kpi_dict.get("outstanding_receivables"),
        low_stock_count=kpi_dict.get("low_stock_count"),
        pending_po_count=kpi_dict.get("pending_po_count"),
        top_selling_products=top_products,
    )


@router.get(
    "/stock-value",
    status_code=status.HTTP_200_OK,
    summary="Get stock value by location",
    description="Returns total stock value (qty × cost_price) per location.",
)
async def get_stock_value(
    db: DbSession,
    current_user: CurrentUser,
) -> dict:
    """Get total stock value broken down by location.

    Calculates: sum(current_quantity × spare_part.cost_price) per location.
    """
    from sqlalchemy import func, select
    from app.models.stock_status_cache import StockStatusCache
    from app.models.spare_part import SparePart
    from app.models.location import Location

    stmt = (
        select(
            StockStatusCache.location_id,
            Location.name.label("location_name"),
            func.sum(StockStatusCache.current_quantity * SparePart.cost_price).label("total_value"),
            func.sum(StockStatusCache.current_quantity).label("total_items"),
        )
        .join(SparePart, StockStatusCache.spare_part_id == SparePart.id)
        .join(Location, StockStatusCache.location_id == Location.id)
        .filter(StockStatusCache.current_quantity > 0)
        .group_by(StockStatusCache.location_id, Location.name)
        .order_by(Location.name.asc())
    )
    result = await db.execute(stmt)
    rows = result.all()

    locations = [
        {
            "location_id": str(row.location_id),
            "location_name": row.location_name,
            "total_value": float(row.total_value or 0),
            "total_items": float(row.total_items or 0),
        }
        for row in rows
    ]

    grand_total = sum(loc["total_value"] for loc in locations)

    return {
        "grand_total": grand_total,
        "locations": locations,
    }


@router.get(
    "/top-products",
    status_code=status.HTTP_200_OK,
    summary="Get top selling products",
    description="Returns top 5 selling products by quantity for a given period.",
)
async def get_top_products(
    db: DbSession,
    current_user: CurrentUser,
    period: str = "all",
) -> dict:
    """Get top 5 selling products.

    Period options: 1m (month), 3m, 6m, 1y, all (all time).
    """
    from sqlalchemy import func, select, and_
    from app.models.sale import Sale, SaleItem, SaleStatus
    from app.models.spare_part import SparePart
    from datetime import date, datetime, timezone, timedelta

    # Calculate start date based on period
    start_date = _get_period_start(period)

    conditions = [Sale.status == SaleStatus.CONFIRMED]
    if start_date:
        conditions.append(Sale.created_at >= start_date)

    stmt = (
        select(
            SaleItem.spare_part_id,
            func.coalesce(SaleItem.external_description, SparePart.name).label("part_name"),
            func.coalesce(SaleItem.external_part_number, SparePart.part_number).label("part_number"),
            func.sum(SaleItem.quantity).label("total_quantity_sold"),
            func.sum(SaleItem.line_total).label("total_revenue"),
        )
        .join(Sale, SaleItem.sale_id == Sale.id)
        .outerjoin(SparePart, SaleItem.spare_part_id == SparePart.id)
        .where(and_(*conditions))
        .group_by(SaleItem.spare_part_id, SparePart.name, SparePart.part_number, SaleItem.external_description, SaleItem.external_part_number)
        .order_by(func.sum(SaleItem.quantity).desc())
        .limit(5)
    )
    result = await db.execute(stmt)
    rows = result.all()

    return {
        "period": period,
        "data": [
            {
                "spare_part_id": str(row.spare_part_id) if row.spare_part_id else None,
                "part_name": row.part_name,
                "part_number": row.part_number,
                "total_quantity_sold": float(row.total_quantity_sold),
                "total_revenue": float(row.total_revenue or 0),
            }
            for row in rows
        ],
    }


@router.get(
    "/top-customers",
    status_code=status.HTTP_200_OK,
    summary="Get top customers by spend",
    description="Returns top 5 customers by total purchase amount for a given period.",
)
async def get_top_customers(
    db: DbSession,
    current_user: CurrentUser,
    period: str = "all",
) -> dict:
    """Get top 5 customers by total spend.

    Period options: 1m (month), 3m, 6m, 1y, all (all time).
    """
    from sqlalchemy import func, select, and_
    from app.models.sale import Sale, SaleStatus
    from app.models.customer import Customer
    from datetime import date, datetime, timezone, timedelta

    # Calculate start date based on period
    start_date = _get_period_start(period)

    conditions = [
        Sale.status == SaleStatus.CONFIRMED,
        Sale.customer_id.isnot(None),
    ]
    if start_date:
        conditions.append(Sale.created_at >= start_date)

    stmt = (
        select(
            Sale.customer_id,
            Customer.name.label("customer_name"),
            Customer.phone.label("customer_phone"),
            func.sum(Sale.total_amount).label("total_spent"),
            func.count(Sale.id).label("order_count"),
        )
        .join(Customer, Sale.customer_id == Customer.id)
        .where(and_(*conditions))
        .group_by(Sale.customer_id, Customer.name, Customer.phone)
        .order_by(func.sum(Sale.total_amount).desc())
        .limit(5)
    )
    result = await db.execute(stmt)
    rows = result.all()

    return {
        "period": period,
        "data": [
            {
                "customer_id": str(row.customer_id),
                "customer_name": row.customer_name,
                "customer_phone": row.customer_phone or "",
                "total_spent": float(row.total_spent or 0),
                "order_count": row.order_count,
            }
            for row in rows
        ],
    }


def _get_period_start(period: str):
    """Convert period string to a datetime start point."""
    from datetime import date, datetime, timezone, timedelta

    today = date.today()
    if period == "1m":
        return datetime(today.year, today.month, 1, tzinfo=timezone.utc)
    elif period == "3m":
        d = today - timedelta(days=90)
        return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    elif period == "6m":
        d = today - timedelta(days=180)
        return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    elif period == "1y":
        d = today - timedelta(days=365)
        return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    else:  # "all"
        return None


def _period_label(period: str) -> str:
    """Human-readable label for a period code."""
    return {
        "1m": "This Month",
        "3m": "Last 3 Months",
        "6m": "Last 6 Months",
        "1y": "Last 12 Months",
        "all": "All Time",
    }.get(period, period)


@router.get(
    "/profit-summary",
    status_code=status.HTTP_200_OK,
    summary="Get profit summary",
    description=(
        "Returns revenue, COGS, gross margin, margin %, and sale count "
        "for the selected period. Admin and Manager only."
    ),
)
async def get_profit_summary(
    db: DbSession,
    current_user: User = Depends(
        require_permission("reports")
    ),
    period: str = "1m",
) -> dict:
    """Return a profit summary for the dashboard.

    Calculates:
      - total_revenue   = SUM(Sale.total_amount)   for confirmed sales in period
      - total_cogs      = SUM(SaleItem.cost_of_goods_sold) for those items
      - gross_margin    = revenue − cogs
      - margin_pct      = gross_margin / revenue × 100  (0 when no sales)
      - sale_count      = number of confirmed sales in period

    Only Admin and Manager roles may call this endpoint.
    Period options: 1m (current calendar month), 3m, 6m, 1y, all.
    """
    from decimal import Decimal
    from sqlalchemy import func, select, and_
    from app.models.sale import Sale, SaleItem, SaleStatus

    start_dt = _get_period_start(period)

    # ── Revenue ──────────────────────────────────────────────────────────────
    revenue_conditions = [Sale.status == SaleStatus.CONFIRMED]
    if start_dt:
        revenue_conditions.append(Sale.created_at >= start_dt)

    rev_stmt = select(
        func.coalesce(func.sum(Sale.total_amount), Decimal("0")),
        func.count(Sale.id),
    ).where(and_(*revenue_conditions))
    rev_result = await db.execute(rev_stmt)
    rev_row = rev_result.one()
    gross_revenue = rev_row[0] or Decimal("0.00")
    sale_count = int(rev_row[1])

    # ── Returns (subtract from revenue) ───────────────────────────────────────
    from app.models.customer_credit_ledger import CustomerCreditLedger
    returns_conditions = [CustomerCreditLedger.transaction_type == "RETURN"]
    if start_dt:
        returns_conditions.append(CustomerCreditLedger.created_at >= start_dt)

    returns_stmt = select(
        func.coalesce(func.sum(CustomerCreditLedger.amount), Decimal("0"))
    ).where(and_(*returns_conditions))
    returns_result = await db.execute(returns_stmt)
    returns_value = abs(returns_result.scalar() or Decimal("0.00"))

    total_revenue = gross_revenue - returns_value

    # ── COGS ──────────────────────────────────────────────────────────────────
    cogs_conditions = [Sale.status == SaleStatus.CONFIRMED]
    if start_dt:
        cogs_conditions.append(Sale.created_at >= start_dt)

    cogs_stmt = select(
        func.coalesce(
            func.sum(SaleItem.cost_of_goods_sold), Decimal("0")
        )
    ).join(Sale, SaleItem.sale_id == Sale.id).where(and_(*cogs_conditions))
    cogs_result = await db.execute(cogs_stmt)
    total_cogs = cogs_result.scalar() or Decimal("0.00")

    # ── Derived ───────────────────────────────────────────────────────────────
    gross_margin = total_revenue - total_cogs
    margin_pct = (
        (gross_margin / total_revenue * Decimal("100")).quantize(Decimal("0.01"))
        if total_revenue > 0
        else Decimal("0.00")
    )

    return {
        "period": period,
        "period_label": _period_label(period),
        "total_revenue": float(total_revenue),
        "total_cogs": float(total_cogs),
        "gross_margin": float(gross_margin),
        "margin_pct": float(margin_pct),
        "sale_count": sale_count,
    }
