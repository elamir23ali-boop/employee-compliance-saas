export const ROLES = {
  PLATFORM_ADMIN: 'platform-admin',
  TENANT_ADMIN: 'tenant-admin',
  HR_MANAGER: 'hr-manager',
  HR_STAFF: 'hr-staff',
  VIEWER: 'viewer',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ROLE_HIERARCHY: Record<Role, number> = {
  'platform-admin': 5,
  'tenant-admin': 4,
  'hr-manager': 3,
  'hr-staff': 2,
  viewer: 1,
};
