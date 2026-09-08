"""
Sales service implementing sales transaction logic.

Handles the sales lifecycle: create, confirm, return.
The service implements a state machine:
  DRAFT → CONFIRMED (on confirm)
  CONFIRMED → RETURNED (on return)
  DRAFT → CANCELLED (on cancel)

Satisfies:
- Requirement 5.1: Create a sale with customer, location, and line items
- Requirement 5.2: Reduce stock at selling location via ledger entries
- Requirement 5.6: Reject if quantity exceeds available stock
- Requirement 5.7: Calculate line_total = (quantity × unit_price) - discount_amount
- Requirement 5.8: Support sales returns reversing inventory and financial entries
- Requirement 5.9: Acquire pessimistic lock on stock records before validation
- Requirement 5.10: Stock validation and deduction in same transaction
- Requirement 5.11: Only one concurrent transaction succeeds for same stock
- Requirement 5.12: Return creates new Cost_Layer using original sale item's unit cost
- Requirement 5.13: Return Cost_Layer timestamp = return processing date (not original)
- Requirement 5.14: Never modify or re-open previously consumed/closed Cost_Layers
"""

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cost_layer import CostLayer
from app.models.inventory_movement_ledger import InventoryMovementLedger, MovementType
from app.models.sale import Sale, SaleItem, SaleStatus, PaymentType
from app.models.stock_status_cache import StockStatusCache
from app.utils.fifo import consume_fifo_layers
from app.utils.invoice_number import generate_invoice_number
from app.utils.ledger import record_inventory_movement


# =============================================================================
# Custom Exceptions
# =============================================================================


class SaleNotFoundError(Exception):
    """Raised when the specified sale does not exist."""

    def __init__(self, sale_id: uuid.UUID):
        self.sale_id = sale_id
        super().__init__(f"Sale with id '{sale_id}' not found")


class InvalidSaleStatusError(Exception):
    """Raised when a sale operation is attempted on an invalid status."""

    def __init__(self, sale_id: uuid.UUID, current_status: str, expected_status: str):
        self.sale_id = sale_id
        self.current_status = current_status
        self.expected_status = expected_status
        super().__init__(
            f"Sale '{sale_id}' is in '{current_status}' status, "
            f"expected '{expected_status}'"
        )


class InsufficientStockError(Exception):
    """Raised when selling location doesn't have enough stock."""

    def __init__(
        self,
        spare_part_id: uuid.UUID,
        location_id: uuid.UUID,
        requested: Decimal,
        available: Decimal,
    ):
        self.spare_part_id = spare_part_id
        self.location_id = location_id
        self.requested = requested
        self.available = available
        super().__init__(
            f"Insufficient stock for part '{spare_part_id}' at location '{location_id}'. "
            f"Requested: {requested}, Available: {available}"
        )


class SaleHasNoItemsError(Exception):
    """Raised when attempting to confirm a sale with no line items."""

    def __init__(self, sale_id: uuid.UUID):
        self.sale_id = sale_id
        super().__init__(f"Sale '{sale_id}' has no items and cannot be confirmed")


class ReturnQuantityExceededError(Exception):
    """Raised when a return request exceeds the returnable quantity."""

    def __init__(self, sale_id: uuid.UUID, detail: str):
        self.sale_id = sale_id
        self.detail = detail
        super().__init__(detail)


# =============================================================================
# Sales Service
# =============================================================================


