#!/usr/bin/env bash
# Runs once LocalStack is ready. Two trios of the three FIFO queues of the messaging rules, each
# with its own input queue redriving to its own dead-letter queue after five receives: the names
# the transport contract fixes, which the Compose stack addresses, and the same names under the
# prefix the suites address them by (`ops.suite-isolation`). One set of containers then serves
# `make demo` and `make check` without either taking the other's messages.
#
# The unprefixed trio is created last because the healthcheck of compose.yaml waits for the last
# queue this script creates.
set -euo pipefail

# Kept in step with TEST_QUEUE_PREFIX, which the Makefile gives the suites as SQS_QUEUE_PREFIX.
test_prefix='test-'

fifo='{"FifoQueue":"true","ContentBasedDeduplication":"true"}'

trio() {
  local prefix="$1" dlq_url dlq_arn

  dlq_url=$(awslocal sqs create-queue --queue-name "${prefix}wager-transactions-dlq.fifo" \
    --attributes "$fifo" --query QueueUrl --output text)
  dlq_arn=$(awslocal sqs get-queue-attributes --queue-url "$dlq_url" --attribute-names QueueArn \
    --query Attributes.QueueArn --output text)

  cat > /tmp/wager-transactions.json <<JSON
{"FifoQueue":"true","ContentBasedDeduplication":"true","RedrivePolicy":"{\"deadLetterTargetArn\":\"$dlq_arn\",\"maxReceiveCount\":\"5\"}"}
JSON
  awslocal sqs create-queue --queue-name "${prefix}wager-transactions.fifo" \
    --attributes file:///tmp/wager-transactions.json
  awslocal sqs create-queue --queue-name "${prefix}wager-integration-events.fifo" \
    --attributes "$fifo"
}

trio "$test_prefix"
trio ''
