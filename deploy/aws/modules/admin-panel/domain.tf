locals {
  use_custom_domain = var.domain_name != null
  domain_labels     = local.use_custom_domain ? split(".", var.domain_name) : []
  # Parent zone of the hostname, e.g. admin.sandbox.data.apro.is -> sandbox.data.apro.is
  parent_domain = local.use_custom_domain ? join(".", slice(local.domain_labels, 1, length(local.domain_labels))) : null
}

# Wildcard ACM certificate for the parent domain. CloudFront requires the
# certificate in us-east-1, hence the aliased provider.
data "aws_acm_certificate" "wildcard" {
  count       = local.use_custom_domain ? 1 : 0
  provider    = aws.us_east_1
  domain      = local.parent_domain
  statuses    = ["ISSUED"]
  most_recent = true
}

data "aws_route53_zone" "this" {
  count        = local.use_custom_domain ? 1 : 0
  name         = local.parent_domain
  private_zone = false
}

resource "aws_route53_record" "alias" {
  for_each = local.use_custom_domain ? toset(["A", "AAAA"]) : toset([])

  zone_id = data.aws_route53_zone.this[0].zone_id
  name    = var.domain_name
  type    = each.value

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}
