// Who may do what. A user holds one role in each organisation they belong to.
// Kitovu roles apply across the whole platform; every other role applies to its own organisation only.
// The future data layer (receipts, loans) adds a second rule: lenders see only what they finance.

export const PERMISSIONS = [
  'users.manage', 'orgs.manage', 'audit.view', 'settings.manage',
  'farmers.view', 'farmers.edit', 'field_partners.manage',
  'warehouses.view', 'warehouses.edit', 'stock.manage',
  'receipts.view', 'receipts.issue',
  'finance.view', 'finance.approve', 'finance.configure',
  'reports.view',
] as const;
export type Permission = typeof PERMISSIONS[number];
export type OrgKind = 'kitovu' | 'lender' | 'warehouse_operator' | 'buyer' | 'insurer' | 'cooperative' | 'field_partner_network' | 'distribution_partner' | 'other';

interface RoleDef { label: string; perms: readonly Permission[] }
const ALL = PERMISSIONS;

export const ROLES: Record<OrgKind, Record<string, RoleDef>> = {
  kitovu: {
    super_admin: { label: 'Super admin', perms: ALL },
    ops_manager: { label: 'Operations manager', perms: ['users.manage', 'audit.view', 'farmers.view', 'farmers.edit', 'field_partners.manage', 'warehouses.view', 'warehouses.edit', 'stock.manage', 'receipts.view', 'receipts.issue', 'finance.view', 'reports.view'] },
    finance: { label: 'Finance', perms: ['audit.view', 'farmers.view', 'warehouses.view', 'receipts.view', 'finance.view', 'finance.approve', 'finance.configure', 'reports.view'] },
    compliance: { label: 'Compliance', perms: ['audit.view', 'farmers.view', 'warehouses.view', 'receipts.view', 'finance.view', 'reports.view'] },
    field_supervisor: { label: 'Field supervisor', perms: ['farmers.view', 'farmers.edit', 'field_partners.manage', 'warehouses.view', 'stock.manage', 'receipts.view', 'receipts.issue'] },
    viewer: { label: 'Viewer', perms: ['farmers.view', 'warehouses.view', 'receipts.view', 'finance.view', 'reports.view'] },
  },
  lender: {
    lender_admin: { label: 'Lender admin', perms: ['users.manage', 'audit.view', 'warehouses.view', 'receipts.view', 'finance.view', 'finance.approve', 'finance.configure', 'reports.view'] },
    credit_officer: { label: 'Credit officer', perms: ['warehouses.view', 'receipts.view', 'finance.view', 'finance.approve', 'reports.view'] },
    lender_viewer: { label: 'Viewer', perms: ['warehouses.view', 'receipts.view', 'finance.view', 'reports.view'] },
  },
  warehouse_operator: {
    warehouse_manager: { label: 'Warehouse manager', perms: ['users.manage', 'audit.view', 'warehouses.view', 'stock.manage', 'receipts.view'] },
    warehouse_clerk: { label: 'Warehouse clerk', perms: ['warehouses.view', 'stock.manage', 'receipts.view'] },
  },
  buyer: { buyer_admin: { label: 'Buyer admin', perms: ['users.manage', 'receipts.view'] } },
  insurer: { insurer_viewer: { label: 'Insurer', perms: ['warehouses.view', 'receipts.view', 'reports.view'] } },
  cooperative: { coop_admin: { label: 'Cooperative admin', perms: ['users.manage', 'farmers.view'] } },
  field_partner_network: { network_admin: { label: 'Network admin', perms: ['users.manage', 'farmers.view', 'farmers.edit', 'field_partners.manage'] } },
  distribution_partner: { partner_admin: { label: 'Partner admin', perms: ['users.manage', 'receipts.view'] } },
  other: {},
};

export interface Membership { org_id: string; org_kind: OrgKind; org_name: string; role: string }

export const roleDef = (kind: OrgKind, role: string): RoleDef | undefined => ROLES[kind]?.[role];
export const validRole = (kind: OrgKind, role: string) => !!roleDef(kind, role);
export const permsOf = (m: Membership): readonly Permission[] => roleDef(m.org_kind, m.role)?.perms ?? [];

/**
 * May the holder of `m` (their active membership) use `perm`, optionally against organisation `targetOrgId`?
 * Kitovu memberships reach every organisation; others only their own.
 */
export function can(m: Membership | null | undefined, perm: Permission, targetOrgId?: string | null) {
  if (!m) return false;
  if (!permsOf(m).includes(perm)) return false;
  if (m.org_kind === 'kitovu') return true;
  return !targetOrgId || targetOrgId === m.org_id;
}

/**
 * May `m` grant `role` in an organisation of `kind` with id `targetOrgId`? Needs users.manage there, and the new
 * role may not carry any permission the granter lacks (no privilege escalation). Only a super admin makes another.
 */
export function canGrant(m: Membership | null | undefined, kind: OrgKind, targetOrgId: string, role: string) {
  if (!m || !can(m, 'users.manage', targetOrgId)) return false;
  const def = roleDef(kind, role);
  if (!def) return false;
  if (kind === 'kitovu' && role === 'super_admin') return m.org_kind === 'kitovu' && m.role === 'super_admin';
  const mine = new Set(permsOf(m));
  return def.perms.every((p) => mine.has(p));
}
