"""PDF generation utility for invoices using WeasyPrint.

Generates invoice PDFs in A4 (full-page) and thermal receipt (80mm width)
formats. Supports embedding QR codes, barcodes, company logos, line items,
totals, payment terms, and status information.

Satisfies Requirements:
- 14.1: PDF invoices with company logo, details, invoice number, date,
         customer details, line items, subtotal, tax, grand total, payment terms, status
- 14.2: Support A4 full-page and thermal receipt (80mm width) formats
- 14.3: Embed QR code containing invoice number and total amount
- 14.4: Embed invoice barcode for scanning and lookup
"""

import base64
import io
import logging
from dataclasses import dataclass, field
from decimal import Decimal
from datetime import datetime
from typing import Optional

import qrcode
from qrcode.image.pil import PilImage

from app.utils.barcode_generator import generate_barcode_svg

logger = logging.getLogger(__name__)


@dataclass
class CompanyDetails:
    """Company information displayed on invoices."""

    name: str = "Auto Spare Parts Ltd"
    address: str = "123 Industrial Road, Lagos, Nigeria"
    email: str = "info@autospareparts.com"
    tax_id: str = "TIN-12345678"
    logo_base64: Optional[str] = None

    # Multiple phone numbers — list of {"label": str, "number": str}
    phones: list[dict] = field(default_factory=list)

    # Multiple bank accounts — list of {"bank_name": str, "account_number": str, "account_name": str}
    bank_accounts: list[dict] = field(default_factory=list)

    @property
    def phone(self) -> str:
        """Return all phone numbers as a single string for backward-compat templates."""
        if not self.phones:
            return ""
        return "  |  ".join(
            f"{p.get('label', '')}: {p.get('number', '')}" if p.get('label') else p.get('number', '')
            for p in self.phones
        )


@dataclass
class CustomerDetails:
    """Customer information for the invoice."""

    name: str = ""
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    tax_id: Optional[str] = None


@dataclass
class InvoiceLineItem:
    """A single line item on the invoice."""

    part_number: str
    description: str
    quantity: Decimal
    unit_price: Decimal
    discount_amount: Decimal = Decimal("0.00")
    line_total: Decimal = Decimal("0.00")


@dataclass
class InvoiceData:
    """All data needed to render an invoice."""

    invoice_number: str
    invoice_date: datetime
    company: CompanyDetails
    customer: CustomerDetails
    line_items: list[InvoiceLineItem] = field(default_factory=list)
    subtotal: Decimal = Decimal("0.00")
    tax_amount: Decimal = Decimal("0.00")
    discount_total: Decimal = Decimal("0.00")
    total_amount: Decimal = Decimal("0.00")
    amount_paid: Decimal = Decimal("0.00")
    balance_due: Decimal = Decimal("0.00")
    payment_type: str = "CASH"
    status: str = "CONFIRMED"
    payment_terms: str = "Due on receipt"
    qr_code_base64: Optional[str] = None
    barcode_svg: Optional[str] = None
    salesperson_name: Optional[str] = None


def generate_qr_code_base64(data: str) -> str:
    """Generate a QR code image as a base64-encoded PNG string.

    The QR code contains the invoice number and total amount for
    quick verification scanning.

    Args:
        data: The string data to encode in the QR code.
              Format: "{invoice_number}|{total_amount}"

    Returns:
        Base64-encoded PNG image string suitable for embedding in HTML.

    Satisfies Requirement 14.3: Embed QR code containing invoice number
    and total amount.
    """
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=4,
        border=2,
    )
    qr.add_data(data)
    qr.make(fit=True)

    img = qr.make_image(fill_color="black", back_color="white")
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    buffer.seek(0)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def generate_barcode_base64(barcode_value: str) -> str:
    """Generate a barcode SVG as a base64-encoded string for HTML embedding.

    Args:
        barcode_value: The value to encode as a Code 128 barcode.

    Returns:
        Base64-encoded SVG string suitable for embedding in HTML img src.

    Satisfies Requirement 14.4: Embed invoice barcode for scanning and lookup.
    """
    svg_bytes = generate_barcode_svg(barcode_value, include_text=True)
    return base64.b64encode(svg_bytes).decode("utf-8")


