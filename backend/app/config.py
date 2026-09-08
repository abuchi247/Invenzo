"""Application configuration using pydantic-settings."""

from functools import lru_cache
from typing import Any, Literal
from urllib.parse import unquote, urlsplit

from pydantic_settings import BaseSettings, SettingsConfigDict


JWT_SECRET_PLACEHOLDERS = frozenset(
    {
        "change-me-in-production",
        "your-secret-key-change-in-production",
        "dev-secret-key-not-for-production",
        "change-me",
        "changeme",
        "your-secret-key",
    }
)
DATABASE_PASSWORD_PLACEHOLDERS = frozenset(
    {
        "",
        "changeme",
        "change-me",
        "change_me",
        "password",
        "postgres",
        "your-password",
        "your_password",
        "example",
        "secret",
    }
)


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # Application
    app_name: str = "Auto Spare Parts ERP"
    app_version: str = "1.0.0"
    debug: bool = False
    environment: Literal["development", "staging", "production"] = "development"

    # Logging
    # Left unset so verbosity follows the environment (DEBUG in development,
    # INFO in staging/production). An explicit value overrides that default.
    log_level: str | None = None

    # Server
    host: str = "0.0.0.0"
    port: int = 8000

    # Database
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/auto_erp"
    # Optional direct value used by deployments that provide POSTGRES_PASSWORD.
    # Docker deployments may provide the same credential only in DATABASE_URL.
    postgres_password: str | None = None
    # Separate migration identity for least-privilege enforcement.
    # In production, this should use a DDL-capable role while DATABASE_URL uses
    # a DML-only application role. Falls back to DATABASE_URL when not set.
    migration_database_url: str | None = None
    database_echo: bool = False
    # Pool sizing is per worker process. Each uvicorn worker AND the ARQ worker
    # container open their own pool, so the total open connections are
    # (WEB_CONCURRENCY + 1) * (pool_size + max_overflow). Kept small so several
    # customer stacks on one small VPS stay well under Postgres max_connections
    # (default 100). Async connections are held only briefly, so a small pool is
    # ample; raise via env only with headroom to spare.
    database_pool_size: int = 5
    database_max_overflow: int = 5
    database_pool_timeout: int = 30
    # Migrations are normally run as the deployment command before Uvicorn.
    # Enable this for environments that deliberately use controlled startup
    # migration execution instead.
    run_migrations_on_startup: bool = False

    # Redis and background jobs
    redis_url: str = "redis://localhost:6379/0"
    # Kept for compatibility with deployments that still expose the old
    # setting; ARQ uses job_queue_name for its native queue.
    password_reset_queue_key: str = "jobs:password-reset"
    job_queue_name: str = "arq:queue"
    job_max_tries: int = 5
    job_base_backoff_seconds: float = 1.0
    job_max_backoff_seconds: float = 300.0
    job_timeout_seconds: float = 300.0
    job_max_concurrency: int = 10

    # Password reset delivery
    frontend_base_url: str = "http://localhost:3000"
    password_reset_path: str = "/reset-password"

    # SMTP delivery (console delivery is used when SMTP is not configured in development)
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_from_email: str | None = None
    smtp_use_tls: bool = True

    # JWT
    jwt_secret_key: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = 30
    jwt_refresh_token_expire_days: int = 7

    # Refresh token cookie (Requirements 3.1, 3.4, 3.5)
    # The refresh credential is delivered as an HTTP-only cookie so client-side
    # JavaScript cannot read it. The path is deliberately narrow so browsers do
    # not attach the credential to unrelated API calls.
    refresh_cookie_name: str = "asm_refresh"
    refresh_cookie_path: str = "/api/v1/auth"
    refresh_cookie_samesite: Literal["strict", "lax", "none"] = "strict"
    # None means "derive from the environment": Secure everywhere except local
    # development, where the API is normally served over plain HTTP.
    refresh_cookie_secure: bool | None = None

    # Rate Limiting
    rate_limit_authenticated: int = 100  # requests per minute
    rate_limit_unauthenticated: int = 20  # requests per minute
    # Authentication endpoints use lower limits to slow credential stuffing.
    rate_limit_login: int = 5
    rate_limit_refresh: int = 10
    rate_limit_password_reset: int = 5
    rate_limit_password_reset_confirm: int = 5

    # Request hardening
    max_request_body_bytes: int = 5 * 1024 * 1024
    health_check_timeout_seconds: float = 2.0

    # Security
    bcrypt_cost_factor: int = 12
    account_lockout_threshold: int = 5
    account_lockout_window_minutes: int = 15
    account_lockout_duration_minutes: int = 30

    # CORS
    cors_origins: list[str] = ["http://localhost:3000"]

    # Error tracking
    error_tracker_enabled: bool = False
    error_tracker_dsn: str | None = None
    error_tracker_environment: str | None = None
    error_tracker_release: str | None = None
    error_tracker_sample_rate: float = 1.0

    # Telemetry / Metrics
    telemetry_enabled: bool = True
    telemetry_slow_query_threshold_ms: float = 200.0

    def __init__(self, **values: Any) -> None:
        """Build settings, then fail without Pydantic echoing secret inputs."""
        super().__init__(**values)
        self.validate_production_settings()

    def validate_production_settings(self) -> None:
        """Validate credentials that must be explicitly safe in production.

        This method intentionally includes setting names only in its errors. It
        never includes the configured secret, password, or database URL.
        """
        if self.environment != "production":
            return

        invalid_settings: list[str] = []
        normalized_jwt_secret = self.jwt_secret_key.strip().lower()
        if (
            len(self.jwt_secret_key.strip()) < 32
            or normalized_jwt_secret in JWT_SECRET_PLACEHOLDERS
        ):
            invalid_settings.append("jwt_secret_key")

        database_password = self.postgres_password
        if database_password is None:
            try:
                database_password = urlsplit(self.database_url).password
            except ValueError:
                # The database URL will produce its own connection error. Do
                # not echo malformed URL contents in this validation error.
                database_password = None

        if database_password is not None:
            normalized_database_password = unquote(database_password).strip().lower()
            if normalized_database_password in DATABASE_PASSWORD_PLACEHOLDERS:
                invalid_settings.append("POSTGRES_PASSWORD/DATABASE_URL")

        # SMTP is required in production for password reset emails.
        # Without it, the ARQ worker will fail silently on every reset request.
        if not self.smtp_host or not self.smtp_from_email:
            invalid_settings.append("SMTP_HOST/SMTP_FROM_EMAIL")

        # CORS wildcard or localhost origins are insecure in production and
        # can be exploited by any website to make credentialed API requests.
        insecure_cors = {"*", "http://localhost", "https://localhost"}
        for origin in self.cors_origins:
            normalized = origin.strip().lower()
            if normalized in insecure_cors or normalized.startswith("http://localhost:") or normalized.startswith("https://localhost:"):
                invalid_settings.append("cors_origins")
                break

        # A non-Secure refresh cookie can be sent over plain HTTP, which defeats
        # the point of moving the credential out of JavaScript's reach.
        if self.refresh_cookie_secure is False:
            invalid_settings.append("refresh_cookie_secure")
        if (
            self.refresh_cookie_samesite == "none"
            and not self.refresh_cookie_secure_enabled
        ):
            invalid_settings.append("refresh_cookie_samesite")

        if invalid_settings:
            raise ValueError(
                "Invalid production configuration for: "
                + ", ".join(invalid_settings)
                + ". Set secure, non-placeholder values."
            )

    @property
    def refresh_cookie_secure_enabled(self) -> bool:
        """Resolve the effective ``Secure`` attribute for the refresh cookie."""
        if self.refresh_cookie_secure is not None:
            return self.refresh_cookie_secure
        return self.environment != "development"

    @property
    def async_database_url(self) -> str:
        """Ensure the database URL uses the asyncpg driver."""
        url = self.database_url
        if url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
        return url


@lru_cache
def get_settings() -> Settings:
    """Get cached application settings singleton."""
    return Settings()
