"""Invoice service for generating and storing PDF invoices.

This service handles the complete invoice generation workflow:
1. Loading sale data with items and customer
2. Generating QR code with invoice number and total amount
3. Generating barcode for invoice scanning/lookup
4. Rendering HTML invoice template
5. Converting to PDF via WeasyPrint
6. Storing the generated PDF in the Invoice model

Satisfies Requirements:
- 14.1: PDF invoices with company logo, details, invoice number, date,
         customer details, line items, subtotal, tax, grand total, payment terms, status
- 14.2: Support A4 full-page and thermal receipt (80mm width) formats
- 14.3: Embed QR code containing invoice number and total amount
- 14.4: Embed invoice barcode for scanning and lookup
- 14.5: Store generated PDF for future retrieval
"""

import uuid
import logging
from decimal import Decimal
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.invoice import Invoice, InvoiceFormat
from app.models.sale import Sale, SaleItem
from app.models.customer import Customer
from app.models.spare_part import SparePart
from app.utils.pdf_generator import (
    CompanyDetails,
    CustomerDetails,
    InvoiceData,
    InvoiceLineItem,
    generate_barcode_base64,
    generate_invoice_pdf,
    generate_qr_code_base64,
)

logger = logging.getLogger(__name__)


class SaleNotFoundError(Exception):
    """Raised when the specified sale does not exist."""

    def __init__(self, sale_id: uuid.UUID):
        self.sale_id = sale_id
        self.message = f"Sale with ID '{sale_id}' not found"
        super().__init__(self.message)


class SaleNotConfirmedError(Exception):
    """Raised when attempting to generate invoice for an unconfirmed sale."""

    def __init__(self, sale_id: uuid.UUID, status: str):
        self.sale_id = sale_id
        self.status = status
        self.message = (
            f"Sale '{sale_id}' is in status '{status}', "
            f"but must be CONFIRMED to generate an invoice"
        )
        super().__init__(self.message)


class InvoiceAlreadyExistsError(Exception):
    """Raised when an invoice already exists for the specified sale and format."""

    def __init__(self, sale_id: uuid.UUID, format: str):
        self.sale_id = sale_id
        self.format = format
        self.message = (
            f"Invoice already exists for sale '{sale_id}' in format '{format}'"
        )
        super().__init__(self.message)


class InvoiceNotFoundError(Exception):
    """Raised when the specified invoice does not exist."""

    def __init__(self, invoice_id: uuid.UUID):
        self.invoice_id = invoice_id
        self.message = f"Invoice with ID '{invoice_id}' not found"
        super().__init__(self.message)


