module "admin_panel" {
  source = "./modules/admin-panel"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name             = var.name
  dist_dir         = coalesce(var.dist_dir, "${path.root}/../../dist")
  api_base_url     = var.api_base_url
  api_server_url   = var.api_server_url
  session_secret   = var.session_secret
  domain_name      = var.domain_name
  lambda_memory_mb = var.lambda_memory_mb
  price_class      = var.price_class
}
