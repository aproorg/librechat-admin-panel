locals {
  client_dir = "${var.dist_dir}/client"

  content_types = {
    ".js"          = "text/javascript"
    ".mjs"         = "text/javascript"
    ".css"         = "text/css"
    ".html"        = "text/html"
    ".json"        = "application/json"
    ".svg"         = "image/svg+xml"
    ".ico"         = "image/x-icon"
    ".png"         = "image/png"
    ".jpg"         = "image/jpeg"
    ".webp"        = "image/webp"
    ".woff"        = "font/woff"
    ".woff2"       = "font/woff2"
    ".txt"         = "text/plain"
    ".map"         = "application/json"
    ".webmanifest" = "application/manifest+json"
  }
}

resource "aws_s3_bucket" "assets" {
  bucket = "${var.name}-assets-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_object" "assets" {
  for_each = fileset(local.client_dir, "**")

  bucket       = aws_s3_bucket.assets.id
  key          = each.value
  source       = "${local.client_dir}/${each.value}"
  etag         = filemd5("${local.client_dir}/${each.value}")
  content_type = lookup(local.content_types, try(regex("\\.[^./]+$", each.value), ""), "application/octet-stream")
}

resource "aws_s3_bucket_policy" "assets" {
  bucket = aws_s3_bucket.assets.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.assets.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.this.arn }
      }
    }]
  })
}
