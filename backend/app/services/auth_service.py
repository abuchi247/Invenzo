"""
Authentication service implementing login, token management, password reset,
and account lockout logic.

Satisfies Requirements:
- 2.2: JWT access + refresh token on login
- 2.3: Refresh without re-entering credentials
- 2.4: Time-limited password reset token
- 2.5: Password complexity (min 8, uppercase, lowercase, digit)
- 2.7: bcrypt with cost factor 12
- 2.8: Lock account after 5 failed attempts in 15 min (30-min lockout)
- 17.3: Session registry tracking active refresh tokens per user
- 17.4: Invalidate refresh token on logout and remove from session registry
- 17.5: Record login history (timestamp, IP, user agent, success/failure)
- 17.6: Admin session revocation (invalidate all refresh tokens for a user)
"""

import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import quote

import bcrypt
from jose import JWTError, jwt
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.models.user import User, UserRole
from app.services.password_reset_service import PasswordResetJobQueue
from app.services.session_service import SessionService


# =============================================================================
# Password Utilities
# =============================================================================

def hash_password(password: str, settings: Optional[Settings] = None) -> str:
    """Hash a password using bcrypt with cost factor 12 (Requirement 2.7).

    Args:
        password: Plain-text password to hash.
        settings: Optional settings override for testing.

    Returns:
        bcrypt hash string.
    """
    if settings is None:
        settings = get_settings()
    salt = bcrypt.gensalt(rounds=settings.bcrypt_cost_factor)
    hashed = bcrypt.hashpw(password.encode("utf-8"), salt)
    return hashed.decode("utf-8")


def verify_password(plain_password: str, hashed_password: str, settings: Optional[Settings] = None) -> bool:
    """Verify a plain-text password against a bcrypt hash.

    Args:
        plain_password: The password to verify.
        hashed_password: The stored bcrypt hash.
        settings: Optional settings override for testing.

    Returns:
        True if the password matches the hash.
    """
    return bcrypt.checkpw(
        plain_password.encode("utf-8"),
        hashed_password.encode("utf-8"),
    )


def validate_password_complexity(password: str) -> tuple[bool, str]:
    """Validate password meets complexity requirements (Requirement 2.5).

    Requirements:
    - Minimum 8 characters
    - At least one uppercase letter
    - At least one lowercase letter
    - At least one digit

    Args:
        password: The password to validate.

    Returns:
        Tuple of (is_valid, error_message). error_message is empty if valid.
    """
    if len(password) < 8:
        return False, "Password must be at least 8 characters long"
    if not re.search(r"[A-Z]", password):
        return False, "Password must contain at least one uppercase letter"
    if not re.search(r"[a-z]", password):
        return False, "Password must contain at least one lowercase letter"
    if not re.search(r"\d", password):
        return False, "Password must contain at least one digit"
    return True, ""


# =============================================================================
# JWT Token Utilities
# =============================================================================

def create_access_token(
    user_id: str,
    role: str,
    settings: Optional[Settings] = None,
) -> str:
    """Create a short-lived JWT access token (Requirement 2.2).

    Payload includes:
    - sub: user_id (UUID string)
    - role: user role
    - type: "access"
    - exp: expiration timestamp
    - iat: issued-at timestamp
    - jti: unique token ID

    Args:
        user_id: The user's UUID as a string.
        role: The user's role.
        settings: Optional settings override.

    Returns:
        Encoded JWT access token string.
    """
    if settings is None:
        settings = get_settings()

    now = datetime.now(timezone.utc)
    expire = now + timedelta(minutes=settings.jwt_access_token_expire_minutes)

    payload: dict[str, Any] = {
        "sub": str(user_id),
        "role": role,
        "type": "access",
        "exp": expire,
        "iat": now,
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def create_refresh_token(
    user_id: str,
    settings: Optional[Settings] = None,
) -> str:
    """Create a long-lived JWT refresh token (Requirement 2.3).

    Payload includes:
    - sub: user_id (UUID string)
    - type: "refresh"
    - exp: expiration timestamp
    - iat: issued-at timestamp
    - jti: unique token ID for revocation tracking

    Args:
        user_id: The user's UUID as a string.
        settings: Optional settings override.

    Returns:
        Encoded JWT refresh token string.
    """
    if settings is None:
        settings = get_settings()

    now = datetime.now(timezone.utc)
    expire = now + timedelta(days=settings.jwt_refresh_token_expire_days)

    payload: dict[str, Any] = {
        "sub": str(user_id),
        "type": "refresh",
        "exp": expire,
        "iat": now,
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def decode_token(token: str, settings: Optional[Settings] = None) -> dict[str, Any]:
    """Decode and validate a JWT token.

    Args:
        token: The JWT token string.
        settings: Optional settings override.

    Returns:
        The decoded payload dictionary.

    Raises:
        JWTError: If the token is invalid or expired.
    """
    if settings is None:
        settings = get_settings()
    return jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])


