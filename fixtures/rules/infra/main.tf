# VIOLATES sec.no-world-open-security-group
resource "aws_security_group" "db" {
  name = "database"

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
