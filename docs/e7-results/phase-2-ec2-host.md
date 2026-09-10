# E7 Phase 2 -- EC2 app host (command log)

Region **eu-west-1** · Account **218201720464** · Principal
`iam::218201720464:user/compliance-deploy`. See **ADR-038** for rationale.

Phase 1 (`phase-1-aws-foundation.md`) left the RDS bootstrap (DB_HOST
write-back, `keycloak_db`, `001..00N` migrations + RLS verification)
deferred to this phase -- it runs **from this EC2 host**, which is the only
thing `compliance-rds-sg` admits on 5432.

---

## 1. Inputs (from Phase 1)

| Thing | Value |
| --- | --- |
| VPC | `vpc-0e33cd6ddb35e6748` (default, 172.31.0.0/16) |
| Public subnet (1a) | `subnet-01107a25b60d78929` |
| App security group | `sg-02d0a10340ecf1da6` (`compliance-app-sg`) |
| Instance profile | `ec2-app-role` (Phase 1 §4) |
| Instance type | `t3.micro` (2 vCPU / 1 GiB, x86_64) -- **not** `t2.micro`: that is not free-tier eligible on this Free Plan account. See §4a. |
| AMI | `ami-0b3ba1acb76a70451` -- `al2023-ami-2023.12.20260909.0-kernel-6.18-x86_64` (owner `amazon`/137112412989; SSM `/aws/service/ami-amazon-linux-latest/*` is denied to `compliance-deploy`, so resolved via `ec2 describe-images`) |
| SSH key pair | `compliance-app` (`key-06ccb6157ddc00a43`, ed25519) |
| RDS endpoint | `compliance-db.cri4qamqaphw.eu-west-1.rds.amazonaws.com:5432` |

## 2. SSH key pair  (operator, out of band)

`compliance-deploy` can create key pairs, but the private key must not
transit the automation session. The operator runs, from their own shell:

```
aws ec2 create-key-pair --key-name compliance-app \
  --key-type ed25519 --query KeyMaterial --output text > ~/.ssh/compliance-app.pem
chmod 600 ~/.ssh/compliance-app.pem
```

or imports an existing public key (`aws ec2 import-key-pair`). Key name:
**`compliance-app`** (`key-06ccb6157ddc00a43`, ed25519).

## 3. Host bootstrap script

`infra/aws/bootstrap.sh` -- passed as EC2 user-data. Host prep only:
2 GB swapfile (`vm.swappiness=10`), `dnf update`, Docker (enabled, `ec2-user`
in the `docker` group), Compose v2 plugin `v2.32.4` (static binary --
not in AL2023 repos). The application stack is deployed in a later phase.

## 4a. Instance-type selection

`t2.micro` (ADR-038's original, the legacy 12-month Free Tier instance) is
**not** free-tier eligible on this post-2025 Free Plan account --
`run-instances` was rejected. Free-tier-eligible types in eu-west-1:

```
aws ec2 describe-instance-types --filters Name=free-tier-eligible,Values=true \
  --query 'InstanceTypes[].[InstanceType,VCpuInfo.DefaultVCpus,MemoryInfo.SizeInMiB,ProcessorInfo.SupportedArchitectures[0]]' --output text
#  c7i-flex.large  2  4096  x86_64
#  t4g.small       2  2048  arm64
#  t3.micro        2  1024  x86_64
#  t4g.micro       2  1024  arm64
#  t3.small        2  2048  x86_64
#  m7i-flex.large  2  8192  x86_64
```

Chosen: **`t3.micro`** -- the 1:1 x86_64 replacement for `t2.micro`
(identical 1 GiB RAM; 2 vCPU; current-gen Nitro). The AL2023 AMI is
x86_64, so the arm64 `t4g.*` options would need an image rebuild. The 2 GB
swap in `bootstrap.sh` and the "upgrade to t3.small if the JVM won't
schedule" path (ADR-038) are both unchanged -- and t3.small is itself
free-tier eligible here.

## 4b. Launch  (run from operator CloudShell)

`compliance-deploy` has no `iam:PassRole` on `role/ec2-app-role` (ADR-038
gave it no IAM perms), so `run-instances` with `--iam-instance-profile`
fails `UnauthorizedOperation` from the automation principal. Rather than
widen `compliance-deploy`, the launch is run once from the operator's
admin CloudShell session; automation resumes for the Elastic IP (§5) and
the host-side RDS bootstrap (§6). `bootstrap.sh` is delivered as a
base64 blob because the repo is not checked out in CloudShell.

```
cat > /tmp/bootstrap.b64 <<'EOF'
<base64 of infra/aws/bootstrap.sh -- regenerate with: base64 -w0 infra/aws/bootstrap.sh>
EOF
base64 -d /tmp/bootstrap.b64 > /tmp/bootstrap.sh

aws ec2 run-instances \
  --image-id ami-0b3ba1acb76a70451 \
  --instance-type t3.micro \
  --key-name compliance-app \
  --security-group-ids sg-02d0a10340ecf1da6 \
  --subnet-id subnet-01107a25b60d78929 \
  --iam-instance-profile Name=ec2-app-role \
  --associate-public-ip-address \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=30,VolumeType=gp2,DeleteOnTermination=true,Encrypted=true}' \
  --user-data file:///tmp/bootstrap.sh \
  --metadata-options 'HttpTokens=required,HttpEndpoint=enabled' \
  --tag-specifications \
    'ResourceType=instance,Tags=[{Key=Name,Value=compliance-app},{Key=Project,Value=employee-compliance-saas},{Key=Epoch,Value=E7}]' \
    'ResourceType=volume,Tags=[{Key=Name,Value=compliance-app-root},{Key=Project,Value=employee-compliance-saas},{Key=Epoch,Value=E7}]' \
  --query 'Instances[0].InstanceId' --output text
```

## 5. Elastic IP  (PENDING -- after launch)

```
aws ec2 allocate-address --domain vpc \
  --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Name,Value=compliance-app-eip},{Key=Project,Value=employee-compliance-saas},{Key=Epoch,Value=E7}]'
aws ec2 associate-address --instance-id <ID> --allocation-id <ALLOC>
```

Then the operator adds the Hostinger A record
`compliance -> <EIP>` (ADR-038 § DNS).

## 6. RDS bootstrap from the host  (PENDING -- deferred from Phase 1)

SSH in, then:
1. `DB_HOST` write-back into `compliance/prod/database` (Phase 1 §5 step 2).
2. `psql "$MASTER_URL" -c 'CREATE DATABASE keycloak_db'`.
3. `infra/postgres/migrate.js` as `migration_user` -> `001..00N`.
4. Verify: `SELECT version()` is PG 18; `app_user` has SELECT+INSERT only on
   `audit_events`; FORCE RLS + NULLIF guard + every `tenant_isolation_*`
   policy present on `employees`, `documents`, `idempotency_keys`,
   `audit_events`, `expiry_policies`.

---

## Resource inventory (Phase 2 additions)

| Kind | Name | Id / ARN | Cost |
| --- | --- | --- | --- |
| Key pair | compliance-app | *(operator, §2)* | free |
| EC2 instance | compliance-app | *(pending -- §4b)* | t3.micro, free-tier eligible (~$8.30/mo after) |
| EBS root vol | compliance-app-root | 30 GB gp2, encrypted | ~$3.30/mo |
| Elastic IP | compliance-app-eip | *(pending -- §5)* | ~$3.60/mo |
