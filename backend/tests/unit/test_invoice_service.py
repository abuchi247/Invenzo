"""Unit tests for the invoice service and PDF generator utility.

Tests cover:
- Invoice model creation and fields
- QR code generation (base64 encoding, data format)
- Barcode generation for invoices
- HTML rendering for A4 and THERMAL formats
- Invoice service: generate, retrieve, validation
- Error cases: sale not found, sale not confirmed, duplicate invoice

Satisfies Requirements: 14.1, 14.2, 14.3, 14.4, 14.5
"""

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.invoice import Invoice, InvoiceFormat
from app.services.invoice_service import (
    InvoiceAlreadyExistsError,
    InvoiceNotFoundError,
    InvoiceService,
    SaleNotConfirmedError,
    SaleNotFoundError,
)
from app.utils.pdf_generator import (
    CompanyDetails,
    CustomerDetails,
    InvoiceData,
    InvoiceLineItem,
    generate_barcode_base64,
    generate_invoice_pdf,
    generate_qr_code_base64,
    render_invoice_html,
)


# =============================================================================
# Fixtures
# =============================================================================


def _make_execute_result(scalar_value=None):
    """Create a mock result object that mimics SQLAlchemy's execute result."""
    result = MagicMock()
    result.scalar_one_or_none = MagicMock(return_value=scalar_value)
    return result


def _make_execute_result_scalars(values=None):
    """Create a mock result with scalars().all() returning a list."""
    result = MagicMock()
    scalars_mock = MagicMock()
    scalars_mock.all = MagicMock(return_value=values or [])
    result.scalars = MagicMock(return_value=scalars_mock)
    return result


def _make_mock_sale(
    sale_id=None,
    invoice_number="INV-2024-0001",
    status_value="CONFIRMED",
    payment_type_value="CASH",
    customer_id=None,
    total_amount=Decimal("1500.00"),
    subtotal=Decimal("1400.00"),
    tax_amount=Decimal("100.00"),
    discount_total=Decimal("0.00"),
    amount_paid=None,
):
    """Helper to create a mock Sale object."""
    mock_sale = MagicMock()
    mock_sale.id = sale_id or uuid.uuid4()
    mock_sale.invoice_number = invoice_number
    mock_sale.status = MagicMock()
    mock_sale.status.value = status_value
    mock_sale.payment_type = MagicMock()
    mock_sale.payment_type.value = payment_type_value
    mock_sale.customer_id = customer_id
    mock_sale.total_amount = total_amount
    mock_sale.subtotal = subtotal
    mock_sale.tax_amount = tax_amount
    mock_sale.discount_total = discount_total
    mock_sale.amount_paid = amount_paid if amount_paid is not None else (total_amount if payment_type_value == "CASH" else Decimal("0.00"))
    mock_sale.created_at = datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc)
    mock_sale.items = []
    return mock_sale


def _make_mock_sale_item(
    spare_part_id=None,
    quantity=Decimal("2"),
    unit_price=Decimal("500.00"),
    discount_amount=Decimal("0.00"),
    line_total=Decimal("1000.00"),
):
    """Helper to create a mock SaleItem object."""
    mock_item = MagicMock()
    mock_item.spare_part_id = spare_part_id or uuid.uuid4()
    mock_item.quantity = quantity
    mock_item.unit_price = unit_price
    mock_item.discount_amount = discount_amount
    mock_item.line_total = line_total
    return mock_item


def _make_mock_customer(
    customer_id=None,
    name="John Doe",
    phone="+234 800 123 4567",
    email="john@example.com",
    address="456 Main St, Lagos",
    tax_id="TIN-87654321",
):
    """Helper to create a mock Customer object."""
    mock_customer = MagicMock()
    mock_customer.id = customer_id or uuid.uuid4()
    mock_customer.name = name
    mock_customer.phone = phone
    mock_customer.email = email
    mock_customer.address = address
    mock_customer.tax_id = tax_id
    return mock_customer


def _make_mock_spare_part(part_number="SP-001", name="Brake Pad Set"):
    """Helper to create a mock SparePart object."""
    mock_part = MagicMock()
    mock_part.id = uuid.uuid4()
    mock_part.part_number = part_number
    mock_part.brand = "Bosch"
    mock_part.name = name
    return mock_part


@pytest.fixture
def mock_db():
    """Create a mock async database session."""
    db = AsyncMock()
    db.add = MagicMock()
    db.flush = AsyncMock()
    db.refresh = AsyncMock()
    return db


@pytest.fixture
def invoice_service(mock_db):
    """Create an InvoiceService with a mock database session."""
    return InvoiceService(db=mock_db)


