#!/usr/bin/env python3
"""Create a user in the Auto Spare Parts ERP system.

Usage (from inside the backend container):
    python scripts/create_user.py --username admin --password Admin123! --role ADMIN --email admin@example.com

Or with Docker:
    docker exec invenzo-backend python scripts/create_user.py \
        --username admin --password Admin123! --role ADMIN --email admin@example.com

Roles: ADMIN, MANAGER, SALESPERSON, STOREKEEPER
"""

import argparse
import asyncio
import sys
import uuid
from datetime import datetime, timezone

from passlib.context import CryptContext
from sqlalchemy import text

sys.path.insert(0, "/app")
from app.database import async_session_factory

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

VALID_ROLES = ["Admin", "Manager", "Salesperson", "Storekeeper"]


async def create_user(username: str, password: str, email: str, role: str, must_change_password: bool = True) -> None:
    """Create a new user or report if one already exists."""
    role = role.capitalize()
    if role not in VALID_ROLES:
        print(f"Error: Invalid role '{role}'. Must be one of: {', '.join(VALID_ROLES)}")
        sys.exit(1)

    # Normalize username/email so accounts are case-insensitive and match the
    # API's behaviour (login/reset lowercase before lookup).
    username = username.strip().lower()
    email = email.strip().lower()

    async with async_session_factory() as session:
        # Check if username already exists
        result = await session.execute(
            text("SELECT id FROM users WHERE username = :username"),
            {"username": username},
        )
        if result.scalar():
            print(f"User '{username}' already exists. Skipping.")
            return

        # Check if email already exists
        result = await session.execute(
            text("SELECT id FROM users WHERE email = :email"),
            {"email": email},
        )
        if result.scalar():
            print(f"Email '{email}' already in use. Skipping.")
            return

        # Create user
        user_id = uuid.uuid4()
        now = datetime.now(timezone.utc)
        password_hash = pwd_context.hash(password)

        await session.execute(
            text("""
                INSERT INTO users (id, username, email, password_hash, role, is_active, failed_login_attempts, must_change_password, created_at, updated_at)
                VALUES (:id, :username, :email, :password_hash, :role, :is_active, :failed_login_attempts, :must_change_password, :created_at, :updated_at)
            """),
            {
                "id": user_id,
                "username": username,
                "email": email,
                "password_hash": password_hash,
                "role": role,
                "is_active": True,
                "failed_login_attempts": 0,
                "must_change_password": must_change_password,
                "created_at": now,
                "updated_at": now,
            },
        )
        await session.commit()
        print(f"✓ User created successfully")
        print(f"  Username:              {username}")
        print(f"  Email:                 {email}")
        print(f"  Role:                  {role}")
        print(f"  Password:              {password}")
        print(f"  Must change password:  {must_change_password}")
        if must_change_password:
            print(f"  (User will be required to set a new password on first login)")


def main():
    parser = argparse.ArgumentParser(description="Create a user in the ERP system")
    parser.add_argument("--username", "-u", required=True, help="Username for the new user")
    parser.add_argument("--password", "-p", required=True, help="Password (min 8 chars, 1 upper, 1 lower, 1 digit)")
    parser.add_argument("--email", "-e", required=True, help="Email address")
    parser.add_argument("--role", "-r", default="ADMIN", choices=VALID_ROLES, help="User role (default: ADMIN)")
    parser.add_argument(
        "--no-force-change",
        action="store_true",
        default=False,
        help="Skip forced password change on first login (default: user must change password)",
    )

    args = parser.parse_args()
    asyncio.run(create_user(
        args.username,
        args.password,
        args.email,
        args.role,
        must_change_password=not args.no_force_change,
    ))


if __name__ == "__main__":
    main()
