terraform {
  backend "s3" {
    bucket       = "librechat-terraform-state-dev"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true
    # `key` is environment-specific — pass it at init time, e.g.:
    #   terraform init -backend-config=environments/dev.s3.tfbackend
  }
}