class SalesService:
    """Service managing sales transactions.

    All mutating methods expect the caller to manage the transaction
    boundary (i.e., call commit or use `async with db.begin()`).
    """

    def __init__(self, db: AsyncSession, user_id: Optional[uuid.UUID] = None):
        self.db = db
        self.user_id = user_id

    # -------------------------------------------------------------------------
    # Create Sale
    # -------------------------------------------------------------------------

    async def create_sale(
        self,
        customer_id: Optional[uuid.UUID],
        location_id: uuid.UUID,
        payment_type: PaymentType = PaymentType.CASH,
        items: Optional[list[dict]] = None,
        amount_paid: Optional[Decimal] = None,
    ) -> Sale:
        """Create a new sale in DRAFT status.

        Args:
            customer_id: Optional customer UUID (None for walk-in).
            location_id: UUID of the selling location.
            payment_type: CASH or CREDIT.
            items: Optional list of item dicts with spare_part_id, quantity,
                   unit_price, and optional discount_amount.
            amount_paid: Optional amount paid at checkout (partial payment for credit).

        Returns:
            The newly created Sale record in DRAFT status.
        """
        sale = Sale(
            customer_id=customer_id,
            location_id=location_id,
            status=SaleStatus.DRAFT,
            payment_type=payment_type,
            subtotal=Decimal("0.00"),
            tax_amount=Decimal("0.00"),
            total_amount=Decimal("0.00"),
            discount_total=Decimal("0.00"),
            amount_paid=amount_paid or Decimal("0.00"),
            created_by=str(self.user_id) if self.user_id else None,
        )
        self.db.add(sale)
        await self.db.flush()

        if items:
            for item_data in items:
                quantity = Decimal(str(item_data["quantity"]))
                unit_price = Decimal(str(item_data["unit_price"]))
                discount_amount = Decimal(str(item_data.get("discount_amount", "0.00")))
                line_total = (quantity * unit_price) - discount_amount

                sale_item = SaleItem(
                    sale_id=sale.id,
                    spare_part_id=item_data["spare_part_id"],
                    quantity=quantity,
                    unit_price=unit_price,
                    discount_amount=discount_amount,
                    line_total=line_total,
                )
                self.db.add(sale_item)

            await self.db.flush()

        return sale

    # -------------------------------------------------------------------------
    # Confirm Sale
    # -------------------------------------------------------------------------

    async def confirm_sale(self, sale_id: uuid.UUID) -> Sale:
        """Confirm a DRAFT sale: validate stock, consume FIFO, record ledger.

        Steps:
        1. Validate sale is in DRAFT status with at least one item
        2. For each item: acquire pessimistic lock on cache, validate stock,
           consume FIFO layers, record ledger entry
        3. Generate sequential invoice number via PostgreSQL sequence
        4. Update sale totals and status

        Args:
            sale_id: UUID of the sale to confirm.

        Returns:
            The confirmed Sale with CONFIRMED status.

        Raises:
            SaleNotFoundError: If sale doesn't exist.
            InvalidSaleStatusError: If sale is not DRAFT.
            SaleHasNoItemsError: If sale has no line items.
            InsufficientStockError: If stock is insufficient.
        """
        sale = await self._get_sale_with_items(sale_id)

        if sale.status != SaleStatus.DRAFT:
            raise InvalidSaleStatusError(
                sale_id=sale_id,
                current_status=sale.status.value if isinstance(sale.status, SaleStatus) else str(sale.status),
                expected_status=SaleStatus.DRAFT.value,
            )

        if not sale.items:
            raise SaleHasNoItemsError(sale_id)

        total_discount = Decimal("0.00")
        subtotal = Decimal("0.00")

        for item in sale.items:
            # Acquire pessimistic lock on the cache row
            stmt = (
                select(StockStatusCache)
                .filter_by(
                    spare_part_id=item.spare_part_id,
                    location_id=sale.location_id,
                )
                .with_for_update()
            )
            result = await self.db.execute(stmt)
            cache = result.scalar_one_or_none()

            available = cache.current_quantity if cache else Decimal("0")
            if available < item.quantity:
                raise InsufficientStockError(
                    spare_part_id=item.spare_part_id,
                    location_id=sale.location_id,
                    requested=item.quantity,
                    available=available,
                )

            # Consume FIFO layers
            total_cogs, _ = await consume_fifo_layers(
                db=self.db,
                spare_part_id=item.spare_part_id,
                location_id=sale.location_id,
                quantity_to_consume=item.quantity,
            )

            # Set COGS on the item
            item.cost_of_goods_sold = total_cogs

            # Recalculate line total
            item.line_total = (item.quantity * item.unit_price) - item.discount_amount

            # Record SALE movement in ledger
            avg_unit_cost = total_cogs / item.quantity if item.quantity else Decimal("0")
            await record_inventory_movement(
                db=self.db,
                spare_part_id=item.spare_part_id,
                location_id=sale.location_id,
                quantity_change=-item.quantity,
                movement_type=MovementType.SALE.value,
                reference_type="sale",
                reference_id=sale.id,
                unit_cost=avg_unit_cost,
                created_by=self.user_id,
            )

            subtotal += item.line_total
            total_discount += item.discount_amount

        # Generate sequential invoice number via PostgreSQL sequence
        sale.invoice_number = await generate_invoice_number(self.db)

        # Update totals
        sale.subtotal = subtotal
        sale.discount_total = total_discount
        sale.total_amount = subtotal + sale.tax_amount
        sale.status = SaleStatus.CONFIRMED

        # For cash sales, mark as fully paid
        if sale.payment_type == PaymentType.CASH:
            sale.amount_paid = sale.total_amount

        # Validate amount_paid doesn't exceed total
        if (sale.amount_paid or Decimal("0")) > sale.total_amount:
            sale.amount_paid = sale.total_amount

        # Record credit ledger entry for credit sales with credit limit validation
        if sale.payment_type == PaymentType.CREDIT and sale.customer_id:
            from app.models.customer import Customer
            from app.services.credit_ledger_service import CreditLedgerService, CreditLimitExceededError

            # Credit amount = total minus any partial payment at checkout
            credit_amount = sale.total_amount - (sale.amount_paid or Decimal("0.00"))

            if credit_amount > Decimal("0.00"):
                # Acquire pessimistic lock on customer record for credit limit validation
                cust_stmt = (
                    select(Customer)
                    .filter_by(id=sale.customer_id)
                    .with_for_update()
                )
                cust_result = await self.db.execute(cust_stmt)
                customer = cust_result.scalar_one_or_none()

                if customer:
                    credit_service = CreditLedgerService(db=self.db)
                    await credit_service.record_debit(
                        customer_id=sale.customer_id,
                        amount=credit_amount,
                        reference_type="sale",
                        reference_id=sale.id,
                        created_by=self.user_id,
                        notes=f"Credit sale {sale.invoice_number}" + (f" (paid {sale.amount_paid} at checkout)" if sale.amount_paid and sale.amount_paid > Decimal("0") else ""),
                        credit_limit=customer.credit_limit,
                    )

        # Trigger low stock notifications for items that fell below minimum
        await self._check_low_stock_alerts(sale)

        await self.db.flush()
        return sale

    # -------------------------------------------------------------------------
    # Return Sale
    # -------------------------------------------------------------------------

    async def return_sale(
        self,
        sale_id: uuid.UUID,
        returned_by: uuid.UUID,
        return_items: Optional[list[dict]] = None,
        return_location_id: Optional[uuid.UUID] = None,
    ) -> Sale:
        """Process a sales return, creating new cost layers and ledger entries.

        This method implements the return flow:
        1. Validate the sale is in CONFIRMED status
        2. For each sale item being returned:
           a. Create a NEW CostLayer at the sale's location with:
              - unit_cost = original sale item's unit_price (cost basis)
              - original_quantity = return quantity
              - remaining_quantity = return quantity
              - source_type = "return"
              - source_reference_id = sale.id
              - created_at = NOW() (return processing date, NOT original receipt date)
           b. Record RETURN movement via record_inventory_movement (positive qty)
        3. Update sale status to RETURNED

        Key rules:
        - NEVER modify or re-open previously consumed/closed cost layers (Req 5.14)
        - New cost layer timestamp = return processing date (Req 5.13)
        - Cost layer unit_cost comes from the original sale item's cost basis (Req 5.12)

        Args:
            sale_id: UUID of the sale to return.
            returned_by: UUID of the user processing the return.
            return_items: Optional list of dicts specifying which items to return
                and quantities. Each dict should have:
                - sale_item_id: UUID of the sale item
                - quantity: Decimal quantity to return
                If None, all items in the sale are returned in full.
            return_location_id: Optional UUID of the location to return items to.
                Defaults to the original sale location if not specified.

        Returns:
            The updated Sale record with RETURNED status.

        Raises:
            SaleNotFoundError: If sale doesn't exist.
            InvalidSaleStatusError: If sale is not CONFIRMED.
        """
        sale = await self._get_sale_with_items(sale_id)

        if sale.status != SaleStatus.CONFIRMED:
            raise InvalidSaleStatusError(
                sale_id=sale_id,
                current_status=sale.status.value if isinstance(sale.status, SaleStatus) else str(sale.status),
                expected_status=SaleStatus.CONFIRMED.value,
            )

        # Determine which items and quantities to return
        # First, query the ledger for previously returned quantities for this sale
        from sqlalchemy import func as sa_func
        prev_return_stmt = (
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
        prev_result = await self.db.execute(prev_return_stmt)
        previously_returned = {
            row.spare_part_id: row.total_returned
            for row in prev_result
        }

        try:
            items_to_return = self._resolve_return_items(sale, return_items, previously_returned)
        except ValueError as e:
            raise ReturnQuantityExceededError(
                sale_id=sale_id,
                detail=str(e),
            )

        # Process each return item
        # Resolve the return location: use provided return_location_id or default to sale's location
        effective_return_location = return_location_id or sale.location_id

        for sale_item, return_quantity in items_to_return:
            # Determine the unit cost for the new cost layer.
            # Use the COGS-derived unit cost if available (COGS / quantity gives
            # the actual average cost consumed during the sale). If not available,
            # fall back to the sale item's unit_price.
            if sale_item.cost_of_goods_sold is not None and sale_item.quantity > 0:
                unit_cost = sale_item.cost_of_goods_sold / sale_item.quantity
            else:
                unit_cost = sale_item.unit_price

            # Create a NEW CostLayer at the return location
            # created_at will be set by BaseModel default to NOW() (Req 5.13)
            new_layer = CostLayer(
                spare_part_id=sale_item.spare_part_id,
                location_id=effective_return_location,
                unit_cost=unit_cost,
                original_quantity=return_quantity,
                remaining_quantity=return_quantity,
                source_type="return",
                source_reference_id=sale.id,
            )
            self.db.add(new_layer)
            await self.db.flush()

            # Record RETURN movement in the ledger (positive quantity = inflow)
            await record_inventory_movement(
                db=self.db,
                spare_part_id=sale_item.spare_part_id,
                location_id=effective_return_location,
                quantity_change=return_quantity,
                movement_type=MovementType.RETURN.value,
                reference_type="sale",
                reference_id=sale.id,
                unit_cost=unit_cost,
                created_by=returned_by,
            )

        # Update sale status — only mark as RETURNED if ALL items are fully returned
        total_sold = sum(Decimal(str(item.quantity)) for item in sale.items)
        total_previously_returned = sum(previously_returned.values())
        total_returned_now = sum(qty for _, qty in items_to_return)
        total_all_returned = total_previously_returned + total_returned_now
        if total_all_returned >= total_sold:
            sale.status = SaleStatus.RETURNED
        # Otherwise keep as CONFIRMED (partial return)

        # Record credit ledger reversal for credit sales (reduces customer balance)
        if sale.payment_type == PaymentType.CREDIT and sale.customer_id:
            from app.models.customer_credit_ledger import CustomerCreditLedger, CreditTransactionType

            # Calculate total refund value for the items being returned now
            refund_amount = Decimal("0.00")
            for sale_item, return_quantity in items_to_return:
                refund_amount += return_quantity * sale_item.unit_price

            if refund_amount > Decimal("0.00"):
                # Build reason summary from return items
                reasons = []
                for sale_item, return_quantity in items_to_return:
                    # Find the reason from the return_items dict list
                    item_reason = None
                    if return_items:
                        for ri in return_items:
                            if ri.get("sale_item_id") == sale_item.id:
                                item_reason = ri.get("reason")
                                break
                    if item_reason:
                        reasons.append(item_reason)

                notes = f"Return on {sale.invoice_number}"
                if reasons:
                    notes += f" — {'; '.join(reasons)}"

                credit_entry = CustomerCreditLedger(
                    customer_id=sale.customer_id,
                    transaction_type=CreditTransactionType.RETURN.value,
                    amount=-refund_amount,
                    reference_type="sale",
                    reference_id=sale.id,
                    notes=notes,
                    created_by=returned_by,
                )
                self.db.add(credit_entry)

        await self.db.flush()
        return sale

    # -------------------------------------------------------------------------
    # Private Helpers
    # -------------------------------------------------------------------------

    async def _get_sale_with_items(self, sale_id: uuid.UUID) -> Sale:
        """Retrieve a sale with its items (and each item's spare_part) loaded.

        Eager-loads SaleItem.spare_part so callers can serialize the sale into
        SaleResponse (which nests spare_part) without triggering a lazy load —
        lazy I/O is not allowed in async SQLAlchemy and raises MissingGreenlet.
        """
        from sqlalchemy.orm import selectinload
        stmt = (
            select(Sale)
            .filter_by(id=sale_id)
            .options(selectinload(Sale.items).selectinload(SaleItem.spare_part))
        )
        result = await self.db.execute(stmt)
        sale = result.scalar_one_or_none()

        if sale is None:
            raise SaleNotFoundError(sale_id)

        return sale

    async def _check_low_stock_alerts(self, sale: Sale) -> None:
        """Check if any items in the sale have fallen below minimum stock level.

        Triggers low stock notifications for items where the current stock
        (after the sale deduction) is below the spare part's min_stock_level.
        """
        try:
            from app.models.spare_part import SparePart
            from app.services.notification_service import NotificationService

            for item in sale.items:
                # Get current stock from cache (already updated by record_inventory_movement)
                cache_stmt = (
                    select(StockStatusCache)
                    .filter_by(
                        spare_part_id=item.spare_part_id,
                        location_id=sale.location_id,
                    )
                )
                cache_result = await self.db.execute(cache_stmt)
                cache = cache_result.scalar_one_or_none()

                if not cache:
                    continue

                # Get the spare part's min_stock_level
                part_stmt = select(SparePart).filter_by(id=item.spare_part_id)
                part_result = await self.db.execute(part_stmt)
                part = part_result.scalar_one_or_none()

                if not part or not part.min_stock_level:
                    continue

                # Check if stock fell below minimum
                if cache.current_quantity < Decimal(str(part.min_stock_level)):
                    notification_service = NotificationService(db=self.db)
                    await notification_service.trigger_low_stock_alert(
                        spare_part_id=item.spare_part_id,
                        location_id=sale.location_id,
                        current_qty=cache.current_quantity,
                        min_qty=Decimal(str(part.min_stock_level)),
                    )
        except Exception:
            # Don't fail the sale if notification fails
            pass

    def _resolve_return_items(
        self,
        sale: Sale,
        return_items: Optional[list[dict]],
        previously_returned: dict[uuid.UUID, Decimal] = None,
    ) -> list[tuple[SaleItem, Decimal]]:
        """Resolve which sale items and quantities are being returned.

        Args:
            sale: The sale with items loaded.
            return_items: Optional explicit return specification. If None,
                all items are returned in full.
            previously_returned: Dict mapping sale_item spare_part_id to qty already returned.

        Returns:
            List of (SaleItem, return_quantity) tuples.

        Raises:
            ValueError: If return quantity exceeds remaining returnable quantity.
        """
        if previously_returned is None:
            previously_returned = {}

        if return_items is None:
            # Return all items in full (minus already returned)
            resolved = []
            for item in sale.items:
                already_returned = previously_returned.get(item.spare_part_id, Decimal("0"))
                remaining = item.quantity - already_returned
                if remaining > 0:
                    resolved.append((item, remaining))
            return resolved

        # Build lookup by sale_item_id
        items_by_id = {item.id: item for item in sale.items}
        resolved = []

        for return_spec in return_items:
            sale_item_id = return_spec["sale_item_id"]
            quantity = Decimal(str(return_spec["quantity"]))

            if sale_item_id in items_by_id:
                sale_item = items_by_id[sale_item_id]
                already_returned = previously_returned.get(sale_item.spare_part_id, Decimal("0"))
                max_returnable = sale_item.quantity - already_returned

                if max_returnable <= 0:
                    raise ValueError(
                        f"All units of this item have already been returned"
                    )

                # Cap return quantity at remaining returnable amount
                actual_return_qty = min(quantity, max_returnable)
                if quantity > max_returnable:
                    raise ValueError(
                        f"Cannot return {quantity} units. Only {max_returnable} remaining "
                        f"(sold: {sale_item.quantity}, already returned: {already_returned})"
                    )
                resolved.append((sale_item, actual_return_qty))

        return resolved
