locals {
  # Static paths served from S3; everything else falls through to the Lambda SSR origin.
  static_patterns = ["/assets/*", "/favicon.ico", "/manifest.json", "/robots.txt", "*.svg"]

  # Lambda Function URL host (strip scheme + trailing slash) for the CloudFront origin.
  lambda_origin_host = replace(replace(aws_lambda_function_url.this.function_url, "https://", ""), "/", "")
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_origin_access_control" "s3" {
  name                              = "${var.name}-s3"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "this" {
  enabled     = true
  comment     = var.name
  price_class = var.price_class
  aliases     = local.use_custom_domain ? [var.domain_name] : []

  origin {
    origin_id                = "s3"
    domain_name              = aws_s3_bucket.assets.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }

  origin {
    origin_id   = "lambda"
    domain_name = local.lambda_origin_host

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    # Secret shared with the Lambda so it only honors requests routed via
    # CloudFront. OAC/SigV4 can't sign POST bodies from a browser, so the
    # Function URL is public (authorization_type = NONE) and gated by this.
    custom_header {
      name  = "x-origin-verify"
      value = random_password.origin_secret.result
    }
  }

  # Dynamic routes (SSR pages + server functions) -> Lambda, never cached.
  default_cache_behavior {
    target_origin_id         = "lambda"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  # Static assets -> S3, cached at the edge.
  dynamic "ordered_cache_behavior" {
    for_each = toset(local.static_patterns)
    content {
      path_pattern           = ordered_cache_behavior.value
      target_origin_id       = "s3"
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["GET", "HEAD"]
      cached_methods         = ["GET", "HEAD"]
      cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = local.use_custom_domain ? null : true
    acm_certificate_arn            = local.use_custom_domain ? data.aws_acm_certificate.wildcard[0].arn : null
    ssl_support_method             = local.use_custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.use_custom_domain ? "TLSv1.2_2021" : null
  }
}