def _render_a4_html(data: InvoiceData) -> str:
    """Render invoice HTML template for A4 format.

    Generates a full-page A4 invoice layout with company logo, details,
    customer information, line items table, totals, and payment terms.

    Satisfies Requirements 14.1, 14.2 (A4 format).
    """
    # Build line items rows
    line_items_html = ""
    for i, item in enumerate(data.line_items, 1):
        line_items_html += f"""
        <tr>
            <td>{i}</td>
            <td>{item.part_number}</td>
            <td>{item.description}</td>
            <td class="number">{item.quantity}</td>
            <td class="number">{item.unit_price:,.2f}</td>
            <td class="number">{item.discount_amount:,.2f}</td>
            <td class="number">{item.line_total:,.2f}</td>
        </tr>"""

    # QR code section
    qr_section = ""
    if data.qr_code_base64:
        qr_section = f'<img src="data:image/png;base64,{data.qr_code_base64}" class="qr-code" alt="Invoice QR Code" />'

    # Barcode section
    barcode_section = ""
    if data.barcode_svg:
        barcode_section = f'<img src="data:image/svg+xml;base64,{data.barcode_svg}" class="barcode" alt="Invoice Barcode" />'

    # "Served by" line — only shown when we could resolve the issuing user
    served_by_section = ""
    if data.salesperson_name:
        served_by_section = f"<p><strong>Served by:</strong> {data.salesperson_name}</p>"

    # Company logo section
    logo_section = ""
    if data.company.logo_base64:
        # Extract raw base64 from data URL if present, then build a clean src
        logo_data = data.company.logo_base64
        if logo_data.startswith("data:"):
            # Use the full data URL as-is (already includes mime type and base64)
            logo_src = logo_data
        else:
            logo_src = f"data:image/png;base64,{logo_data}"
        logo_section = f'<img src="{logo_src}" class="logo" alt="{data.company.name}" />'
    else:
        logo_section = f'<div class="logo-text">{data.company.name}</div>'

    # Customer details
    customer_info = f"<strong>{data.customer.name}</strong>"
    if data.customer.address:
        customer_info += f"<br/>{data.customer.address}"
    if data.customer.phone:
        customer_info += f"<br/>Phone: {data.customer.phone}"
    if data.customer.email:
        customer_info += f"<br/>Email: {data.customer.email}"
    if data.customer.tax_id:
        customer_info += f"<br/>Tax ID: {data.customer.tax_id}"

    # Bank accounts section for invoice footer
    bank_accounts_html = ""
    if data.company.bank_accounts:
        rows = "".join(
            f"<tr><td><strong>{ba.get('bank_name','')}</strong></td>"
            f"<td>{ba.get('account_number','')}</td>"
            f"<td>{ba.get('account_name','')}</td></tr>"
            for ba in data.company.bank_accounts
        )
        bank_accounts_html = f"""
        <div class="bank-details">
            <h4>Bank Details</h4>
            <table class="bank-table">
                <thead><tr><th>Bank</th><th>Account No.</th><th>Account Name</th></tr></thead>
                <tbody>{rows}</tbody>
            </table>
        </div>"""

    html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Invoice {data.invoice_number}</title>
    <style>
        @page {{
            size: A4;
            margin: 15mm;
        }}
        body {{
            font-family: Arial, Helvetica, sans-serif;
            font-size: 11pt;
            color: #333;
            margin: 0;
            padding: 0;
        }}
        .header {{
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 20px;
            border-bottom: 2px solid #2c3e50;
            padding-bottom: 15px;
        }}
        .company-info {{
            flex: 1;
        }}
        .company-info h1 {{
            margin: 0 0 5px 0;
            color: #2c3e50;
            font-size: 18pt;
        }}
        .company-info p {{
            margin: 2px 0;
            font-size: 9pt;
            color: #666;
        }}
        .logo {{
            max-width: 120px;
            max-height: 60px;
        }}
        .logo-text {{
            font-size: 18pt;
            font-weight: bold;
            color: #2c3e50;
        }}
        .invoice-title {{
            text-align: right;
        }}
        .invoice-title h2 {{
            margin: 0;
            color: #2c3e50;
            font-size: 24pt;
        }}
        .invoice-title p {{
            margin: 3px 0;
            font-size: 10pt;
        }}
        .status-badge {{
            display: inline-block;
            padding: 3px 10px;
            border-radius: 3px;
            font-size: 9pt;
            font-weight: bold;
            color: white;
            background-color: #27ae60;
        }}
        .status-DRAFT {{ background-color: #f39c12; }}
        .status-CONFIRMED {{ background-color: #27ae60; }}
        .status-RETURNED {{ background-color: #e74c3c; }}
        .status-CANCELLED {{ background-color: #95a5a6; }}
        .parties {{
            display: flex;
            justify-content: space-between;
            margin: 20px 0;
        }}
        .bill-to {{
            flex: 1;
        }}
        .bill-to h3 {{
            margin: 0 0 5px 0;
            color: #2c3e50;
            font-size: 10pt;
            text-transform: uppercase;
        }}
        .items-table {{
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
        }}
        .items-table th {{
            background-color: #2c3e50;
            color: white;
            padding: 8px 6px;
            text-align: left;
            font-size: 9pt;
        }}
        .items-table td {{
            padding: 8px 6px;
            border-bottom: 1px solid #eee;
            font-size: 10pt;
        }}
        .items-table tr:nth-child(even) {{
            background-color: #f9f9f9;
        }}
        .number {{
            text-align: right;
        }}
        .totals {{
            margin-left: auto;
            width: 280px;
            margin-top: 10px;
        }}
        .totals table {{
            width: 100%;
            border-collapse: collapse;
        }}
        .totals td {{
            padding: 5px 8px;
            font-size: 10pt;
        }}
        .totals .total-row {{
            font-weight: bold;
            font-size: 12pt;
            border-top: 2px solid #2c3e50;
        }}
        .footer {{
            margin-top: 30px;
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
        }}
        .payment-terms {{
            font-size: 9pt;
            color: #666;
        }}
        .payment-terms h4 {{
            margin: 0 0 5px 0;
            color: #2c3e50;
        }}
        .bank-details {{
            margin-top: 12px;
        }}
        .bank-details h4 {{
            margin: 0 0 4px 0;
            color: #2c3e50;
            font-size: 9pt;
        }}
        .bank-table {{
            border-collapse: collapse;
            font-size: 8.5pt;
        }}
        .bank-table th {{
            background: #ecf0f1;
            padding: 3px 8px;
            text-align: left;
            border: 1px solid #ddd;
        }}
        .bank-table td {{
            padding: 3px 8px;
            border: 1px solid #ddd;
        }}
        .codes {{
            text-align: right;
        }}
        .qr-code {{
            width: 80px;
            height: 80px;
        }}
        .barcode {{
            width: 180px;
            height: 50px;
            margin-top: 5px;
        }}
    </style>
</head>
<body>
    <div class="header">
        <div class="company-info">
            {logo_section}
            <h1>{data.company.name}</h1>
            <p>{data.company.address}</p>
            <p>Phone: {data.company.phone}</p>
            <p>Email: {data.company.email}</p>
            <p>Tax ID: {data.company.tax_id}</p>
        </div>
        <div class="invoice-title">
            <h2>INVOICE</h2>
            <p><strong>Invoice #:</strong> {data.invoice_number}</p>
            <p><strong>Date:</strong> {data.invoice_date.strftime("%Y-%m-%d")}</p>
            <p><strong>Payment:</strong> {data.payment_type}</p>
            {served_by_section}
            <p><span class="status-badge status-{data.status}">{data.status}</span></p>
        </div>
    </div>

    <div class="parties">
        <div class="bill-to">
            <h3>Bill To</h3>
            {customer_info}
        </div>
    </div>

    <table class="items-table">
        <thead>
            <tr>
                <th>#</th>
                <th>Part No.</th>
                <th>Description</th>
                <th class="number">Qty</th>
                <th class="number">Unit Price</th>
                <th class="number">Discount</th>
                <th class="number">Total</th>
            </tr>
        </thead>
        <tbody>
            {line_items_html}
        </tbody>
    </table>

    <div class="totals">
        <table>
            <tr>
                <td>Subtotal:</td>
                <td class="number">{data.subtotal:,.2f}</td>
            </tr>
            <tr>
                <td>Discount:</td>
                <td class="number">-{data.discount_total:,.2f}</td>
            </tr>
            <tr>
                <td>Tax:</td>
                <td class="number">{data.tax_amount:,.2f}</td>
            </tr>
            <tr class="total-row">
                <td>Grand Total:</td>
                <td class="number">{data.total_amount:,.2f}</td>
            </tr>
            <tr>
                <td>Amount Paid:</td>
                <td class="number">{data.amount_paid:,.2f}</td>
            </tr>
            <tr class="total-row" style="color: {'#c0392b' if data.balance_due > 0 else '#27ae60'};">
                <td>Balance Due:</td>
                <td class="number">{data.balance_due:,.2f}</td>
            </tr>
        </table>
    </div>

    <div class="footer">
        <div class="payment-terms">
            <h4>Payment Terms</h4>
            <p>{data.payment_terms}</p>
            <p style="margin-top: 10px; font-size: 8pt;">Thank you for your business!</p>
            {bank_accounts_html}
        </div>
        <div class="codes">
            {qr_section}
            {barcode_section}
        </div>
    </div>
</body>
</html>"""
    return html


def _render_thermal_html(data: InvoiceData) -> str:
    """Render invoice HTML template for thermal receipt (80mm width) format.

    Generates a compact receipt-style layout optimized for 80mm thermal
    printers with essential information in a narrow column format.

    Satisfies Requirements 14.1, 14.2 (THERMAL format).
    """
    # Build line items
    line_items_html = ""
    for item in data.line_items:
        line_items_html += f"""
        <div class="item">
            <div class="item-name">{item.description}</div>
            <div class="item-details">
                <span>{item.quantity} x {item.unit_price:,.2f}</span>
                <span class="item-total">{item.line_total:,.2f}</span>
            </div>
        </div>"""

    # QR code section (smaller for thermal)
    qr_section = ""
    if data.qr_code_base64:
        qr_section = f'<img src="data:image/png;base64,{data.qr_code_base64}" class="qr-code" alt="QR Code" />'

    # Barcode section (smaller for thermal)
    barcode_section = ""
    if data.barcode_svg:
        barcode_section = f'<img src="data:image/svg+xml;base64,{data.barcode_svg}" class="barcode" alt="Barcode" />'

    # Thermal logo section
    thermal_logo_section = ""
    if data.company.logo_base64:
        logo_src = data.company.logo_base64
        if not logo_src.startswith("data:"):
            logo_src = f"data:image/png;base64,{logo_src}"
        thermal_logo_section = f'<img src="{logo_src}" style="width:50px;height:50px;margin:0 auto 5px;display:block;object-fit:contain;" alt="Logo" />'

    # "Served by" line (compact) — only when the issuing user is known
    thermal_served_by = (
        f"<div>Served by: {data.salesperson_name}</div>"
        if data.salesperson_name
        else ""
    )

    # Thermal bank accounts (compact)
    thermal_bank_html = ""
    if data.company.bank_accounts:
        lines = "".join(
            f"<p>{ba.get('bank_name','')} | {ba.get('account_number','')} | {ba.get('account_name','')}</p>"
            for ba in data.company.bank_accounts
        )
        thermal_bank_html = f"<div style='margin-top:4px;text-align:left;'><strong>Bank Details:</strong>{lines}</div>"

    html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Receipt {data.invoice_number}</title>
    <style>
        @page {{
            size: 80mm auto;
            margin: 3mm;
        }}
        body {{
            font-family: 'Courier New', monospace;
            font-size: 9pt;
            color: #000;
            margin: 0;
            padding: 0;
            width: 74mm;
        }}
        .center {{
            text-align: center;
        }}
        .header {{
            text-align: center;
            margin-bottom: 8px;
            border-bottom: 1px dashed #000;
            padding-bottom: 8px;
        }}
        .header h1 {{
            margin: 0;
            font-size: 12pt;
        }}
        .header p {{
            margin: 1px 0;
            font-size: 8pt;
        }}
        .invoice-info {{
            margin: 5px 0;
            font-size: 8pt;
        }}
        .divider {{
            border-top: 1px dashed #000;
            margin: 5px 0;
        }}
        .item {{
            margin: 3px 0;
        }}
        .item-name {{
            font-size: 8pt;
            font-weight: bold;
        }}
        .item-details {{
            display: flex;
            justify-content: space-between;
            font-size: 8pt;
        }}
        .item-total {{
            font-weight: bold;
        }}
        .totals {{
            margin-top: 5px;
            border-top: 1px dashed #000;
            padding-top: 5px;
        }}
        .totals .row {{
            display: flex;
            justify-content: space-between;
            font-size: 9pt;
        }}
        .totals .grand-total {{
            font-weight: bold;
            font-size: 11pt;
            border-top: 1px solid #000;
            padding-top: 3px;
            margin-top: 3px;
        }}
        .footer {{
            margin-top: 8px;
            text-align: center;
            border-top: 1px dashed #000;
            padding-top: 5px;
            font-size: 8pt;
        }}
        .qr-code {{
            width: 60px;
            height: 60px;
            margin: 5px auto;
            display: block;
        }}
        .barcode {{
            width: 70mm;
            height: 30px;
            margin: 3px auto;
            display: block;
        }}
        .status {{
            font-weight: bold;
            font-size: 8pt;
        }}
    </style>
</head>
<body>
    <div class="header">
        {thermal_logo_section}
        <h1>{data.company.name}</h1>
        <p>{data.company.address}</p>
        <p>Tel: {data.company.phone}</p>
        <p>Tax ID: {data.company.tax_id}</p>
    </div>

    <div class="invoice-info">
        <div>Invoice: {data.invoice_number}</div>
        <div>Date: {data.invoice_date.strftime("%Y-%m-%d %H:%M")}</div>
        <div>Customer: {data.customer.name or "Walk-in"}</div>
        <div>Payment: {data.payment_type}</div>
        {thermal_served_by}
        <div class="status">Status: {data.status}</div>
    </div>

    <div class="divider"></div>

    <div class="items">
        {line_items_html}
    </div>

    <div class="totals">
        <div class="row">
            <span>Subtotal:</span>
            <span>{data.subtotal:,.2f}</span>
        </div>
        <div class="row">
            <span>Discount:</span>
            <span>-{data.discount_total:,.2f}</span>
        </div>
        <div class="row">
            <span>Tax:</span>
            <span>{data.tax_amount:,.2f}</span>
        </div>
        <div class="row grand-total">
            <span>TOTAL:</span>
            <span>{data.total_amount:,.2f}</span>
        </div>
        <div class="row">
            <span>Paid:</span>
            <span>{data.amount_paid:,.2f}</span>
        </div>
        <div class="row" style="font-weight:bold;">
            <span>Balance Due:</span>
            <span>{data.balance_due:,.2f}</span>
        </div>
    </div>

    <div class="footer">
        <p>Terms: {data.payment_terms}</p>
        {thermal_bank_html}
        {qr_section}
        {barcode_section}
        <p>Thank you for your business!</p>
    </div>
</body>
</html>"""
    return html


def render_invoice_html(data: InvoiceData, format: str = "A4") -> str:
    """Render invoice data to HTML string based on format.

    Args:
        data: InvoiceData containing all invoice information.
        format: Either "A4" for full-page or "THERMAL" for 80mm receipt.

    Returns:
        HTML string ready for PDF conversion.

    Satisfies Requirement 14.2: Support A4 full-page and thermal receipt formats.
    """
    if format == "THERMAL":
        return _render_thermal_html(data)
    return _render_a4_html(data)


def html_to_pdf(html_content: str) -> bytes:
    """Convert HTML string to PDF bytes using WeasyPrint.

    Falls back to returning HTML bytes if WeasyPrint is not available
    (e.g., in test environments without system dependencies).

    Args:
        html_content: Complete HTML document string.

    Returns:
        PDF bytes if WeasyPrint is available, otherwise HTML bytes as fallback.
    """
    try:
        from weasyprint import HTML
        pdf_bytes = HTML(string=html_content).write_pdf()
        return pdf_bytes
    except (ImportError, OSError) as e:
        # WeasyPrint requires system libraries (cairo, pango, etc.)
        # Fall back to storing HTML as bytes if unavailable
        logger.warning(
            f"WeasyPrint not available, falling back to HTML bytes: {e}"
        )
        return html_content.encode("utf-8")


def generate_invoice_pdf(data: InvoiceData, format: str = "A4") -> bytes:
    """Generate a complete invoice PDF from invoice data.

    This is the main entry point for PDF generation. It:
    1. Renders the invoice HTML template based on format
    2. Converts the HTML to PDF using WeasyPrint

    Args:
        data: Complete InvoiceData with all fields populated.
        format: "A4" for full-page or "THERMAL" for 80mm receipt.

    Returns:
        PDF bytes ready for storage or download.

    Satisfies Requirements:
    - 14.1: PDF invoices with all required details
    - 14.2: Support A4 and thermal formats
    - 14.3: QR code embedded (via data.qr_code_base64)
    - 14.4: Barcode embedded (via data.barcode_svg)
    """
    html_content = render_invoice_html(data, format=format)
    return html_to_pdf(html_content)