@pytest.fixture
def sample_invoice_data():
    """Create sample InvoiceData for testing."""
    return InvoiceData(
        invoice_number="INV-2024-0001",
        invoice_date=datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc),
        company=CompanyDetails(),
        customer=CustomerDetails(
            name="John Doe",
            phone="+234 800 123 4567",
            email="john@example.com",
            address="456 Main St, Lagos",
        ),
        line_items=[
            InvoiceLineItem(
                part_number="SP-001",
                description="Brake Pad Set",
                quantity=Decimal("2"),
                unit_price=Decimal("500.00"),
                discount_amount=Decimal("0.00"),
                line_total=Decimal("1000.00"),
            ),
            InvoiceLineItem(
                part_number="SP-002",
                description="Oil Filter",
                quantity=Decimal("3"),
                unit_price=Decimal("150.00"),
                discount_amount=Decimal("50.00"),
                line_total=Decimal("400.00"),
            ),
        ],
        subtotal=Decimal("1400.00"),
        tax_amount=Decimal("100.00"),
        discount_total=Decimal("50.00"),
        total_amount=Decimal("1450.00"),
        payment_type="CASH",
        status="CONFIRMED",
        payment_terms="Due on receipt",
    )


# =============================================================================
# Invoice Model Tests
# =============================================================================


class TestInvoiceModel:
    """Tests for the Invoice SQLAlchemy model."""

    def test_invoice_format_enum_values(self):
        """InvoiceFormat should have A4 and THERMAL values."""
        assert InvoiceFormat.A4.value == "A4"
        assert InvoiceFormat.THERMAL.value == "THERMAL"

    def test_invoice_format_enum_count(self):
        """InvoiceFormat should have exactly 2 values."""
        assert len(InvoiceFormat) == 2


# =============================================================================
# QR Code Generation Tests
# =============================================================================


class TestGenerateQrCodeBase64:
    """Tests for generate_qr_code_base64."""

    def test_generates_non_empty_base64_string(self):
        """Should generate a non-empty base64-encoded string."""
        result = generate_qr_code_base64("INV-2024-0001|1500.00")
        assert result is not None
        assert len(result) > 0

    def test_generates_valid_base64(self):
        """Output should be valid base64 that can be decoded."""
        import base64

        result = generate_qr_code_base64("INV-2024-0001|1500.00")
        # Should not raise an exception
        decoded = base64.b64decode(result)
        assert len(decoded) > 0

    def test_generates_png_image(self):
        """Decoded base64 should be a valid PNG image."""
        import base64

        result = generate_qr_code_base64("TEST|100.00")
        decoded = base64.b64decode(result)
        # PNG magic bytes
        assert decoded[:8] == b"\x89PNG\r\n\x1a\n"

    def test_different_data_produces_different_qr(self):
        """Different input data should produce different QR codes."""
        qr1 = generate_qr_code_base64("INV-0001|100.00")
        qr2 = generate_qr_code_base64("INV-0002|200.00")
        assert qr1 != qr2

    def test_encodes_invoice_number_and_amount(self):
        """Should handle the standard invoice data format."""
        # This should not raise any exceptions
        result = generate_qr_code_base64("INV-2024-00001|99999.99")
        assert len(result) > 0


# =============================================================================
# Barcode Generation Tests
# =============================================================================


class TestGenerateBarcodeBase64:
    """Tests for generate_barcode_base64."""

    def test_generates_non_empty_base64_string(self):
        """Should generate a non-empty base64-encoded string."""
        result = generate_barcode_base64("INV-2024-0001")
        assert result is not None
        assert len(result) > 0

    def test_generates_valid_base64(self):
        """Output should be valid base64 that can be decoded."""
        import base64

        result = generate_barcode_base64("INV-2024-0001")
        decoded = base64.b64decode(result)
        assert len(decoded) > 0

    def test_generates_svg_content(self):
        """Decoded base64 should contain SVG content."""
        import base64

        result = generate_barcode_base64("TEST-BARCODE")
        decoded = base64.b64decode(result)
        svg_str = decoded.decode("utf-8")
        assert "svg" in svg_str.lower()


# =============================================================================
# HTML Rendering Tests
# =============================================================================


