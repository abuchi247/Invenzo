"""Lowercase existing users.username and users.email for case-insensitive auth.

Login, user creation, and password reset now normalize username/email to
lowercase (trimmed) at the API boundary and in the service lookups. Existing
rows may have been stored in mixed case before that change, so a user created
as ``John`` would no longer be found once login lowercases the input to
``john``. This migration canonicalizes the existing data to match.

To avoid violating the unique indexes (ix_users_username / ix_users_email),
a row is only lowercased when no *different* row already holds the lowercased
value. Any row that WOULD collide is left untouched and reported via a raised
error listing the conflicts, so the operator can resolve the duplicate
manually rather than the migration failing opaquely on a constraint violation.

Revision ID: 0015
Revises: 0014
Create Date: 2025-01-15 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def _detect_collisions(conn, column: str) -> list[str]:
    """Return values whose lowercased form is shared by more than one row.

    These cannot be safely lowercased without breaking the unique index, so we
    surface them for manual resolution instead of failing on a constraint.
    """
    rows = conn.execute(
        sa.text(
            f"""
            SELECT lower({column}) AS lowered, COUNT(*) AS n
            FROM users
            WHERE deleted_at IS NULL
            GROUP BY lower({column})
            HAVING COUNT(*) > 1
            """
        )
    ).fetchall()
    return [r.lowered for r in rows]


def upgrade() -> None:
    conn = op.get_bind()

    # Fail loudly (before mutating anything) if lowercasing would create dupes.
    conflicts = {
        "username": _detect_collisions(conn, "username"),
        "email": _detect_collisions(conn, "email"),
    }
    messages = []
    for column, values in conflicts.items():
        for value in values:
            messages.append(
                f"multiple active users share {column} '{value}' when lowercased"
            )
    if messages:
        raise RuntimeError(
            "Cannot lowercase user identifiers due to case-only duplicates. "
            "Resolve these manually, then re-run the migration:\n  - "
            + "\n  - ".join(messages)
        )

    # Safe to normalize. Only touch rows that actually change, to keep the
    # migration idempotent and minimal.
    conn.execute(
        sa.text(
            "UPDATE users SET username = lower(trim(username)) "
            "WHERE username <> lower(trim(username))"
        )
    )
    conn.execute(
        sa.text(
            "UPDATE users SET email = lower(trim(email)) "
            "WHERE email <> lower(trim(email))"
        )
    )


def downgrade() -> None:
    # Lowercasing is not reversible — the original casing is not retained.
    # This is a data normalization; downgrade is intentionally a no-op.
    pass
