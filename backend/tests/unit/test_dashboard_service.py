"""Unit tests for the DashboardService.

Tests validate:
1. Role-based KPI visibility (Salesperson, Manager, Admin, Storekeeper)
2. Sales KPI queries (today, this month)
3. Outstanding receivables calculation
4. Low stock count query
5. Pending purchase orders count
6. Top selling products query

Satisfies Requirements: 13.1, 13.2, 13.4
"""

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.user import UserRole
from app.services.dashboard_service import DashboardService, KPIData


# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def mock_db():
    """Create a mock async database session."""
    db = AsyncMock()
    return db


@pytest.fixture
def service(mock_db):
    """Create a DashboardService instance with mock db."""
    return DashboardService(db=mock_db)


# =============================================================================
# KPIData Tests
# =============================================================================


class TestKPIData:
    """Tests for the KPIData container class."""

    def test_default_values(self):
        """KPIData initializes with sensible defaults."""
        kpi = KPIData()
        assert kpi.total_sales_today == Decimal("0.00")
        assert kpi.total_sales_month == Decimal("0.00")
        assert kpi.outstanding_receivables is None
        assert kpi.low_stock_count is None
        assert kpi.pending_po_count is None
        assert kpi.top_selling_products == []

    def test_to_dict_salesperson_view(self):
        """to_dict for Salesperson returns only sales KPIs."""
        kpi = KPIData(
            total_sales_today=Decimal("5000.00"),
            total_sales_month=Decimal("150000.00"),
        )
        result = kpi.to_dict()
        assert result == {
            "total_sales_today": "5000.00",
            "total_sales_month": "150000.00",
            "top_selling_products": [],
        }
        assert "outstanding_receivables" not in result
        assert "low_stock_count" not in result
        assert "pending_po_count" not in result

    def test_to_dict_full_view(self):
        """to_dict for Manager/Admin returns all KPIs."""
        kpi = KPIData(
            total_sales_today=Decimal("5000.00"),
            total_sales_month=Decimal("150000.00"),
            outstanding_receivables=Decimal("250000.00"),
            low_stock_count=12,
            pending_po_count=5,
            top_selling_products=[
                {
                    "spare_part_id": "abc-123",
                    "part_name": "Brake Pad",
                    "part_number": "BP-001",
                    "total_quantity_sold": "45",
                }
            ],
        )
        result = kpi.to_dict()
        assert result["total_sales_today"] == "5000.00"
        assert result["total_sales_month"] == "150000.00"
        assert result["outstanding_receivables"] == "250000.00"
        assert result["low_stock_count"] == 12
        assert result["pending_po_count"] == 5
        assert len(result["top_selling_products"]) == 1
        assert result["top_selling_products"][0]["part_name"] == "Brake Pad"


# =============================================================================
# Role-Based KPI Visibility Tests
# =============================================================================


