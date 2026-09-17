resource "aws_s3_bucket" "uploads" {
  bucket = "orders-uploads"
}

resource "aws_s3_bucket_acl" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  acl    = "public-read"
}

resource "aws_db_instance" "orders" {
  engine              = "postgres"
  instance_class      = "db.t3.micro"
  storage_encrypted   = false
  publicly_accessible = true
  skip_final_snapshot = true
}
