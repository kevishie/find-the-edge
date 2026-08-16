# Critical monitoring and one-time log cleanup

FIND THE EDGE uses eight standard CloudWatch alarm metrics across the two
deployed stacks. This leaves two of CloudWatch's current ten free standard
alarm metrics unused:

- staging: Live Odds Lambda errors, Live Odds DLQ depth, Provider Landing
  Lambda errors, and Provider Landing DLQ depth;
- production: Live Odds Lambda errors, Live Odds DLQ depth, Upcoming Events
  worker errors, and Upcoming Events DLQ depth.

Each alarm evaluates five-minute AWS service metrics, enters `ALARM` only when
two of three periods breach, and treats missing data as non-breaching. When
`FTE_CRITICAL_ALARM_EMAIL` is configured, SNS sends only the `ALARM`
transition. No OK/recovery action is attached. Confirm the SNS subscription
email for both deployed stacks and verify the subscriptions are `Confirmed`
before treating email delivery as operational.

The free allowance is shared with unrelated CloudWatch usage in the AWS
account. Check the Billing console's Free Tier page before and after deployment;
the repository can cap its own eight alarm metrics but cannot reserve the
account-wide allowance.

The repository does not provision log groups, API access logging, Step
Functions logging, custom metrics, Contributor Insights, or Lambda log-delivery
permissions. Two classes of old log groups require one-time cleanup because
removing a retained resource from a CloudFormation template does not delete its
physical resource, and Lambda-created groups were never owned by CloudFormation:

1. Inventory every `FindTheEdge-*` foundation stack in the account, including
   any legacy development stack. Capture every stack-owned
   `AWS::CloudWatch::Alarm` and `AWS::Logs::LogGroup` physical ID with
   `aws cloudformation list-stack-resources`.
2. Capture every `AWS::Lambda::Function` physical ID from the same stacks and
   derive its group as `/aws/lambda/<function-name>`.
3. Review the deployment change set. It must retain only the four stage-specific
   alarms above, delete the other alarms, and add no `AWS::Logs::*` resource.
4. Deploy to both `FindTheEdge-staging-Foundation` and
   `FindTheEdge-prod-Foundation`. Update any legacy development foundation
   stack with the alarm-free non-deployed-stage template, or remove the retired
   stack's captured alarms through a separately reviewed exact-resource cleanup.
5. With an administrator identity, delete only the captured legacy log-group
   names. The deployment roles intentionally have no CloudWatch Logs access.

Do not use an account-wide wildcard deletion. Verify every physical ID belongs
to a `FindTheEdge-*` foundation stack before deleting it. Finally, confirm the
account contains exactly the intended eight repository-owned alarm metrics.