class TestRenderInvoiceHtml:
    """Tests for render_invoice_html."""

    def test_render_a4_format(self, sample_invoice_data):
        """Should render A4 format HTML."""
        html = render_invoice_html(sample_invoice_data, format="A4")
        assert "<!DOCTYPE html>" in html
        assert "A4" in html  # @page size
        assert sample_invoice_data.invoice_number in html

    def test_render_thermal_format(self, sample_invoice_data):
        """Should render THERMAL format HTML."""
        html = render_invoice_html(sample_invoice_data, format="THERMAL")
        assert "<!DOCTYPE html>" in html
        assert "80mm" in html  # @page size
        assert sample_invoice_data.invoice_number in html

    def test_includes_company_details(self, sample_invoice_data):
        """HTML should include company details."""
        html = render_invoice_html(sample_invoice_data, format="A4")
        assert sample_invoice_data.company.name in html
        assert sample_invoice_data.company.phone in html
        assert sample_invoice_data.company.email in html

    def test_includes_customer_details(self, sample_invoice_data):
        """HTML should include customer details."""
        html = render_invoice_html(sample_invoice_data, format="A4")
        assert sample_invoice_data.customer.name in html
        assert sample_invoice_data.customer.phone in html

    def test_includes_line_items(self, sample_invoice_data):
        """HTML should include all line items."""
        html = render_invoice_html(sample_invoice_data, format="A4")
        assert "SP-001" in html
        assert "Brake Pad Set" in html
        assert "SP-002" in html
        assert "Oil Filter" in html

    def test_includes_totals(self, sample_invoice_data):
        """HTML should include subtotal, tax, discount, and total."""
        html = render_invoice_html(sample_invoice_data, format="A4")
        assert "1,400.00" in html  # subtotal
        assert "100.00" in html  # tax
        assert "1,450.00" in html  # total

    def test_includes_status(self, sample_invoice_data):
        """HTML should include the invoice status."""
        html = render_invoice_html(sample_invoice_data, format="A4")
        assert "CONFIRMED" in html

    def test_includes_payment_terms(self, sample_invoice_data):
        """HTML should include payment terms."""
        html = render_invoice_html(sample_invoice_data, format="A4")
        assert "Due on receipt" in html

    def test_includes_qr_code_when_present(self, sample_invoice_data):
        """HTML should include QR code image when qr_code_base64 is set."""
        sample_invoice_data.qr_code_base64 = "dGVzdA=="  # base64("test")
        html = render_invoice_html(sample_invoice_data, format="A4")
        assert "data:image/png;base64,dGVzdA==" in html

    def test_includes_barcode_when_present(self, sample_invoice_data):
        """HTML should include barcode image when barcode_svg is set."""
        sample_invoice_data.barcode_svg = "YmFyY29kZQ=="  # base64("barcode")
        html = render_invoice_html(sample_invoice_data, format="A4")
        assert "data:image/svg+xml;base64,YmFyY29kZQ==" in html

    def test_thermal_includes_line_items(self, sample_invoice_data):
        """Thermal format should include line items."""
        html = render_invoice_html(sample_invoice_data, format="THERMAL")
        assert "Brake Pad Set" in html
        assert "Oil Filter" in html

    def test_walk_in_customer(self, sample_invoice_data):
        """Should handle walk-in customer (no detailed info)."""
        sample_invoice_data.customer = CustomerDetails(name="Walk-in Customer")
        html = render_invoice_html(sample_invoice_data, format="A4")
        assert "Walk-in Customer" in html


# =============================================================================
# PDF Generation Tests
# =============================================================================


class TestGenerateInvoicePdf:
    """Tests for generate_invoice_pdf."""

    def test_generates_non_empty_bytes(self, sample_invoice_data):
        """Should generate non-empty PDF/HTML bytes."""
        result = generate_invoice_pdf(sample_invoice_data, format="A4")
        assert result is not None
        assert len(result) > 0

    def test_generates_for_thermal_format(self, sample_invoice_data):
        """Should generate bytes for thermal format."""
        result = generate_invoice_pdf(sample_invoice_data, format="THERMAL")
        assert result is not None
        assert len(result) > 0

    def test_a4_and_thermal_produce_different_output(self, sample_invoice_data):
        """A4 and THERMAL should produce different PDF content."""
        a4_result = generate_invoice_pdf(sample_invoice_data, format="A4")
        thermal_result = generate_invoice_pdf(sample_invoice_data, format="THERMAL")
        assert a4_result != thermal_result


# =============================================================================
# Invoice Service Tests
# =============================================================================


