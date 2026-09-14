"""Invoice router for invoice generation and retrieval endpoints.

Provides the following endpoints:
- GET    /api/v1/invoices/{id}/pdf         - Download invoice PDF by ID
- POST   /api/v1/invoices/generate         - Generate invoice for a sale
- GET    /api/v1/invoices/by-sale/{sale_id} - Get invoice by sale ID

Satisfies Requirements: 14.5
"""

from html import escape
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import CurrentUser, DbSession
from app.middleware.auth import require_roles
from app.services.permission_service import require_permission
from app.models.user import User, UserRole
from app.schemas.invoice import InvoiceGenerateRequest, InvoiceResponse
from app.services.invoice_service import (
    InvoiceAlreadyExistsError,
    InvoiceNotFoundError,
    InvoiceService,
    SaleNotConfirmedError,
    SaleNotFoundError,
)

router = APIRouter(prefix="/api/v1/invoices", tags=["Invoices"])


def _get_invoice_service(db: AsyncSession) -> InvoiceService:
    """Create an InvoiceService instance (no business settings — fallback)."""
    return InvoiceService(db=db)


async def _get_invoice_service_with_settings(db: AsyncSession) -> InvoiceService:
    """Create an InvoiceService with business settings loaded from DB."""
    return await InvoiceService.from_db(db)


# =============================================================================
# Endpoints
# =============================================================================


@router.post(
    "/generate",
    response_model=InvoiceResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Generate invoice for a sale",
    description="Generate a PDF invoice for a confirmed sale. Supports A4 and THERMAL formats.",
    responses={
        400: {"description": "Sale not confirmed or validation error"},
        404: {"description": "Sale not found"},
        409: {"description": "Invoice already exists for this sale/format"},
    },
)
async def generate_invoice(
    request: InvoiceGenerateRequest,
    db: DbSession,
    current_user: User = Depends(
        require_permission("invoices")
    ),
) -> InvoiceResponse:
    """Generate a PDF invoice for a confirmed sale.

    Requirements:
    - 14.1: PDF invoices with company logo, details, line items, totals
    - 14.2: Support A4 and thermal formats
    - 14.3: Embed QR code with invoice number and total
    - 14.4: Embed barcode for scanning
    - 14.5: Store generated PDF for future retrieval
    """
    service = await _get_invoice_service_with_settings(db)

    try:
        invoice = await service.generate_invoice_pdf(
            sale_id=request.sale_id,
            format=request.format,
            overwrite=request.overwrite,
        )
        await db.commit()
        await db.refresh(invoice)
        return InvoiceResponse.model_validate(invoice)
    except SaleNotFoundError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )
    except SaleNotConfirmedError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except InvoiceAlreadyExistsError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(e),
        )


@router.get(
    "/by-sale/{sale_id}",
    response_model=InvoiceResponse,
    status_code=status.HTTP_200_OK,
    summary="Get invoice by sale ID",
    description="Retrieve invoice metadata by sale ID and optional format filter.",
    responses={
        404: {"description": "Invoice not found for the given sale"},
    },
)
async def get_invoice_by_sale(
    sale_id: UUID,
    db: DbSession,
    current_user: CurrentUser,
    format: str = Query(default="A4", description="Invoice format: A4 or THERMAL"),
) -> InvoiceResponse:
    """Get invoice metadata by sale ID.

    Requirements:
    - 14.5: Store generated PDF for future retrieval
    """
    service = _get_invoice_service(db)

    invoice = await service.get_invoice_by_sale(sale_id=sale_id, format=format)
    if invoice is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Invoice not found for sale '{sale_id}' in format '{format}'",
        )

    return InvoiceResponse.model_validate(invoice)


