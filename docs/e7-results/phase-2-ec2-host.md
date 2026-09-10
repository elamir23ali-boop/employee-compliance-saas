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
| AMI | `ami-0acc44548cf5d9ed9` -- `al2023-ami-2023.12.20260909.0-kernel-6.12-x86_64` (owner `amazon`; SSM `/aws/service/ami-amazon-linux-latest/*` is denied to `compliance-deploy`, so resolved via `ec2 describe-images`) |
| RDS endpoint | `compliance-db.cri4qamqaphw.eu-west-1.rds.amazonaws.com:5432` |

## 2. SSH key pair  (operator, out of band)

`compliance-deploy` can create key pairs, but the private key must not
transit the automation session. The operator runs, from their own shell:

```
aws ec2 create-key-pair --key-name compliance-app \
  --key-type ed25519 --query KeyMaterial --output text > ~/.ssh/compliance-app.pem
chmod 600 ~/.ssh/compliance-app.pem
```

or imports an existing public key (`aws ec2 import-key-pair`). Key name
recorded here once known: **`<pending>`**.

## 3. Host bootstrap script

`infra/aws/bootstrap.sh` -- passed as EC2 user-data. Host prep only:
2 GB swapfile (`vm.swappiness=10`), `dnf update`, Docker (enabled, `ec2-user`
in the `docker` group), Compose v2 plugin `v2.32.4` (static binary --
not in AL2023 repos). The application stack is deployed in a later phase.

## 4. Launch  (PENDING -- needs the key name from §2)

```
aws ec2 run-instances \
  --image-id ami-0acc44548cf5d9ed9 \
  --instance-type t2.micro \
  --key-name <KEY_NAME> \
  --security-group-ids sg-02d0a10340ecf1da6 \
  --subnet-id subnet-01107a25b60d78929 \
  --iam-instance-profile Name=ec2-app-role \
  --associate-public-ip-address \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=30,VolumeType=gp2,DeleteOnTermination=true,Encrypted=true}' \
  --user-data file://infra/aws/bootstrap.sh \
  --metadata-options 'HttpTokens=required,HttpEndpoint=enabled' \
  --tag-specifications \
    'ResourceType=instance,Tags=[{Key=Name,Value=compliance-app},{Key=Project,Value=employee-compliance-saas},{Key=Epoch,Value=E7}]' \
    'ResourceType=volume,Tags=[{Key=Name,Value=compliance-app-root},{Key=Project,Value=employee-compliance-saas},{Key=Epoch,Value=E7}]'
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
| EC2 instance | compliance-app | *(pending -- §4)* | ~$9/mo |
| EBS root vol | compliance-app-root | 30 GB gp2, encrypted | ~$3.30/mo |
| Elastic IP | compliance-app-eip | *(pending -- §5)* | ~$3.60/mo |
