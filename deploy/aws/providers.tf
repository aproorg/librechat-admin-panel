provider "aws" {
  region = var.region
}

# CloudFront ACM certificates must live in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}
