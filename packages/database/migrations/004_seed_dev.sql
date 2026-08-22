-- E0: synthetic seed data ONLY. No real employee data or document numbers.
INSERT INTO tenants (id, name, slug, status) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Acme Corp', 'org-tenant-a', 'active'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Beta Industries', 'org-tenant-b', 'active'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Gamma LLC', 'org-tenant-c', 'active');

-- Tenant A employees
INSERT INTO employees (id, tenant_id, employee_code, full_name, department) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'EMP-A1', 'Employee_A1', 'Operations'),
  ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'EMP-A2', 'Employee_A2', 'Operations'),
  ('a0000000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'EMP-A3', 'Employee_A3', 'Finance'),
  ('a0000000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'EMP-A4', 'Employee_A4', 'Finance'),
  ('a0000000-0000-0000-0000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'EMP-A5', 'Employee_A5', 'HR');

-- Tenant B employees
INSERT INTO employees (id, tenant_id, employee_code, full_name, department) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'EMP-B1', 'Employee_B1', 'Operations'),
  ('b0000000-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'EMP-B2', 'Employee_B2', 'Operations'),
  ('b0000000-0000-0000-0000-000000000003', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'EMP-B3', 'Employee_B3', 'Finance'),
  ('b0000000-0000-0000-0000-000000000004', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'EMP-B4', 'Employee_B4', 'Finance'),
  ('b0000000-0000-0000-0000-000000000005', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'EMP-B5', 'Employee_B5', 'HR');

-- Tenant C employees
INSERT INTO employees (id, tenant_id, employee_code, full_name, department) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'EMP-C1', 'Employee_C1', 'Operations'),
  ('c0000000-0000-0000-0000-000000000002', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'EMP-C2', 'Employee_C2', 'Operations'),
  ('c0000000-0000-0000-0000-000000000003', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'EMP-C3', 'Employee_C3', 'Finance'),
  ('c0000000-0000-0000-0000-000000000004', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'EMP-C4', 'Employee_C4', 'Finance'),
  ('c0000000-0000-0000-0000-000000000005', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'EMP-C5', 'Employee_C5', 'HR');

-- Tenant A documents (2 per employee, DOC-A-001..010)
INSERT INTO documents (tenant_id, employee_id, doc_type, doc_number, expiry_date) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000001', 'passport', 'DOC-A-001', '2027-01-15'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000001', 'residence', 'DOC-A-002', '2027-03-10'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000002', 'passport', 'DOC-A-003', '2026-11-20'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000002', 'badge', 'DOC-A-004', '2026-12-31'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000003', 'passport', 'DOC-A-005', '2027-05-05'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000003', 'residence', 'DOC-A-006', '2027-02-14'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000004', 'passport', 'DOC-A-007', '2026-09-09'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000004', 'badge', 'DOC-A-008', '2027-07-07'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000005', 'passport', 'DOC-A-009', '2027-08-08'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000005', 'residence', 'DOC-A-010', '2027-10-10');

-- Tenant B documents (2 per employee, DOC-B-001..010)
INSERT INTO documents (tenant_id, employee_id, doc_type, doc_number, expiry_date) VALUES
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-000000000001', 'passport', 'DOC-B-001', '2027-01-15'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-000000000001', 'residence', 'DOC-B-002', '2027-03-10'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-000000000002', 'passport', 'DOC-B-003', '2026-11-20'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-000000000002', 'badge', 'DOC-B-004', '2026-12-31'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-000000000003', 'passport', 'DOC-B-005', '2027-05-05'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-000000000003', 'residence', 'DOC-B-006', '2027-02-14'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-000000000004', 'passport', 'DOC-B-007', '2026-09-09'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-000000000004', 'badge', 'DOC-B-008', '2027-07-07'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-000000000005', 'passport', 'DOC-B-009', '2027-08-08'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-000000000005', 'residence', 'DOC-B-010', '2027-10-10');

-- Tenant C documents (2 per employee, DOC-C-001..010)
INSERT INTO documents (tenant_id, employee_id, doc_type, doc_number, expiry_date) VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000001', 'passport', 'DOC-C-001', '2027-01-15'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000001', 'residence', 'DOC-C-002', '2027-03-10'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000002', 'passport', 'DOC-C-003', '2026-11-20'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000002', 'badge', 'DOC-C-004', '2026-12-31'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000003', 'passport', 'DOC-C-005', '2027-05-05'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000003', 'residence', 'DOC-C-006', '2027-02-14'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000004', 'passport', 'DOC-C-007', '2026-09-09'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000004', 'badge', 'DOC-C-008', '2027-07-07'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000005', 'passport', 'DOC-C-009', '2027-08-08'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c0000000-0000-0000-0000-000000000005', 'residence', 'DOC-C-010', '2027-10-10');