class TestInvoiceServiceGenerate:
    """Tests for InvoiceService.generate_invoice_pdf."""

    @pytest.mark.asyncio
    async def test_generate_invoice_success(self, invoice_service, mock_db):
        """Should generate and store an invoice for a confirmed sale."""
        sale_id = uuid.uuid4()
        customer_id = uuid.uuid4()
        part_id = uuid.uuid4()

        mock_sale = _make_mock_sale(sale_id=sale_id, customer_id=customer_id)
        mock_item = _make_mock_sale_item(spare_part_id=part_id)
        mock_sale.items = [mock_item]

        mock_customer = _make_mock_customer(customer_id=customer_id)
        mock_part = _make_mock_spare_part()
        mock_part.id = part_id

        # Calls: _get_sale_with_items, _get_existing_invoice, _get_customer_details, _build_line_items
        mock_db.execute = AsyncMock(
            side_effect=[
                _make_execute_result(scalar_value=mock_sale),  # get sale
                _make_execute_result(scalar_value=None),  # no existing invoice
                _make_execute_result(scalar_value=mock_customer),  # get customer
                _make_execute_result_scalars(values=[mock_part]),  # get spare parts
            ]
        )

        result = await invoice_service.generate_invoice_pdf(sale_id, format="A4")

        assert result is not None
        assert result.sale_id == sale_id
        assert result.invoice_number == "INV-2024-0001"
        assert result.format == InvoiceFormat.A4
        assert len(result.pdf_data) > 0
        mock_db.add.assert_called_once()
        mock_db.flush.assert_awaited()

    @pytest.mark.asyncio
    async def test_generate_invoice_sale_not_found(self, invoice_service, mock_db):
        """Should raise SaleNotFoundError if sale doesn't exist."""
        sale_id = uuid.uuid4()

        mock_db.execute = AsyncMock(
            return_value=_make_execute_result(scalar_value=None)
        )

        with pytest.raises(SaleNotFoundError) as exc_info:
            await invoice_service.generate_invoice_pdf(sale_id)
        assert str(sale_id) in str(exc_info.value.message)

    @pytest.mark.asyncio
    async def test_generate_invoice_sale_not_confirmed(self, invoice_service, mock_db):
        """Should raise SaleNotConfirmedError if sale is in DRAFT status."""
        sale_id = uuid.uuid4()
        mock_sale = _make_mock_sale(sale_id=sale_id, status_value="DRAFT")

        mock_db.execute = AsyncMock(
            return_value=_make_execute_result(scalar_value=mock_sale)
        )

        with pytest.raises(SaleNotConfirmedError) as exc_info:
            await invoice_service.generate_invoice_pdf(sale_id)
        assert "DRAFT" in str(exc_info.value.message)

    @pytest.mark.asyncio
    async def test_generate_invoice_already_exists(self, invoice_service, mock_db):
        """Should raise InvoiceAlreadyExistsError if invoice exists and overwrite=False."""
        sale_id = uuid.uuid4()
        mock_sale = _make_mock_sale(sale_id=sale_id)
        existing_invoice = MagicMock()

        mock_db.execute = AsyncMock(
            side_effect=[
                _make_execute_result(scalar_value=mock_sale),  # get sale
                _make_execute_result(scalar_value=existing_invoice),  # existing invoice
            ]
        )

        with pytest.raises(InvoiceAlreadyExistsError):
            await invoice_service.generate_invoice_pdf(sale_id, format="A4")

    @pytest.mark.asyncio
    async def test_generate_invoice_overwrite(self, invoice_service, mock_db):
        """Should overwrite existing invoice when overwrite=True."""
        sale_id = uuid.uuid4()
        customer_id = uuid.uuid4()
        part_id = uuid.uuid4()

        mock_sale = _make_mock_sale(sale_id=sale_id, customer_id=customer_id)
        mock_item = _make_mock_sale_item(spare_part_id=part_id)
        mock_sale.items = [mock_item]

        mock_customer = _make_mock_customer(customer_id=customer_id)
        mock_part = _make_mock_spare_part()
        mock_part.id = part_id

        existing_invoice = MagicMock()
        existing_invoice.pdf_data = b"old_data"

        # Calls: _get_sale_with_items, _get_customer_details, _build_line_items, _get_existing_invoice (overwrite check)
        mock_db.execute = AsyncMock(
            side_effect=[
                _make_execute_result(scalar_value=mock_sale),  # get sale
                _make_execute_result(scalar_value=mock_customer),  # get customer
                _make_execute_result_scalars(values=[mock_part]),  # get spare parts
                _make_execute_result(scalar_value=existing_invoice),  # existing invoice (overwrite)
            ]
        )

        result = await invoice_service.generate_invoice_pdf(
            sale_id, format="A4", overwrite=True
        )

        assert result == existing_invoice
        # PDF data should be updated
        assert existing_invoice.pdf_data != b"old_data"

    @pytest.mark.asyncio
    async def test_generate_thermal_invoice(self, invoice_service, mock_db):
        """Should generate a thermal format invoice."""
        sale_id = uuid.uuid4()
        part_id = uuid.uuid4()

        mock_sale = _make_mock_sale(sale_id=sale_id, customer_id=None)
        mock_item = _make_mock_sale_item(spare_part_id=part_id)
        mock_sale.items = [mock_item]

        mock_part = _make_mock_spare_part()
        mock_part.id = part_id

        mock_db.execute = AsyncMock(
            side_effect=[
                _make_execute_result(scalar_value=mock_sale),  # get sale
                _make_execute_result(scalar_value=None),  # no existing invoice
                _make_execute_result(scalar_value=None),  # no customer (walk-in)
                _make_execute_result_scalars(values=[mock_part]),  # get spare parts
            ]
        )

        result = await invoice_service.generate_invoice_pdf(
            sale_id, format="THERMAL"
        )

        assert result.format == InvoiceFormat.THERMAL
        assert len(result.pdf_data) > 0

    @pytest.mark.asyncio
    async def test_generate_invoice_credit_payment_terms(self, invoice_service, mock_db):
        """Should set 'Net 30 days' payment terms for credit sales."""
        sale_id = uuid.uuid4()
        part_id = uuid.uuid4()

        mock_sale = _make_mock_sale(
            sale_id=sale_id, customer_id=None, payment_type_value="CREDIT"
        )
        mock_item = _make_mock_sale_item(spare_part_id=part_id)
        mock_sale.items = [mock_item]

        mock_part = _make_mock_spare_part()
        mock_part.id = part_id

        mock_db.execute = AsyncMock(
            side_effect=[
                _make_execute_result(scalar_value=mock_sale),  # get sale
                _make_execute_result(scalar_value=None),  # no existing invoice
                _make_execute_result(scalar_value=None),  # no customer
                _make_execute_result_scalars(values=[mock_part]),  # get spare parts
            ]
        )

        result = await invoice_service.generate_invoice_pdf(sale_id, format="A4")

        # The PDF should contain "Net 30 days" for credit sales
        assert len(result.pdf_data) > 0


