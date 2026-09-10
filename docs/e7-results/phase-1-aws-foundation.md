# E7 Phase 1 -- AWS Foundation (command log)

Region: **eu-west-1** · Account: **218201720464** · Principal:
`arn:aws:iam::218201720464:user/compliance-deploy` (not root)

See **ADR-038** for the rationale behind every choice below.

---

## 1. Recon (read-only)

```
aws sts get-caller-identity
#   -> account 218201720464, user compliance-deploy

aws ec2 describe-vpcs --query 'Vpcs[?IsDefault==`true`].[VpcId,CidrBlock]'
#   -> vpc-0e33cd6ddb35e6748   172.31.0.0/16

aws ec2 describe-subnets --filters Name=vpc-id,Values=vpc-0e33cd6ddb35e6748
#   eu-west-1a  subnet-01107a25b60d78929  172.31.16.0/20  (public)
#   eu-west-1b  subnet-0ecdd912f5c720c8a  172.31.32.0/20  (public)
#   eu-west-1c  subnet-0d2539fac156ccef6  172.31.0.0/20   (public)

aws rds describe-db-engine-versions --engine postgres \
  --query "DBEngineVersions[?starts_with(EngineVersion,'18')].EngineVersion"
#   -> 18.1 18.2 18.3 18.4 18.6   (using 18.4 -- matches local dev container)

curl -s https://checkip.amazonaws.com
#   -> 217.165.199.47   (operator IP for the SSH rule; dynamic -- see runbook)
```

Deploy-user permission probe: **can** EC2 / RDS / S3 / Secrets Manager / ECR.
**cannot** IAM, Route53, ACM (all AccessDenied) -> `ec2-app-role` is created
by the operator from an admin session (§4 below); DNS is on Hostinger; TLS is
Let's Encrypt.

---

## 2. Security groups  (DONE -- free)

```
aws ec2 create-security-group --group-name compliance-app-sg \
  --description "Compliance SaaS EC2 host: SSH from operator IP, HTTP/HTTPS public" \
  --vpc-id vpc-0e33cd6ddb35e6748 \
  --tag-specifications 'ResourceType=security-group,Tags=[{Key=Name,Value=compliance-app-sg},{Key=Project,Value=employee-compliance-saas},{Key=Epoch,Value=E7}]'
#   -> sg-02d0a10340ecf1da6

aws ec2 create-security-group --group-name compliance-rds-sg \
  --description "Compliance SaaS RDS: 5432 from compliance-app-sg only, no egress" \
  --vpc-id vpc-0e33cd6ddb35e6748 \
  --tag-specifications 'ResourceType=security-group,Tags=[{Key=Name,Value=compliance-rds-sg},{Key=Project,Value=employee-compliance-saas},{Key=Epoch,Value=E7}]'
#   -> sg-0182cee63337b13fb

aws ec2 authorize-security-group-ingress --group-id sg-02d0a10340ecf1da6 \
  --ip-permissions 'IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=217.165.199.47/32,Description="operator SSH"}]'

aws ec2 authorize-security-group-ingress --group-id sg-02d0a10340ecf1da6 \
  --ip-permissions \
    'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0,Description="HTTP (redirects to HTTPS)"}]' \
    'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0,Description="HTTPS"}]'

aws ec2 authorize-security-group-ingress --group-id sg-0182cee63337b13fb \
  --ip-permissions 'IpProtocol=tcp,FromPort=5432,ToPort=5432,UserIdGroupPairs=[{GroupId=sg-02d0a10340ecf1da6,Description="Postgres from app host"}]'

aws ec2 revoke-security-group-egress --group-id sg-0182cee63337b13fb \
  --ip-permissions 'IpProtocol=-1,IpRanges=[{CidrIp=0.0.0.0/0}]'
```

### Result

| Group | Id | Ingress | Egress |
| --- | --- | --- | --- |
| `compliance-app-sg` | `sg-02d0a10340ecf1da6` | 22 <- 217.165.199.47/32 · 80,443 <- 0.0.0.0/0 | allow all |
| `compliance-rds-sg` | `sg-0182cee63337b13fb` | 5432 <- compliance-app-sg | none |

