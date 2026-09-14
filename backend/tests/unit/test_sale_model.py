"""Unit tests for Sale and SaleItem models."""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import Numeric, String, Enum, inspect
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

from app.models.sale import Sale, SaleItem, SaleStatus, PaymentType
from app.models.base import BaseModel, SoftDeleteMixin


# =============================================================================
# SaleStatus Enum Tests
# =============================================================================


class TestSaleStatusEnum:
    """Test SaleStatus enumeration values."""

    def test_draft_status(self):
        """SaleStatus should have a DRAFT value."""
        assert SaleStatus.DRAFT == "DRAFT"

    def test_confirmed_status(self):
        """SaleStatus should have a CONFIRMED value."""
        assert SaleStatus.CONFIRMED == "CONFIRMED"

    def test_returned_status(self):
        """SaleStatus should have a RETURNED value."""
        assert SaleStatus.RETURNED == "RETURNED"

    def test_cancelled_status(self):
        """SaleStatus should have a CANCELLED value."""
        assert SaleStatus.CANCELLED == "CANCELLED"

    def test_all_statuses_present(self):
        """SaleStatus should have exactly 4 members."""
        assert len(SaleStatus) == 4


# =============================================================================
# PaymentType Enum Tests
# =============================================================================


class TestPaymentTypeEnum:
    """Test PaymentType enumeration values."""

    def test_cash_type(self):
        """PaymentType should have a CASH value."""
        assert PaymentType.CASH == "CASH"

    def test_credit_type(self):
        """PaymentType should have a CREDIT value."""
        assert PaymentType.CREDIT == "CREDIT"

    def test_all_types_present(self):
        """PaymentType should have exactly 2 members."""
        assert len(PaymentType) == 2


# =============================================================================
# Sale Model Tests
# =============================================================================


class TestSaleModel:
    """Test Sale model definition (Requirement 5.1)."""

    def test_sale_inherits_base_model(self):
        """Sale should inherit from BaseModel."""
        assert issubclass(Sale, BaseModel)

    def test_sale_has_soft_delete_mixin(self):
        """Sale should include SoftDeleteMixin."""
        assert issubclass(Sale, SoftDeleteMixin)

    def test_sale_tablename(self):
        """Sale should map to the 'sales' table."""
        assert Sale.__tablename__ == "sales"

    def test_customer_id_column(self):
        """Sale should have a nullable customer_id FK for walk-in customers."""
        col = Sale.__table__.columns["customer_id"]
        assert isinstance(col.type, PG_UUID)
        assert col.nullable is True
        fk = list(col.foreign_keys)[0]
        assert fk.target_fullname == "customers.id"

    def test_location_id_column(self):
        """Sale should have a non-nullable location_id FK."""
        col = Sale.__table__.columns["location_id"]
        assert isinstance(col.type, PG_UUID)
        assert col.nullable is False
        fk = list(col.foreign_keys)[0]
        assert fk.target_fullname == "locations.id"

    def test_invoice_number_column(self):
        """Sale should have a nullable unique invoice_number."""
        col = Sale.__table__.columns["invoice_number"]
        assert isinstance(col.type, String)
        assert col.nullable is True
        assert col.unique is True

    def test_status_column(self):
        """Sale should have a non-nullable status enum column."""
        col = Sale.__table__.columns["status"]
        assert isinstance(col.type, Enum)
        assert col.nullable is False

    def test_payment_type_column(self):
        """Sale should have a non-nullable payment_type enum column."""
        col = Sale.__table__.columns["payment_type"]
        assert isinstance(col.type, Enum)
        assert col.nullable is False

    def test_subtotal_column(self):
        """Sale should have a non-nullable Numeric subtotal column."""
        col = Sale.__table__.columns["subtotal"]
        assert isinstance(col.type, Numeric)
        assert col.nullable is False

    def test_tax_amount_column(self):
        """Sale should have a non-nullable Numeric tax_amount column."""
        col = Sale.__table__.columns["tax_amount"]
        assert isinstance(col.type, Numeric)
        assert col.nullable is False

    def test_total_amount_column(self):
        """Sale should have a non-nullable Numeric total_amount column."""
        col = Sale.__table__.columns["total_amount"]
        assert isinstance(col.type, Numeric)
        assert col.nullable is False

    def test_discount_total_column(self):
        """Sale should have a non-nullable Numeric discount_total column."""
        col = Sale.__table__.columns["discount_total"]
        assert isinstance(col.type, Numeric)
        assert col.nullable is False

    def test_sale_has_audit_columns(self):
        """Sale should have inherited audit columns from BaseModel."""
        table = Sale.__table__
        assert "id" in table.columns
        assert "created_at" in table.columns
        assert "updated_at" in table.columns
        assert "created_by" in table.columns
        assert "updated_by" in table.columns

    def test_sale_has_soft_delete_columns(self):
        """Sale should have soft-delete columns."""
        table = Sale.__table__
        assert "deleted_at" in table.columns
        assert "deleted_by" in table.columns

    def test_sale_has_items_relationship(self):
        """Sale should have an 'items' relationship to SaleItem."""
        mapper = inspect(Sale)
        relationship_names = [r.key for r in mapper.relationships]
        assert "items" in relationship_names


