# Changelog

## 0.1.0

First release.

- **Postify API** credential: a workspace API key, sent as `Authorization: Bearer`, tested with `GET /v1/channels`.
- **Postify** node (programmatic, usable as an AI Agent tool):
  - Post: Create Draft (never published), Schedule (publishes for real at the set time; a time without an offset is read in the workflow's timezone), Get, Get Many. Every create carries an `Idempotency-Key` derived from the execution, node, run and item (so Retry On Fail does not create items twice), an optional deduplication key, and one same-key retry on a 5xx, a 409 `idempotency_in_progress` or a request that got no answer.
  - Channel: Get Many.
  - Media: Upload from binary data (ticket, presigned PUT without the credential, complete, optional wait until ready), Get Many.
  - Analytics: Get Summary.
  - Channel multi-select and post search dropdown loaded from the workspace.
- **Postify Trigger** node: registers a Postify webhook endpoint for the chosen post and channel events, verifies the Standard Webhooks signature of every delivery, refuses deliveries signed more than 5 minutes from now, starts the workflow once per `webhook-id`, and can read the post or channel back after answering Postify.
