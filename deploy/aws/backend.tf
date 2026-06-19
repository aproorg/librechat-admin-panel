terraform {
  backend "s3" {
    bucket       = "librechat-terraform-state-dev"
    key          = "dev/admin-panel/terraform.tfstate"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true
  }
}
