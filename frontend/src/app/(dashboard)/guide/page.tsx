'use client';

/**
 * User Guide Page — /guide
 *
 * Interactive accordion guide covering every feature of Invenzo.
 * Sections follow the natural workflow: first-time setup → daily operations →
 * purchasing → transfers → audits → reports → account management.
 *
 * Keep this file in sync whenever new features are added.
 */

import React, { useState } from 'react';
import Link from 'next/link';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Step {
  title: string;
  description: string;
  details: string[];
  tip?: string;
  link?: string;
  linkLabel?: string;
}

interface Section {
  title: string;
  icon: string;
  intro: string;
  steps: Step[];
}

// ---------------------------------------------------------------------------
// Guide content — single source of truth
// ---------------------------------------------------------------------------

const GUIDE_SECTIONS: Section[] = [
  // ── 1. First-time setup ─────────────────────────────────────────────────
  {
    title: 'First-Time Setup',
    icon: '🚀',
    intro: 'Complete these steps once when you first launch the system. Doing them in order saves time.',
    steps: [
      {
        title: '1. Configure your business profile',
        description: 'Set your company name, logo, address, tax ID, phone numbers, and bank accounts. This information appears on every invoice you generate.',
        details: [
          'Go to Settings → Business Profile tab',
          'Fill in: business name, email, address, tax ID, and website',
          'Add phone numbers — you can add up to 10 (e.g. "Main: 08012345678", "WhatsApp: 09087654321")',
          'Add bank accounts — you can add up to 10; all of them print on invoices so customers can choose where to pay',
          'Upload your logo (PNG or JPEG, max 500 KB — auto-resized for invoices)',
          'Add an optional invoice footer message (e.g. "Thank you for your patronage")',
          'Click Save Business Settings',
        ],
        tip: 'You can update this at any time. Existing invoices are not changed, but you can regenerate them from the sale detail page to pick up the latest settings.',
        link: '/settings',
        linkLabel: 'Go to Settings',
      },
      {
        title: '2. Create your locations',
        description: 'Locations represent where your stock physically lives — warehouses, shops, or transit points. You must have at least one location before adding stock.',
        details: [
          'Go to Locations → Add Location',
          'Give it a clear name (e.g. "Main Warehouse", "Ikeja Shop")',
          'Choose the type: Warehouse, Shop, or Transit',
          'Add an optional description and address',
          'Create one location per physical place you store or sell parts',
        ],
        tip: 'Transit locations are managed automatically by the transfer system — you rarely need to create one manually.',
        link: '/locations',
        linkLabel: 'Go to Locations',
      },
      {
        title: '3. Review your categories',
        description: 'Default categories are automatically created when the system first starts. They cover the most common auto spare parts groups.',
        details: [
          '10 parent categories are pre-loaded: Brakes, Filters, Engine Parts, Electrical, Suspension, Body Parts, Transmission, Cooling, Exhaust, Fuel System',
          'Each parent has 3–4 subcategories (e.g. Brakes → Brake Pads, Brake Discs, Brake Fluid)',
          'Go to Categories to review them',
          'Add custom categories or subcategories for anything not covered',
          'Categories drive the auto-generated part number prefix (e.g. BRK-00001 for Brakes)',
        ],
        tip: 'You cannot delete a category that has parts assigned to it — deactivate it instead to hide it from dropdowns.',
        link: '/categories',
        linkLabel: 'Go to Categories',
      },
      {
        title: '4. Add your spare parts',
        description: 'Build your product catalogue. Each part tracks its cost price, selling price, and minimum stock level.',
        details: [
          'Go to Inventory → Add Part',
          'Select a category and subcategory — the part number is auto-generated (e.g. BRK-00001)',
          'Set Cost Price (what you pay the supplier) and Selling Price (what you charge customers)',
          'Set Minimum Stock Level — you will get a low-stock alert when quantity drops to this',
          'Optional: assign a barcode, or generate one from the part detail page later',
          'To add opening stock: select a location and enter the quantity on the same form',
          'Or skip stock now and adjust it later from the part\'s detail page',
        ],
        tip: 'You can scan a barcode on the Add Part form to assign an existing barcode, or generate a new Code 128 barcode from the part detail page.',
        link: '/inventory',
        linkLabel: 'Go to Inventory',
      },
      {
        title: '5. Create your user accounts',
        description: 'Give each staff member their own login. Admins can create accounts from Settings.',
        details: [
          'Go to Settings → User Management tab',
          'Click Create User',
          'Set username, email, role, and a temporary password',
          'All new users must change their password on first login',
          'Password requirements: minimum 8 characters, at least one uppercase letter, one lowercase letter, and one digit',
          'Usernames and emails are not case-sensitive — "John", "JOHN", and "john" are treated as the same account. Passwords, however, are case-sensitive.',
        ],
        tip: 'Roles control exactly what each user can see and do. See the Role Permissions section at the bottom of this guide for a full breakdown.',
        link: '/settings',
        linkLabel: 'Go to Settings',
      },
    ],
  },

  // ── 2. Daily Operations ─────────────────────────────────────────────────
  {
    title: 'Daily Operations',
    icon: '🏪',
    intro: 'The core day-to-day workflows: making sales, recording payments, and managing customer accounts.',
    steps: [
      {
        title: 'Making a sale',
        description: 'Record a customer purchase — cash or credit.',
        details: [
          'Go to Sales → Create Sale',
          'Select the customer (or leave as Walk-in for one-off cash buyers)',
          'Choose your selling location',
          'Set payment type: Cash or Credit',
          'Search for parts and add them to the sale — the selling price pre-fills but is editable',
          'For partial cash payment at checkout: enter the amount paid in the "Amount Paid" field',
          'Click Confirm Sale to deduct stock and generate the invoice',
          'Or click Save Draft to finish later — stock is not deducted until the sale is confirmed',
        ],
        tip: 'Confirming a sale locks the items and triggers FIFO cost-of-goods calculation. Drafts can be edited or deleted.',
        link: '/sales',
        linkLabel: 'Go to Sales',
      },
      {
        title: 'Downloading an invoice',
        description: 'Generate a PDF invoice for any confirmed sale.',
        details: [
          'Click on a confirmed sale to open its detail page',
          'Click Generate Invoice to create a PDF (choose A4 or Thermal 80mm format)',
          'Click Download Invoice to save the PDF',
          'Invoices include your business logo, address, bank details, and a QR code',
          'To reflect updated business settings on an old sale, click Regenerate Invoice',
        ],
        link: '/sales',
        linkLabel: 'Go to Sales',
      },
      {
        title: 'Processing a return',
        description: 'When a customer returns parts from a confirmed sale.',
        details: [
          'Open the confirmed sale → click Process Return',
          'Select which line items to return and the quantity for each',
          'Stock is automatically restored to the original selling location',
          'The sale status changes to Returned and shows a Return Summary with net amounts',
          'A credit note PDF is automatically generated',
          'If the original sale was a credit sale, the customer\'s balance is reduced',
        ],
        tip: 'Only Managers and Admins can process returns.',
        link: '/sales',
        linkLabel: 'Go to Sales',
      },
      {
        title: 'Recording a customer payment',
        description: 'When a credit customer pays off some or all of their balance.',
        details: [
          'Go to Customers → click on the customer\'s name',
          'Open the Credit Ledger tab',
          'Click Record Payment',
          'Enter the amount received — you can link it to a specific outstanding sale',
          'The customer\'s balance updates immediately in the ledger',
          'Every payment is permanently recorded in the immutable ledger (cannot be deleted)',
        ],
        tip: 'You can also make credit adjustments from the Credit Ledger tab (Manager/Admin only) for write-offs or corrections.',
        link: '/customers',
        linkLabel: 'Go to Customers',
      },
      {
        title: 'Managing customer accounts',
        description: 'Control credit access for customers.',
        details: [
          'Click on a customer to open their profile',
          'Suspend: blocks credit sales to this customer; they can still buy cash',
          'Activate: restores credit access after a suspended customer pays',
          'Close Account: marks the customer as permanently inactive; they disappear from the sales dropdown',
          'Set or change the credit limit at any time from the customer profile',
        ],
        link: '/customers',
        linkLabel: 'Go to Customers',
      },
    ],
  },

  // ── 3. Purchasing & Restocking ──────────────────────────────────────────
  {
    title: 'Purchasing & Restocking',
    icon: '📦',
    intro: 'Order stock from suppliers, get it approved, receive it into a location, and track what you owe.',
    steps: [
      {
        title: 'Adding a supplier',
        description: 'Create a supplier profile before raising a purchase order.',
        details: [
          'Go to Suppliers → Add Supplier',
          'Fill in: name, contact person, phone, email, address',
          'Optional: tax ID and payment terms',
          'The supplier\'s balance tracks what you owe them across all purchase orders',
        ],
        link: '/suppliers',
        linkLabel: 'Go to Suppliers',
      },
      {
        title: 'Creating a purchase order (PO)',
        description: 'Formally request stock from a supplier.',
        details: [
          'Go to Purchases → Create PO',
          'Select the supplier',
          'Add line items: choose the part, quantity needed, and the agreed unit cost',
          'Save as Draft — the PO needs Manager or Admin approval before it is acted on',
          'The PO shows a total value based on the line item costs',
        ],
        tip: 'Storekeepers can create draft POs. Only Managers and Admins can approve them.',
        link: '/purchases',
        linkLabel: 'Go to Purchases',
      },
      {
        title: 'Approving a purchase order',
        description: 'Manager or Admin reviews and signs off the order.',
        details: [
          'Open the draft PO → click Approve',
          'The status changes to Approved — it can now be sent to the supplier',
          'Approved POs can still be cancelled if the supplier cannot fulfil the order',
        ],
      },
      {
        title: 'Receiving goods (GRN)',
        description: 'Record the physical delivery and add stock to a location.',
        details: [
          'Open an Approved PO → click Mark Received / Receive Goods',
          'Select the receiving location (which warehouse or shop the delivery went to)',
          'Enter the actual quantities received for each line item',
          'Add any delivery notes',
          'Click Confirm Receipt — stock is immediately added to that location',
          'FIFO cost layers are created at the received unit price',
          'The PO status becomes Received or Partially Received if some items are still outstanding',
          'The supplier\'s balance increases by the received amount',
        ],
        tip: 'Partial receipts are supported — the PO stays open until all items are received or the PO is closed.',
      },
      {
        title: 'Paying a supplier',
        description: 'Record payments made to a supplier against their balance.',
        details: [
          'Go to Suppliers → click the supplier name',
          'Open the Ledger tab',
          'Click Record Payment',
          'Enter the amount paid',
          'The supplier\'s outstanding balance is reduced immediately',
          'Every transaction is permanently recorded (immutable ledger)',
        ],
        link: '/suppliers',
        linkLabel: 'Go to Suppliers',
      },
    ],
  },

  // ── 4. Transfers ────────────────────────────────────────────────────────
  {
    title: 'Stock Transfers',
    icon: '🔄',
    intro: 'Move stock between locations — for example from the warehouse to a shop. Transfers go through an approval and in-transit stage to maintain an accurate audit trail.',
    steps: [
      {
        title: 'Creating a transfer',
        description: 'Request to move stock from one location to another.',
        details: [
          'Go to Transfers → Create Transfer',
          'Select the spare part to transfer',
          'Choose the source location (where stock is coming from)',
          'Choose the destination location (where it is going)',
          'Enter the quantity to transfer',
          'Add optional notes',
          'Save — the transfer status is Pending and awaits Manager/Admin approval',
        ],
        tip: 'Storekeepers and Admins can create transfers. Only Managers and Admins can approve them.',
        link: '/transfers',
        linkLabel: 'Go to Transfers',
      },
      {
        title: 'Approving and completing a transfer',
        description: 'A Manager or Admin moves the transfer through to completion.',
        details: [
          'Open a Pending transfer → click Approve Transfer',
          'On approval the stock is deducted from the source and the transfer moves to In Transit',
          'The destination confirms arrival by clicking Receive — stock is added to the destination',
          'FIFO cost layers follow the stock to the new location',
          'Status becomes Received — the transfer is complete',
        ],
      },
    ],
  },

  // ── 5. Inventory Audits ─────────────────────────────────────────────────
  {
    title: 'Inventory Audits',
    icon: '✅',
    intro: 'Periodically verify your physical stock matches the system. Audits create a snapshot of expected quantities, then compare them to your physical count.',
    steps: [
      {
        title: 'Starting an audit',
        description: 'Initiate a count session for a location.',
        details: [
          'Go to Audits → Start Audit',
          'Choose the audit type: Cycle Count (a subset of parts) or Full Stock Count (all parts)',
          'Select the location to audit',
          'The system takes a snapshot of all current stock quantities at that moment',
          'The audit status becomes Initiated (it moves to In Progress once you enter the first count)',
        ],
        tip: 'Run audits during quiet periods to minimise stock movement while counting.',
        link: '/audits',
        linkLabel: 'Go to Audits',
      },
      {
        title: 'Entering counts',
        description: 'Record the physical quantities you find on the shelves.',
        details: [
          'Open the audit while it is Initiated or In Progress',
          'For each part listed, enter the physical quantity you counted in the Physical Count column',
          'The system shows the system quantity (from the snapshot) and your count side by side',
          'Variances (physical count − system quantity) are calculated and highlighted automatically',
          'Click Submit Counts to save — you can come back and update a count, and the first submission moves the audit to In Progress',
        ],
      },
      {
        title: 'Completing and reconciling',
        description: 'Finalise the audit and apply any adjustments.',
        details: [
          'Once the counts are entered, a Manager or Admin reviews the variances',
          'A Manager or Admin clicks Approve Audit to complete it',
          'The system adjusts the stock quantities to match the physical count (only parts with a non-zero variance are adjusted)',
          'Every adjustment is written to the immutable inventory movement ledger',
          'The audit status becomes Completed and the record is permanently stored for compliance and reporting',
        ],
      },
    ],
  },

  // ── 6. Reports & Dashboard ──────────────────────────────────────────────
  {
    title: 'Reports & Dashboard',
    icon: '📊',
    intro: 'Get insight into your business performance. Reports can be exported as CSV or PDF.',
    steps: [
      {
        title: 'Dashboard',
        description: 'A live summary of your business at a glance.',
        details: [
          'Today\'s sales total and the number of transactions',
          'Monthly sales revenue',
          'Total outstanding customer receivables',
          'Low stock count — how many parts are at or below their minimum level',
          'Top 5 selling products (filterable by last month, 3M, 6M, 1Y, or all time)',
          'Top 5 customers by revenue',
          'Data refreshes automatically every 5 minutes',
        ],
        link: '/dashboard',
        linkLabel: 'Go to Dashboard',
      },
      {
        title: 'Profit Summary (Admin & Manager only)',
        description: 'A financial health widget showing revenue, cost of goods, and gross profit for any period — visible only to Admin and Manager roles.',
        details: [
          'Four metric cards: Revenue, Cost of Goods Sold (COGS), Gross Profit, and Margin %',
          'Margin colour coding: green ≥ 20% (healthy), amber 10–19% (moderate), red < 10% (low)',
          'Waterfall bar chart shows how revenue splits into COGS and gross profit at a glance',
          'Period filter: This Month, 3 Months, 6 Months, 1 Year, All Time',
          'Sale count shown under Revenue so you know how many transactions the margin is based on',
          'Click "View full Financial Report" to drill into the detailed report with CSV/PDF export',
          'Salespersons and Storekeepers do not see this widget — it is not shown and the API call is not made',
        ],
        tip: 'Gross Profit = Revenue − Cost of Goods Sold. COGS is calculated using FIFO cost layers at the time each sale is confirmed.',
        link: '/dashboard',
        linkLabel: 'Go to Dashboard',
      },
      {
        title: 'Generating reports',
        description: 'Detailed reports with date filters and export options.',
        details: [
          'Go to Reports and choose a report type:',
          'Sales Report — revenue, number of transactions, and payment types by period',
          'Inventory Report — stock quantities, values at cost, and low-stock items',
          'Customer Report — outstanding balances and aging (30/60/90+ days)',
          'Supplier Report — amounts owed and payment history',
          'Financial Summary — gross profit, COGS breakdown, and net sales',
          'Set your date range and click Generate',
          'Click Export CSV or Export PDF to download',
        ],
        tip: 'Reports are available to Managers and Admins only.',
        link: '/reports',
        linkLabel: 'Go to Reports',
      },
    ],
  },

  // ── 7. Notifications ────────────────────────────────────────────────────
  {
    title: 'Notifications',
    icon: '🔔',
    intro: 'The system automatically sends you alerts when something needs your attention. Each user only sees their own notifications.',
    steps: [
      {
        title: 'Understanding notifications',
        description: 'What triggers a notification and who receives it.',
        details: [
          'Low Stock Alert — sent to Storekeepers, Managers, and Admins when a part\'s quantity drops to or below its minimum level',
          'Credit Limit Exceeded — sent to Managers and Admins when a customer\'s balance exceeds their credit limit',
          'Overdue Customer — sent to Managers and Admins when a customer has an outstanding balance for 90+ days',
          'Pending Approval — sent to Managers and Admins when a transfer or purchase order has been waiting for approval for more than 24 hours',
        ],
        link: '/notifications',
        linkLabel: 'Go to Notifications',
      },
      {
        title: 'Managing notifications',
        description: 'Keep your notification list clean.',
        details: [
          'Open Notifications from the left sidebar',
          'Unread notifications are highlighted',
          'Click on a notification to mark it as read',
          'Click Mark All as Read to clear them all at once',
          'The bell icon in the top header shows your unread count',
        ],
        link: '/notifications',
        linkLabel: 'Go to Notifications',
      },
    ],
  },

  // ── 8. Account & Settings ───────────────────────────────────────────────
  {
    title: 'Account & Settings',
    icon: '⚙️',
    intro: 'Manage your own account, change your password, and (if you are an Admin) configure the system and manage users.',
    steps: [
      {
        title: 'Viewing your profile',
        description: 'See your account details and change your password.',
        details: [
          'Click your username in the sidebar (bottom-left) or in the top header',
          'Your Profile page shows: username, email, role, account status, and when you joined',
          'When signing in, your username and email are not case-sensitive — capitalization does not matter. Your password is case-sensitive.',
          'To change your password: enter your current password, then your new password twice',
          'Password requirements: minimum 8 characters, uppercase, lowercase, and digit',
          'You can change your own password regardless of your role',
          'Account lockout: after 5 failed login attempts within 15 minutes, an account is locked for 30 minutes. Wait it out, or ask an Admin to reset your password (which unlocks it immediately)',
        ],
        link: '/profile',
        linkLabel: 'Go to My Profile',
      },
      {
        title: 'Managing users (Admin only)',
        description: 'Create, edit, deactivate, and reset passwords for staff accounts.',
        details: [
          'Go to Settings → User Management tab',
          'Click Create User to add a new staff member',
          'All new users must change their password on first login',
          'To edit a user: click Edit to change their email, role, or active status',
          'To deactivate a user: Edit them and set Status to Inactive',
          'Deactivated users cannot log in but their history is preserved',
          'To reset a password: click Reset password on the user\'s row, set a temporary password, and share it securely — the user must change it on next login, and this also clears any account lockout',
        ],
        tip: 'If a user is locked out from too many failed logins, resetting their password clears the lock in the same step.',
        link: '/settings',
        linkLabel: 'Go to Settings',
      },
      {
        title: 'Business profile (Admin only)',
        description: 'Update company information that appears on invoices and reports.',
        details: [
          'Go to Settings → Business Profile tab',
          'Update: name, address, email, tax ID, logo, and invoice footer',
          'Phone numbers: click "Add phone number" to add more — label each one (e.g. "Main", "WhatsApp", "Abuja Branch") — up to 10 supported',
          'Bank accounts: click "Add bank account" to add more — all accounts are printed on every invoice — up to 10 supported',
          'Changes apply to all invoices generated from that point forward',
          'To update an existing invoice: open the sale → click Regenerate Invoice',
        ],
        link: '/settings',
        linkLabel: 'Go to Settings',
      },
      {
        title: 'Currency display',
        description: 'Change the currency symbol shown throughout the app.',
        details: [
          'Go to Settings → System Settings tab',
          'Select your preferred currency (NGN, USD, GBP, EUR, and more)',
          'The change takes effect immediately across all pages',
          'This is a display setting only — it does not convert values',
        ],
        link: '/settings',
        linkLabel: 'Go to Settings',
      },
    ],
  },

  // ── 9. Role permissions ─────────────────────────────────────────────────
  {
    title: 'Role Permissions',
    icon: '🔐',
    intro: 'There are four roles. Each person should have the role that matches their job — this keeps sensitive actions protected at every layer.',
    steps: [
      {
        title: 'How access control works',
        description: 'The system enforces permissions at three layers — if any check fails, access is denied.',
        details: [
          'Layer 1 — Page access: users are automatically redirected to the Dashboard if they try to open a page they don\'t have access to (even by typing the URL directly)',
          'Layer 2 — Sidebar navigation: only pages you have access to appear in the menu',
          'Layer 3 — API enforcement: the backend independently verifies your role on every action and returns "Access denied" if it doesn\'t match',
          'This means a user can never bypass permissions by guessing URLs or manipulating the browser — the backend always has the final say',
        ],
        tip: 'If a user gets redirected to the Dashboard unexpectedly, it means their role does not have access to that page. An Admin needs to change their role in Settings if they need access.',
      },
      {
        title: 'Admin',
        description: 'Full access to every part of the system.',
        details: [
          'Everything a Manager can do, plus:',
          'Create, edit, and deactivate user accounts (Settings page)',
          'Update business profile and system settings',
          'Delete categories and locations',
          'View the Profit Summary on the dashboard',
          'Access all reports and audit records',
        ],
      },
      {
        title: 'Manager',
        description: 'Operational oversight — approvals, reports, and financial actions.',
        details: [
          'Approve and reject purchase orders and transfers',
          'Process sales returns and credit adjustments',
          'View all reports (sales, inventory, customer, supplier, financial)',
          'View the Profit Summary on the dashboard',
          'Manage suppliers and purchase orders',
          'Approve inventory audits and reconcile variances',
          'Create and edit categories and locations',
          'Delete customers and suppliers',
        ],
      },
      {
        title: 'Salesperson',
        description: 'Front-line sales and customer management.',
        details: [
          'Create, confirm, and cancel sales (cannot process returns)',
          'Create and manage customers',
          'Record customer payments',
          'Generate and download invoices',
          'View inventory stock levels (cannot adjust stock)',
          'View the dashboard (without Profit Summary) and their own notifications',
          'Cannot access: Categories, Suppliers, Purchases, Reports, Transfers, Audits, Locations, Settings',
        ],
      },
      {
        title: 'Storekeeper',
        description: 'Inventory and warehouse operations.',
        details: [
          'Add and edit spare parts',
          'Adjust stock quantities',
          'Create and receive transfers',
          'Initiate and submit inventory audits for approval',
          'Receive purchase order goods (GRN)',
          'Generate and assign barcodes',
          'Manage locations',
          'View the dashboard (without Profit Summary) and their own notifications',
          'Cannot access: Categories, Sales, Customers, Suppliers, Purchases, Reports, Settings',
        ],
      },
      {
        title: 'Page access by role',
        description: 'Quick reference showing which pages each role can access.',
        details: [
          'All roles: Dashboard, Inventory (view), Notifications, Profile, User Guide',
          'Admin + Manager: Categories, Suppliers, Purchases, Reports, Profit Summary',
          'Admin + Manager + Storekeeper: Transfers, Audits, Locations',
          'Admin + Manager + Salesperson: Sales, Customers',
          'Admin only: Settings (user management, business profile)',
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function GuidePage() {
  const [openSection, setOpenSection] = useState<number>(0);

  function toggleSection(index: number) {
    setOpenSection(openSection === index ? -1 : index);
  }

  return (
    <div className="space-y-6">

      {/* Page header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">User Guide</h1>
        <p className="mt-1 text-sm text-gray-500">
          Step-by-step instructions for every feature in Invenzo.
        </p>
      </div>

      {/* Quick start tip */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
        <p className="text-sm text-blue-800">
          <strong>New here?</strong> Follow the{' '}
          <button
            type="button"
            onClick={() => setOpenSection(0)}
            className="font-semibold underline underline-offset-2 hover:text-blue-900"
          >
            First-Time Setup
          </button>{' '}
          section in order:{' '}
          <span className="whitespace-nowrap">Business Profile →</span>{' '}
          <span className="whitespace-nowrap">Locations →</span>{' '}
          <span className="whitespace-nowrap">Categories →</span>{' '}
          <span className="whitespace-nowrap">Spare Parts →</span>{' '}
          <span className="whitespace-nowrap">Users.</span>{' '}
          Categories and the first Admin account are created automatically when the system
          starts for the first time.
        </p>
      </div>

      {/* Jump links */}
      <nav aria-label="Guide sections" className="flex flex-wrap gap-2">
        {GUIDE_SECTIONS.map((section, i) => (
          <button
            key={section.title}
            type="button"
            onClick={() => setOpenSection(i)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              openSection === i
                ? 'bg-[#667eea] text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            <span aria-hidden="true">{section.icon}</span>
            {section.title}
          </button>
        ))}
      </nav>

      {/* Accordion sections */}
      <div className="space-y-3">
        {GUIDE_SECTIONS.map((section, sectionIndex) => {
          const isOpen = openSection === sectionIndex;
          return (
            <div
              key={section.title}
              className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm"
            >
              {/* Section header */}
              <button
                type="button"
                onClick={() => toggleSection(sectionIndex)}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-2xl leading-none" aria-hidden="true">
                    {section.icon}
                  </span>
                  <div>
                    <p className="font-semibold text-gray-900">{section.title}</p>
                    <p className="mt-0.5 text-xs text-gray-500 hidden sm:block">
                      {section.intro}
                    </p>
                  </div>
                </div>
                <svg
                  className={`h-5 w-5 shrink-0 text-gray-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* Section body */}
              {isOpen && (
                <div className="border-t border-gray-100">
                  {/* Intro on mobile (hidden on sm+ from the header) */}
                  <p className="px-5 pt-4 text-sm text-gray-600 sm:hidden">{section.intro}</p>

                  <div className="divide-y divide-gray-100">
                    {section.steps.map((step, stepIndex) => (
                      <div key={stepIndex} className="px-5 py-5 space-y-3">
                        {/* Step title */}
                        <h3 className="font-semibold text-gray-900">{step.title}</h3>

                        {/* Description */}
                        <p className="text-sm text-gray-600">{step.description}</p>

                        {/* Detail bullets */}
                        <ul className="space-y-1.5 pl-1">
                          {step.details.map((detail, i) => (
                            <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#667eea]" aria-hidden="true" />
                              <span>{detail}</span>
                            </li>
                          ))}
                        </ul>

                        {/* Tip callout */}
                        {step.tip && (
                          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
                            <span className="text-base leading-none mt-0.5" aria-hidden="true">💡</span>
                            <p className="text-xs text-amber-800">{step.tip}</p>
                          </div>
                        )}

                        {/* Navigation link */}
                        {step.link && (
                          <div>
                            <Link
                              href={step.link}
                              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-[#667eea] ring-1 ring-[#667eea]/30 hover:bg-[#667eea]/5 transition-colors"
                            >
                              {step.linkLabel}
                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                              </svg>
                            </Link>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <p className="pb-2 text-center text-xs text-gray-400">
        Need help?{' '}
        <a
          href="mailto:support@invenzo.app"
          className="text-[#667eea] hover:underline"
        >
          Contact support
        </a>
      </p>
    </div>
  );
}
