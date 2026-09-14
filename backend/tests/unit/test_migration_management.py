"""Tests for Alembic-only schema management and controlled startup execution."""

import ast
import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app import database
from app.config import Settings
from app.migration_runner import run_migrations


BACKEND_ROOT = Path(__file__).parents[2]
VERSIONS_ROOT = BACKEND_ROOT / "alembic" / "versions"
MIGRATION_PATH = VERSIONS_ROOT / "20250107_000000_0007_add_amount_paid_to_sales.py"


def _literal_assignment(path: Path, name: str):
    tree = ast.parse(path.read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target]
        else:
            continue
        if any(isinstance(target, ast.Name) and target.id == name for target in targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f"{name} is not declared in {path}")


def _load_amount_paid_migration():
    spec = importlib.util.spec_from_file_location("migration_0007", MIGRATION_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    # The repository's alembic directory is a package name collision with the
    # installed Alembic package, so provide only the migration operation proxy.
    fake_alembic = types.ModuleType("alembic")
    fake_alembic.op = MagicMock()
    with patch.dict(sys.modules, {"alembic": fake_alembic}):
        spec.loader.exec_module(module)
    return module


def test_migration_chain_is_linear_with_single_head():
    """The migration chain is linear and 0017 is the current head."""
    revisions = {}
    for path in VERSIONS_ROOT.glob("*.py"):
        if path.name == "__init__.py":
            continue
        revision = _literal_assignment(path, "revision")
        revisions[revision] = _literal_assignment(path, "down_revision")

    # Verify the chain is intact up to the previous confirmed head
    assert revisions["0008"] == "0007"
    assert revisions["0009"] == "0008"
    assert revisions["0010"] == "0009"
    assert revisions["0011"] == "0010"
    assert revisions["0012"] == "0011"
    assert revisions["0013"] == "0012"
    assert revisions["0014"] == "0013"
    assert revisions["0015"] == "0014"
    assert revisions["0016"] == "0015"
    assert revisions["0017"] == "0016"

    # There must be exactly one revision that is not a parent of any other —
    # that is the head. Update this assertion whenever a new migration is added.
    parents = {parent for parent in revisions.values() if parent is not None}
    assert {revision for revision in revisions if revision not in parents} == {"0017"}


def test_amount_paid_upgrade_adds_missing_column():
    """A 0006 schema receives the amount_paid column with the model shape."""
    migration = _load_amount_paid_migration()
    operation = MagicMock()
    operation.get_bind.return_value = object()
    migration.op = operation
    with patch.object(migration.sa, "inspect") as inspect:
        inspect.return_value.get_columns.return_value = [{"name": "id"}]
        migration.upgrade()

    operation.add_column.assert_called_once()
    table_name, column = operation.add_column.call_args.args
    assert table_name == "sales"
    assert column.name == "amount_paid"
    assert column.type.precision == 14
    assert column.type.scale == 2
    assert str(column.server_default) == "DefaultClause('0.00', for_update=False)"


def test_amount_paid_upgrade_accepts_existing_startup_patch():
    """A column created by the removed startup patch is not added twice."""
    migration = _load_amount_paid_migration()
    operation = MagicMock()
    operation.get_bind.return_value = object()
    migration.op = operation
    with patch.object(migration.sa, "inspect") as inspect:
        inspect.return_value.get_columns.return_value = [
            {"name": "id"},
            {"name": "amount_paid"},
        ]
        migration.upgrade()

    operation.add_column.assert_not_called()


@pytest.mark.asyncio
async def test_controlled_migration_runner_propagates_success():
    """The runner invokes the installed Alembic command using app settings."""
    settings = Settings(
        database_url="postgresql+asyncpg://postgres:strong-password@db/erp",
        run_migrations_on_startup=True,
    )
    with (
        patch("app.migration_runner.shutil.which", return_value="/usr/bin/alembic"),
        patch("app.migration_runner.subprocess.run") as run,
    ):
        await run_migrations(settings)

    run.assert_called_once()
    command, = run.call_args.args
    assert command == ["/usr/bin/alembic", "upgrade", "head"]
    assert run.call_args.kwargs["cwd"] == BACKEND_ROOT
    assert run.call_args.kwargs["check"] is True
    assert run.call_args.kwargs["env"]["DATABASE_URL"] == settings.database_url


@pytest.mark.asyncio
async def test_init_db_aborts_when_startup_migration_fails(monkeypatch):
    """Enabled startup migrations fail closed instead of serving traffic."""
    monkeypatch.setattr(database, "_import_models", lambda: None)
    monkeypatch.setattr(database.settings, "run_migrations_on_startup", True)
    migration = AsyncMock(side_effect=RuntimeError("migration failed"))
    monkeypatch.setattr(database, "run_migrations", migration)

    with pytest.raises(RuntimeError, match="migration failed"):
        await database.init_db()

    migration.assert_awaited_once_with(database.settings)


def test_database_startup_contains_no_schema_ddl_calls():
    """Runtime initialization must not call create_all or execute inline DDL."""
    source = (BACKEND_ROOT / "app" / "database.py").read_text()
    tree = ast.parse(source)
    called_attributes = {
        node.func.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    }
    assert "create_all" not in called_attributes
    assert "execute" not in called_attributes
    assert "CREATE SEQUENCE" not in source
    assert "ALTER TABLE" not in source
