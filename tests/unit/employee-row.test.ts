import { describe, expect, it } from 'vitest';
import {
  buildRowRecord,
  normalizeCellValue,
  parseEmployeeImportRow,
} from '../../apps/api/src/import-export/employee-row';

describe('parseEmployeeImportRow', () => {
  it('IMPROW-01: a valid row parses into a CreateEmployeeDto', () => {
    const result = parseEmployeeImportRow({
      employeeCode: 'EMP-001',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
      department: 'Engineering',
    });
    expect('data' in result).toBe(true);
    if ('data' in result) {
      expect(result.data).toEqual({
        employeeCode: 'EMP-001',
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.test',
        department: 'Engineering',
      });
    }
  });

  it('IMPROW-02: missing required field (lastName) produces a row error', () => {
    const result = parseEmployeeImportRow({ employeeCode: 'EMP-002', firstName: 'Ada' });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('lastName');
    }
  });

  it('IMPROW-03: missing required field (employeeCode) produces a row error', () => {
    const result = parseEmployeeImportRow({ firstName: 'Ada', lastName: 'Lovelace' });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('employeeCode');
    }
  });

  it('IMPROW-04: invalid email produces a row error', () => {
    const result = parseEmployeeImportRow({
      employeeCode: 'EMP-004',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'not-an-email',
    });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('email');
    }
  });

  it('IMPROW-05: unknown extra columns are ignored, not an error', () => {
    const result = parseEmployeeImportRow({
      employeeCode: 'EMP-005',
      firstName: 'Ada',
      lastName: 'Lovelace',
      someRandomColumn: 'ignored',
    });
    expect('data' in result).toBe(true);
    if ('data' in result) {
      expect(result.data).not.toHaveProperty('someRandomColumn');
    }
  });
});

describe('normalizeCellValue', () => {
  it('CELL-01: null/undefined become undefined', () => {
    expect(normalizeCellValue(null)).toBeUndefined();
    expect(normalizeCellValue(undefined)).toBeUndefined();
  });

  it('CELL-02: a plain string is trimmed', () => {
    expect(normalizeCellValue('  Ada  ')).toBe('Ada');
  });

  it('CELL-03: a number is stringified', () => {
    expect(normalizeCellValue(42)).toBe('42');
  });

  it('CELL-04: a rich-text cell concatenates its runs', () => {
    expect(normalizeCellValue({ richText: [{ text: 'Ada ' }, { text: 'Lovelace' }] })).toBe('Ada Lovelace');
  });

  it('CELL-05: a formula cell with a cached result uses the result', () => {
    expect(normalizeCellValue({ formula: 'CONCAT(A1,B1)', result: 'AdaLovelace' })).toBe('AdaLovelace');
  });

  it('CELL-06: a formula cell with no cached result is unreadable (undefined)', () => {
    expect(normalizeCellValue({ formula: 'CONCAT(A1,B1)' })).toBeUndefined();
  });

  it('CELL-07: a blank string becomes undefined', () => {
    expect(normalizeCellValue('   ')).toBeUndefined();
  });
});

describe('buildRowRecord', () => {
  it('ROWREC-01: zips headers to 1-indexed exceljs row values', () => {
    const headers = ['employeeCode', 'firstName', 'lastName'];
    // exceljs row.values is 1-indexed; index 0 is unused.
    const rowValues = [undefined, 'EMP-001', 'Ada', 'Lovelace'];
    expect(buildRowRecord(headers, rowValues)).toEqual({
      employeeCode: 'EMP-001',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
  });

  it('ROWREC-02: a missing trailing cell becomes undefined for that field', () => {
    const headers = ['employeeCode', 'firstName', 'lastName'];
    const rowValues = [undefined, 'EMP-001', 'Ada'];
    expect(buildRowRecord(headers, rowValues)).toEqual({
      employeeCode: 'EMP-001',
      firstName: 'Ada',
      lastName: undefined,
    });
  });
});
