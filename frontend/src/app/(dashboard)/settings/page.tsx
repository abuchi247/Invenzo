'use client';

import React, { useCallback, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { get, post, put } from '@/lib/api';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usePaginatedQuery, queryKeys, toQueryString, normalizeList } from '@/lib/queries';import {
  DataTable,
  Button,
  Input,
  Select,
  Badge,
  Modal,
  Alert,
  LoadingSpinner,
} from '@/components';
import type { Column, SelectOption } from '@/components';
import type {
  UserProfile,
  UserCreate,
  UserUpdate,
  UserRole,
  PaginatedResponse,
} from '@/lib/types';
import { useAuth } from '@/hooks/useAuth';
import { useRequirePermission } from '@/hooks/useRequirePermission';
import { getCurrency, setCurrency, CURRENCY_OPTIONS } from '@/lib/currency';
import { normalizeRole } from '@/lib/enums';

import { formatFieldErrors, validateWithSchema } from '@/lib/validation/errors';
import { userCreateSchema, userUpdateSchema } from '@/lib/validation/schemas';

function getRoleBadge(role: UserRole | string): React.ReactNode {
  const variants: Record<UserRole, 'info' | 'success' | 'warning' | 'default'> = {
    admin: 'info',
    manager: 'success',
    salesperson: 'warning',
    storekeeper: 'default',
  };
  const labels: Record<UserRole, string> = {
    admin: 'Admin',
    manager: 'Manager',
    salesperson: 'Salesperson',
    storekeeper: 'Storekeeper',
  };
  // The API returns capitalized roles (e.g. "Admin") while these maps are keyed
  // by the lowercase UserRole values. normalizeRole is the shared contract for
  // that casing; fall back gracefully so the badge never renders blank.
  const key = normalizeRole(role);
  const variant = variants[key] ?? 'default';
  const label = labels[key] ?? (role ? role.toString() : 'Unknown');
  return <Badge variant={variant}>{label}</Badge>;
}

function getStatusBadge(isActive: boolean): React.ReactNode {
  return isActive ? (
    <Badge variant="success">Active</Badge>
  ) : (
    <Badge variant="danger">Inactive</Badge>
  );
}

const ROLE_OPTIONS: SelectOption[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'manager', label: 'Manager' },
  { value: 'salesperson', label: 'Salesperson' },
  { value: 'storekeeper', label: 'Storekeeper' },
];

const USER_STATUS_OPTIONS: SelectOption[] = [
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
];

