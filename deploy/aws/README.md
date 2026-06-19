# AWS deployment (CloudFront + S3 + Lambda)

Terraform for the serverless deployment described in the root README's
"AWS Lambda + CloudFront + S3" section. CloudFront serves the static client
assets from S3 and routes dynamic routes (SSR + server functions) to a Lambda
Function URL with response streaming.

This is an apro-side deployment recipe — it is **not** part of the upstream
admin-panel app.

## Prerequisites

- Terraform >= 1.6, AWS credentials (e.g. `AWS_PROFILE=apro-dev AWS_REGION=eu-west-1`)
- The build artifacts present at `../../dist`:

```bash
cd ../..            # repo root
bun install
bun run build:lambda
cd deploy/aws
```

## Deploy

```bash
cp terraform.tfvars.example terraform.tfvars   # edit values
export TF_VAR_session_secret="$(openssl rand -hex 32)"   # or set in tfvars

terraform init
terraform plan
terraform apply
```

`terraform output cloudfront_url` prints the public URL.

## Notes

- **SSO callback:** add `https://genai.sandbox.data.apro.is/api/admin/oauth/openid/callback`
  to the Cognito app client's allowed callback URLs (the backend, not the
  CloudFront domain, is the OIDC client). Already configured for the sandbox.
- **Cache:** static assets use the managed `CachingOptimized` policy; the Lambda
  behavior uses `CachingDisabled` and the handler also returns `no-cache`.
- **Re-deploying app changes:** re-run `bun run build:lambda` then
  `terraform apply` — the Lambda zip hash and changed S3 objects update in place.
- **Custom domain:** add an ACM cert in `us-east-1`, an `aliases` entry, and a
  `viewer_certificate` block referencing the cert (omitted here for brevity).