---

## 3. Secrets Manager  (DONE -- ~$2/month)

Five `SecretString` JSON secrets, default `aws/secretsmanager` KMS key
(`KmsKeyId: null` -- no customer-managed CMK, no $1/key/month charge),
passwords via `openssl rand -hex 20`. Created `2026-09-09`, tagged
`Project=employee-compliance-saas` / `Epoch=E7`.

Naming note: the secrets were created **without** a leading slash --
`compliance/prod/database`, not `/compliance/prod/database`. The IAM policy
resource pattern (§4) and ADR-038's table are aligned to the created form:
`arn:aws:secretsmanager:eu-west-1:218201720464:secret:compliance/prod/*`.
A leading-slash pattern would NOT match these ARNs and the instance would
get AccessDenied on every secret read.

| Name | ARN | Keys |
| --- | --- | --- |
| `compliance/prod/database` | `...:secret:compliance/prod/database-I5kSwy` | DB_HOST, DB_PORT, DB_NAME, DB_APP_USER, DB_APP_PASSWORD, DB_MIGRATION_USER, DB_MIGRATION_PASSWORD, DB_MASTER_USER, DB_MASTER_PASSWORD |
| `compliance/prod/redis` | `...:secret:compliance/prod/redis-c89JOv` | REDIS_HOST, REDIS_PORT, REDIS_PASSWORD |
| `compliance/prod/keycloak` | `...:secret:compliance/prod/keycloak-duRl5L` | KC_HOSTNAME, KC_DB_PASSWORD, KC_ADMIN_PASSWORD |
| `compliance/prod/smtp` | `...:secret:compliance/prod/smtp-HrSByi` | SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS |
| `compliance/prod/app` | `...:secret:compliance/prod/app-2D1HnF` | NODE_ENV, PORT |

`DB_HOST` in `compliance/prod/database` is a `CHANGE_ME` placeholder until
the RDS endpoint exists (§5); the operator writes it back with
`aws secretsmanager put-secret-value` once RDS is provisioned.

---

## 4. IAM `ec2-app-role`  (DONE -- 2026-09-10, operator ran this from an admin session)

`ec2-app-role` created with the inline policy `compliance-ec2-app-policy`
(`infra/aws/iam/ec2-app-role-permissions.json`) attached; the console
auto-created the matching instance profile.

`compliance-deploy` has no IAM permissions. From an **admin** console/CLI
session:

### Console
1. IAM -> Roles -> Create role -> Trusted entity: **AWS service** -> **EC2**.
2. Skip the managed-policy screen (Next).
3. Name: **`ec2-app-role`**. Create.
4. Open the role -> Add permissions -> Create inline policy -> JSON tab ->
   paste `infra/aws/iam/ec2-app-role-permissions.json` -> name it
   **`compliance-ec2-app-policy`** -> Create.
5. (Console auto-creates the instance profile `ec2-app-role`.)

### Or CLI (admin creds)
```
aws iam create-role --role-name ec2-app-role \
  --assume-role-policy-document file://infra/aws/iam/ec2-app-role-trust-policy.json

aws iam put-role-policy --role-name ec2-app-role \
  --policy-name compliance-ec2-app-policy \
  --policy-document file://infra/aws/iam/ec2-app-role-permissions.json

aws iam create-instance-profile --instance-profile-name ec2-app-role
aws iam add-role-to-instance-profile \
  --instance-profile-name ec2-app-role --role-name ec2-app-role
```

The inline policy grants (least privilege -- NOT the prompt's broad managed
policies; see ADR-038):
- Secrets Manager **read** on `compliance/prod/*` + `kms:Decrypt` via
  Secrets Manager only
- CloudWatch Logs **write** on `/compliance/*` only
- S3 on `s3://compliance-prod-backups-218201720464` **only**
- ECR pull for `compliance-api` / `compliance-worker` **only**

---

## 5. RDS PostgreSQL  (CREATING -- 2026-09-10, ~$15-17/month)

