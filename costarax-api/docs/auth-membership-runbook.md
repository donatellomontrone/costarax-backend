# Costarax Auth + Membership Hardening Runbook

This documents the auth/membership hardening work now live in app + API, plus
the remaining database step needed to fully enable atomic supplier relinking.

## Already live in production

- Account context is resolved centrally in `lib/user-context.js`
- `/api/me` returns the real workspace context for the logged-in account
- Buyer/supplier/admin routing uses account context rather than `profiles.role`
- Supplier linking uses a safer backend path with rollback-style fallback
- Admin user responses include richer supplier/business context
- Backend tests cover:
  - role normalization
  - membership scoring/selection
  - supplier-link RPC preference/fallback behavior

## Remaining DB step

Apply:

- `migrations/organization_members_relink.sql`

This creates:

- `public.admin_replace_supplier_link(uuid, uuid)`

Once applied, admin supplier relinking becomes truly atomic at the database
level. Until then, production safely uses the app-layer fallback in
`lib/membership-admin.js`.

## Recommended SQL apply order

If the environment is still missing some of the supporting infra, apply in this
order:

1. `migrations/admin_actions.sql`
2. `migrations/organization_members_integrity.sql`
3. `migrations/organization_members_relink.sql`

## What to verify after applying the relink SQL

### 1. Admin: link a supplier to a user

- Open Admin -> Users
- Pick a supplier user
- Change `Link to supplier`
- Click `Save link`

Expected:

- Success toast
- User row refreshes with the new linked supplier
- Old user previously attached to that supplier is displaced automatically

### 2. Supplier login

- Log out
- Log in with the supplier-linked account

Expected:

- User lands in supplier workspace
- No fallback to another supplier
- No `Your account is not linked to a supplier yet` message if linked

### 3. Duplicate supplier ownership transfer

If supplier `S` was previously attached to user `A`, then linking `S` to user
`B` should result in:

- `B -> S`
- `A -> no supplier`

### 4. Audit log

Check `admin_actions` for:

- `link_supplier_user`
- `unlink_supplier_user`
- notes containing displaced user IDs when applicable

## Current production behavior if the SQL function is not present

The API automatically falls back to the legacy relink path:

- unlink current supplier memberships for the target user
- detach other users from the target supplier
- insert the new link
- verify final state
- best-effort restore on failure

This is good enough for now, but the SQL function is the cleaner end state.

## Quick smoke checklist

- Buyer login resolves correctly
- Supplier login resolves correctly
- Admin login resolves correctly
- Users tab loads without visiting Manage suppliers first
- Save changes does not collapse silently
- Save link stays visible and updates the user row
- Supplier workspace loads even if supplier catalog/supplier list is partial