export default function SettingsPage() {
  const router = useRouter();
  const { hasRole, user: currentUser, isLoading: authLoading } = useAuth();
  const { allowed } = useRequirePermission(['user_management', 'system_settings']);

  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState('username');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const usersQuery = usePaginatedQuery<UserProfile>(queryKeys.users.list({ page, page_size: pageSize, search, sort_by: sortField, sort_direction: sortDirection }), `/users?${toQueryString({ page, page_size: pageSize, search, sort_by: sortField, sort_direction: sortDirection })}`, { enabled: hasRole('admin') });
  const users = normalizeList(usersQuery.data).data;
  const isLoading = usersQuery.isLoading;
  const error = usersQuery.error?.message ?? null;
  const totalPages = normalizeList(usersQuery.data).totalPages;
  const createUser = useMutation({ mutationFn: (payload: UserCreate) => post('/users', payload), onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.users.all }) });
  const updateUser = useMutation({ mutationFn: ({ id, payload }: { id: string; payload: UserUpdate }) => put(`/users/${id}`, payload), onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.users.all }) });
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newUser, setNewUser] = useState<UserCreate>({
    username: '',
    email: '',
    password: '',
    role: 'salesperson',
  });

  // Edit user modal
  const [showEditModal, setShowEditModal] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editingUser, setEditingUser] = useState<UserProfile | null>(null);
  const [editData, setEditData] = useState<UserUpdate>({});

  // Reset password modal (admin sets a temporary password for a user)
  const resetUserPassword = useMutation({
    mutationFn: ({ id, new_password }: { id: string; new_password: string }) =>
      post(`/users/${id}/reset-password`, { new_password }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.users.all }),
  });
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSuccess, setResetSuccess] = useState<string | null>(null);
  const [resetUser, setResetUser] = useState<UserProfile | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState('');

  // Debounced search only changes the Query key after the short input pause.
  useEffect(() => { const timeout = setTimeout(() => setPage(1), 300); return () => clearTimeout(timeout); }, [search]);

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const closeCreateUserModal = useCallback(() => {
    setShowCreateModal(false);
    setCreateError(null);
  }, []);

  const closeEditUserModal = useCallback(() => {
    setShowEditModal(false);
    setEditError(null);
    setEditingUser(null);
  }, []);

  const handleCreateUser = () => {
    const validation = validateWithSchema(userCreateSchema, newUser);
    if (!validation.data) {
      setCreateError(formatFieldErrors(validation.errors));
      return;
    }
    const payload = { ...validation.data, role: validation.data.role.charAt(0).toUpperCase() + validation.data.role.slice(1) } as UserCreate;
    setCreateError(null);
    createUser.mutate(payload, { onError: (err) => setCreateError(err.message), onSuccess: () => { setShowCreateModal(false); setNewUser({ username: '', email: '', password: '', role: 'salesperson' }); setSearch(''); } });
  };

  const handleEditUser = (userProfile: UserProfile) => {
    setEditingUser(userProfile);
    setEditData({
      username: userProfile.username,
      email: userProfile.email,
      // Normalize the API's capitalized role (e.g. "Admin") to the lowercase
      // UserRole the Select options are keyed by, so the dropdown preselects
      // the user's current role. handleSaveUser re-capitalizes for the API.
      role: normalizeRole(userProfile.role),
      is_active: userProfile.is_active,
    });
    setEditError(null);
    setShowEditModal(true);
  };

  const handleSaveUser = () => {
    if (!editingUser) return;
    const validation = validateWithSchema(userUpdateSchema, editData);
    if (!validation.data) {
      setEditError(formatFieldErrors(validation.errors));
      return;
    }
    const payload: UserUpdate = { ...validation.data, role: validation.data.role ? (validation.data.role.charAt(0).toUpperCase() + validation.data.role.slice(1)) as UserRole : undefined };
    setEditError(null);
    updateUser.mutate({ id: editingUser.id, payload }, { onError: (err) => setEditError(err.message), onSuccess: () => { setShowEditModal(false); setEditingUser(null); setEditData({}); } });
  };

  const openResetPassword = (userProfile: UserProfile) => {
    setResetUser(userProfile);
    setResetPasswordValue('');
    setResetError(null);
    setResetSuccess(null);
    setShowResetModal(true);
  };

  const closeResetPassword = useCallback(() => {
    setShowResetModal(false);
    setResetUser(null);
    setResetPasswordValue('');
    setResetError(null);
    setResetSuccess(null);
  }, []);

  const handleResetPassword = () => {
    if (!resetUser) return;
    // Client-side complexity check mirrors the backend so the admin gets
    // immediate feedback; the backend re-validates authoritatively.
    const pw = resetPasswordValue;
    const complexityOk =
      pw.length >= 8 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /\d/.test(pw);
    if (!complexityOk) {
      setResetError(
        'Temporary password must be at least 8 characters and include an uppercase letter, a lowercase letter, and a digit.',
      );
      return;
    }
    setResetError(null);
    resetUserPassword.mutate(
      { id: resetUser.id, new_password: pw },
      {
        onError: (err) => setResetError(err.message),
        onSuccess: () => {
          setResetSuccess(
            `Password reset for "${resetUser.username}". Share the temporary password securely — they must change it on next login.`,
          );
        },
      },
    );
  };



  const columns: Column<UserProfile>[] = [
    {
      key: 'username',
      header: 'Username',
      sortable: true,
      render: (item) => (
        <span className="font-medium text-gray-900">{item.username}</span>
      ),
    },
    {
      key: 'email',
      header: 'Email',
      sortable: true,
      render: (item) => <span>{item.email}</span>,
    },
    {
      key: 'role',
      header: 'Role',
      sortable: true,
      render: (item) => getRoleBadge(item.role),
    },
    {
      key: 'is_active',
      header: 'Status',
      render: (item) => getStatusBadge(item.is_active),
    },
    {
      key: 'created_at',
      header: 'Created',
      sortable: true,
      render: (item) => (
        <span className="text-sm text-gray-500">
          {new Date(item.created_at).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (item) => (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => handleEditUser(item)}
            disabled={item.id === currentUser?.id}
          >
            Edit
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => openResetPassword(item)}
            disabled={item.id === currentUser?.id}
            title={
              item.id === currentUser?.id
                ? 'Use your Profile page to change your own password'
                : 'Set a temporary password for this user'
            }
          >
            Reset password
          </Button>
        </div>
      ),
    },
  ];

  // Don't render content for non-admins
  if (!allowed) return null;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Settings</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage users and system configuration
          </p>
        </div>
      </div>

      {/* Business Settings Section */}
      <BusinessSettingsSection />

      {/* System Settings Section */}
      <SystemSettingsSection />

      {/* Role Permissions Section */}
      <RolePermissionsSection />

      {/* User Management Section */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 sm:p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">User Management</h2>
            <p className="mt-1 text-sm text-gray-500">
              Create and manage user accounts, roles, and access
            </p>
          </div>
          <Button onClick={() => setShowCreateModal(true)}>Create User</Button>
        </div>

        {/* Search */}
        <div className="mb-4">
          <Input
            placeholder="Search by username or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search users"
          />
        </div>

        {/* Error display */}
        {error && (
          <div className="mb-4">
            <Alert variant="error">{error}</Alert>
          </div>
        )}

        {/* Users table */}
        <DataTable
          columns={columns}
          data={users}
          isLoading={isLoading}
          currentPage={page}
          totalPages={totalPages}
          onPageChange={setPage}
          sortField={sortField}
          sortDirection={sortDirection}
          onSort={handleSort}
          label="Users"
          emptyMessage="No users found."
        />
      </div>

      {/* Create User Modal */}
      <Modal
        isOpen={showCreateModal}
        onClose={closeCreateUserModal}
        title="Create New User"
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={closeCreateUserModal}>
              Cancel
            </Button>
            <Button onClick={handleCreateUser} isLoading={createUser.isPending}>
              Create User
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {createError && (
            <Alert variant="error" onClose={() => setCreateError(null)}>
              {createError}
            </Alert>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Username"
              value={newUser.username}
              onChange={(e) =>
                setNewUser({ ...newUser, username: e.target.value })
              }
              required
            />
            <Input
              label="Email"
              type="email"
              value={newUser.email}
              onChange={(e) =>
                setNewUser({ ...newUser, email: e.target.value })
              }
              required
            />
            <Input
              label="Password"
              type="password"
              value={newUser.password}
              onChange={(e) =>
                setNewUser({ ...newUser, password: e.target.value })
              }
              required
              placeholder="Min 8 chars, 1 uppercase, 1 lowercase, 1 digit"
            />
            <Select
              label="Role"
              options={ROLE_OPTIONS}
              value={newUser.role}
              onChange={(e) =>
                setNewUser({ ...newUser, role: e.target.value as UserRole })
              }
            />
          </div>
        </div>
      </Modal>

      {/* Edit User Modal */}
      <Modal
        isOpen={showEditModal}
        onClose={closeEditUserModal}
        title={`Edit User: ${editingUser?.username || ''}`}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={closeEditUserModal}>
              Cancel
            </Button>
            <Button onClick={handleSaveUser} isLoading={updateUser.isPending}>
              Save Changes
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {editError && (
            <Alert variant="error" onClose={() => setEditError(null)}>
              {editError}
            </Alert>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Username"
              value={editData.username || ''}
              onChange={(e) =>
                setEditData({ ...editData, username: e.target.value })
              }
              helperText="Used to log in. Not case-sensitive; must be unique."
            />
            <Input
              label="Email"
              type="email"
              value={editData.email || ''}
              onChange={(e) =>
                setEditData({ ...editData, email: e.target.value })
              }
            />
            <Select
              label="Role"
              options={ROLE_OPTIONS}
              value={editData.role || ''}
              onChange={(e) =>
                setEditData({ ...editData, role: e.target.value as UserRole })
              }
            />
            <Select
              label="Status"
              options={USER_STATUS_OPTIONS}
              value={String(editData.is_active ?? true)}
              onChange={(e) =>
                setEditData({ ...editData, is_active: e.target.value === 'true' })
              }
            />
          </div>
        </div>
      </Modal>

      {/* Reset Password Modal */}
      <Modal
        isOpen={showResetModal}
        onClose={closeResetPassword}
        title={`Reset Password: ${resetUser?.username || ''}`}
        size="md"
        footer={
          resetSuccess ? (
            <Button onClick={closeResetPassword}>Done</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={closeResetPassword}>
                Cancel
              </Button>
              <Button onClick={handleResetPassword} isLoading={resetUserPassword.isPending}>
                Reset Password
              </Button>
            </>
          )
        }
      >
        <div className="space-y-4">
          {resetError && (
            <Alert variant="error" onClose={() => setResetError(null)}>
              {resetError}
            </Alert>
          )}
          {resetSuccess ? (
            <Alert variant="success">{resetSuccess}</Alert>
          ) : (
            <>
              <p className="text-sm text-gray-600">
                Set a temporary password for <span className="font-medium">{resetUser?.username}</span>.
                They will be required to change it the next time they log in, and any account
                lockout will be cleared.
              </p>
              <Input
                label="Temporary password"
                type="text"
                value={resetPasswordValue}
                onChange={(e) => setResetPasswordValue(e.target.value)}
                placeholder="Min 8 chars, 1 uppercase, 1 lowercase, 1 digit"
                autoComplete="new-password"
              />
              <p className="text-xs text-gray-400">
                Share this password with the user securely (not by email in plain text).
                It is shown here so you can communicate it — it is not stored in readable form.
              </p>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PhoneEntry {
  label: string;
  number: string;
}

interface BankAccountEntry {
  bank_name: string;
  account_number: string;
  account_name: string;
}

interface BusinessSettingsData {
  id?: string;
  business_name: string;
  address: string;
  email: string;
  tax_id: string;
  website: string;
  logo_base64: string;
  invoice_footer: string;
  phones: PhoneEntry[];
  bank_accounts: BankAccountEntry[];
}

// ---------------------------------------------------------------------------
// Reusable list-editor sub-components
// ---------------------------------------------------------------------------

interface PhoneListEditorProps {
  phones: PhoneEntry[];
  onChange: (phones: PhoneEntry[]) => void;
  disabled?: boolean;
}

function PhoneListEditor({ phones, onChange, disabled }: PhoneListEditorProps) {
  function update(index: number, field: keyof PhoneEntry, value: string) {
    const next = phones.map((p, i) => (i === index ? { ...p, [field]: value } : p));
    onChange(next);
  }

  function add() {
    if (phones.length >= 10) return;
    onChange([...phones, { label: '', number: '' }]);
  }

  function remove(index: number) {
    onChange(phones.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-2">
      {phones.map((phone, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="w-28 shrink-0">
            <input
              type="text"
              aria-label={`Phone ${i + 1} label`}
              placeholder='e.g. "Main"'
              value={phone.label}
              onChange={(e) => update(i, 'label', e.target.value)}
              disabled={disabled}
              maxLength={50}
              className="h-9 w-full rounded-md border border-gray-300 px-2.5 text-sm focus:border-[#667eea] focus:outline-none focus:ring-2 focus:ring-[#667eea]/10 disabled:opacity-50"
            />
          </div>
          <div className="flex-1">
            <input
              type="tel"
              aria-label={`Phone ${i + 1} number`}
              placeholder="08012345678"
              value={phone.number}
              onChange={(e) => update(i, 'number', e.target.value)}
              disabled={disabled}
              maxLength={30}
              className="h-9 w-full rounded-md border border-gray-300 px-2.5 text-sm focus:border-[#667eea] focus:outline-none focus:ring-2 focus:ring-[#667eea]/10 disabled:opacity-50"
            />
          </div>
          <button
            type="button"
            onClick={() => remove(i)}
            disabled={disabled}
            aria-label={`Remove phone ${i + 1}`}
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-gray-200 text-gray-400 hover:border-red-300 hover:text-red-500 disabled:opacity-40 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}

      {phones.length === 0 && (
        <p className="text-xs text-gray-400 italic">No phone numbers added yet.</p>
      )}

      {phones.length < 10 && (
        <button
          type="button"
          onClick={add}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[#667eea] hover:text-[#764ba2] disabled:opacity-40 transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add phone number
        </button>
      )}

      {phones.length > 0 && (
        <p className="text-xs text-gray-400">
          <span className="font-medium">Label</span>{' '}is optional (e.g. &ldquo;Main&rdquo;, &ldquo;WhatsApp&rdquo;, &ldquo;Abuja Branch&rdquo;).
          {phones.length >= 10 && ' Maximum of 10 reached.'}
        </p>
      )}
    </div>
  );
}

interface BankAccountListEditorProps {
  accounts: BankAccountEntry[];
  onChange: (accounts: BankAccountEntry[]) => void;
  disabled?: boolean;
}

function BankAccountListEditor({ accounts, onChange, disabled }: BankAccountListEditorProps) {
  function update(index: number, field: keyof BankAccountEntry, value: string) {
    const next = accounts.map((a, i) => (i === index ? { ...a, [field]: value } : a));
    onChange(next);
  }

  function add() {
    if (accounts.length >= 10) return;
    onChange([...accounts, { bank_name: '', account_number: '', account_name: '' }]);
  }

  function remove(index: number) {
    onChange(accounts.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-3">
      {accounts.map((acct, i) => (
        <div key={i} className="relative rounded-lg border border-gray-200 bg-gray-50 p-3">
          {/* Remove button */}
          <button
            type="button"
            onClick={() => remove(i)}
            disabled={disabled}
            aria-label={`Remove bank account ${i + 1}`}
            className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-40 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <p className="mb-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Account {i + 1}
          </p>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div>
              <label className="mb-0.5 block text-xs font-medium text-gray-600">Bank Name</label>
              <input
                type="text"
                placeholder='e.g. "First Bank"'
                value={acct.bank_name}
                onChange={(e) => update(i, 'bank_name', e.target.value)}
                disabled={disabled}
                maxLength={100}
                className="h-9 w-full rounded-md border border-gray-300 bg-white px-2.5 text-sm focus:border-[#667eea] focus:outline-none focus:ring-2 focus:ring-[#667eea]/10 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="mb-0.5 block text-xs font-medium text-gray-600">Account Number</label>
              <input
                type="text"
                placeholder="0123456789"
                value={acct.account_number}
                onChange={(e) => update(i, 'account_number', e.target.value)}
                disabled={disabled}
                maxLength={30}
                className="h-9 w-full rounded-md border border-gray-300 bg-white px-2.5 text-sm focus:border-[#667eea] focus:outline-none focus:ring-2 focus:ring-[#667eea]/10 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="mb-0.5 block text-xs font-medium text-gray-600">Account Name</label>
              <input
                type="text"
                placeholder="Chidi Auto Parts Ltd"
                value={acct.account_name}
                onChange={(e) => update(i, 'account_name', e.target.value)}
                disabled={disabled}
                maxLength={255}
                className="h-9 w-full rounded-md border border-gray-300 bg-white px-2.5 text-sm focus:border-[#667eea] focus:outline-none focus:ring-2 focus:ring-[#667eea]/10 disabled:opacity-50"
              />
            </div>
          </div>
        </div>
      ))}

      {accounts.length === 0 && (
        <p className="text-xs text-gray-400 italic">No bank accounts added yet.</p>
      )}

      {accounts.length < 10 && (
        <button
          type="button"
          onClick={add}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[#667eea] hover:text-[#764ba2] disabled:opacity-40 transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add bank account
        </button>
      )}

      {accounts.length >= 10 && (
        <p className="text-xs text-gray-400">Maximum of 10 bank accounts reached.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Business Settings section
// ---------------------------------------------------------------------------

const EMPTY_SETTINGS: BusinessSettingsData = {
  business_name: '',
  address: '',
  email: '',
  tax_id: '',
  website: '',
  logo_base64: '',
  invoice_footer: '',
  phones: [],
  bank_accounts: [],
};

function normaliseSettings(data: Partial<BusinessSettingsData>): BusinessSettingsData {
  return {
    ...EMPTY_SETTINGS,
    ...data,
    business_name: data.business_name ?? '',
    address: data.address ?? '',
    email: data.email ?? '',
    tax_id: data.tax_id ?? '',
    website: data.website ?? '',
    logo_base64: data.logo_base64 ?? '',
    invoice_footer: data.invoice_footer ?? '',
    phones: Array.isArray(data.phones) ? data.phones : [],
    bank_accounts: Array.isArray(data.bank_accounts) ? data.bank_accounts : [],
  };
}

function BusinessSettingsSection() {
  const [settings, setSettings] = useState<BusinessSettingsData>(EMPTY_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    get<BusinessSettingsData>('/business-settings')
      .then((data) => setSettings(normaliseSettings(data)))
      .catch(() => { /* first boot — no row yet */ })
      .finally(() => setIsLoading(false));
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const { id: _id, ...payload } = settings;
      const cleanPayload = {
        ...payload,
        logo_base64: payload.logo_base64 || null,
        // Strip entries where required fields are empty
        phones: payload.phones.filter((p) => p.number.trim() !== ''),
        bank_accounts: payload.bank_accounts.filter(
          (b) => b.bank_name.trim() !== '' || b.account_number.trim() !== '',
        ),
      };
      const data = await put<BusinessSettingsData>('/business-settings', cleanPayload);
      setSettings(normaliseSettings(data));
      setSuccessMsg('Business settings saved successfully');
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (err: unknown) {
      let message = 'Failed to save settings';
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { data?: { detail?: string }; status?: number } };
        message = axiosErr.response?.data?.detail
          ?? (axiosErr.response?.status ? `Request failed with status ${axiosErr.response.status}` : message);
      } else if (err instanceof Error) {
        message = err.message;
      }
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 500 * 1024) { setError('Logo must be under 500 KB'); return; }
    const reader = new FileReader();
    reader.onload = () => setSettings((s) => ({ ...s, logo_base64: reader.result as string }));
    reader.readAsDataURL(file);
  };

  if (isLoading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4 sm:p-6">
        <div className="flex items-center justify-center py-8"><LoadingSpinner /></div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 sm:p-6">
      {/* Section header */}
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-900">Business Profile</h2>
        <p className="mt-1 text-sm text-gray-500">
          This information appears on your invoices, receipts, and reports
        </p>
      </div>

      {error && <div className="mb-4"><Alert variant="error" onClose={() => setError(null)}>{error}</Alert></div>}
      {successMsg && <div className="mb-4"><Alert variant="success" onClose={() => setSuccessMsg(null)}>{successMsg}</Alert></div>}

      <div className="space-y-8">

        {/* ── Basic info ───────────────────────────────────────────────── */}
        <div>
          <h3 className="mb-3 text-sm font-semibold text-gray-700 uppercase tracking-wide">
            Business Details
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Business Name"
              value={settings.business_name}
              onChange={(e) => setSettings((s) => ({ ...s, business_name: e.target.value }))}
              placeholder="e.g. Chidi Auto Parts Ltd"
              required
            />
            <Input
              label="Email"
              type="email"
              value={settings.email}
              onChange={(e) => setSettings((s) => ({ ...s, email: e.target.value }))}
              placeholder="e.g. info@business.com"
            />
            <Input
              label="Tax ID (TIN / VAT)"
              value={settings.tax_id}
              onChange={(e) => setSettings((s) => ({ ...s, tax_id: e.target.value }))}
              placeholder="e.g. TIN-12345678"
            />
            <Input
              label="Website"
              value={settings.website}
              onChange={(e) => setSettings((s) => ({ ...s, website: e.target.value }))}
              placeholder="e.g. www.business.com"
            />
          </div>

          {/* Address */}
          <div className="mt-4">
            <label className="mb-1 block text-sm font-medium text-gray-700">Address</label>
            <textarea
              rows={2}
              value={settings.address}
              onChange={(e) => setSettings((s) => ({ ...s, address: e.target.value }))}
              placeholder="Business address..."
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-[#667eea] focus:outline-none focus:ring-2 focus:ring-[#667eea]/10"
            />
          </div>
        </div>

        {/* ── Phone numbers ────────────────────────────────────────────── */}
        <div>
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
              Phone Numbers
            </h3>
            <span className="text-xs text-gray-400">{settings.phones.length} / 10</span>
          </div>
          <div className="mb-1.5 hidden grid-cols-[7rem_1fr_2.25rem] gap-2 px-0.5 sm:grid">
            <span className="text-xs font-medium text-gray-500">Label (optional)</span>
            <span className="text-xs font-medium text-gray-500">Number</span>
          </div>
          <PhoneListEditor
            phones={settings.phones}
            onChange={(phones) => setSettings((s) => ({ ...s, phones }))}
            disabled={isSaving}
          />
        </div>

        {/* ── Logo ─────────────────────────────────────────────────────── */}
        <div>
          <h3 className="mb-3 text-sm font-semibold text-gray-700 uppercase tracking-wide">
            Business Logo
          </h3>
          <div className="flex items-center gap-4">
            {settings.logo_base64 && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={settings.logo_base64}
                alt="Business logo preview"
                width={64}
                height={64}
                loading="lazy"
                decoding="async"
                className="h-16 w-16 rounded border border-gray-200 object-contain"
              />
            )}
            <div>
              <input
                type="file"
                accept="image/png,image/jpeg,image/svg+xml"
                onChange={handleLogoUpload}
                className="block text-sm text-gray-500 file:mr-4 file:rounded-md file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100"
              />
              <p className="mt-1 text-xs text-gray-400">PNG, JPEG, or SVG — max 500 KB</p>
            </div>
            {settings.logo_base64 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setSettings((s) => ({ ...s, logo_base64: '' }))}
              >
                Remove
              </Button>
            )}
          </div>
        </div>

        {/* ── Bank accounts ────────────────────────────────────────────── */}
        <div>
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
              Bank Accounts
            </h3>
            <span className="text-xs text-gray-400">{settings.bank_accounts.length} / 10</span>
          </div>
          <p className="mb-3 text-xs text-gray-500">
            All accounts are printed on invoices so customers can choose where to pay.
          </p>
          <BankAccountListEditor
            accounts={settings.bank_accounts}
            onChange={(bank_accounts) => setSettings((s) => ({ ...s, bank_accounts }))}
            disabled={isSaving}
          />
        </div>

        {/* ── Invoice footer ───────────────────────────────────────────── */}
        <div>
          <h3 className="mb-3 text-sm font-semibold text-gray-700 uppercase tracking-wide">
            Invoice Footer
          </h3>
          <textarea
            rows={2}
            value={settings.invoice_footer}
            onChange={(e) => setSettings((s) => ({ ...s, invoice_footer: e.target.value }))}
            placeholder="e.g. Thank you for your patronage. All sales are final."
            className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-[#667eea] focus:outline-none focus:ring-2 focus:ring-[#667eea]/10"
          />
        </div>

        {/* Save */}
        <div>
          <Button onClick={handleSave} isLoading={isSaving}>
            Save Business Settings
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- System Settings Component ---

function SystemSettingsSection() {
  const [currency, setCurrencyState] = useState(getCurrency());
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const handleCurrencyChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    setCurrency(value);
    setCurrencyState(value);
    setSuccessMsg('Currency updated successfully');
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  const currencyOptions: SelectOption[] = CURRENCY_OPTIONS.map((opt) => ({
    value: opt.value,
    label: opt.label,
  }));

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 sm:p-6">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-900">System Settings</h2>
        <p className="mt-1 text-sm text-gray-500">
          Configure application-wide settings
        </p>
      </div>

      {successMsg && (
        <div className="mb-4">
          <Alert variant="success" onClose={() => setSuccessMsg(null)}>
            {successMsg}
          </Alert>
        </div>
      )}

      <div className="max-w-sm">
        <Select
          label="Currency"
          options={currencyOptions}
          value={currency}
          onChange={handleCurrencyChange}
        />
      </div>
    </div>
  );
}


// --- Role Permissions Component ---

const PERMISSION_LABELS: Record<string, string> = {
  sales: 'Sales (create, confirm, cancel, edit)',
  sales_returns: 'Process Returns',
  customers: 'Customers (create, edit, record payments)',
  credit_management: 'Credit Management (adjustments, suspend/close)',
  inventory: 'Inventory (add/edit parts, adjust stock, barcodes)',
  purchasing: 'Purchasing (create/approve POs, manage suppliers)',
  receiving: 'Receive Goods (GRN)',
  transfers: 'Transfers (create, receive)',
  transfer_approval: 'Approve Transfers',
  locations: 'Manage Locations',
  categories: 'Manage Categories',
  audits: 'Audits (start, submit counts)',
  audit_approval: 'Approve Audits',
  reports: 'Reports & Profit Summary',
  invoices: 'Generate Invoices',
  user_management: 'User Management',
  system_settings: 'System Settings',
};

const PERMISSION_GROUPS: { label: string; keys: string[] }[] = [
  {
    label: 'Sales & Customers',
    keys: ['sales', 'sales_returns', 'customers', 'credit_management', 'invoices'],
  },
  {
    label: 'Inventory & Warehouse',
    keys: ['inventory', 'locations', 'categories', 'transfers', 'transfer_approval'],
  },
  {
    label: 'Purchasing & Suppliers',
    keys: ['purchasing', 'receiving'],
  },
  {
    label: 'Audits & Reports',
    keys: ['audits', 'audit_approval', 'reports'],
  },
  {
    label: 'Administration',
    keys: ['user_management', 'system_settings'],
  },
];

interface RolePermData {
  role: string;
  permissions: Record<string, boolean>;
}

interface RolePermsApiResponse {
  roles: RolePermData[];
  all_permissions: string[];
}

function RolePermissionsSection() {
  const [rolesData, setRolesData] = useState<RolePermData[]>([]);
  const [allPermissions, setAllPermissions] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [savingRole, setSavingRole] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});

  useEffect(() => {
    get<RolePermsApiResponse>('/role-permissions')
      .then((data) => {
        setRolesData(data.roles);
        setAllPermissions(data.all_permissions);
      })
      .catch(() => setError('Failed to load role permissions'))
      .finally(() => setIsLoading(false));
  }, []);

  const handleToggle = (role: string, key: string) => {
    if (role === 'Admin') return; // Can't modify Admin
    setRolesData((prev) =>
      prev.map((r) =>
        r.role === role
          ? { ...r, permissions: { ...r.permissions, [key]: !r.permissions[key] } }
          : r
      )
    );
    setDirty((prev) => ({ ...prev, [role]: true }));
    setSuccessMsg(null);
  };

  const handleSave = async (role: string) => {
    const roleData = rolesData.find((r) => r.role === role);
    if (!roleData) return;

    setSavingRole(role);
    setError(null);
    setSuccessMsg(null);
    try {
      await put(`/role-permissions/${role}`, { permissions: roleData.permissions });
      setDirty((prev) => ({ ...prev, [role]: false }));
      setSuccessMsg(`Permissions for ${role} saved successfully`);
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save permissions';
      setError(message);
    } finally {
      setSavingRole(null);
    }
  };

  const handleSelectAll = (role: string) => {
    if (role === 'Admin') return;
    setRolesData((prev) =>
      prev.map((r) =>
        r.role === role
          ? { ...r, permissions: Object.fromEntries(allPermissions.map((k) => [k, true])) }
          : r
      )
    );
    setDirty((prev) => ({ ...prev, [role]: true }));
  };

  const handleDeselectAll = (role: string) => {
    if (role === 'Admin') return;
    setRolesData((prev) =>
      prev.map((r) =>
        r.role === role
          ? { ...r, permissions: Object.fromEntries(allPermissions.map((k) => [k, false])) }
          : r
      )
    );
    setDirty((prev) => ({ ...prev, [role]: true }));
  };

  if (isLoading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4 sm:p-6">
        <div className="flex items-center justify-center py-8"><LoadingSpinner /></div>
      </div>
    );
  }

  // Non-admin roles for the editable columns
  const editableRoles = rolesData.filter((r) => r.role !== 'Admin');
  const adminRole = rolesData.find((r) => r.role === 'Admin');

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 sm:p-6">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-900">Role Permissions</h2>
        <p className="mt-1 text-sm text-gray-500">
          Configure what each role can do. Admin always has full access. Changes take effect immediately after saving.
        </p>
      </div>

      {error && (
        <div className="mb-4"><Alert variant="error" onClose={() => setError(null)}>{error}</Alert></div>
      )}
      {successMsg && (
        <div className="mb-4"><Alert variant="success" onClose={() => setSuccessMsg(null)}>{successMsg}</Alert></div>
      )}

      {/* Permissions matrix */}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="py-3 pr-4 text-left font-medium text-gray-700 sticky left-0 bg-white min-w-[200px]">
                Permission
              </th>
              {adminRole && (
                <th className="px-3 py-3 text-center font-medium text-gray-400 min-w-[100px]">
                  Admin
                  <p className="text-[10px] font-normal text-gray-400">(always all)</p>
                </th>
              )}
              {editableRoles.map((r) => (
                <th key={r.role} className="px-3 py-3 text-center font-medium text-gray-700 min-w-[110px]">
                  {r.role}
                  <div className="mt-1 flex justify-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleSelectAll(r.role)}
                      className="text-[10px] text-blue-600 hover:underline"
                    >
                      All
                    </button>
                    <span className="text-[10px] text-gray-300">|</span>
                    <button
                      type="button"
                      onClick={() => handleDeselectAll(r.role)}
                      className="text-[10px] text-blue-600 hover:underline"
                    >
                      None
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSION_GROUPS.map((group) => (
              <React.Fragment key={group.label}>
                {/* Group header */}
                <tr>
                  <td
                    colSpan={1 + (adminRole ? 1 : 0) + editableRoles.length}
                    className="pt-4 pb-1 text-xs font-bold uppercase tracking-wide text-gray-500"
                  >
                    {group.label}
                  </td>
                </tr>
                {/* Permission rows */}
                {group.keys.map((key) => (
                  <tr key={key} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="py-2 pr-4 text-gray-700 sticky left-0 bg-white">
                      {PERMISSION_LABELS[key] || key}
                    </td>
                    {/* Admin column — always checked, disabled */}
                    {adminRole && (
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={true}
                          disabled
                          className="h-4 w-4 rounded border-gray-300 text-blue-600 opacity-50 cursor-not-allowed"
                          aria-label={`Admin: ${PERMISSION_LABELS[key]}`}
                        />
                      </td>
                    )}
                    {/* Editable role columns */}
                    {editableRoles.map((r) => (
                      <td key={r.role} className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={r.permissions[key] ?? false}
                          onChange={() => handleToggle(r.role, key)}
                          disabled={savingRole === r.role}
                          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer disabled:opacity-50"
                          aria-label={`${r.role}: ${PERMISSION_LABELS[key]}`}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Save buttons per role */}
      <div className="mt-6 flex flex-wrap gap-3 border-t border-gray-200 pt-4">
        {editableRoles.map((r) => (
          <Button
            key={r.role}
            onClick={() => handleSave(r.role)}
            isLoading={savingRole === r.role}
            disabled={!dirty[r.role]}
            variant={dirty[r.role] ? 'primary' : 'secondary'}
          >
            Save {r.role}
          </Button>
        ))}
      </div>
    </div>
  );
}
