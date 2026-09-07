"""Pydantic schemas for user management endpoints.

Defines request/response models for user CRUD operations (Admin only).

Satisfies Requirements: 2.1, 2.5
"""

from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.models.user import UserRole


def _normalize_identifier(value: Optional[str]) -> Optional[str]:
    """Lowercase and trim a username/email so lookups are case-insensitive.

    Applied at the API boundary so a value is stored and matched in one
    canonical form regardless of how the user typed it. ``None`` passes through
    unchanged for optional fields.
    """
    if value is None:
        return None
    return value.strip().lower()


# =============================================================================
# Request Schemas
# =============================================================================


class PasswordChangeRequest(BaseModel):
    """Request body for PUT /api/v1/users/me/password."""

    current_password: str = Field(
        ...,
        description="The user's current password (required for verification)",
    )
    new_password: str = Field(
        ...,
        min_length=8,
        description="New password (min 8 chars, uppercase, lowercase, digit)",
        examples=["NewSecurePass1!"],
    )


class UserCreate(BaseModel):
    """Request body for POST /api/v1/users (create new user)."""

    username: str = Field(
        ...,
        min_length=3,
        max_length=150,
        description="Unique login username",
        examples=["john_doe"],
    )
    email: EmailStr = Field(
        ...,
        description="Unique email address",
        examples=["john@example.com"],
    )
    password: str = Field(
        ...,
        min_length=8,
        description="Password (min 8 chars, must include uppercase, lowercase, and digit)",
        examples=["SecurePass1"],
    )
    role: UserRole = Field(
        ...,
        description="User role assignment",
        examples=["Salesperson"],
    )
    is_active: bool = Field(
        default=True,
        description="Whether the account is active on creation",
    )

    _normalize_username = field_validator("username")(_normalize_identifier)
    _normalize_email = field_validator("email", mode="before")(_normalize_identifier)


class UserUpdate(BaseModel):
    """Request body for updating a user (partial update)."""

    username: Optional[str] = Field(
        default=None,
        min_length=3,
        max_length=150,
        description="New username",
    )
    email: Optional[EmailStr] = Field(
        default=None,
        description="New email address",
    )
    role: Optional[UserRole] = Field(
        default=None,
        description="New role assignment",
    )
    is_active: Optional[bool] = Field(
        default=None,
        description="Enable or disable the account",
    )

    _normalize_username = field_validator("username")(_normalize_identifier)
    _normalize_email = field_validator("email", mode="before")(_normalize_identifier)


class AdminPasswordReset(BaseModel):
    """Request body for an admin resetting another user's password.

    The admin supplies a temporary password. The user is then forced to change
    it on next login, and any account lockout is cleared. This is distinct from
    self-service password change (which requires the current password) and the
    email-based reset flow (which requires a valid reset token).
    """

    new_password: str = Field(
        ...,
        min_length=8,
        description="Temporary password (min 8 chars, at least one uppercase, one lowercase, and one digit)",
    )


# =============================================================================
# Response Schemas
# =============================================================================


class UserResponse(BaseModel):
    """Response body for a single user."""

    id: UUID = Field(..., description="User unique identifier")
    username: str = Field(..., description="Login username")
    email: str = Field(..., description="Email address")
    role: str = Field(..., description="User role")
    is_active: bool = Field(..., description="Whether the account is active")
    failed_login_attempts: int = Field(..., description="Number of consecutive failed login attempts")
    locked_until: Optional[datetime] = Field(
        default=None,
        description="Account locked until this timestamp (null if not locked)",
    )
    created_at: Optional[datetime] = Field(default=None, description="Record creation timestamp")
    updated_at: Optional[datetime] = Field(default=None, description="Last update timestamp")

    model_config = {"from_attributes": True}


class UserListResponse(BaseModel):
    """Response body for user list with pagination metadata."""

    data: list[UserResponse] = Field(..., description="List of users")
    meta: dict = Field(
        default_factory=lambda: {"page": 1, "total": 0},
        description="Pagination metadata",
    )