`postgres` 18.4 · `db.t3.micro` · 20 GB gp2 · **storage encrypted**
(`aws/rds` KMS key) · Single-AZ · not public · `compliance-rds-sg` ·
subnet group `compliance-db-subnets` · DB `compliance_db` · master
`compliance_master` · **deletion protection ON** · `copy-tags-to-snapshot`.

```
CREDS=$(aws secretsmanager get-secret-value --secret-id compliance/prod/database --query SecretString --output text)
aws rds create-db-instance \
  --db-instance-identifier compliance-db \
  --engine postgres --engine-version 18.4 \
  --db-instance-class db.t3.micro \
  --allocated-storage 20 --storage-type gp2 --storage-encrypted \
  --no-multi-az --no-publicly-accessible \
  --db-name compliance_db \
  --master-username "$(echo "$CREDS" | jq -r .DB_MASTER_USER)" \
  --master-user-password "$(echo "$CREDS" | jq -r .DB_MASTER_PASSWORD)" \
  --vpc-security-group-ids sg-0182cee63337b13fb \
  --db-subnet-group-name compliance-db-subnets \
  --backup-retention-period 1 \
  --deletion-protection --copy-tags-to-snapshot \
  --tags Key=Name,Value=compliance-db Key=Project,Value=employee-compliance-saas Key=Epoch,Value=E7
```

**Backup-retention deviation:** the plan (§ADR-038) calls for 7-day
automated backups, but this account is on the AWS **Free Plan**, which
rejects `--backup-retention-period 7`:

```
FreeTierRestrictionError: The specified backup retention period exceeds
the maximum available to free tier customers.
```

Created with `--backup-retention-period 1`. Retention is mutable
post-creation -- once the account is upgraded off the Free Plan:

```
aws rds modify-db-instance --db-instance-identifier compliance-db \
  --backup-retention-period 7 --apply-immediately
```

**Storage encryption** (`--storage-encrypted`) was added beyond §ADR-038's
original text: it is immutable after creation and this is a compliance
data store. `aws/rds` managed key, no extra cost.

### After `available`
1. Record the endpoint address below.
2. Write `DB_HOST` back into `compliance/prod/database`:
   `aws secretsmanager put-secret-value --secret-id compliance/prod/database --secret-string ...`
3. Create `keycloak_db` (post-provision `CREATE DATABASE`).
4. Run `001..00N` migrations as `migration_user`; verify RLS / FORCE RLS /
   NULLIF guard / `tenant_isolation_*` policies / `audit_events`
   SELECT+INSERT-only grant.

| Field | Value |
| --- | --- |
| Identifier | `compliance-db` |
| Endpoint | *(pending -- fill after `available`)* |
| Port | 5432 |
| Engine | postgres 18.4 |
| Encrypted | yes (`aws/rds`) |
| Backup retention | 1 day (Free Plan cap; target 7) |
| Deletion protection | ON |

---

## Resource inventory (running total)

| Kind | Name | Id / ARN | Cost |
| --- | --- | --- | --- |
| Security group | compliance-app-sg | `sg-02d0a10340ecf1da6` | free |
| Security group | compliance-rds-sg | `sg-0182cee63337b13fb` | free |
| Secret | compliance/prod/database | `...:secret:compliance/prod/database-I5kSwy` | ~$0.40/mo |
| Secret | compliance/prod/redis | `...:secret:compliance/prod/redis-c89JOv` | ~$0.40/mo |
| Secret | compliance/prod/keycloak | `...:secret:compliance/prod/keycloak-duRl5L` | ~$0.40/mo |
| Secret | compliance/prod/smtp | `...:secret:compliance/prod/smtp-HrSByi` | ~$0.40/mo |
| Secret | compliance/prod/app | `...:secret:compliance/prod/app-2D1HnF` | ~$0.40/mo |
| IAM role + instance profile | ec2-app-role | created, `compliance-ec2-app-policy` attached (§4) | free |
| DB subnet group | compliance-db-subnets | 1a/1b/1c, vpc-0e33cd6ddb35e6748 | free |
| RDS instance | compliance-db | creating -- endpoint TBD (§5) | ~$15-17/mo |
