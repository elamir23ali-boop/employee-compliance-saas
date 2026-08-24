import type ExcelJS from 'exceljs';
import type { CreateEmployeeDto } from '@ecs/shared';
import { createEmployeeSchema } from '../employees/employees.schemas';

export type ParsedEmployeeRow = { data: CreateEmployeeDto } | { error: string };

/**
 * Normalizes one exceljs cell value to a plain string (or undefined for an
 * empty cell). exceljs never evaluates formulas -- a formula cell's cached
 * `.result` is used if present; a formula with no cached result (no
 * `.result`, or the formula string itself) is treated as unreadable rather
 * than trusted, since it did not come from a plain data-entry cell.
 */
export function normalizeCellValue(value: ExcelJS.CellValue): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object') {
    if ('richText' in value) {
      return value.richText.map((part) => part.text).join('');
    }
    if ('text' in value && typeof value.text === 'string') {
      return value.text;
    }
    if ('result' in value && value.result !== undefined && typeof value.result !== 'object') {
      return String(value.result);
    }
    return undefined;
  }
  return String(value).trim() || undefined;
}

/** Builds a plain field-name -> string record from a header row and one data row's cells, both 1-indexed as exceljs returns them. */
export function buildRowRecord(headers: string[], rowValues: ExcelJS.CellValue[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  headers.forEach((header, index) => {
    if (!header) return;
    // header/index are drawn from the workbook's own header row, not
    // attacker-controlled property names from a JSON body.
    // eslint-disable-next-line security/detect-object-injection
    record[header] = normalizeCellValue(rowValues[index + 1]);
  });
  return record;
}

/**
 * Pure, side-effect-free row validation -- no DB, no file I/O. Reuses the
 * exact same zod schema the single-employee POST endpoint validates
 * against (employees.controller.ts's createEmployeeSchema), so a row that
 * would be rejected by a manual POST is rejected here for the same reason,
 * not a second, drifting set of rules.
 */
export function parseEmployeeImportRow(rawRow: Record<string, unknown>): ParsedEmployeeRow {
  const parsed = createEmployeeSchema.safeParse(rawRow);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const field = firstIssue?.path.join('.') || 'row';
    const message = firstIssue?.message ?? 'Invalid row';
    return { error: `${field}: ${message}` };
  }
  return { data: parsed.data };
}
