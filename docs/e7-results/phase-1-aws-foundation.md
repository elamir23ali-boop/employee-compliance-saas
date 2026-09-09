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

## 3. Secrets Manager  (PENDING)

Five secrets under `/compliance/prod/*`, `aws/secretsmanager` KMS key,
passwords via `openssl rand -hex 20`. `DB_HOST` in `/compliance/prod/database`
is written back after the RDS endpoint exists. ARNs recorded here once created.

---

## 4. IAM `ec2-app-role`  (PENDING -- operator does this from an admin session)

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
- Secrets Manager **read** on `/compliance/prod/*` + `kms:Decrypt` via
  Secrets Manager only
- CloudWatch Logs **write** on `/compliance/*` only
- S3 on `s3://compliance-prod-backups-218201720464` **only**
- ECR pull for `compliance-api` / `compliance-worker` **only**

---

## 5. RDS PostgreSQL  (PENDING)

`postgres` 18.4 · `db.t3.micro` · 20 GB gp2 · Single-AZ · not public ·
`compliance-rds-sg` · DB `compliance_db` · master `compliance_master` ·
7-day backups · **deletion protection ON**. Then: create `keycloak_db`,
run `001..00N` migrations as `migration_user`, verify RLS/FORCE RLS/grants.

---

## Resource inventory (running total)

| Kind | Name | Id / ARN | Cost |
| --- | --- | --- | --- |
| Security group | compliance-app-sg | `sg-02d0a10340ecf1da6` | free |
| Security group | compliance-rds-sg | `sg-0182cee63337b13fb` | free |
