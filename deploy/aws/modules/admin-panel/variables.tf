variable "name" {
  type        = string
  description = "Resource name prefix."
}

variable "dist_dir" {
  type        = string
  description = "Path to the build output (containing client/ and lambda/index.mjs). Run `bun run build:lambda` first."
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
  sensitive   = true
  description = "SESSION_SECRET — session cookie encryption key (min 32 chars)."
}

variable "lambda_memory_mb" {
  type        = number
  default     = 1024
  description = "Lambda memory (MB). Higher memory also raises CPU, reducing SSR cold-start latency."
}

variable "price_class" {
  type        = string
  default     = "PriceClass_100"
  description = "CloudFront price class (PriceClass_100 = NA + EU edge locations)."
}