class InvoiceService:
    """Service for generating and managing PDF invoices.

    Handles the complete lifecycle of invoice generation:
    - Loading sale with items and customer data
    - Generating QR code and barcode
    - Rendering PDF in A4 or thermal format
    - Storing generated PDF for future retrieval

    Satisfies Requirements 14.1-14.5.
    """

    def __init__(self, db: AsyncSession, company: Optional[CompanyDetails] = None):
        """Initialize the invoice service.

        Args:
            db: Async database session.
            company: Company details to display on invoices.
                     Fetched from business_settings if not provided.
        """
        self.db = db
        self.company = company or CompanyDetails()

    @classmethod
    async def from_db(cls, db: AsyncSession) -> "InvoiceService":
        """Create an InvoiceService with company details loaded from the DB."""
        from sqlalchemy import select as _select
        from app.models.business_settings import BusinessSettings

        result = await db.execute(_select(BusinessSettings).limit(1))
        bs = result.scalar_one_or_none()

        if bs is None:
            return cls(db=db)

        phones = bs.phones if isinstance(bs.phones, list) else []
        bank_accounts = bs.bank_accounts if isinstance(bs.bank_accounts, list) else []

        company = CompanyDetails(
            name=bs.business_name or "My Business",
            address=bs.address or "",
            email=bs.email or "",
            tax_id=bs.tax_id or "",
            logo_base64=bs.logo_base64,
            invoice_footer=bs.invoice_footer,
            phones=phones,
            bank_accounts=bank_accounts,
        )
        return cls(db=db, company=company)

    async def generate_invoice_pdf(
        self,
        sale_id: uuid.UUID,
        format: str = "A4",
        overwrite: bool = False,
    ) -> Invoice:
        """Generate a PDF invoice for a confirmed sale.

        This method:
        1. Loads the sale with items and customer
        2. Validates the sale is confirmed and has an invoice number
        3. Generates QR code (invoice_number|total_amount)
        4. Generates barcode from invoice number
        5. Builds InvoiceData with all details
        6. Renders and converts to PDF
        7. Stores the PDF in the Invoice model

        Args:
            sale_id: UUID of the sale to generate invoice for.
            format: Invoice format - "A4" or "THERMAL".
            overwrite: If True, replace existing invoice for this sale/format.

        Returns:
            The created Invoice model instance with PDF data.

        Raises:
            SaleNotFoundError: If the sale doesn't exist.
            SaleNotConfirmedError: If the sale isn't confirmed.
            InvoiceAlreadyExistsError: If invoice exists and overwrite=False.

        Satisfies Requirements:
        - 14.1: PDF with company logo, details, line items, totals
        - 14.2: A4 and thermal formats
        - 14.3: QR code with invoice number and total
        - 14.4: Barcode for scanning
        - 14.5: Store PDF for retrieval
        """
        # 1. Load the sale with items
        sale = await self._get_sale_with_items(sale_id)
        if sale is None:
            raise SaleNotFoundError(sale_id)

        # 2. Validate sale status
        if sale.status.value != "CONFIRMED":
            raise SaleNotConfirmedError(sale_id, sale.status.value)

        # Ensure invoice number exists
        if not sale.invoice_number:
            raise SaleNotConfirmedError(sale_id, sale.status.value)

        # 3. Check for existing invoice
        invoice_format = InvoiceFormat(format)
        if not overwrite:
            existing = await self._get_existing_invoice(sale_id, invoice_format)
            if existing is not None:
                raise InvoiceAlreadyExistsError(sale_id, format)

        # 4. Generate QR code data
        qr_data = f"{sale.invoice_number}|{sale.total_amount}"
        qr_code_base64 = generate_qr_code_base64(qr_data)

        # 5. Generate barcode
        barcode_svg_base64 = generate_barcode_base64(sale.invoice_number)

        # 6. Load customer details
        customer_details = await self._get_customer_details(sale.customer_id)

        # 7. Build line items
        line_items = await self._build_line_items(sale.items)

        # 8. Determine payment terms
        payment_terms = self._get_payment_terms(sale.payment_type.value)

        # 8b. Resolve who issued the sale (for the "Served by" line)
        salesperson_name = await self._get_salesperson_name(sale.created_by)

        # 9. Calculate amount paid and balance due
        amount_paid = Decimal("0.00")
        if sale.payment_type.value == "CASH":
            amount_paid = sale.total_amount
        elif hasattr(sale, 'amount_paid') and sale.amount_paid:
            amount_paid = sale.amount_paid
        balance_due = sale.total_amount - amount_paid

        # 10. Build InvoiceData
        invoice_data = InvoiceData(
            invoice_number=sale.invoice_number,
            invoice_date=sale.created_at,
            company=self.company,
            customer=customer_details,
            line_items=line_items,
            subtotal=sale.subtotal,
            tax_amount=sale.tax_amount,
            discount_total=sale.discount_total,
            total_amount=sale.total_amount,
            amount_paid=amount_paid,
            balance_due=balance_due,
            payment_type=sale.payment_type.value,
            status=sale.status.value,
            payment_terms=payment_terms,
            qr_code_base64=qr_code_base64,
            barcode_svg=barcode_svg_base64,
            salesperson_name=salesperson_name,
        )

        # 11. Generate PDF
        pdf_bytes = generate_invoice_pdf(invoice_data, format=format)

        # 12. Store invoice
        if overwrite:
            existing = await self._get_existing_invoice(sale_id, invoice_format)
            if existing is not None:
                existing.pdf_data = pdf_bytes
                await self.db.flush()
                return existing

        invoice = Invoice(
            sale_id=sale_id,
            invoice_number=sale.invoice_number,
            pdf_data=pdf_bytes,
            format=invoice_format,
        )
        self.db.add(invoice)
        await self.db.flush()

        return invoice

    async def get_invoice_by_id(self, invoice_id: uuid.UUID) -> Invoice:
        """Retrieve an invoice by its ID.

        Args:
            invoice_id: UUID of the invoice to retrieve.

        Returns:
            The Invoice model instance.

        Raises:
            InvoiceNotFoundError: If the invoice doesn't exist.

        Satisfies Requirement 14.5: Store generated PDF for future retrieval.
        """
        stmt = select(Invoice).filter_by(id=invoice_id)
        result = await self.db.execute(stmt)
        invoice = result.scalar_one_or_none()
        if invoice is None:
            raise InvoiceNotFoundError(invoice_id)
        return invoice

    async def get_invoice_by_sale(
        self,
        sale_id: uuid.UUID,
        format: str = "A4",
    ) -> Optional[Invoice]:
        """Retrieve an invoice by sale ID and format.

        Args:
            sale_id: UUID of the sale.
            format: Invoice format to retrieve ("A4" or "THERMAL").

        Returns:
            The Invoice model instance, or None if not found.

        Satisfies Requirement 14.5: Store generated PDF for future retrieval.
        """
        invoice_format = InvoiceFormat(format)
        return await self._get_existing_invoice(sale_id, invoice_format)

    # -------------------------------------------------------------------------
    # Private Helper Methods
    # -------------------------------------------------------------------------

    async def _get_sale_with_items(self, sale_id: uuid.UUID) -> Optional[Sale]:
        """Load a sale with its items eagerly loaded."""
        stmt = (
            select(Sale)
            .options(selectinload(Sale.items))
            .filter_by(id=sale_id)
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def _get_existing_invoice(
        self,
        sale_id: uuid.UUID,
        format: InvoiceFormat,
    ) -> Optional[Invoice]:
        """Check if an invoice already exists for this sale and format."""
        stmt = select(Invoice).filter_by(sale_id=sale_id, format=format)
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def _get_customer_details(
        self,
        customer_id: Optional[uuid.UUID],
    ) -> CustomerDetails:
        """Load customer details or return default walk-in details."""
        if customer_id is None:
            return CustomerDetails(name="Walk-in Customer")

        stmt = select(Customer).filter_by(id=customer_id)
        result = await self.db.execute(stmt)
        customer = result.scalar_one_or_none()

        if customer is None:
            return CustomerDetails(name="Walk-in Customer")

        return CustomerDetails(
            name=customer.name,
            phone=customer.phone,
            email=customer.email,
            address=customer.address,
            tax_id=customer.tax_id,
        )

    async def _get_salesperson_name(
        self,
        created_by: Optional[str],
    ) -> Optional[str]:
        """Resolve the sale's created_by UUID to a username for the invoice.

        Returns None if there's no creator recorded or the id can't be resolved,
        so the template simply omits the "Served by" line.
        """
        if not created_by:
            return None
        from app.models.user import User
        try:
            creator_uuid = uuid.UUID(str(created_by))
        except (ValueError, TypeError):
            return None
        result = await self.db.execute(
            select(User.username).filter_by(id=creator_uuid)
        )
        return result.scalar_one_or_none()

    async def _build_line_items(
        self,
        sale_items: list[SaleItem],
    ) -> list[InvoiceLineItem]:
        """Build invoice line items from sale items with spare part details."""
        line_items = []

        # Collect spare part IDs for batch lookup
        part_ids = [item.spare_part_id for item in sale_items]

        # Batch query spare parts
        parts_map = {}
        if part_ids:
            stmt = select(SparePart).filter(SparePart.id.in_(part_ids))
            result = await self.db.execute(stmt)
            parts = result.scalars().all()
            parts_map = {part.id: part for part in parts}

        for item in sale_items:
            part = parts_map.get(item.spare_part_id)
            part_number = part.part_number if part else "N/A"
            description = part.name if part else "Unknown Part"

            line_items.append(
                InvoiceLineItem(
                    part_number=part_number,
                    description=description,
                    quantity=item.quantity,
                    unit_price=item.unit_price,
                    discount_amount=item.discount_amount,
                    line_total=item.line_total,
                )
            )

        return line_items

    def _get_payment_terms(self, payment_type: str) -> str:
        """Determine payment terms based on payment type."""
        if payment_type == "CREDIT":
            return "Net 30 days from invoice date"
        return "Due on receipt"