def create_password_reset_token(
    user_id: str,
    settings: Optional[Settings] = None,
) -> str:
    """Create a time-limited password reset token (Requirement 2.4).

    The token expires in 1 hour and includes the user_id and a type marker.

    Args:
        user_id: The user's UUID as a string.
        settings: Optional settings override.

    Returns:
        Encoded JWT reset token string.
    """
    if settings is None:
        settings = get_settings()

    now = datetime.now(timezone.utc)
    expire = now + timedelta(hours=1)

    payload: dict[str, Any] = {
        "sub": str(user_id),
        "type": "password_reset",
        "exp": expire,
        "iat": now,
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def create_password_change_token(
    user_id: str,
    settings: Optional[Settings] = None,
) -> str:
    """Create a short-lived token scoped only to the force-change-password endpoint.

    Issued when a user authenticates successfully but has must_change_password=True.
    This token cannot be used as a regular access token; its type claim restricts
    it to the password change operation only.

    Args:
        user_id: The user's UUID as a string.
        settings: Optional settings override.

    Returns:
        Encoded JWT token string with type="password_change".
    """
    if settings is None:
        settings = get_settings()

    now = datetime.now(timezone.utc)
    # Short-lived: 10 minutes to complete the password change
    expire = now + timedelta(minutes=10)

    payload: dict[str, Any] = {
        "sub": str(user_id),
        "type": "password_change",
        "exp": expire,
        "iat": now,
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


# =============================================================================
# Auth Service - Main Service Class
# =============================================================================

class AuthService:
    """Authentication service handling login, refresh, logout, and password reset.

    This service encapsulates all authentication business logic including
    account lockout, token generation, password management, session registry
    management, and login history recording.
    """

    def __init__(
        self,
        db: AsyncSession,
        settings: Optional[Settings] = None,
        session_service: Optional[SessionService] = None,
        password_reset_queue: Optional[PasswordResetJobQueue] = None,
    ):
        """Initialize the auth service.

        Args:
            db: Async SQLAlchemy session for database operations.
            settings: Application settings (defaults to singleton).
            session_service: Session registry service for token tracking.
                             If None, session registry features are disabled.
        """
        self.db = db
        self.settings = settings or get_settings()
        self.session_service = session_service
        self.password_reset_queue = password_reset_queue

    async def login(
        self,
        username: str,
        password: str,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
    ) -> dict[str, Any]:
        """Authenticate a user and issue tokens (Requirements 2.2, 2.8, 17.3, 17.5).

        Implements account lockout: after 5 failed attempts within 15 minutes,
        the account is locked for 30 minutes.

        Records login attempt in history and registers session in Redis on success.

        Args:
            username: The user's login username.
            password: The plain-text password.
            ip_address: Client IP address for login history.
            user_agent: Client user agent for login history.

        Returns:
            Dict with access_token, refresh_token, and token_type on success.

        Raises:
            AuthenticationError: If credentials are invalid or account is locked.
        """
        # Normalize so login is case-insensitive regardless of caller. The API
        # schema also normalizes; this guards direct/service-level callers.
        username = username.strip().lower()

        # Look up user by username
        result = await self.db.execute(
            select(User).filter_by(username=username, deleted_at=None)
        )
        user = result.scalar_one_or_none()

        if user is None:
            # Record failed login attempt (user not found)
            if self.session_service:
                await self.session_service.record_login_attempt(
                    username=username,
                    success=False,
                    ip_address=ip_address,
                    user_agent=user_agent,
                    failure_reason="User not found",
                )
            raise AuthenticationError("Invalid username or password")

        # Check if account is inactive
        if not user.is_active:
            if self.session_service:
                await self.session_service.record_login_attempt(
                    username=username,
                    success=False,
                    user_id=user.id,
                    ip_address=ip_address,
                    user_agent=user_agent,
                    failure_reason="Account inactive",
                )
            raise AuthenticationError("Account is inactive")

        # Check if account is currently locked (Requirement 2.8)
        if user.is_locked:
            if self.session_service:
                await self.session_service.record_login_attempt(
                    username=username,
                    success=False,
                    user_id=user.id,
                    ip_address=ip_address,
                    user_agent=user_agent,
                    failure_reason="Account locked",
                )
            raise AccountLockedError(
                "Account is locked due to too many failed login attempts. "
                "Please try again later."
            )

        # Verify password
        if not verify_password(password, user.password_hash, self.settings):
            await self._handle_failed_login(user)
            if self.session_service:
                await self.session_service.record_login_attempt(
                    username=username,
                    success=False,
                    user_id=user.id,
                    ip_address=ip_address,
                    user_agent=user_agent,
                    failure_reason="Invalid password",
                )
            raise AuthenticationError("Invalid username or password")

        # Successful login: reset failed attempts and the sliding window
        user.failed_login_attempts = 0
        user.first_failed_login_at = None
        user.locked_until = None
        await self.db.flush()

        # Check if user must change their password before accessing the system
        if user.must_change_password:
            password_change_token = create_password_change_token(
                user_id=str(user.id),
                settings=self.settings,
            )
            # Record successful authentication (but access not yet granted)
            if self.session_service:
                await self.session_service.record_login_attempt(
                    username=username,
                    success=True,
                    user_id=user.id,
                    ip_address=ip_address,
                    user_agent=user_agent,
                )
            return {
                "password_change_required": True,
                "password_change_token": password_change_token,
                "message": "Password change required before first access",
            }

        # Generate tokens
        access_token = create_access_token(
            user_id=str(user.id),
            role=user.role,
            settings=self.settings,
        )
        refresh_token = create_refresh_token(
            user_id=str(user.id),
            settings=self.settings,
        )

        # Register session in Redis (Requirement 17.3)
        if self.session_service:
            # Extract JTI from the refresh token
            refresh_payload = decode_token(refresh_token, self.settings)
            jti = refresh_payload.get("jti", "")
            await self.session_service.register_session(
                user_id=str(user.id),
                jti=jti,
                ip_address=ip_address,
                user_agent=user_agent,
            )

            # Record successful login
            await self.session_service.record_login_attempt(
                username=username,
                success=True,
                user_id=user.id,
                ip_address=ip_address,
                user_agent=user_agent,
            )

        return {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_type": "bearer",
        }

    async def refresh_token(
        self,
        refresh_token_str: str,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
    ) -> dict[str, Any]:
        """Issue new tokens from a valid refresh token (Requirements 2.3, 17.3, 17.4).

        Validates the refresh token against the session registry before issuing
        new tokens. The old session is removed and a new one is registered.

        Args:
            refresh_token_str: The current refresh token.
            ip_address: Client IP address for session metadata.
            user_agent: Client user agent for session metadata.

        Returns:
            Dict with new access_token, refresh_token, and token_type.

        Raises:
            AuthenticationError: If the refresh token is invalid, expired, or revoked.
        """
        try:
            payload = decode_token(refresh_token_str, self.settings)
        except JWTError:
            raise AuthenticationError("Invalid or expired refresh token")

        if payload.get("type") != "refresh":
            raise AuthenticationError("Invalid token type")

        user_id = payload.get("sub")
        if user_id is None:
            raise AuthenticationError("Invalid token payload")

        # Validate token against session registry (Requirement 17.3)
        old_jti = payload.get("jti", "")
        if self.session_service:
            is_valid = await self.session_service.is_session_valid(user_id, old_jti)
            if not is_valid:
                raise AuthenticationError("Token has been revoked")

        # Verify user still exists and is active
        result = await self.db.execute(
            select(User).filter_by(id=user_id, deleted_at=None)
        )
        user = result.scalar_one_or_none()

        if user is None or not user.is_active:
            raise AuthenticationError("User not found or inactive")

        # Issue new token pair
        access_token = create_access_token(
            user_id=str(user.id),
            role=user.role,
            settings=self.settings,
        )
        new_refresh_token = create_refresh_token(
            user_id=str(user.id),
            settings=self.settings,
        )

        # Rotate session in registry: remove old, register new
        if self.session_service:
            await self.session_service.remove_session(user_id, old_jti)
            new_payload = decode_token(new_refresh_token, self.settings)
            new_jti = new_payload.get("jti", "")
            await self.session_service.register_session(
                user_id=user_id,
                jti=new_jti,
                ip_address=ip_address,
                user_agent=user_agent,
            )

        return {
            "access_token": access_token,
            "refresh_token": new_refresh_token,
            "token_type": "bearer",
        }

    async def logout(self, refresh_token_str: str) -> dict[str, str]:
        """Invalidate a refresh token (logout) (Requirement 17.4).

        Removes the token's JTI from the session registry in Redis,
        effectively preventing any further use of this refresh token.

        Args:
            refresh_token_str: The refresh token to invalidate.

        Returns:
            Dict with a success message.

        Raises:
            AuthenticationError: If the token is invalid.
        """
        try:
            payload = decode_token(refresh_token_str, self.settings)
        except JWTError:
            raise AuthenticationError("Invalid refresh token")

        if payload.get("type") != "refresh":
            raise AuthenticationError("Invalid token type")

        user_id = payload.get("sub")
        jti = payload.get("jti", "")

        # Remove session from registry (Requirement 17.4)
        if self.session_service and user_id:
            await self.session_service.remove_session(user_id, jti)

        return {"message": "Successfully logged out"}

    async def request_password_reset(self, email: str) -> dict[str, str]:
        """Request a reset link without revealing whether an account exists.

        Existing users receive a delivery job containing the reset URL. Unknown
        users follow the same response path and receive the same message, so
        the endpoint cannot be used for email enumeration.
        """
        generic_message = "If the email exists, a reset link will be sent"
        # Normalize so reset matches regardless of the case the email was typed.
        email = email.strip().lower()
        result = await self.db.execute(
            select(User).filter_by(email=email, deleted_at=None)
        )
        user = result.scalar_one_or_none()

        if user is not None:
            reset_token = create_password_reset_token(
                user_id=str(user.id),
                settings=self.settings,
            )
            reset_url = (
                f"{self.settings.frontend_base_url.rstrip('/')}/"
                f"{self.settings.password_reset_path.lstrip('/')}?token={quote(reset_token)}"
            )
            if self.password_reset_queue is not None:
                await self.password_reset_queue.enqueue(
                    "password_reset_email",
                    {"recipient": user.email, "reset_url": reset_url},
                )

        return {"message": generic_message}

    async def reset_password(self, reset_token: str, new_password: str) -> dict[str, str]:
        """Reset a user's password using a valid reset token (Requirement 2.4).

        Args:
            reset_token: The password reset JWT token.
            new_password: The new password (must meet complexity requirements).

        Returns:
            Dict with a success message.

        Raises:
            AuthenticationError: If the reset token is invalid or expired.
            PasswordValidationError: If the new password doesn't meet requirements.
        """
        # Validate password complexity
        is_valid, error_msg = validate_password_complexity(new_password)
        if not is_valid:
            raise PasswordValidationError(error_msg)

        # Decode and validate the reset token. jose validates the signature and
        # exp claim; the explicit claim checks reject structurally valid JWTs
        # intended for another token flow or missing one-time-use metadata.
        try:
            payload = decode_token(reset_token, self.settings)
        except (JWTError, TypeError, ValueError):
            raise AuthenticationError("Invalid or expired reset token")

        if payload.get("type") != "password_reset":
            raise AuthenticationError("Invalid token type")

        user_id = payload.get("sub")
        jti = payload.get("jti")
        exp = payload.get("exp")
        if not user_id or not jti or not exp:
            raise AuthenticationError("Invalid token payload")
        try:
            uuid.UUID(str(user_id))
            uuid.UUID(str(jti))
            expires_at = datetime.fromtimestamp(float(exp), tz=timezone.utc)
        except (TypeError, ValueError, OverflowError):
            raise AuthenticationError("Invalid token payload")

        # Claim the JTI before changing the password. Redis SET NX is atomic,
        # preventing two concurrent confirmations from both succeeding.
        if self.session_service is not None:
            token_claimed = await self.session_service.consume_password_reset_token(
                str(jti), expires_at
            )
            if not token_claimed:
                raise AuthenticationError("Reset token has already been used")

        # Find user
        result = await self.db.execute(
            select(User).filter_by(id=user_id, deleted_at=None)
        )
        user = result.scalar_one_or_none()

        if user is None:
            raise AuthenticationError("User not found")

        # Update password
        user.password_hash = hash_password(new_password, self.settings)
        # Reset lockout state on password reset
        user.failed_login_attempts = 0
        user.first_failed_login_at = None
        user.locked_until = None
        await self.db.flush()

        # Password changes invalidate every active refresh session, not just
        # the session that submitted the reset request.
        if self.session_service is not None:
            await self.session_service.revoke_all_sessions(str(user.id))

        return {"message": "Password reset successfully"}

    async def admin_reset_password(
        self,
        user_id: str,
        new_password: str,
        performed_by: Optional[str] = None,
    ) -> dict[str, str]:
        """Admin-driven reset of another user's password (Requirement 2.4).

        Used when a user has forgotten their password and cannot use the
        self-service email flow. The admin sets a temporary password, which the
        user is forced to change on their next login (must_change_password=True).

        Security properties (best practice for an admin-issued temporary
        credential):
        - The new password must meet complexity requirements.
        - must_change_password is set so the temporary password is single-use;
          the user must choose their own on first login.
        - Any lockout is cleared (failed_login_attempts=0, locked_until=None) so
          a locked-out user who forgot their password is recovered in one step.
        - All of the target user's active sessions are revoked, so any attacker
          holding a live session is immediately logged out.

        This method does NOT require the target user's current password — it is
        an administrative action, gated by the user_management permission at the
        router layer. It must never be exposed as a self-service endpoint.

        Args:
            user_id: UUID of the user whose password is being reset.
            new_password: The new temporary password (complexity-validated).
            performed_by: UUID of the admin performing the reset (for audit).

        Returns:
            Dict with a success message.

        Raises:
            PasswordValidationError: If the new password fails complexity.
            AuthenticationError: If the target user does not exist.
        """
        is_valid, error_msg = validate_password_complexity(new_password)
        if not is_valid:
            raise PasswordValidationError(error_msg)

        result = await self.db.execute(
            select(User).filter_by(id=user_id, deleted_at=None)
        )
        user = result.scalar_one_or_none()

        if user is None:
            raise AuthenticationError("User not found")

        user.password_hash = hash_password(new_password, self.settings)
        # Force the user to set their own password on next login.
        user.must_change_password = True
        # Recover any lockout state in the same action.
        user.failed_login_attempts = 0
        user.first_failed_login_at = None
        user.locked_until = None
        if performed_by:
            user.updated_by = performed_by
        await self.db.flush()

        # Revoke every active session for the target user so a stale/attacker
        # session cannot continue after the reset.
        if self.session_service is not None:
            await self.session_service.revoke_all_sessions(str(user.id))

        return {"message": "Password reset successfully"}

    async def _handle_failed_login(self, user: User) -> None:
        """Handle a failed login attempt, implementing account lockout (Requirement 2.8).

        Uses a true sliding window: the account locks only after
        account_lockout_threshold (5) failures occur within
        account_lockout_window_minutes (15). Once locked, it stays locked for
        account_lockout_duration_minutes (30).

        The window is anchored by first_failed_login_at. If the current failure
        arrives after that anchor plus the window, the previous failures have
        aged out, so a fresh window starts at count 1. This prevents an
        occasional typo over days from eventually locking a legitimate user,
        while still stopping a burst of guesses.

        Args:
            user: The user whose login attempt failed.
        """
        now = datetime.now(timezone.utc)
        window = timedelta(minutes=self.settings.account_lockout_window_minutes)

        first_failure = user.first_failed_login_at
        # Normalize to an aware datetime for comparison (stored as tz-aware).
        if first_failure is not None and first_failure.tzinfo is None:
            first_failure = first_failure.replace(tzinfo=timezone.utc)

        if first_failure is None or (now - first_failure) > window:
            # Start (or restart) the sliding window at this failure.
            user.first_failed_login_at = now
            user.failed_login_attempts = 1
        else:
            # Still within the window — accumulate.
            user.failed_login_attempts += 1

        if user.failed_login_attempts >= self.settings.account_lockout_threshold:
            user.locked_until = now + timedelta(
                minutes=self.settings.account_lockout_duration_minutes
            )

        await self.db.flush()

    async def revoke_all_user_sessions(self, user_id: str) -> dict[str, Any]:
        """Revoke all active sessions for a user (Requirement 17.6).

        Admin action that immediately invalidates all refresh tokens for
        a specified user by clearing their session registry in Redis.

        Args:
            user_id: The target user's UUID string.

        Returns:
            Dict with the number of sessions revoked.

        Raises:
            AuthenticationError: If session service is not available.
        """
        if not self.session_service:
            raise AuthenticationError("Session service not available")

        revoked_count = await self.session_service.revoke_all_sessions(user_id)
        return {
            "message": f"All sessions revoked for user {user_id}",
            "revoked_count": revoked_count,
        }

    async def force_change_password(
        self,
        token: str,
        new_password: str,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
    ) -> dict[str, Any]:
        """Change password for a user who has must_change_password=True.

        Validates the scoped password_change token, enforces password complexity,
        updates the password, clears the must_change_password flag, and issues
        normal access/refresh tokens so the user is immediately logged in.

        Args:
            token: The password_change JWT token issued at login.
            new_password: The new password (must meet complexity requirements).
            ip_address: Client IP for session registration.
            user_agent: Client user agent for session registration.

        Returns:
            Dict with access_token, refresh_token, and token_type.

        Raises:
            AuthenticationError: If the token is invalid or expired.
            PasswordValidationError: If the new password doesn't meet requirements.
        """
        # Validate password complexity first
        is_valid, error_msg = validate_password_complexity(new_password)
        if not is_valid:
            raise PasswordValidationError(error_msg)

        # Decode and validate the scoped token
        try:
            payload = decode_token(token, self.settings)
        except (JWTError, TypeError, ValueError):
            raise AuthenticationError("Invalid or expired password change token")

        if payload.get("type") != "password_change":
            raise AuthenticationError("Invalid token type")

        user_id = payload.get("sub")
        if not user_id:
            raise AuthenticationError("Invalid token payload")

        # Find the user
        result = await self.db.execute(
            select(User).filter_by(id=user_id, deleted_at=None)
        )
        user = result.scalar_one_or_none()

        if user is None:
            raise AuthenticationError("User not found")

        if not user.is_active:
            raise AuthenticationError("Account is inactive")

        if not user.must_change_password:
            raise AuthenticationError("Password change is not required for this account")

        # Update password and clear the flag
        user.password_hash = hash_password(new_password, self.settings)
        user.must_change_password = False
        user.failed_login_attempts = 0
        user.first_failed_login_at = None
        user.locked_until = None
        await self.db.flush()

        # Issue normal tokens so the user is immediately logged in
        access_token = create_access_token(
            user_id=str(user.id),
            role=user.role,
            settings=self.settings,
        )
        refresh_token = create_refresh_token(
            user_id=str(user.id),
            settings=self.settings,
        )

        # Register session in Redis
        if self.session_service:
            refresh_payload = decode_token(refresh_token, self.settings)
            jti = refresh_payload.get("jti", "")
            await self.session_service.register_session(
                user_id=str(user.id),
                jti=jti,
                ip_address=ip_address,
                user_agent=user_agent,
            )

        return {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_type": "bearer",
        }


# =============================================================================
# Custom Exceptions
# =============================================================================

class AuthenticationError(Exception):
    """Raised when authentication fails (invalid credentials, expired token, etc.)."""

    def __init__(self, message: str = "Authentication failed"):
        self.message = message
        super().__init__(self.message)


class AccountLockedError(AuthenticationError):
    """Raised when a login attempt is made on a locked account."""

    pass


class PasswordValidationError(Exception):
    """Raised when a password does not meet complexity requirements."""

    def __init__(self, message: str = "Password does not meet requirements"):
        self.message = message
        super().__init__(self.message)
