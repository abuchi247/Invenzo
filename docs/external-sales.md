# Externally sourced sales

Built on `main` at `a0b8a99`, in branch `codex/externally-sourced-sales`. This feature assumes an agreed purchase price with the supplying store; commission/consignment arrangements need a different settlement model.

## Using the feature

1. Add the other store under Suppliers.
2. On Create Sale or Edit Draft, choose **Add externally sourced item**.
3. Enter the description, optional part number, supplier, quantity, supplier cost, selling price, and any supplier payment already made.
4. Add your own stock items to the same sale if needed, then confirm normally.
5. On the supplier page, review the balance and transactions and record subsequent payments. Customer payment and supplier payment are independent.

External items do not require a catalogue record. The API can optionally associate them with an existing product, but still treats their stock separately. Supplier cost and payment details remain internal; receipts show the item description, quantity, price, and discount. Drafts do not affect balances. Confirming records cost and supplier debt/payment atomically; a locked sale row prevents duplicate confirmation.

## Returns

Customer returns are tracked per external sale item and never increase owned stock. The supplier debt remains until the supplier accepts the goods and credits their cost. The sale detail page shows units awaiting acceptance and allows users with purchasing permission to confirm acceptance. The API supports partial supplier acceptance. A supplier credit after payment remains a credit on that supplier account; it does not claim that a cash refund was received.

The customer credit note includes external items and prorates discounts. Existing cash refund handling remains a manual payment process. Later supplier payments are tracked against the supplier account, not allocated to individual sale items; the sale displays only the payment recorded at checkout.

## Migration and merge order

Migration `0017` extends `sale_items`, preserving existing rows as `STOCK`. It refuses downgrade if external sales exist, to protect transaction history.

This branch is independent of the unfinished operating-expense checkout. Merge this feature first. Before merging the operating-expense branch, rebase it onto the updated main and give its migration the next revision (`0018`, following `0017`) to avoid duplicate revision IDs.

## Verification

Backend coverage includes external-only and mixed sales, supplier payment retries, independent item returns, supplier acceptance, input validation, and existing sales/invoice/supplier regressions. Frontend checks cover form data surviving checkout validation, invalid supplier payments, TypeScript, and production compilation. Migration upgrade/downgrade/re-upgrade and simultaneous confirmation were exercised against a disposable PostgreSQL database.
