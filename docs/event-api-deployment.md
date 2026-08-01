# Event API deployment

FTE-016 assumes a newly owned DynamoDB table. There is no import, migration, backfill, or `Scan` path. After deployment, run the configured FTE-DATA-002 fixture or provider ingestion once; the first successful canonical transaction atomically writes the canonical event, detail pointer, sport/day row, league/day row, and `EVENT_PROJECTIONS/READINESS` marker.

Required deployment configuration:

- `FTE_JWT_ISSUER`
- `FTE_JWT_AUDIENCE`
- `FTE_EVENT_CURSOR_SECRET_ARN`

The Secrets Manager value must contain the exact cursor-ring schema documented by `apps/api/src/secrets.ts`, with a canonical base64 32-byte current key. Rotation may include the complete previous-key tuple. Retire previous acceptance only after existing cursors no longer need to decode.

Post-deploy smoke check:

1. Confirm one fixture/provider ingestion succeeds and the readiness marker is present.
2. Call `GET /events?sport=<sport>&status=scheduled&day=<YYYY-MM-DD>` with a JWT containing `events:read`; expect `projectionState: ready` and `cache-control: no-store`.
3. If a fixture event is returned, call `GET /events/{eventId}` and confirm the participant labels, raw ISO kickoff, Eastern day/display, status, and provisional league key agree with the list row.
4. Repeat the list request without a token and without the scope; expect 401 and 403. Confirm both attempts appear only as redacted request/route/status/latency access-log entries.
5. Confirm `FindTheEdge/EventApi` receives `Requests`/`Latency`, and force a safe test failure to verify the route-dimensional `Caught5xx` alarm.

An absent readiness marker is reported as `projectionState: uninitialized`; it must not be interpreted as an empty schedule. Disposable local or development environments should recreate the table and reingest fixtures instead of attempting migration.
