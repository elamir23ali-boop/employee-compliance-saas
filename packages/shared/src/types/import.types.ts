export interface ImportBatch {
  importBatchId: string;
  tenantId: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'ROLLED_BACK';
  totalRows: number;
  processedRows: number;
  errorRows: number;
  createdAt: string;
  completedAt: string | null;
  createdBy: string | null;
}

export interface ImportRowError {
  row: number;
  employeeCode?: string | undefined;
  message: string;
}
