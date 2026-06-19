# AWS deployment (CloudFront + S3 + Lambda)

Terraform for the serverless deployment described in the root README's
"AWS Lambda + CloudFront + S3" section. CloudFront serves the static client
assets from S3 and routes dynamic routes (SSR + server functions) to a Lambda
Function URL with response streaming.

This is an apro-side deployment recipe — it is **not** part of the upstream
admin-panel app.

## Layout

```
deploy/aws/
├── modules/admin-panel/     # reusable module (S3 + Lambda + CloudFront)
├── environments/
│   ├── dev.tfvars.json      # per-environment variables
│   └── dev.s3.tfbackend     # per-environment state key
├── main.tf                  # calls the module
├── backend.tf providers.tf variables.tf outputs.tf versions.tf
```

The root is a thin caller; all resources live in `modules/admin-panel`, so new
environments are just another `<env>.tfvars.json` + `<env>.s3.tfbackend` pair.

## Prerequisites

- Terraform >= 1.10, AWS credentials (e.g. `AWS_PROFILE=apro-dev AWS_REGION=eu-west-1`)
- Build artifacts at `../../dist`:

```bash
cd ../..            # repo root
bun install
bun run build:lambda
cd deploy/aws
```

## Deploy an environment

Each environment selects its own state key (via `-backend-config`) and its own
variables (via `-var-file`). State lives in the `librechat-terraform-state-dev`
bucket with native S3 locking.

```bash
export TF_VAR_session_secret="$(openssl rand -hex 32)"   # keep secrets out of the json

terraform init  -backend-config=environments/dev.s3.tfbackend
terraform plan  -var-file=environments/dev.tfvars.json
terraform apply -var-file=environments/dev.tfvars.json

terraform output cloudfront_url   # public URL
```

Switching environments re-runs `init` with that environment's backend config:

```bash
terraform init -reconfigure -backend-config=environments/prod.s3.tfbackend
terraform apply -var-file=environments/prod.tfvars.json
```

## Add a new environment

1. `environments/<env>.tfvars.json` — set `region`, `api_base_url`,
   `api_server_url`, etc.
2. `environments/<env>.s3.tfbackend` — set a unique
   `key = "<env>/admin-panel/terraform.tfstate"`.
3. `terraform init -reconfigure -backend-config=environments/<env>.s3.tfbackend`
   then `apply -var-file=environments/<env>.tfvars.json`.

`session_secret` is not stored in the json — pass it via `TF_VAR_session_secret`.

## Notes

- **SSO callback:** add `https://<api_base_url>/api/admin/oauth/openid/callback`
  to the Cognito app client's allowed callback URLs (the backend, not the
  CloudFront domain, is the OIDC client). Already configured for the sandbox.
- **Re-deploying app changes:** re-run `bun run build:lambda` then
  `terraform apply` — the Lambda zip hash and changed S3 objects update in place.
- **Custom domain:** set `domain_name` in the env tfvars (dev uses
  `admin.sandbox.data.apro.is`). The module looks up the wildcard ACM cert for
  the parent domain in **us-east-1** (`data "aws_acm_certificate"`) and creates
  Route53 A/AAAA alias records in the parent zone. Leave `domain_name` unset to
  use the default `*.cloudfront.net` domain with no DNS record.
