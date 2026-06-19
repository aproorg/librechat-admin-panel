terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = ">= 5.40, < 7.0"
      configuration_aliases = [aws.us_east_1]
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
  }
}

data "aws_caller_identity" "current" {}