# =============================================================================
# Sale Instance Tests
# =============================================================================


class TestSaleInstance:
    """Test Sale instance creation and defaults."""

    def test_instance_with_required_fields(self):
        """A Sale instance should be creatable with required fields."""
        location_id = uuid.uuid4()
        sale = Sale(location_id=location_id)
        assert sale.location_id == location_id
        assert sale.customer_id is None
        assert sale.invoice_number is None

    def test_default_status_is_draft(self):
        """Sale should default to DRAFT status."""
        col = Sale.__table__.columns["status"]
        assert col.default.arg == SaleStatus.DRAFT

    def test_default_payment_type_is_cash(self):
        """Sale should default to CASH payment type."""
        col = Sale.__table__.columns["payment_type"]
        assert col.default.arg == PaymentType.CASH

    def test_default_financial_values(self):
        """Sale financial columns should default to 0.00."""
        sale = Sale(location_id=uuid.uuid4())
        # Check column defaults exist
        subtotal_col = Sale.__table__.columns["subtotal"]
        assert subtotal_col.default.arg == Decimal("0.00")
        tax_col = Sale.__table__.columns["tax_amount"]
        assert tax_col.default.arg == Decimal("0.00")
        total_col = Sale.__table__.columns["total_amount"]
        assert total_col.default.arg == Decimal("0.00")
        discount_col = Sale.__table__.columns["discount_total"]
        assert discount_col.default.arg == Decimal("0.00")

    def test_instance_with_customer(self):
        """A Sale instance can be created with a customer_id."""
        customer_id = uuid.uuid4()
        location_id = uuid.uuid4()
        sale = Sale(
            customer_id=customer_id,
            location_id=location_id,
            status=SaleStatus.CONFIRMED,
            payment_type=PaymentType.CREDIT,
            subtotal=Decimal("100.00"),
            tax_amount=Decimal("7.50"),
            total_amount=Decimal("107.50"),
            discount_total=Decimal("0.00"),
            invoice_number="INV-2024-0001",
        )
        assert sale.customer_id == customer_id
        assert sale.location_id == location_id
        assert sale.status == SaleStatus.CONFIRMED
        assert sale.payment_type == PaymentType.CREDIT
        assert sale.subtotal == Decimal("100.00")
        assert sale.tax_amount == Decimal("7.50")
        assert sale.total_amount == Decimal("107.50")
        assert sale.invoice_number == "INV-2024-0001"

    def test_sale_soft_delete(self):
        """Sale should support soft deletion."""
        sale = Sale(location_id=uuid.uuid4())
        assert sale.is_deleted is False
        sale.soft_delete(deleted_by="admin")
        assert sale.is_deleted is True
        assert sale.deleted_by == "admin"

    def test_sale_repr(self):
        """Sale repr should include key identifiers."""
        sale = Sale(
            location_id=uuid.uuid4(),
            invoice_number="INV-001",
            status=SaleStatus.DRAFT,
            total_amount=Decimal("50.00"),
        )
        result = repr(sale)
        assert "Sale" in result
        assert "INV-001" in result


# =============================================================================
# SaleItem Model Tests
# =============================================================================


