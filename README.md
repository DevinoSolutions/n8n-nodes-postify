# n8n-nodes-postify

This is an n8n community node for [Postify](https://usepostify.com), the social media scheduler by Devino Solutions. It lets you draft and schedule posts to your connected social accounts (LinkedIn, Instagram, X, Facebook, TikTok, Threads, YouTube, Pinterest, Bluesky and more) from your n8n workflows, upload images and videos to the media library, read your workspace analytics, and start workflows when a post publishes or fails, or when a channel connects or needs reconnecting.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

- [Installation](#installation)
- [Credentials](#credentials)
- [Operations](#operations)
- [Trigger](#trigger)
- [Usage examples](#usage-examples)
- [Use as an AI Agent tool](#use-as-an-ai-agent-tool)
- [Compatibility](#compatibility)
- [Development](#development)
- [Publishing (owner step)](#publishing-owner-step)
- [Resources](#resources)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

1. In n8n, go to **Settings > Community Nodes**.
2. Select **Install**.
3. Enter `n8n-nodes-postify` as the npm package name.
4. Accept the risks of using community nodes and select **Install**.

After installation, search for **Postify** in the nodes panel. The package adds two nodes:

- **Postify**: actions on posts, channels, media and analytics.
- **Postify Trigger**: starts a workflow when Postify sends a webhook for a post or channel event.

## Credentials

The nodes authenticate with an API key of a Postify workspace. A key belongs to one workspace, and every call runs against that workspace.

1. Sign in to [Postify](https://app.usepostify.com) as a workspace **owner or admin**.
2. Open **Settings > API keys** and create a key (it starts with `postify_live_`).
3. In n8n, create a new **Postify API** credential and paste the key into **API Key**.

n8n checks the credential with `GET https://app.usepostify.com/v1/channels`. The key is sent as the `Authorization: Bearer <key>` header.

The scopes each part of the package needs:

| Used by | Scopes |
| --- | --- |
| Credential test, Channel > Get Many, the Channels dropdown | `channels:read` |
| Post > Get, Get Many, the Post dropdown, Media > Get Many | `posts:read` |
| Post > Create Draft, Schedule, Media > Upload | `posts:write` |
| Analytics > Get Summary | `analytics:read` |
| Postify Trigger | `webhooks:read`, `webhooks:write` (plus `posts:read` and `channels:read` for **Include Details**) |

A scheduled time less than 60 seconds ahead is sent by Postify's next publish sweep, so Postify also asks for `posts:publish` then. Schedule posts at least a minute ahead to avoid needing it.

**Costs.** Every `/v1` request spends one request from the workspace's monthly API allowance (Free 1,000, Starter 10,000, Team 50,000, Agency 250,000). Each scheduled post counts against the plan's posts-per-month allowance; drafts do not. Each active Postify Trigger registers one webhook endpoint, which counts against the plan's Integrations allowance (Free 1, Starter 3, Team 10, Agency 25), as each API key does.

## Operations

### Post

| Operation | What it does | Postify API |
| --- | --- | --- |
| Create Draft | Save a draft post on one or more channels, each getting its own copy of the text. Optional: an internal title, media (image or video URLs from **Media > Upload**) and a deduplication key. **Nothing is published**: review and schedule the draft in Postify. | `POST /v1/posts` with `draft: true` |
| Schedule | **Publishes for real.** At **Publish At**, Postify posts the text publicly to every chosen social account. Same fields as Create Draft. **Publish At** must be in the future; a time without a timezone (what n8n's date picker gives) is read in the workflow's timezone, and a time with an offset or `Z` is kept as it is. | `POST /v1/posts` with `scheduled_at` |
| Get | Retrieve a post with its status, its per-channel variants and each channel's latest delivery outcome. | `GET /v1/posts/{id}` |
| Get Many | List posts, newest first, filtered by status, with Return All or a limit. | `GET /v1/posts` |

There is no "publish now" operation, as in Postify's Zapier app: immediate publishing is Postify's dangerous `posts:publish` operation. To publish soon, schedule a post a few minutes ahead.

TikTok channels cannot be scheduled from n8n: TikTok forbids a default audience, and the node does not set one. Postify refuses the request with its own message. Create a draft and schedule it in Postify instead.

Every create carries an `Idempotency-Key` header, and Postify answers a repeated key with the first answer for 24 hours instead of creating a second post:

- **Without a Deduplication Key** the key is derived from where the item sits in n8n: the instance, workflow, execution, node, run of the node and input item.
  - The node's own retry (once, with the same key and the same body, after a 5xx, a 409 `idempotency_in_progress` or a request that got no answer) never creates two posts.
  - n8n's **Retry On Fail** re-runs the whole node, every item included, inside the same execution, so items already created get their first answer back instead of a second post.
  - A loop, or an AI Agent calling the node again, is a new run of the node and creates again, as intended.
  - A manual **Retry** of a failed execution, or running the workflow again, is a new execution with a new ID. Items created before the failure **are created again**. Only a Deduplication Key prevents that.
- **With a Deduplication Key** (a row or record ID, say) the key is the same in every execution, so Postify will not create that post again for 24 hours, whatever re-runs the item. A second create under the same key with a different body is refused with an error and nothing is created.

### Channel

| Operation | What it does | Postify API |
| --- | --- | --- |
| Get Many | List the social accounts connected to the workspace, with their network, handle, followers and connection status (only `live` channels can publish). | `GET /v1/channels` |

### Media

| Operation | What it does | Postify API |
| --- | --- | --- |
| Upload | Upload the image, video or audio file in an input binary field (from an HTTP Request or Read/Write Files node, say) to the media library. The output's `url` goes into a post's **Media**. With **Wait Until Ready** (on by default) the node waits up to 2 minutes while Postify processes a video. **Nothing is published.** | `POST /v1/media/uploads`, a `PUT` of the bytes to the presigned upload URL, then `POST /v1/media/uploads/{id}/complete` |
| Get Many | List the media library, newest first. | `GET /v1/media` |

The file's bytes go straight to Postify's storage through the presigned URL that Postify signs for that one file. That request carries no Postify credential.

### Analytics

| Operation | What it does | Postify API |
| --- | --- | --- |
| Get Summary | Workspace-wide counts (posts, published, scheduled, failed, channels), the delivery success rate, publishes per day over the last 14 days, and summed engagement (impressions, likes, comments, shares, clicks). | `GET /v1/analytics` |

**Channels** is a multi-select loaded from your workspace, and **Post** is a searchable dropdown of your posts. You can also use expressions or switch to **By ID**.

## Trigger

**Postify Trigger** registers a webhook endpoint in your Postify workspace when the workflow is activated, and deletes it when the workflow is deactivated. You pick one or more events:

| Event | Fires when |
| --- | --- |
| Post Published | A post finished publishing to at least one channel (a partly failed post counts) |
| Post Failed | A post tried to publish and every channel failed |
| Delivery Failed | Publishing to one channel failed; the post may still be live elsewhere |
| Channel Connected | A new social account finished connecting |
| Channel Needs Reconnecting | A channel's sign-in expired or was revoked |

- **Signatures are verified.** Postify signs every delivery with Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256). The node answers `401` to any request whose signature does not match, without starting the workflow. Both signatures sent during a secret rotation are accepted.
- **Replays are refused.** Postify signs each attempt, retries included, with the time of that attempt, so the node also answers `401` to a delivery whose signed timestamp is more than 5 minutes from the n8n server's clock. Keep that clock synchronised (NTP).
- **Each event starts the workflow once.** Postify retries a delivery until it gets a `2xx`, with the same `webhook-id`. The node remembers the last 200 delivery IDs and answers a repeat with `200` without starting the workflow.
- **Where the secret lives.** Postify shows the signing secret once over the API, when the endpoint is created. The node keeps it, with the endpoint ID and the recent delivery IDs, in the workflow's static data, which n8n stores with the workflow in its database, as it does for its own trigger nodes. **Listen for test event** registers a separate endpoint for the test URL, with its own secret that n8n holds only for the test session.
- **Each item** has `event`, `event_id` (the delivery's `webhook-id`, stable across Postify's retries), `occurred_at`, `test`, and the raw event `data` (for post events: `postId`, `platforms`, `succeeded`, `failed`, `failures`, `preview`).
- **Include Details** (on by default) reads the post (`GET /v1/posts/{id}`, with each channel's delivery outcome) or the channel (`GET /v1/channels`) back from Postify. The node answers Postify's request before that read, so the read never delays the answer. If the read fails, the item is still emitted with the detail set to `null`. Turn it off to save that API request.
- A **Send test** delivery from Postify's **Settings > Webhooks** is passed through with `test: true` and no details.
- On activation the node replaces an endpoint it registered earlier if its URL (n8n's base URL changed), its events or its state (Postify disables an endpoint after 20 failed deliveries) no longer match, deleting the old one in Postify first.

## Usage examples

**Schedule posts from a content calendar.** Start with a Google Sheets or Airtable trigger on new rows, then add a **Postify** node: Resource **Post**, Operation **Schedule**, pick the **Channels**, map **Text** to `{{ $json.copy }}` and **Publish At** to `{{ $json.publish_at }}`, and under **Additional Fields** set **Deduplication Key** to `{{ $json.id }}`. While you build the workflow, use **Create Draft** instead, so nothing goes live.

**Post an image from a URL.** Fetch the image with an **HTTP Request** node (Response Format: File), run **Media > Upload**, then **Post > Create Draft** with **Media** URL `{{ $json.url }}`.

**Act on failures.** Start with **Postify Trigger** on **Post Failed** and send `{{ $json.data.failures }}` to Slack or email, so a failed post never goes unnoticed.

## Use as an AI Agent tool

The **Postify** node can be used as a tool by n8n's AI Agent node, for example to draft posts or read analytics. Connect it to the agent's **Tool** input and describe in the tool description what the agent may do. Give an agent **Create Draft** rather than **Schedule** unless you want it to publish on its own: a scheduled post goes live without review.

## Compatibility

- Built with the `@n8n/node-cli` scaffold, n8n Nodes API version 1, strict mode.
- Tested with n8n 2.x. AI Agent tool use needs an n8n version that supports `usableAsTool`.
- No runtime dependencies (only `n8n-workflow` as a peer dependency and Node's built-in `crypto`).

## Development

```bash
npm install
npm run lint     # n8n community-node lint (strict)
npm test         # type-checks the tests, then runs them with mocked HTTP
npm run build
npm run dev      # starts a local n8n with the node loaded
```

The tests never touch the network: every Postify response is a canned answer, and each test checks the exact request the node sends.

## Publishing (owner step)

The package is built and tested but not published. These steps remain, and each needs the owner:

1. **Public GitHub repository** `DevinoSolutions/n8n-nodes-postify` (MIT), matching `repository` in `package.json`. The repository is private until then; n8n checks that the npm package links to a real public repository.
2. **npm token**: for the first release only, a short-lived granular npm token with publish rights, stored as the `NPM_TOKEN` repository secret. npm cannot attach a trusted publisher to a package that does not exist yet.
3. **Provenance publish**: push a version tag (for example `0.1.0`); `.github/workflows/publish.yml` publishes with an npm provenance statement, which n8n requires for verified nodes since May 1, 2026. Then configure npm Trusted Publishing for `publish.yml`, delete the `NPM_TOKEN` secret and revoke the token.
4. **n8n verification**: submit the published package in the [n8n Creator Portal](https://creators.n8n.io/nodes) so it becomes installable from the nodes panel and on n8n Cloud.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Postify](https://usepostify.com)
- [Postify API documentation](https://usepostify.com/docs/api)
- [Postify API reference (OpenAPI)](https://app.usepostify.com/v1/openapi.json)

## License

[MIT](LICENSE.md)