class TestRoleBasedVisibility:
    """Tests for role-based KPI visibility.

    Satisfies Requirement 13.4: Salesperson sees only sales KPIs,
    Manager and Admin see all KPIs.
    """

    @pytest.mark.asyncio
    async def test_salesperson_sees_only_sales_kpis(self, service, mock_db):
        """Salesperson gets only total_sales_today and total_sales_month."""
        mock_result_sales = MagicMock()
        mock_result_sales.scalar.return_value = Decimal("1000.00")
        mock_result_returns = MagicMock()
        mock_result_returns.scalar.return_value = Decimal("0.00")

        mock_db.execute.side_effect = [
            mock_result_sales,    # _get_total_sales_today gross
            mock_result_returns,  # _get_total_sales_today returns
            mock_result_sales,    # _get_total_sales_month gross
            mock_result_returns,  # _get_total_sales_month returns
        ]

        kpi = await service.get_kpis(UserRole.SALESPERSON.value)

        assert kpi.total_sales_today == Decimal("1000.00")
        assert kpi.total_sales_month == Decimal("1000.00")
        # Salesperson should NOT see these KPIs
        assert kpi.outstanding_receivables is None
        assert kpi.low_stock_count is None
        assert kpi.pending_po_count is None
        assert kpi.top_selling_products == []

    @pytest.mark.asyncio
    async def test_manager_sees_all_kpis(self, service, mock_db):
        """Manager gets all KPI data."""
        mock_result_sales = MagicMock()
        mock_result_sales.scalar.return_value = Decimal("5000.00")

        mock_result_returns = MagicMock()
        mock_result_returns.scalar.return_value = Decimal("0.00")

        mock_result_receivables = MagicMock()
        mock_result_receivables.scalar.return_value = Decimal("25000.00")

        mock_result_low_stock = MagicMock()
        mock_result_low_stock.scalar.return_value = 8

        mock_result_pending_po = MagicMock()
        mock_result_pending_po.scalar.return_value = 3

        mock_result_top_products = MagicMock()
        mock_result_top_products.all.return_value = []

        mock_db.execute.side_effect = [
            mock_result_sales,       # _get_total_sales_today gross
            mock_result_returns,     # _get_total_sales_today returns
            mock_result_sales,       # _get_total_sales_month gross
            mock_result_returns,     # _get_total_sales_month returns
            mock_result_receivables, # outstanding_receivables
            mock_result_low_stock,   # low_stock_count
            mock_result_pending_po,  # pending_po_count
            mock_result_top_products,  # top_selling_products
        ]

        kpi = await service.get_kpis(UserRole.MANAGER.value)

        assert kpi.total_sales_today == Decimal("5000.00")
        assert kpi.total_sales_month == Decimal("5000.00")
        assert kpi.outstanding_receivables == Decimal("25000.00")
        assert kpi.low_stock_count == 8
        assert kpi.pending_po_count == 3
        assert kpi.top_selling_products == []

    @pytest.mark.asyncio
    async def test_admin_sees_all_kpis(self, service, mock_db):
        """Admin gets all KPI data (same as Manager)."""
        mock_result_sales = MagicMock()
        mock_result_sales.scalar.return_value = Decimal("10000.00")

        mock_result_returns = MagicMock()
        mock_result_returns.scalar.return_value = Decimal("0.00")

        mock_result_receivables = MagicMock()
        mock_result_receivables.scalar.return_value = Decimal("50000.00")

        mock_result_low_stock = MagicMock()
        mock_result_low_stock.scalar.return_value = 15

        mock_result_pending_po = MagicMock()
        mock_result_pending_po.scalar.return_value = 7

        mock_result_top_products = MagicMock()
        mock_result_top_products.all.return_value = []

        mock_db.execute.side_effect = [
            mock_result_sales,       # _get_total_sales_today gross
            mock_result_returns,     # _get_total_sales_today returns
            mock_result_sales,       # _get_total_sales_month gross
            mock_result_returns,     # _get_total_sales_month returns
            mock_result_receivables, # outstanding_receivables
            mock_result_low_stock,   # low_stock_count
            mock_result_pending_po,  # pending_po_count
            mock_result_top_products,  # top_selling_products
        ]

        kpi = await service.get_kpis(UserRole.ADMIN.value)

        assert kpi.total_sales_today == Decimal("10000.00")
        assert kpi.total_sales_month == Decimal("10000.00")
        assert kpi.outstanding_receivables == Decimal("50000.00")
        assert kpi.low_stock_count == 15
        assert kpi.pending_po_count == 7

    @pytest.mark.asyncio
    async def test_storekeeper_sees_inventory_kpis(self, service, mock_db):
        """Storekeeper gets sales + inventory-related KPIs."""
        mock_result_sales = MagicMock()
        mock_result_sales.scalar.return_value = Decimal("2000.00")

        mock_result_returns = MagicMock()
        mock_result_returns.scalar.return_value = Decimal("0.00")

        mock_result_low_stock = MagicMock()
        mock_result_low_stock.scalar.return_value = 4

        mock_result_pending_po = MagicMock()
        mock_result_pending_po.scalar.return_value = 2

        mock_db.execute.side_effect = [
            mock_result_sales,      # _get_total_sales_today gross
            mock_result_returns,    # _get_total_sales_today returns
            mock_result_sales,      # _get_total_sales_month gross
            mock_result_returns,    # _get_total_sales_month returns
            mock_result_low_stock,  # low_stock_count
            mock_result_pending_po, # pending_po_count
        ]

        kpi = await service.get_kpis(UserRole.STOREKEEPER.value)

        assert kpi.total_sales_today == Decimal("2000.00")
        assert kpi.total_sales_month == Decimal("2000.00")
        assert kpi.outstanding_receivables is None
        assert kpi.low_stock_count == 4
        assert kpi.pending_po_count == 2
        assert kpi.top_selling_products == []


