"""
Dashboard service providing KPI widgets for the executive dashboard.

This module implements role-based KPI queries for the dashboard including:
- Total sales today and this month
- Outstanding receivables
- Low stock item count
- Pending purchase orders count
- Top selling products for the current month

All KPI queries are designed using aggregate SQL functions (SUM, COUNT)
to ensure data loads within 3 seconds.

Satisfies Requirement 13.1: KPI widgets for sales, receivables, stock, POs, top products.
Satisfies Requirement 13.2: All KPI data loads within 3 seconds.
Satisfies Requirement 13.4: Role-based KPI visibility.
"""

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy import func, select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.customer_credit_ledger import CustomerCreditLedger
from app.models.purchase_order import PurchaseOrder, PurchaseOrderStatus
from app.models.sale import Sale, SaleItem, SaleStatus
from app.models.spare_part import SparePart
from app.models.stock_status_cache import StockStatusCache
from app.models.user import UserRole


class KPIData:
    """Container for dashboard KPI data.

    Attributes:
        total_sales_today: Total confirmed sales amount for today.
        total_sales_month: Total confirmed sales amount for the current month.
        outstanding_receivables: Sum of outstanding customer credit balances.
        low_stock_count: Count of spare parts below minimum stock level.
        pending_po_count: Count of purchase orders in pending states.
        top_selling_products: List of top selling products for the current month.
    """

    def __init__(
        self,
        total_sales_today: Decimal = Decimal("0.00"),
        total_sales_month: Decimal = Decimal("0.00"),
        outstanding_receivables: Optional[Decimal] = None,
        low_stock_count: Optional[int] = None,
        pending_po_count: Optional[int] = None,
        top_selling_products: Optional[list[dict]] = None,
    ):
        self.total_sales_today = total_sales_today
        self.total_sales_month = total_sales_month
        self.outstanding_receivables = outstanding_receivables
        self.low_stock_count = low_stock_count
        self.pending_po_count = pending_po_count
        self.top_selling_products = top_selling_products if top_selling_products is not None else []

    def to_dict(self) -> dict:
        """Convert KPI data to a serializable dictionary."""
        result = {
            "total_sales_today": str(self.total_sales_today),
            "total_sales_month": str(self.total_sales_month),
        }
        if self.outstanding_receivables is not None:
            result["outstanding_receivables"] = str(self.outstanding_receivables)
        if self.low_stock_count is not None:
            result["low_stock_count"] = self.low_stock_count
        if self.pending_po_count is not None:
            result["pending_po_count"] = self.pending_po_count
        if self.top_selling_products is not None:
            result["top_selling_products"] = self.top_selling_products
        return result