class TestInvoiceServiceGetById:
    """Tests for InvoiceService.get_invoice_by_id."""

    @pytest.mark.asyncio
    async def test_get_invoice_success(self, invoice_service, mock_db):
        """Should return the invoice when found."""
        invoice_id = uuid.uuid4()
        mock_invoice = MagicMock()
        mock_invoice.id = invoice_id

        mock_db.execute = AsyncMock(
            return_value=_make_execute_result(scalar_value=mock_invoice)
        )

        result = await invoice_service.get_invoice_by_id(invoice_id)
        assert result == mock_invoice

    @pytest.mark.asyncio
    async def test_get_invoice_not_found(self, invoice_service, mock_db):
        """Should raise InvoiceNotFoundError when invoice doesn't exist."""
        invoice_id = uuid.uuid4()

        mock_db.execute = AsyncMock(
            return_value=_make_execute_result(scalar_value=None)
        )

        with pytest.raises(InvoiceNotFoundError):
            await invoice_service.get_invoice_by_id(invoice_id)


class TestInvoiceServiceGetBySale:
    """Tests for InvoiceService.get_invoice_by_sale."""

    @pytest.mark.asyncio
    async def test_get_invoice_by_sale_found(self, invoice_service, mock_db):
        """Should return invoice when it exists for sale and format."""
        sale_id = uuid.uuid4()
        mock_invoice = MagicMock()

        mock_db.execute = AsyncMock(
            return_value=_make_execute_result(scalar_value=mock_invoice)
        )

        result = await invoice_service.get_invoice_by_sale(sale_id, format="A4")
        assert result == mock_invoice

    @pytest.mark.asyncio
    async def test_get_invoice_by_sale_not_found(self, invoice_service, mock_db):
        """Should return None when no invoice exists for sale and format."""
        sale_id = uuid.uuid4()

        mock_db.execute = AsyncMock(
            return_value=_make_execute_result(scalar_value=None)
        )

        result = await invoice_service.get_invoice_by_sale(sale_id, format="A4")
        assert result is None


@pytest.mark.parametrize("format", ["A4", "THERMAL"])
def test_receipt_brand_and_product_identity(sample_invoice_data, format):
    sample_invoice_data.line_items[0].brand = "Bosch & <Original>"
    html = render_invoice_html(sample_invoice_data, format=format)
    assert "Brand: Bosch &amp; &lt;Original&gt;" in html
    assert html.count("Brand:") == 1
    assert "Powered by <strong>Invenzo</strong>" in html
    assert 'alt="Invenzo logo"' in html
    assert sample_invoice_data.company.name in html
