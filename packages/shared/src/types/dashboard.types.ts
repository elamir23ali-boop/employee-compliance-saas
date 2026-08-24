import type { DocumentType, ExpiryStatus } from './document.types';

export interface DashboardSummary {
  totalDocuments: number;
  byStatus: Record<ExpiryStatus, number>;
}

export interface DocumentStatsRow {
  docType: DocumentType;
  expiryStatus: ExpiryStatus;
  count: number;
}
