variable "region" {
  type        = string
  default     = "eu-west-1"
  description = "AWS region for the Lambda and S3 bucket."
}

variable "name" {
  type        = string
  default     = "librechat-admin-panel"
  description = "Resource name prefix."
}

variable "dist_dir" {
  type        = string
  default     = null
  description = "Path to the build output. Defaults to the repo's dist/ (two levels up). Run `bun run build:lambda` first."
}

variable "api_base_url" {
  type        = string
  description = "VITE_API_BASE_URL — browser-facing LibreChat API URL (used for OAuth redirects)."
}

variable "api_server_url" {
  type        = string
  default     = ""
  description = "API_SERVER_URL — server-to-server LibreChat API URL. Falls back to api_base_url when empty."
}

variable "session_secret" {
  type        = string
  default     = null
  sensitive   = true
  description = "SESSION_SECRET — session cookie encryption key. When null (default), the module generates and persists a random one in state."
}

variable "domain_name" {
  type        = string
  default     = null
  description = "Custom hostname for the panel (e.g. admin.sandbox.data.apro.is). When set, the wildcard ACM cert for the parent domain is looked up in us-east-1 and Route53 alias records are created."
}

variable "lambda_memory_mb" {
  type        = number
  default     = 1024
  description = "Lambda memory (MB)."
}

variable "price_class" {
  type        = string
  default     = "PriceClass_100"
  description = "CloudFront price class."
}