# =============================================================================
# Individual KPI Query Tests
# =============================================================================


class TestSalesKPIs:
    """Tests for sales-related KPI queries."""

    @pytest.mark.asyncio
    async def test_total_sales_today_returns_sum(self, service, mock_db):
        """_get_total_sales_today returns the aggregated sum (net of returns)."""
        mock_gross = MagicMock()
        mock_gross.scalar.return_value = Decimal("7500.50")
        mock_returns = MagicMock()
        mock_returns.scalar.return_value = Decimal("0.00")
        mock_db.execute.side_effect = [mock_gross, mock_returns]

        result = await service._get_total_sales_today()
        assert result == Decimal("7500.50")

    @pytest.mark.asyncio
    async def test_total_sales_today_returns_zero_when_no_sales(self, service, mock_db):
        """_get_total_sales_today returns 0.00 when there are no sales."""
        mock_gross = MagicMock()
        mock_gross.scalar.return_value = None
        mock_returns = MagicMock()
        mock_returns.scalar.return_value = None
        mock_db.execute.side_effect = [mock_gross, mock_returns]

        result = await service._get_total_sales_today()
        assert result == Decimal("0.00")

    @pytest.mark.asyncio
    async def test_total_sales_month_returns_sum(self, service, mock_db):
        """_get_total_sales_month returns the aggregated sum (net of returns)."""
        mock_gross = MagicMock()
        mock_gross.scalar.return_value = Decimal("125000.00")
        mock_returns = MagicMock()
        mock_returns.scalar.return_value = Decimal("0.00")
        mock_db.execute.side_effect = [mock_gross, mock_returns]

        result = await service._get_total_sales_month()
        assert result == Decimal("125000.00")

    @pytest.mark.asyncio
    async def test_total_sales_month_returns_zero_when_no_sales(self, service, mock_db):
        """_get_total_sales_month returns 0.00 when there are no sales."""
        mock_gross = MagicMock()
        mock_gross.scalar.return_value = None
        mock_returns = MagicMock()
        mock_returns.scalar.return_value = None
        mock_db.execute.side_effect = [mock_gross, mock_returns]

        result = await service._get_total_sales_month()
        assert result == Decimal("0.00")


class TestReceivablesKPI:
    """Tests for outstanding receivables KPI."""

    @pytest.mark.asyncio
    async def test_outstanding_receivables_returns_sum(self, service, mock_db):
        """_get_outstanding_receivables returns the ledger sum."""
        mock_result = MagicMock()
        mock_result.scalar.return_value = Decimal("350000.00")
        mock_db.execute.return_value = mock_result

        result = await service._get_outstanding_receivables()
        assert result == Decimal("350000.00")

    @pytest.mark.asyncio
    async def test_outstanding_receivables_returns_zero_when_empty(self, service, mock_db):
        """_get_outstanding_receivables returns 0.00 with no ledger entries."""
        mock_result = MagicMock()
        mock_result.scalar.return_value = None
        mock_db.execute.return_value = mock_result

        result = await service._get_outstanding_receivables()
        assert result == Decimal("0.00")