class DashboardService:
    """Service for generating dashboard KPI data.

    Implements role-based KPI visibility:
    - Salesperson: sees only sales KPIs (total_sales_today, total_sales_month)
    - Manager/Admin: sees all KPIs
    - Storekeeper: sees low stock count and pending POs (inventory-related)

    Satisfies Requirement 13.4: Role-based KPI visibility.
    """

    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_kpis(self, user_role: str) -> KPIData:
        """Retrieve KPI data based on user role.

        Args:
            user_role: The role of the requesting user (Admin, Manager, Salesperson, Storekeeper).

        Returns:
            KPIData with role-appropriate KPI values populated.

        Satisfies Requirement 13.1: All KPI widgets.
        Satisfies Requirement 13.2: Efficient aggregate queries for sub-3-second loading.
        Satisfies Requirement 13.4: Role-based visibility filtering.
        """
        kpi_data = KPIData()

        # Sales KPIs are visible to all roles. These are simple indexed
        # aggregates that run in a few milliseconds each; they share the
        # request's single AsyncSession (which cannot run queries concurrently),
        # so they are awaited sequentially.
        kpi_data.total_sales_today = await self._get_total_sales_today()
        kpi_data.total_sales_month = await self._get_total_sales_month()

        # Manager and Admin see all KPIs
        if user_role in (UserRole.ADMIN.value, UserRole.MANAGER.value):
            kpi_data.outstanding_receivables = await self._get_outstanding_receivables()
            kpi_data.low_stock_count = await self._get_low_stock_count()
            kpi_data.pending_po_count = await self._get_pending_po_count()
            kpi_data.top_selling_products = await self._get_top_selling_products()

        # Storekeeper sees inventory-related KPIs
        elif user_role == UserRole.STOREKEEPER.value:
            kpi_data.low_stock_count = await self._get_low_stock_count()
            kpi_data.pending_po_count = await self._get_pending_po_count()

        return kpi_data

    async def _get_total_sales_today(self) -> Decimal:
        """Get NET sales for today (gross sales - returns value).

        Net = SUM(confirmed totals) - ABS(SUM(credit ledger RETURN amounts today))
        """
        today = date.today()
        today_start = datetime(today.year, today.month, today.day, tzinfo=timezone.utc)
        from datetime import timedelta
        tomorrow_start = today_start + timedelta(days=1)

        # Gross sales
        gross_stmt = select(
            func.coalesce(func.sum(Sale.total_amount), Decimal("0.00"))
        ).where(
            and_(
                Sale.status == SaleStatus.CONFIRMED,
                Sale.created_at >= today_start,
                Sale.created_at < tomorrow_start,
            )
        )
        gross_result = await self.db.execute(gross_stmt)
        gross = gross_result.scalar() or Decimal("0.00")

        # Returns value from credit ledger (RETURN entries are negative amounts)
        returns_stmt = select(
            func.coalesce(func.sum(CustomerCreditLedger.amount), Decimal("0.00"))
        ).where(
            and_(
                CustomerCreditLedger.transaction_type == "RETURN",
                CustomerCreditLedger.created_at >= today_start,
                CustomerCreditLedger.created_at < tomorrow_start,
            )
        )
        returns_result = await self.db.execute(returns_stmt)
        returns_value = abs(returns_result.scalar() or Decimal("0.00"))

        return gross - returns_value

    async def _get_total_sales_month(self) -> Decimal:
        """Get NET sales for the current month (gross sales - returns value).

        Net = SUM(confirmed totals) - ABS(SUM(credit ledger RETURN amounts this month))
        """
        today = date.today()
        first_of_month = datetime(today.year, today.month, 1, tzinfo=timezone.utc)
        from datetime import timedelta
        if today.month == 12:
            next_month_start = datetime(today.year + 1, 1, 1, tzinfo=timezone.utc)
        else:
            next_month_start = datetime(today.year, today.month + 1, 1, tzinfo=timezone.utc)

        # Gross sales
        gross_stmt = select(
            func.coalesce(func.sum(Sale.total_amount), Decimal("0.00"))
        ).where(
            and_(
                Sale.status == SaleStatus.CONFIRMED,
                Sale.created_at >= first_of_month,
                Sale.created_at < next_month_start,
            )
        )
        gross_result = await self.db.execute(gross_stmt)
        gross = gross_result.scalar() or Decimal("0.00")

        # Returns value from credit ledger
        returns_stmt = select(
            func.coalesce(func.sum(CustomerCreditLedger.amount), Decimal("0.00"))
        ).where(
            and_(
                CustomerCreditLedger.transaction_type == "RETURN",
                CustomerCreditLedger.created_at >= first_of_month,
                CustomerCreditLedger.created_at < next_month_start,
            )
        )
        returns_result = await self.db.execute(returns_stmt)
        returns_value = abs(returns_result.scalar() or Decimal("0.00"))

        return gross - returns_value

    async def _get_outstanding_receivables(self) -> Decimal:
        """Get the total outstanding customer receivables.

        Outstanding receivables = SUM of all entries in the customer credit
        ledger. Positive amounts are debits (charges), negative are credits
        (payments). The net sum represents total outstanding balance.

        Returns:
            Total outstanding receivables, or 0.00 if none.
        """
        stmt = select(
            func.coalesce(func.sum(CustomerCreditLedger.amount), Decimal("0.00"))
        )
        result = await self.db.execute(stmt)
        return result.scalar() or Decimal("0.00")

    async def _get_low_stock_count(self) -> int:
        """Get the count of spare parts with stock below minimum level.

        Totals stock across locations for each active spare part and counts
        items below their defined minimum threshold. Parts with no stock
        records are treated as having zero stock.

        Returns:
            Count of low-stock items.
        """
        total_stock = (
            select(func.coalesce(func.sum(StockStatusCache.current_quantity), 0))
            .where(StockStatusCache.spare_part_id == SparePart.id)
            .scalar_subquery()
        )
        stmt = select(func.count(SparePart.id)).where(
            SparePart.deleted_at.is_(None),
            total_stock < SparePart.min_stock_level,
        )
        result = await self.db.execute(stmt)
        return result.scalar() or 0

    async def _get_pending_po_count(self) -> int:
        """Get the count of purchase orders in pending states.

        Counts POs with status in (DRAFT, APPROVED, ORDERED) — these are
        not yet fully received or cancelled.

        Returns:
            Count of pending purchase orders.
        """
        pending_statuses = [
            PurchaseOrderStatus.DRAFT,
            PurchaseOrderStatus.APPROVED,
            PurchaseOrderStatus.ORDERED,
        ]
        stmt = select(func.count()).select_from(PurchaseOrder).where(
            PurchaseOrder.status.in_(pending_statuses)
        )
        result = await self.db.execute(stmt)
        return result.scalar() or 0

    async def _get_top_selling_products(self, limit: int = 5) -> list[dict]:
        """Get the top selling products for the current month.

        Groups SaleItem by spare_part_id for confirmed sales in the current
        month, orders by total quantity sold descending, and returns the top N.

        Args:
            limit: Maximum number of products to return (default 5).

        Returns:
            List of dicts with spare_part_id, part_name, and total_quantity_sold.
        """
        today = date.today()
        first_of_month = today.replace(day=1)

        stmt = (
            select(
                SaleItem.spare_part_id,
                func.coalesce(SaleItem.external_description, SparePart.name).label("part_name"),
                func.coalesce(SaleItem.external_part_number, SparePart.part_number).label("part_number"),
                func.sum(SaleItem.quantity).label("total_quantity_sold"),
            )
            .join(Sale, SaleItem.sale_id == Sale.id)
            .outerjoin(SparePart, SaleItem.spare_part_id == SparePart.id)
            .where(
                and_(
                    Sale.status == SaleStatus.CONFIRMED,
                    func.date(Sale.created_at) >= first_of_month,
                    func.date(Sale.created_at) <= today,
                )
            )
            .group_by(
                SaleItem.spare_part_id,
                SparePart.name,
                SparePart.part_number,
                SaleItem.external_description,
                SaleItem.external_part_number,
            )
            .order_by(func.sum(SaleItem.quantity).desc())
            .limit(limit)
        )
        result = await self.db.execute(stmt)
        rows = result.all()

        return [
            {
                "spare_part_id": str(row.spare_part_id) if row.spare_part_id else None,
                "part_name": row.part_name,
                "part_number": row.part_number,
                "total_quantity_sold": str(row.total_quantity_sold),
            }
            for row in rows
        ]
