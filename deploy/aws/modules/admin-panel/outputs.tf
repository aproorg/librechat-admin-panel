output "cloudfront_url" {
  value       = "https://${aws_cloudfront_distribution.this.domain_name}"
  description = "Public URL of the admin panel."
}

output "function_url" {
  value       = aws_lambda_function_url.this.function_url
  description = "Lambda Function URL (origin behind CloudFront; not for direct use)."
}

output "assets_bucket" {
  value       = aws_s3_bucket.assets.bucket
  description = "S3 bucket holding the static client assets."
}
