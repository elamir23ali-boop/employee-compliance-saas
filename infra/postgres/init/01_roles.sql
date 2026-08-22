-- E0: role setup. migration_user is BYPASSRLS and must NEVER be used by application code.
CREATE ROLE app_user WITH LOGIN PASSWORD 'app_dev_pass_local';
CREATE ROLE migration_user WITH LOGIN PASSWORD 'migration_dev_pass_local' BYPASSRLS;

GRANT CONNECT ON DATABASE e0db TO app_user;
GRANT CONNECT ON DATABASE e0db TO migration_user;

-- PG15+ revokes CREATE on public from PUBLIC by default; migration_user needs it to run migrations.
GRANT USAGE ON SCHEMA public TO app_user;
GRANT USAGE, CREATE ON SCHEMA public TO migration_user;