@router.get(
    "/{invoice_id}/pdf",
    status_code=status.HTTP_200_OK,
    summary="Download invoice PDF",
    description="Download the PDF file for an invoice by its ID.",
    responses={
        404: {"description": "Invoice not found"},
    },
)
async def download_invoice_pdf(
    invoice_id: UUID,
    db: DbSession,
    current_user: User = Depends(
        require_permission("invoices")
    ),
) -> Response:
    """Download invoice PDF by invoice ID.

    Returns the raw PDF binary with appropriate content-type header
    for browser download/display.

    Requirements:
    - 14.5: Store generated PDF for future retrieval
    """
    service = _get_invoice_service(db)

    try:
        invoice = await service.get_invoice_by_id(invoice_id)
    except InvoiceNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Invoice with ID '{invoice_id}' not found",
        )

    filename = f"invoice_{invoice.invoice_number}.pdf"

    return Response(
        content=invoice.pdf_data,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
        },
    )


@router.post(
    "/credit-note/{sale_id}",
    status_code=status.HTTP_200_OK,
    summary="Generate credit note PDF for a returned sale",
    description="Generate a credit note (refund document) for a sale that has been fully or partially returned.",
    responses={
        400: {"description": "Sale has no returns"},
        404: {"description": "Sale not found"},
    },
)
async def generate_credit_note(
    sale_id: UUID,
    db: DbSession,
    current_user: User = Depends(
        require_permission("invoices")
    ),
) -> Response:
    """Generate a credit note PDF for a returned sale.

    Best practice: original invoice is never modified. A credit note is
    a separate document referencing the original invoice.
    """
    from decimal import Decimal
    from datetime import datetime, timezone
    from sqlalchemy.orm import selectinload
    from app.models.sale import Sale, SaleItem, SaleStatus
    from app.models.spare_part import SparePart
    from app.models.customer import Customer
    from app.models.inventory_movement_ledger import InventoryMovementLedger, MovementType
    from sqlalchemy import func as sa_func

    # Load sale with items
    stmt = (
        select(Sale)
        .filter_by(id=sale_id)
        .options(selectinload(Sale.items).selectinload(SaleItem.spare_part))
    )
    result = await db.execute(stmt)
    sale = result.scalar_one_or_none()

    if sale is None:
        raise HTTPException(status_code=404, detail="Sale not found")

    # Check sale has returns
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
    returned_map = {row.spare_part_id: abs(float(row.total_returned)) for row in return_result}

    if not returned_map and not any(i.external_returned_quantity for i in sale.items):
        raise HTTPException(status_code=400, detail="This sale has no returns. Credit note can only be generated for returned sales.")

    # Get customer name
    customer_name = "Walk-in Customer"
    if sale.customer_id:
        cust_result = await db.execute(select(Customer.name).filter_by(id=sale.customer_id))
        customer_name = cust_result.scalar_one_or_none() or "Walk-in Customer"

    # Load business settings for header
    service = await _get_invoice_service_with_settings(db)
    company = service.company

    # Build credit note items
    credit_items_html = ""
    total_refund = Decimal("0.00")
    for item in sale.items:
        qty_returned = item.external_returned_quantity if item.source_type == "EXTERNAL" else returned_map.get(item.spare_part_id, 0)
        if qty_returned > 0:
            refund_amount = Decimal(str(qty_returned)) * (item.line_total / item.quantity)
            total_refund += refund_amount
            part_name = item.external_description or (item.spare_part.name if item.spare_part else "Unknown")
            part_number = item.external_part_number or (item.spare_part.part_number if item.spare_part else "")
            credit_items_html += f"""
            <tr>
                <td>{escape(part_number)}</td>
                <td>{escape(part_name)}</td>
                <td class="number">{qty_returned:.0f}</td>
                <td class="number">{item.unit_price:,.2f}</td>
                <td class="number">{refund_amount:,.2f}</td>
            </tr>"""

    # Generate credit note HTML
    now = datetime.now(timezone.utc)
    html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Credit Note - {sale.invoice_number}</title>
    <style>
        @page {{ size: A4; margin: 15mm; }}
        body {{ font-family: Arial, sans-serif; font-size: 11pt; color: #333; }}
        .header {{ display: flex; justify-content: space-between; margin-bottom: 20px; border-bottom: 2px solid #c0392b; padding-bottom: 15px; }}
        .company-info h1 {{ margin: 5px 0; font-size: 16pt; color: #333; }}
        .company-info p {{ margin: 2px 0; font-size: 9pt; color: #666; }}
        .credit-note-title {{ text-align: right; }}
        .credit-note-title h2 {{ margin: 0; color: #c0392b; font-size: 24pt; }}
        .credit-note-title p {{ margin: 3px 0; font-size: 10pt; }}
        .details {{ display: flex; justify-content: space-between; margin: 20px 0; }}
        .bill-to h3 {{ margin: 0 0 5px; color: #333; font-size: 10pt; text-transform: uppercase; }}
        table {{ width: 100%; border-collapse: collapse; margin: 20px 0; }}
        th {{ background-color: #c0392b; color: white; padding: 8px 6px; text-align: left; font-size: 9pt; }}
        td {{ padding: 8px 6px; border-bottom: 1px solid #eee; font-size: 10pt; }}
        .number {{ text-align: right; }}
        .totals {{ margin-top: 20px; text-align: right; }}
        .totals table {{ width: 300px; margin-left: auto; }}
        .totals td {{ padding: 5px 8px; }}
        .total-row {{ font-weight: bold; font-size: 14pt; border-top: 2px solid #c0392b; }}
        .footer {{ margin-top: 30px; padding-top: 15px; border-top: 1px solid #eee; font-size: 9pt; color: #666; }}
        .watermark {{ color: #c0392b; font-size: 14pt; font-weight: bold; text-align: center; margin: 10px 0; padding: 8px; border: 2px solid #c0392b; display: inline-block; }}
    </style>
</head>
<body>
    <div class="header">
        <div class="company-info">
            <h1>{company.name}</h1>
            <p>{company.address}</p>
            <p>Phone: {company.phone}</p>
            <p>Email: {company.email}</p>
        </div>
        <div class="credit-note-title">
            <h2>CREDIT NOTE</h2>
            <p><strong>Reference:</strong> CN-{sale.invoice_number}</p>
            <p><strong>Date:</strong> {now.strftime("%Y-%m-%d")}</p>
            <p><strong>Original Invoice:</strong> {sale.invoice_number}</p>
        </div>
    </div>

    <div style="text-align: center; margin: 10px 0;">
        <span class="watermark">REFUND / CREDIT NOTE</span>
    </div>

    <div class="details">
        <div class="bill-to">
            <h3>Credited To</h3>
            <p><strong>{customer_name}</strong></p>
        </div>
        <div>
            <p><strong>Original Sale Date:</strong> {sale.created_at.strftime("%Y-%m-%d")}</p>
            <p><strong>Payment Type:</strong> {sale.payment_type.value if hasattr(sale.payment_type, 'value') else sale.payment_type}</p>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th>Part No.</th>
                <th>Description</th>
                <th class="number">Qty Returned</th>
                <th class="number">Unit Price</th>
                <th class="number">Refund Amount</th>
            </tr>
        </thead>
        <tbody>
            {credit_items_html}
        </tbody>
    </table>

    <div class="totals">
        <table>
            <tr>
                <td>Original Sale Total:</td>
                <td class="number">{sale.total_amount:,.2f}</td>
            </tr>
            <tr class="total-row">
                <td>Total Credit/Refund:</td>
                <td class="number">-{total_refund:,.2f}</td>
            </tr>
        </table>
    </div>

    <div class="footer">
        <p>This credit note confirms the return of goods and corresponding refund/credit against invoice {sale.invoice_number}.</p>
        <p>Generated on {now.strftime("%Y-%m-%d %H:%M")} UTC</p>
    </div>
</body>
</html>"""

    # Convert to PDF
    from app.utils.pdf_generator import html_to_pdf
    pdf_bytes = html_to_pdf(html)

    filename = f"credit_note_CN-{sale.invoice_number}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )
