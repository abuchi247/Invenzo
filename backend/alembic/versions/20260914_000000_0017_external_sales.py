"""Support externally sourced sale items without stock movements."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column("sale_items", "spare_part_id", nullable=True)
    op.add_column("sale_items", sa.Column("source_type", sa.String(20), nullable=False, server_default="STOCK"))
    for name, length in [("external_description", 255), ("external_part_number", 100)]:
        op.add_column("sale_items", sa.Column(name, sa.String(length)))
    op.add_column("sale_items", sa.Column("supplier_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("suppliers.id")))
    op.add_column("sale_items", sa.Column("supplier_unit_cost", sa.Numeric(12, 2)))
    for name in ["supplier_amount_paid", "external_returned_quantity", "supplier_returned_quantity"]:
        op.add_column("sale_items", sa.Column(name, sa.Numeric(14 if name == "supplier_amount_paid" else 12, 2), nullable=False, server_default="0"))
    op.create_check_constraint("ck_sale_items_source", "sale_items", "(source_type = 'STOCK' AND spare_part_id IS NOT NULL AND supplier_id IS NULL AND supplier_unit_cost IS NULL AND supplier_amount_paid = 0) OR (source_type = 'EXTERNAL' AND supplier_id IS NOT NULL AND length(trim(external_description)) > 0 AND external_description IS NOT NULL AND supplier_unit_cost > 0 AND supplier_unit_cost IS NOT NULL AND supplier_amount_paid >= 0 AND supplier_amount_paid <= quantity * supplier_unit_cost)")
    op.create_check_constraint("ck_sale_items_external_returns", "sale_items", "supplier_returned_quantity >= 0 AND supplier_returned_quantity <= external_returned_quantity AND external_returned_quantity <= quantity")


def downgrade():
    # Refuse to erase external sales history during downgrade.
    connection = op.get_bind()
    if connection.execute(sa.text("SELECT 1 FROM sale_items WHERE source_type = 'EXTERNAL' LIMIT 1")).first():
        raise RuntimeError("Cannot downgrade while external sale items exist")
    op.drop_constraint("ck_sale_items_external_returns", "sale_items")
    op.drop_constraint("ck_sale_items_source", "sale_items")
    for name in ["supplier_returned_quantity", "external_returned_quantity", "supplier_amount_paid", "supplier_unit_cost", "supplier_id", "external_part_number", "external_description", "source_type"]:
        op.drop_column("sale_items", name)
    op.alter_column("sale_items", "spare_part_id", nullable=False)
