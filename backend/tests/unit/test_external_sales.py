"""External sales must never become owned stock or lose supplier liabilities."""
import uuid
from decimal import Decimal as D
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select, func

from app.models.sale import Sale, SaleItem, SaleStatus, PaymentType
from app.models.supplier import Supplier
from app.models.supplier_ledger import SupplierLedger
from app.models.inventory_movement_ledger import InventoryMovementLedger
from app.models.cost_layer import CostLayer
from app.schemas.sale import SaleItemCreate, ExternalSupplierReturnRequest
from app.schemas.supplier import SupplierPaymentRequest
from app.services.sales_service import SalesService, InvalidSaleStatusError, ReturnQuantityExceededError
from app.services.supplier_service import SupplierService
from app.routers.sales import accept_external_supplier_return
from app.routers.suppliers import record_supplier_payment
from types import SimpleNamespace


@pytest.fixture
async def db_session():
    # Only the tables exercised here; unrelated settings use PostgreSQL JSONB.
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from app.database import Base
    from app.models.category import Category
    from app.models.spare_part import SparePart
    from app.models.stock_status_cache import StockStatusCache
    engine = create_async_engine('sqlite+aiosqlite:///:memory:')
    tables = [model.__table__ for model in (Sale, SaleItem, Supplier, SupplierLedger, SparePart, Category, StockStatusCache, CostLayer, InventoryMovementLedger)]
    async with engine.begin() as connection:
        await connection.run_sync(lambda conn: Base.metadata.create_all(conn, tables=tables))
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        yield session
    await engine.dispose()


def payload(**overrides):
    return dict(source_type='EXTERNAL', external_description='Brake assembly',
        supplier_id=uuid.uuid4(), supplier_unit_cost=D('40'), supplier_amount_paid=D('20'),
        quantity=D('2'), unit_price=D('50'), discount_amount=D('4'), **overrides)


@pytest.mark.parametrize('field,value', [
    ('external_description', ' '), ('supplier_id', None), ('supplier_unit_cost', 0),
    ('supplier_amount_paid', 81), ('source_type', 'STOCK'), ('discount_amount', 101),
])
def test_external_input_validation(field, value):
    data = payload(); data[field] = value
    with pytest.raises(ValidationError):
        SaleItemCreate(**data)


@pytest.mark.asyncio
async def test_external_sale_payment_returns_and_retry(db_session):
    user = SimpleNamespace(id=uuid.uuid4())
    supplier = Supplier(name='Neighbour store', account_status='active', payment_terms='Net 7')
    db_session.add(supplier); await db_session.flush()
    service = SalesService(db_session, user.id)
    data = payload(); data['supplier_id'] = supplier.id
    data = SaleItemCreate(**data).model_dump()
    sale = await service.create_sale(None, uuid.uuid4(), items=[data])
    await db_session.commit()
    assert await SupplierService(db_session).calculate_balance(supplier.id) == 0
    with patch('app.services.sales_service.generate_invoice_number', AsyncMock(return_value='INV-EXTERNAL-1')), \
         patch('app.services.sales_service.consume_fifo_layers', AsyncMock()) as fifo, \
         patch('app.services.sales_service.record_inventory_movement', AsyncMock()) as movement:
        sale = await service.confirm_sale(sale.id)
        await db_session.commit()
        assert sale.total_amount == D('96')
        assert sale.amount_paid == D('96')
        assert sale.items[0].cost_of_goods_sold == D('80')
        assert await SupplierService(db_session).calculate_balance(supplier.id) == D('60')
        fifo.assert_not_awaited(); movement.assert_not_awaited()
        with pytest.raises(InvalidSaleStatusError):
            await service.confirm_sale(sale.id)
        assert await db_session.scalar(select(func.count()).select_from(SupplierLedger)) == 2

        item = sale.items[0]
        await service.return_sale(sale.id, user.id, [{'sale_item_id': item.id, 'quantity': D('1')}])
        await db_session.commit()
        assert item.external_returned_quantity == 1
        assert sale.status == SaleStatus.CONFIRMED
        assert await SupplierService(db_session).calculate_balance(supplier.id) == D('60')
        await accept_external_supplier_return(sale.id, item.id, ExternalSupplierReturnRequest(quantity=1), db_session, user)
        assert await SupplierService(db_session).calculate_balance(supplier.id) == D('20')
        with pytest.raises(HTTPException):
            await accept_external_supplier_return(sale.id, item.id, ExternalSupplierReturnRequest(quantity=1), db_session, user)
        payment = SupplierPaymentRequest(amount=20, reference_id=uuid.uuid4(), notes='Bank transfer')
        first = await record_supplier_payment(supplier.id, payment, db_session, user)
        second = await record_supplier_payment(supplier.id, payment, db_session, user)
        assert first == second
        assert await SupplierService(db_session).calculate_balance(supplier.id) == D('0')
        with pytest.raises(HTTPException) as overpayment:
            await record_supplier_payment(
                supplier.id,
                SupplierPaymentRequest(amount=1, reference_id=uuid.uuid4(), notes='Overpayment'),
                db_session,
                user,
            )
        assert overpayment.value.status_code == 422
        assert await SupplierService(db_session).calculate_balance(supplier.id) == D('0')
        await service.return_sale(sale.id, user.id)
        await db_session.commit()
        assert sale.status == SaleStatus.RETURNED
        assert item.external_returned_quantity == 2
        movement.assert_not_awaited()
    assert await db_session.scalar(select(func.count()).select_from(CostLayer)) == 0
    assert await db_session.scalar(select(func.count()).select_from(InventoryMovementLedger)) == 0


