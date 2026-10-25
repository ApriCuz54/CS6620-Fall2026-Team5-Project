# AWS Academy session setup (Aditya)

Use the course Learner Lab account, not a personal AWS account. Start the lab, open its AWS Details credentials view and copy the current aws_access_key_id, aws_secret_access_key and aws_session_token into a local named CLI profile. All three values are temporary and must be refreshed after expiration.

Use a local editor for ~/.aws/credentials (outside this repository):

```ini
[cs6620-lab]
aws_access_key_id = <current lab value>
aws_secret_access_key = <current lab value>
aws_session_token = <current lab value>
```

Do not put live values in command history, project files, screenshots, Terraform variables or chat. Configure the same region used in the lab:

```sh
aws configure set region us-east-1 --profile cs6620-lab
export AWS_PROFILE=cs6620-lab
npm run check:aws
```

Replace us-east-1 if the lab uses another region. Local CLI commands do not need a permanent IAM user. Only this session's shell inherits the export; repeat it in new terminals. AWS SDKs and Terraform use this profile without embedding credentials in source.

Record the permitted pre-existing instance profile in your private setup notes. Lab environments may disallow creating IAM roles. Do not assume role names or permissions. Confirm access to EC2, ALB, Auto Scaling, S3, SQS, DynamoDB, CloudWatch, SSM SecureString and certificate management before designing around them. The worker/API processes on AWS should use instance-role credentials; never copy your lab credentials onto EC2.

The deployment service token is separate from AWS credentials. It is not needed for the local scanner. Generate it only once the authenticated API exists; put the raw token in the team repository's GitHub Actions secret and the agreed verifier in SSM SecureString. Aditya owns rotation; document the overlap/cache refresh process. Never store either in Terraform state.
