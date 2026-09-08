"""Add pg_trgm GIN indexes on spare_parts.part_number and name.

The sales list "product sold" filter and the spare-part search use
case-insensitive substring matching (ILIKE '%term%'). A leading-wildcard
ILIKE cannot use a plain btree index, so those queries fall back to a
sequential scan of spare_parts — fine with a handful of parts, but it
degrades as the catalogue grows. A GIN index using the pg_trgm operator
class makes ILIKE '%term%' index-assisted.

Indexes are created on part_number and name (the columns the product filter
matches). CREATE EXTENSION and the GIN builds are wrapped defensively with
IF NOT EXISTS so the migration is safe to re-run.

Revision ID: 0016
Revises: 0015
Create Date: 2025-01-16 00:00:00.000000
"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # pg_trgm provides the gin_trgm_ops operator class used by the indexes.
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_spare_parts_part_number_trgm "
        "ON spare_parts USING gin (part_number gin_trgm_ops)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_spare_parts_name_trgm "
        "ON spare_parts USING gin (name gin_trgm_ops)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_spare_parts_name_trgm")
    op.execute("DROP INDEX IF EXISTS ix_spare_parts_part_number_trgm")
    # Leave the pg_trgm extension in place — other objects may rely on it and
    # dropping an extension is rarely what a downgrade wants.