@pytest.mark.asyncio
async def test_two_external_items_return_independently(db_session):
    user_id = uuid.uuid4()
    supplier = Supplier(name='Store', account_status='active'); db_session.add(supplier); await db_session.flush()
    data = payload(); data['supplier_id'] = supplier.id
    service = SalesService(db_session, user_id)
    sale = await service.create_sale(None, uuid.uuid4(), items=[SaleItemCreate(**data).model_dump(), SaleItemCreate(**data).model_dump()])
    with patch('app.services.sales_service.generate_invoice_number', AsyncMock(return_value='INV-EXTERNAL-2')):
        sale = await service.confirm_sale(sale.id)
    await db_session.commit()
    first, second = sale.items
    with pytest.raises(ReturnQuantityExceededError):
        await service.return_sale(sale.id, user_id, [{'sale_item_id': first.id, 'quantity': 1}] * 2)
    await service.return_sale(sale.id, user_id, [{'sale_item_id': first.id, 'quantity': 2}])
    await db_session.commit()
    assert first.external_returned_quantity == 2
    assert second.external_returned_quantity == 0
    assert sale.status == SaleStatus.CONFIRMED
    with pytest.raises(ReturnQuantityExceededError):
        await service.return_sale(sale.id, user_id, [{'sale_item_id': second.id, 'quantity': 3}])


def test_customer_return_request_uses_existing_contract():
    from app.schemas.sale import SaleReturnRequest
    request = SaleReturnRequest(items=[{"sale_item_id": uuid.uuid4(), "quantity": 1, "reason": "Wrong part"}])
    assert request.items[0].quantity == 1


@pytest.mark.asyncio
async def test_mixed_sale_only_consumes_owned_stock(db_session, factory):
    from app.models.stock_status_cache import StockStatusCache
    from app.services.invoice_service import InvoiceService
    part = factory.create_spare_part()
    part.category_id = uuid.uuid4()
    supplier = Supplier(name='Other store', account_status='active')
    db_session.add_all([part, supplier]); await db_session.flush()
    location_id = uuid.uuid4()
    db_session.add(factory.create_stock_status_cache(part.id, location_id, D('5')))
    await db_session.flush()
    data = payload(); data['supplier_id'] = supplier.id; data['spare_part_id'] = part.id
    service = SalesService(db_session, uuid.uuid4())
    sale = await service.create_sale(None, location_id, items=[
        SaleItemCreate(spare_part_id=part.id, quantity=1, unit_price=20).model_dump(),
        SaleItemCreate(**data).model_dump(),
    ])
    with patch('app.services.sales_service.generate_invoice_number', AsyncMock(return_value='INV-MIXED')), \
         patch('app.services.sales_service.consume_fifo_layers', AsyncMock(return_value=(D('10'), []))) as fifo, \
         patch('app.services.sales_service.record_inventory_movement', AsyncMock()) as movement:
        sale = await service.confirm_sale(sale.id)
        assert sale.total_amount == D('116')
        fifo.assert_awaited_once(); movement.assert_awaited_once()
        assert movement.call_args.kwargs['quantity_change'] == -1
    invoice = await InvoiceService(db_session)._build_line_items(sale.items)
    assert {line.description for line in invoice} == {part.name, 'Brake assembly'}
