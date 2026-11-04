import {
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IHookFunctions,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';
import { postifyRequest, throwApiError } from '../Postify/shared/transport';
import { readHeader, signatureMatches, timestampIsFresh } from './signature';

/** The event types POST /v1/webhook-endpoints accepts (WEBHOOK_EVENT_TYPES in Postify's contracts). */
export const EVENT_OPTIONS = [
	{
		name: 'Channel Connected',
		value: 'channel.connected',
		description: 'A new social account finishes connecting to the workspace',
	},
	{
		name: 'Channel Needs Reconnecting',
		value: 'channel.reauth_required',
		description: "A channel's sign-in expired or was revoked, so it must be reconnected in Postify",
	},
	{
		name: 'Delivery Failed',
		value: 'delivery.failed',
		description:
			'Publishing to one channel failed. The post may still be live on its other channels.',
	},
	{
		name: 'Post Failed',
		value: 'post.failed',
		description: 'A post tried to publish and every channel failed',
	},
	{
		name: 'Post Published',
		value: 'post.published',
		description:
			'A post finished publishing to at least one channel. A partly failed post counts as published.',
	},
];

/** Postify's synthetic ping from Settings > Webhooks > Send test. Never subscribable. */
export const TEST_EVENT = 'webhook.test';

/**
 * What the node keeps in the workflow's static data: the Postify webhook endpoint it registered,
 * the signing secret Postify shows once when the endpoint is created (n8n's own trigger nodes
 * keep their webhook IDs and secrets the same way), and the IDs of the last deliveries it
 * accepted.
 *
 * n8n keeps this per mode: a production activation reads and writes the workflow's saved static
 * data, while "Listen for test event" starts from empty static data held with the test
 * registration only, so a test listen registers its own endpoint for the test URL and never
 * sees, replaces or deletes the production endpoint's ID or secret.
 */
interface WebhookState extends IDataObject {
	webhookId?: string;
	webhookSecret?: string;
	deliveryIds?: string[];
}

/** How many accepted delivery IDs are remembered to drop Postify's retries of the same event. */
export const REMEMBERED_DELIVERIES = 200;

interface Envelope {
	id?: string;
	type?: string;
	createdAt?: string;
	data?: IDataObject;
}

interface WebhookEndpoint {
	id: string;
	url: string;
	event_types: string[];
	enabled: boolean;
}

function sameEvents(left: string[], right: string[]): boolean {
	const a = [...new Set(left)].sort();
	const b = [...new Set(right)].sort();
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** DELETE a registered endpoint; a 404 means it is already gone, which is the goal. */
async function removeEndpoint(this: IHookFunctions, endpointId: string): Promise<boolean> {
	const response = await postifyRequest.call(this, {
		method: 'DELETE',
		path: `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}`,
	});
	return response.statusCode < 400 || response.statusCode === 404;
}

/** Reads a post or the channel list back from Postify; any failure leaves the detail empty. */
async function readBack(this: IWebhookFunctions, path: string): Promise<IDataObject | null> {
	try {
		const response = await postifyRequest.call(this, { method: 'GET', path });
		return response.statusCode < 400 ? (response.body as IDataObject) : null;
	} catch {
		return null;
	}
}

export class PostifyTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Postify Trigger',
		name: 'postifyTrigger',
		icon: { light: 'file:../../icons/postify.svg', dark: 'file:../../icons/postify.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when Postify sends a webhook for a post or channel event',
		defaults: {
			name: 'Postify Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'postifyApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: [],
				options: EVENT_OPTIONS,
				description: 'The Postify events that start the workflow',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Include Details',
						name: 'includeDetails',
						type: 'boolean',
						default: true,
						description:
							"Whether to read the post (with each channel's delivery outcome) or the channel back from Postify, so the item carries the full record. Each event then costs one API request.",
					},
				],
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as WebhookState;
				if (!state.webhookId || !state.webhookSecret) return false;

				// The API reads endpoints as one list (plan-bounded, never paginated).
				const response = await postifyRequest.call(this, {
					method: 'GET',
					path: '/v1/webhook-endpoints',
				});
				if (response.statusCode >= 400) {
					throwApiError.call(this, response, 'Could not check the Postify webhook endpoint:');
				}
				const endpoints = ((response.body as { data?: WebhookEndpoint[] }).data ??
					[]) as WebhookEndpoint[];
				const endpoint = endpoints.find((candidate) => candidate.id === state.webhookId);
				if (!endpoint) {
					delete state.webhookId;
					delete state.webhookSecret;
					return false;
				}

				const events = this.getNodeParameter('events', []) as string[];
				if (
					endpoint.url === this.getNodeWebhookUrl('default') &&
					endpoint.enabled &&
					sameEvents(endpoint.event_types ?? [], events)
				) {
					return true;
				}
				// Another URL (n8n's base URL changed), other events, or auto-disabled after 20 failed
				// deliveries: remove it before `create` registers the replacement, so the old one
				// stops posting this workspace's events to a URL nobody verifies.
				if (!(await removeEndpoint.call(this, state.webhookId))) {
					throw new NodeOperationError(
						this.getNode(),
						'Could not remove the outdated Postify webhook endpoint',
						{ description: 'Delete it in Postify under Settings > Webhooks, then activate again.' },
					);
				}
				delete state.webhookId;
				delete state.webhookSecret;
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const events = this.getNodeParameter('events', []) as string[];
				const response = await postifyRequest.call(this, {
					method: 'POST',
					path: '/v1/webhook-endpoints',
					body: { url: this.getNodeWebhookUrl('default'), event_types: events },
				});
				if (response.statusCode >= 400) {
					throwApiError.call(
						this,
						response,
						'Postify refused to register the webhook endpoint this trigger needs:',
					);
				}
				const created = response.body as { id?: string; signing_secret?: string };
				if (!created.id || !created.signing_secret) {
					// Without the secret no delivery can be verified, so an endpoint kept now would only
					// post requests this node refuses. Remove it, and fail the activation loudly: n8n
					// ignores what `create` returns, so `false` would leave a dead trigger "active".
					if (created.id) await removeEndpoint.call(this, created.id);
					throw new NodeOperationError(
						this.getNode(),
						'Postify registered the webhook endpoint without returning its signing secret',
						{ description: 'The endpoint was removed again. Activate the workflow again.' },
					);
				}

				// The signing secret is shown once over the API, by this response only; it is kept
				// to verify every delivery.
				const state = this.getWorkflowStaticData('node') as WebhookState;
				state.webhookId = created.id;
				state.webhookSecret = created.signing_secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as WebhookState;
				if (!state.webhookId) return true;
				// 404: already deleted in Postify under Settings > Webhooks, which is the goal.
				if (!(await removeEndpoint.call(this, state.webhookId))) return false;
				delete state.webhookId;
				delete state.webhookSecret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const state = this.getWorkflowStaticData('node') as WebhookState;
		const request = this.getRequestObject();
		const headers = this.getHeaderData() as Record<string, string | string[] | undefined>;
		const rawBody: unknown = (request as { rawBody?: unknown }).rawBody;
		const body = Buffer.isBuffer(rawBody)
			? rawBody.toString('utf8')
			: typeof rawBody === 'string'
				? rawBody
				: undefined;

		const id = readHeader(headers, 'webhook-id');
		const timestamp = readHeader(headers, 'webhook-timestamp');
		const signature = readHeader(headers, 'webhook-signature');
		const verified =
			!!state.webhookSecret &&
			body !== undefined &&
			!!id &&
			!!timestamp &&
			!!signature &&
			signatureMatches({
				secret: state.webhookSecret,
				id,
				timestamp,
				body,
				signatureHeader: signature,
			});

		if (!verified || !id || !timestamp) {
			// A forged request: refuse it without starting the workflow.
			this.getResponseObject().status(401).json({ error: 'Invalid Postify webhook signature' });
			return { noWebhookResponse: true };
		}
		// Postify signs every attempt, its retries included, with the time of that attempt, so a
		// genuine delivery is never older than its trip over the network. One signed more than
		// five minutes away from now is a captured request played back.
		if (!timestampIsFresh(timestamp)) {
			this.getResponseObject().status(401).json({ error: 'Stale Postify webhook timestamp' });
			return { noWebhookResponse: true };
		}

		const envelope = this.getBodyData() as Envelope;
		const events = this.getNodeParameter('events', []) as string[];
		const isTest = envelope.type === TEST_EVENT;
		if (!envelope.type || (!isTest && !events.includes(envelope.type))) {
			return {};
		}

		// Postify re-sends an event until it gets a 2xx, with the same `webhook-id` each time
		// (at-least-once delivery). One already accepted is answered 200 and starts nothing. The
		// list is replaced rather than pushed to, so n8n sees the change and saves it.
		const seen = Array.isArray(state.deliveryIds) ? state.deliveryIds : [];
		if (seen.includes(id)) {
			return { webhookResponse: { received: true, duplicate: true } };
		}
		state.deliveryIds = [...seen, id].slice(-REMEMBERED_DELIVERIES);

		const data = (envelope.data ?? {}) as IDataObject;
		const output: IDataObject = {
			event: envelope.type,
			event_id: id,
			occurred_at: envelope.createdAt ?? null,
			test: isTest,
			data,
		};

		const options = this.getNodeParameter('options', {}) as IDataObject;
		const postId = typeof data.postId === 'string' ? data.postId : undefined;
		const channelId = typeof data.channelId === 'string' ? data.channelId : undefined;
		if (options.includeDetails === false || isTest || (!postId && !channelId)) {
			return { workflowData: [this.helpers.returnJsonArray([output])] };
		}

		// The read-back is one more API call. In the "onReceived" response mode n8n answers only
		// after this method returns, and Postify abandons an attempt after 10 seconds and retries
		// it, so the node sends the 200 itself first; `noWebhookResponse` then stops n8n from
		// answering a second time. The delivery ID is recorded above, so a retry that still raced
		// this answer would start nothing. Read-back failures leave the detail empty and never
		// throw, because the answer is already sent.
		this.getResponseObject().status(200).json({ received: true });
		if (postId) {
			output.post = await readBack.call(this, `/v1/posts/${encodeURIComponent(postId)}`);
		} else if (channelId) {
			// There is no GET /v1/channels/{id}; the list holds at most 50 channels.
			const list = await readBack.call(this, '/v1/channels');
			const channels = ((list?.data as IDataObject[] | undefined) ?? []) as IDataObject[];
			output.channel = channels.find((channel) => channel.id === channelId) ?? null;
		}

		return {
			noWebhookResponse: true,
			workflowData: [this.helpers.returnJsonArray([output])],
		};
	}
}