class TestSaleItemModel:
    """Test SaleItem model definition (Requirement 5.1)."""

    def test_sale_item_inherits_base_model(self):
        """SaleItem should inherit from BaseModel."""
        assert issubclass(SaleItem, BaseModel)

    def test_sale_item_does_not_have_soft_delete(self):
        """SaleItem should NOT include SoftDeleteMixin (deleted with parent sale)."""
        assert not issubclass(SaleItem, SoftDeleteMixin)

    def test_sale_item_tablename(self):
        """SaleItem should map to the 'sale_items' table."""
        assert SaleItem.__tablename__ == "sale_items"

    def test_sale_id_column(self):
        """SaleItem should have a non-nullable sale_id FK."""
        col = SaleItem.__table__.columns["sale_id"]
        assert isinstance(col.type, PG_UUID)
        assert col.nullable is False
        fk = list(col.foreign_keys)[0]
        assert fk.target_fullname == "sales.id"

    def test_spare_part_id_column(self):
        """SaleItem should have a nullable spare_part_id FK for external items."""
        col = SaleItem.__table__.columns["spare_part_id"]
        assert isinstance(col.type, PG_UUID)
        assert col.nullable is True
        fk = list(col.foreign_keys)[0]
        assert fk.target_fullname == "spare_parts.id"

    def test_quantity_column(self):
        """SaleItem should have a non-nullable Numeric quantity column."""
        col = SaleItem.__table__.columns["quantity"]
        assert isinstance(col.type, Numeric)
        assert col.nullable is False

    def test_unit_price_column(self):
        """SaleItem should have a non-nullable Numeric unit_price column."""
        col = SaleItem.__table__.columns["unit_price"]
        assert isinstance(col.type, Numeric)
        assert col.nullable is False

    def test_discount_amount_column(self):
        """SaleItem should have a non-nullable Numeric discount_amount column with default 0."""
        col = SaleItem.__table__.columns["discount_amount"]
        assert isinstance(col.type, Numeric)
        assert col.nullable is False
        assert col.default.arg == Decimal("0.00")

    def test_line_total_column(self):
        """SaleItem should have a non-nullable Numeric line_total column."""
        col = SaleItem.__table__.columns["line_total"]
        assert isinstance(col.type, Numeric)
        assert col.nullable is False

    def test_cost_of_goods_sold_column(self):
        """SaleItem should have a nullable Numeric cost_of_goods_sold column."""
        col = SaleItem.__table__.columns["cost_of_goods_sold"]
        assert isinstance(col.type, Numeric)
        assert col.nullable is True

    def test_sale_item_has_audit_columns(self):
        """SaleItem should have inherited audit columns from BaseModel."""
        table = SaleItem.__table__
        assert "id" in table.columns
        assert "created_at" in table.columns
        assert "updated_at" in table.columns
        assert "created_by" in table.columns
        assert "updated_by" in table.columns

    def test_sale_item_has_sale_relationship(self):
        """SaleItem should have a 'sale' relationship."""
        mapper = inspect(SaleItem)
        relationship_names = [r.key for r in mapper.relationships]
        assert "sale" in relationship_names


# =============================================================================
# SaleItem Instance Tests
# =============================================================================


class TestSaleItemInstance:
    """Test SaleItem instance creation and defaults."""

    def test_instance_creation_with_required_fields(self):
        """A SaleItem instance should be creatable with required fields."""
        sale_id = uuid.uuid4()
        spare_part_id = uuid.uuid4()
        item = SaleItem(
            sale_id=sale_id,
            spare_part_id=spare_part_id,
            quantity=Decimal("2.00"),
            unit_price=Decimal("25.00"),
            line_total=Decimal("50.00"),
        )
        assert item.sale_id == sale_id
        assert item.spare_part_id == spare_part_id
        assert item.quantity == Decimal("2.00")
        assert item.unit_price == Decimal("25.00")
        assert item.line_total == Decimal("50.00")
        assert item.cost_of_goods_sold is None

    def test_instance_with_discount(self):
        """A SaleItem can include a discount amount."""
        item = SaleItem(
            sale_id=uuid.uuid4(),
            spare_part_id=uuid.uuid4(),
            quantity=Decimal("5.00"),
            unit_price=Decimal("10.00"),
            discount_amount=Decimal("5.00"),
            line_total=Decimal("45.00"),  # (5 * 10) - 5
        )
        assert item.discount_amount == Decimal("5.00")
        assert item.line_total == Decimal("45.00")

    def test_instance_with_cogs(self):
        """A SaleItem can have cost_of_goods_sold set (after confirmation)."""
        item = SaleItem(
            sale_id=uuid.uuid4(),
            spare_part_id=uuid.uuid4(),
            quantity=Decimal("3.00"),
            unit_price=Decimal("20.00"),
            line_total=Decimal("60.00"),
            cost_of_goods_sold=Decimal("36.00"),
        )
        assert item.cost_of_goods_sold == Decimal("36.00")

    def test_sale_item_repr(self):
        """SaleItem repr should include key identifiers."""
        sale_id = uuid.uuid4()
        spare_part_id = uuid.uuid4()
        item = SaleItem(
            sale_id=sale_id,
            spare_part_id=spare_part_id,
            quantity=Decimal("2.00"),
            unit_price=Decimal("25.00"),
            line_total=Decimal("50.00"),
        )
        result = repr(item)
        assert "SaleItem" in result
        assert str(sale_id) in result
        assert str(spare_part_id) in result
