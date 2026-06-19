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
  default     = null
  sensitive   = true
  description = "SESSION_SECRET — session cookie encryption key (min 32 chars). When null, a random 64-char secret is generated and kept in state."
}

variable "domain_name" {
  type        = string
  default     = null
  description = "Custom hostname for the panel (e.g. admin.sandbox.data.apro.is). When set, the module looks up the wildcard ACM cert for the parent domain (in us-east-1) and creates Route53 alias records. When null, CloudFront uses its default certificate and no DNS record is created."
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