class TestLowStockKPI:
    """Tests for low stock count KPI."""

    @pytest.mark.asyncio
    async def test_low_stock_count_returns_count(self, service, mock_db):
        """_get_low_stock_count returns the count of low-stock items."""
        mock_result = MagicMock()
        mock_result.scalar.return_value = 23
        mock_db.execute.return_value = mock_result

        result = await service._get_low_stock_count()
        assert result == 23

    @pytest.mark.asyncio
    async def test_low_stock_count_returns_zero_when_all_stocked(self, service, mock_db):
        """_get_low_stock_count returns 0 when all parts are above minimum."""
        mock_result = MagicMock()
        mock_result.scalar.return_value = 0
        mock_db.execute.return_value = mock_result

        result = await service._get_low_stock_count()
        assert result == 0


class TestPendingPOsKPI:
    """Tests for pending purchase orders count KPI."""

    @pytest.mark.asyncio
    async def test_pending_po_count_returns_count(self, service, mock_db):
        """_get_pending_po_count returns the count of pending POs."""
        mock_result = MagicMock()
        mock_result.scalar.return_value = 9
        mock_db.execute.return_value = mock_result

        result = await service._get_pending_po_count()
        assert result == 9

    @pytest.mark.asyncio
    async def test_pending_po_count_returns_zero_when_none_pending(self, service, mock_db):
        """_get_pending_po_count returns 0 when no POs are pending."""
        mock_result = MagicMock()
        mock_result.scalar.return_value = 0
        mock_db.execute.return_value = mock_result

        result = await service._get_pending_po_count()
        assert result == 0


class TestTopSellingProducts:
    """Tests for top selling products KPI."""

    @pytest.mark.asyncio
    async def test_top_selling_products_returns_formatted_list(self, service, mock_db):
        """_get_top_selling_products returns properly formatted list."""
        part_id = uuid.uuid4()
        mock_row = MagicMock()
        mock_row.spare_part_id = part_id
        mock_row.part_name = "Oil Filter"
        mock_row.part_number = "OF-100"
        mock_row.total_quantity_sold = Decimal("150")

        mock_result = MagicMock()
        mock_result.all.return_value = [mock_row]
        mock_db.execute.return_value = mock_result

        result = await service._get_top_selling_products()

        assert len(result) == 1
        assert result[0]["spare_part_id"] == str(part_id)
        assert result[0]["part_name"] == "Oil Filter"
        assert result[0]["part_number"] == "OF-100"
        assert result[0]["total_quantity_sold"] == "150"

    @pytest.mark.asyncio
    async def test_top_selling_products_returns_empty_when_no_sales(self, service, mock_db):
        """_get_top_selling_products returns empty list when no sales."""
        mock_result = MagicMock()
        mock_result.all.return_value = []
        mock_db.execute.return_value = mock_result

        result = await service._get_top_selling_products()
        assert result == []

    @pytest.mark.asyncio
    async def test_top_selling_products_includes_external_items(self, service, mock_db):
        """External items have no inventory id but still belong in sales KPIs."""
        mock_row = MagicMock()
        mock_row.spare_part_id = None
        mock_row.part_name = "Wheel Speed Sensor"
        mock_row.part_number = "SENSOR-EXT-01"
        mock_row.total_quantity_sold = Decimal("1")

        mock_result = MagicMock()
        mock_result.all.return_value = [mock_row]
        mock_db.execute.return_value = mock_result

        result = await service._get_top_selling_products()

        assert result == [
            {
                "spare_part_id": None,
                "part_name": "Wheel Speed Sensor",
                "part_number": "SENSOR-EXT-01",
                "total_quantity_sold": "1",
            }
        ]

    @pytest.mark.asyncio
    async def test_top_selling_products_respects_limit(self, service, mock_db):
        """_get_top_selling_products respects the limit parameter."""
        rows = []
        for i in range(3):
            row = MagicMock()
            row.spare_part_id = uuid.uuid4()
            row.part_name = f"Part {i}"
            row.part_number = f"P-{i:03d}"
            row.total_quantity_sold = Decimal(str(100 - i * 10))
            rows.append(row)

        mock_result = MagicMock()
        mock_result.all.return_value = rows
        mock_db.execute.return_value = mock_result

        result = await service._get_top_selling_products(limit=3)
        assert len(result) == 3
        # Verify ordering is preserved
        assert result[0]["part_name"] == "Part 0"
        assert result[2]["part_name"] == "Part 2"
