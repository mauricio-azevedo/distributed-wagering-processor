#!/usr/bin/env bash
# Runs once LocalStack is ready: the three FIFO queues of the messaging rules, with the input queue
# redriving to the dead-letter queue after five receives.
set -euo pipefail

fifo='{"FifoQueue":"true","ContentBasedDeduplication":"true"}'

dlq_url=$(awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes "$fifo" \
  --query QueueUrl --output text)
dlq_arn=$(awslocal sqs get-queue-attributes --queue-url "$dlq_url" --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

cat > /tmp/wager-transactions.json <<JSON
{"FifoQueue":"true","ContentBasedDeduplication":"true","RedrivePolicy":"{\"deadLetterTargetArn\":\"$dlq_arn\",\"maxReceiveCount\":\"5\"}"}
JSON
awslocal sqs create-queue --queue-name wager-transactions.fifo \
  --attributes file:///tmp/wager-transactions.json
awslocal sqs create-queue --queue-name wager-integration-events.fifo --attributes "$fifo"
