export type TenantStatus = 'active' | 'inactive';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  createdAt: string;
}
