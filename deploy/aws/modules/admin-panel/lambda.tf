data "archive_file" "lambda" {
  type        = "zip"
  source_file = "${var.dist_dir}/lambda/index.mjs"
  output_path = "${path.root}/.build/${var.name}-lambda.zip"
}

# Generated once and kept in state when no session_secret is supplied, so
# repeated applies don't rotate it (which would invalidate active sessions).
resource "random_password" "session_secret" {
  count   = var.session_secret == null ? 1 : 0
  length  = 64
  special = false
}

locals {
  session_secret = coalesce(var.session_secret, one(random_password.session_secret[*].result))
}

resource "aws_iam_role" "lambda" {
  name = "${var.name}-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "this" {
  function_name = var.name
  role          = aws_iam_role.lambda.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  memory_size   = var.lambda_memory_mb
  timeout       = 30

  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  environment {
    variables = {
      NODE_ENV          = "production"
      SESSION_SECRET    = local.session_secret
      VITE_API_BASE_URL = var.api_base_url
      API_SERVER_URL    = var.api_server_url != "" ? var.api_server_url : var.api_base_url
    }
  }
}

resource "aws_lambda_function_url" "this" {
  function_name      = aws_lambda_function.this.function_name
  authorization_type = "AWS_IAM"
  invoke_mode        = "BUFFERED"
}

resource "aws_lambda_permission" "cloudfront" {
  statement_id           = "AllowCloudFrontInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.this.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.this.arn
  function_url_auth_type = "AWS_IAM"
}
