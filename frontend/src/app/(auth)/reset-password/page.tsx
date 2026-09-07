'use client';

/**
 * Password Reset Page — two modes:
 *
 *  1. No `?token=` in the URL  → REQUEST mode: enter your email and we send a
 *     reset link (POST /auth/reset-password).
 *  2. `?token=...` present     → CONFIRM mode: the link from the reset email
 *     lands here; set a new password (POST /auth/reset-password/confirm), then
 *     go to /login.
 *
 * Requirements: 2.4 (Time-limited reset token for password reset)
 */

import { useState, useEffect, Suspense, FormEvent } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';

const BACK_TO_LOGIN = (
  <div className="mt-6 text-center">
    <Link
      href="/login"
      className="text-sm font-medium text-[#667eea] hover:text-[#764ba2] transition-colors"
    >
      ← Back to login
    </Link>
  </div>
);

const submitButtonClass =
  'flex w-full justify-center rounded-md px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:-translate-y-[1px] hover:shadow-[0_4px_12px_rgba(102,126,234,0.3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#667eea] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:translate-y-0';

const submitButtonStyle = {
  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
};

const inputClass =
  'mt-1.5 flex h-10 w-full rounded-md border border-[#ddd] bg-white px-3 py-2 text-sm transition-colors placeholder:text-gray-400 focus:outline-none focus:border-[#2196F3] focus:ring-2 focus:ring-[#2196F3]/10 disabled:cursor-not-allowed disabled:opacity-50';

function Spinner({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2">
      <svg
        className="h-4 w-4 animate-spin"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
      {label}
    </span>
  );
}

/** CONFIRM mode: user arrived from the reset email link with a token. */
function SetNewPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDone, setIsDone] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters long');
      return;
    }
    if (!/[A-Z]/.test(newPassword)) {
      setError('Password must contain at least one uppercase letter');
      return;
    }
    if (!/[a-z]/.test(newPassword)) {
      setError('Password must contain at least one lowercase letter');
      return;
    }
    if (!/\d/.test(newPassword)) {
      setError('Password must contain at least one digit');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setIsSubmitting(true);
    try {
      await api.post('/auth/reset-password/confirm', {
        reset_token: token,
        new_password: newPassword,
      });
      setIsDone(true);
      setTimeout(() => router.replace('/login'), 2500);
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(
        detail ||
          'This reset link is invalid or has expired. Request a new one from the login page.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isDone) {
    return (
      <div className="text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
          <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </div>
        <h2 className="mt-4 text-xl font-semibold text-gray-900">Password updated</h2>
        <p className="mt-2 text-sm text-gray-600">
          Your password has been changed. Redirecting you to login…
        </p>
        {BACK_TO_LOGIN}
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-center text-xl font-semibold text-[#333]">Set a new password</h2>
      <p className="text-center text-sm text-[#666] mt-1">
        Choose a new password for your account.
      </p>

      <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate aria-label="Set new password form">
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert" aria-live="assertive">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="new-password" className="block text-sm font-medium text-[#333]">
            New Password
          </label>
          <input
            id="new-password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            required
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={isSubmitting}
            aria-required="true"
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="confirm-password" className="block text-sm font-medium text-[#333]">
            Confirm Password
          </label>
          <input
            id="confirm-password"
            name="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={isSubmitting}
            aria-required="true"
            className={inputClass}
          />
        </div>

        <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-xs text-blue-700">
          <p className="font-medium mb-1">Password requirements:</p>
          <ul className="list-disc list-inside space-y-0.5">
            <li>At least 8 characters</li>
            <li>At least one uppercase letter</li>
            <li>At least one lowercase letter</li>
            <li>At least one digit</li>
          </ul>
        </div>

        <button type="submit" disabled={isSubmitting} aria-busy={isSubmitting} className={submitButtonClass} style={submitButtonStyle}>
          {isSubmitting ? <Spinner label="Updating…" /> : 'Update password'}
        </button>
      </form>

      {BACK_TO_LOGIN}
    </div>
  );
}

/** REQUEST mode: no token — ask for the email to send a reset link. */
function RequestResetForm() {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError('Email address is required');
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      setError('Please enter a valid email address');
      return;
    }

    setIsLoading(true);
    try {
      await api.post('/auth/reset-password', { email: email.trim() });
      setIsSubmitted(true);
    } catch {
      // Show success even on error to prevent email enumeration
      setIsSubmitted(true);
    } finally {
      setIsLoading(false);
    }
  }

  if (isSubmitted) {
    return (
      <div className="text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
          <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
          </svg>
        </div>
        <h2 className="mt-4 text-xl font-semibold text-gray-900">Check your email</h2>
        <p className="mt-2 text-sm text-gray-600">
          If an account exists with the email{' '}
          <span className="font-medium text-gray-900">{email}</span>, you will receive a password reset link shortly.
        </p>
        <p className="mt-1 text-sm text-gray-500">
          The reset link will expire after a limited time for security.
        </p>
        {BACK_TO_LOGIN}
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-center text-xl font-semibold text-[#333]">Reset your password</h2>
      <p className="mt-1 text-center text-sm text-[#666]">
        Enter the email associated with your account and we&apos;ll send you a link to reset your password.
      </p>

      <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate aria-label="Password reset request form">
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert" aria-live="assertive">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="email" className="block text-sm font-medium text-[#333]">
            Email address
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isLoading}
            aria-required="true"
            className={inputClass}
            placeholder="you@example.com"
          />
        </div>

        <button type="submit" disabled={isLoading} aria-busy={isLoading} className={submitButtonClass} style={submitButtonStyle}>
          {isLoading ? <Spinner label="Sending…" /> : 'Send reset link'}
        </button>
      </form>

      {BACK_TO_LOGIN}
    </div>
  );
}

function ResetPasswordContent() {
  const searchParams = useSearchParams();
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    setToken(searchParams.get('token'));
  }, [searchParams]);

  return token ? <SetNewPasswordForm token={token} /> : <RequestResetForm />;
}

export default function ResetPasswordPage() {
  // useSearchParams must be wrapped in Suspense for the App Router.
  return (
    <Suspense fallback={null}>
      <ResetPasswordContent />
    </Suspense>
  );
}
