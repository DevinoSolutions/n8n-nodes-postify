import { createHmac } from 'node:crypto';
import { assert, describe, it } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import { PostifyTrigger, REMEMBERED_DELIVERIES } from '../nodes/PostifyTrigger/PostifyTrigger.node';
import {
	hookContext,
	MockHttp,
	rejection,
	sampleChannel,
	samplePost,
	WEBHOOK_URL,
	webhookContext,
	type WebhookResponseRecorder,
} from './helpers';

const trigger = new PostifyTrigger();
const hooks = trigger.webhookMethods.default;
const API = 'https://app.usepostify.com';
const SECRET = `whsec_${Buffer.from('a-24-byte-signing-key!!!').toString('base64')}`;
const ENDPOINT_ID = 'cmc9x2y3z0001wxyz';

/** Signs like Postify's apps/web/src/lib/webhooks/sign.ts, independently of the node's code. */
function sign(secret: string, id: string, timestamp: string, body: string): string {
	const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
	return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

function delivery(type: string, data: IDataObject, id = 'evt_1') {
	return JSON.stringify({ id, type, createdAt: '2026-11-04T10:05:12.000Z', data });
}

function nowSeconds(): string {
	return String(Math.floor(Date.now() / 1000));
}

function signedHeaders(
	body: string,
	secret = SECRET,
	id = 'evt_1',
	timestamp = nowSeconds(),
): IDataObject {
	return {
		'content-type': 'application/json',
		'webhook-id': id,
		'webhook-timestamp': timestamp,
		'webhook-signature': sign(secret, id, timestamp, body),
	};
}

async function receive(options: {
	body: string;
	headers: IDataObject;
	events: string[];
	staticData?: IDataObject;
	http?: MockHttp;
	includeDetails?: boolean;
}) {
	const recorder: WebhookResponseRecorder = {};
	const http = options.http ?? new MockHttp();
	const staticData = options.staticData ?? { webhookId: ENDPOINT_ID, webhookSecret: SECRET };
	const result = await trigger.webhook.call(
		webhookContext({
			parameters: {
				events: options.events,
				options:
					options.includeDetails === undefined ? {} : { includeDetails: options.includeDetails },
			},
			staticData,
			headers: options.headers,
			rawBody: options.body,
			http,
			recorder,
		}),
	);
	return { result, recorder, http, staticData };
}

function endpoint(overrides: IDataObject = {}): IDataObject {
	return {
		id: ENDPOINT_ID,
		url: WEBHOOK_URL,
		event_types: ['post.published'],
		enabled: true,
		auto_disabled_at: null,
		consecutive_failures: 0,
		created_at: '2026-11-04T09:00:00.000Z',
		...overrides,
	};
}

describe('Postify Trigger > webhook lifecycle', () => {
	it('is a trigger with no inputs, one POST webhook and every Postify event type', () => {
		const { description } = trigger;
		assert.deepEqual(description.inputs, []);
		assert.strictEqual(description.webhooks?.[0].httpMethod, 'POST');
		const events = description.properties[0].options as Array<{ value: string }>;
		assert.deepEqual(events.map((event) => event.value).sort(), [
			'channel.connected',
			'channel.reauth_required',
			'delivery.failed',
			'post.failed',
			'post.published',
		]);
	});

	it('create registers the n8n URL for the chosen events and keeps the show-once secret', async () => {
		const staticData: IDataObject = {};
		const http = new MockHttp([
			{ statusCode: 201, body: { ...endpoint(), signing_secret: SECRET } },
		]);
		const created = await hooks.create.call(
			hookContext({ events: ['post.published', 'post.failed'] }, staticData, http),
		);
		assert.strictEqual(created, true);
		assert.strictEqual(http.calls[0].credentialName, 'postifyApi');
		assert.strictEqual(http.calls[0].method, 'POST');
		assert.strictEqual(http.calls[0].url, `${API}/v1/webhook-endpoints`);
		assert.deepEqual(http.calls[0].body, {
			url: WEBHOOK_URL,
			event_types: ['post.published', 'post.failed'],
		});
		assert.deepEqual(staticData, { webhookId: ENDPOINT_ID, webhookSecret: SECRET });
	});

	it('create reports a refused registration (a member, not an owner or admin)', async () => {
		const http = new MockHttp([
			{
				statusCode: 403,
				body: {
					code: 'insufficient_scope',
					detail: 'Only workspace owners and admins can manage webhook endpoints.',
				},
			},
		]);
		const error = await rejection(
			hooks.create.call(hookContext({ events: ['post.published'] }, {}, http)),
		);
		assert.match(error.message, /refused to register the webhook endpoint/);
		assert.match(error.message, /owners and admins/);
	});

	it('create removes an endpoint that came back without a secret, and fails loudly', async () => {
		const staticData: IDataObject = {};
		const http = new MockHttp([{ statusCode: 201, body: endpoint() }, { statusCode: 200 }]);
		const error = await rejection(
			hooks.create.call(hookContext({ events: ['post.published'] }, staticData, http)),
		);
		assert.match(error.message, /without returning its signing secret/);
		assert.strictEqual(http.calls[1].method, 'DELETE');
		assert.strictEqual(http.calls[1].url, `${API}/v1/webhook-endpoints/${ENDPOINT_ID}`);
		assert.deepEqual(staticData, {});
	});

	it('checkExists is false, without a request, when nothing was registered', async () => {
		const http = new MockHttp();
		assert.strictEqual(
			await hooks.checkExists.call(hookContext({ events: ['post.published'] }, {}, http)),
			false,
		);
		assert.strictEqual(http.calls.length, 0);
	});

	it('checkExists is true when the listed endpoint matches the URL, the events and is enabled', async () => {
		const http = new MockHttp([
			{ statusCode: 200, body: { data: [endpoint({ id: 'other' }), endpoint()] } },
		]);
		const staticData = { webhookId: ENDPOINT_ID, webhookSecret: SECRET };
		assert.strictEqual(
			await hooks.checkExists.call(hookContext({ events: ['post.published'] }, staticData, http)),
			true,
		);
		assert.strictEqual(http.calls[0].method, 'GET');
		assert.strictEqual(http.calls[0].url, `${API}/v1/webhook-endpoints`);
	});

	it('checkExists forgets an endpoint deleted in Postify', async () => {
		const http = new MockHttp([{ statusCode: 200, body: { data: [] } }]);
		const staticData: IDataObject = { webhookId: ENDPOINT_ID, webhookSecret: SECRET };
		assert.strictEqual(
			await hooks.checkExists.call(hookContext({ events: ['post.published'] }, staticData, http)),
			false,
		);
		assert.deepEqual(staticData, {});
	});

	for (const [reason, stale] of [
		['other events', endpoint({ event_types: ['post.failed'] })],
		['another URL', endpoint({ url: 'https://old.example.com/webhook/x' })],
		['auto-disabled', endpoint({ enabled: false })],
	] as const) {
		it(`checkExists deletes an endpoint with ${reason} so create can replace it`, async () => {
			const http = new MockHttp([
				{ statusCode: 200, body: { data: [stale] } },
				{ statusCode: 200 },
			]);
			const staticData: IDataObject = { webhookId: ENDPOINT_ID, webhookSecret: SECRET };
			assert.strictEqual(
				await hooks.checkExists.call(hookContext({ events: ['post.published'] }, staticData, http)),
				false,
			);
			assert.strictEqual(http.calls[1].method, 'DELETE');
			assert.strictEqual(http.calls[1].url, `${API}/v1/webhook-endpoints/${ENDPOINT_ID}`);
			assert.deepEqual(staticData, {});
		});
	}

	it('delete removes the endpoint and clears the state; a 404 counts as removed', async () => {
		for (const statusCode of [200, 404]) {
			const http = new MockHttp([{ statusCode, body: { id: ENDPOINT_ID, deleted: true } }]);
			const staticData: IDataObject = { webhookId: ENDPOINT_ID, webhookSecret: SECRET };
			assert.strictEqual(
				await hooks.delete.call(hookContext({ events: ['post.published'] }, staticData, http)),
				true,
			);
			assert.strictEqual(http.calls[0].method, 'DELETE');
			assert.deepEqual(staticData, {});
		}
	});

	it('delete keeps the state when Postify refuses, so n8n can try again', async () => {
		const http = new MockHttp([{ statusCode: 500 }]);
		const staticData: IDataObject = { webhookId: ENDPOINT_ID, webhookSecret: SECRET };
		assert.strictEqual(
			await hooks.delete.call(hookContext({ events: ['post.published'] }, staticData, http)),
			false,
		);
		assert.strictEqual(staticData.webhookId, ENDPOINT_ID);
	});
});

describe('Postify Trigger > deliveries', () => {
	it('answers 200 first, reads the post back, and emits the event with the post', async () => {
		const body = delivery('post.published', { postId: 'p1', succeeded: 2, failed: 0 });
		const http = new MockHttp([
			{ statusCode: 200, body: samplePost({ id: 'p1', status: 'published' }) },
		]);
		const { result, recorder } = await receive({
			body,
			headers: signedHeaders(body),
			events: ['post.published'],
			http,
		});
		assert.strictEqual(recorder.statusCode, 200);
		assert.strictEqual(result.noWebhookResponse, true);
		assert.strictEqual(http.calls[0].method, 'GET');
		assert.strictEqual(http.calls[0].url, `${API}/v1/posts/p1`);
		const [[item]] = result.workflowData ?? [];
		assert.deepEqual(item.json, {
			event: 'post.published',
			event_id: 'evt_1',
			occurred_at: '2026-11-04T10:05:12.000Z',
			test: false,
			data: { postId: 'p1', succeeded: 2, failed: 0 },
			post: samplePost({ id: 'p1', status: 'published' }),
		});
	});

	it('reads a channel event back from the channel list', async () => {
		const body = delivery('channel.reauth_required', { channelId: 'ch_x', platform: 'x' });
		const http = new MockHttp([
			{ statusCode: 200, body: { data: [sampleChannel(), sampleChannel({ id: 'ch_x' })] } },
		]);
		const { result } = await receive({
			body,
			headers: signedHeaders(body),
			events: ['channel.reauth_required'],
			http,
		});
		assert.strictEqual(http.calls[0].url, `${API}/v1/channels`);
		const [[item]] = result.workflowData ?? [];
		assert.deepEqual(item.json.channel, sampleChannel({ id: 'ch_x' }));
	});

	it('emits the bare event with no API request when Include Details is off', async () => {
		const body = delivery('post.failed', { postId: 'p1' });
		const { result, http } = await receive({
			body,
			headers: signedHeaders(body),
			events: ['post.failed'],
			includeDetails: false,
		});
		assert.strictEqual(http.calls.length, 0);
		assert.strictEqual(result.noWebhookResponse, undefined);
		const [[item]] = result.workflowData ?? [];
		assert.strictEqual(item.json.event, 'post.failed');
		assert.strictEqual(item.json.post, undefined);
	});

	it('keeps the event when the read-back fails, with the detail empty', async () => {
		const body = delivery('delivery.failed', { postId: 'p1', attemptCount: 3 });
		const http = new MockHttp([{ statusCode: 0, networkError: 'ETIMEDOUT' }]);
		const { result } = await receive({
			body,
			headers: signedHeaders(body),
			events: ['delivery.failed'],
			http,
		});
		const [[item]] = result.workflowData ?? [];
		assert.strictEqual(item.json.post, null);
	});

	it("passes Postify's Send test ping through as a test item, without a read-back", async () => {
		const body = delivery('webhook.test', { message: 'Test delivery' });
		const { result, http } = await receive({
			body,
			headers: signedHeaders(body),
			events: ['post.published'],
		});
		assert.strictEqual(http.calls.length, 0);
		const [[item]] = result.workflowData ?? [];
		assert.strictEqual(item.json.test, true);
		assert.strictEqual(item.json.event, 'webhook.test');
	});

	it('ignores an event type the trigger is not listening for', async () => {
		const body = delivery('post.failed', { postId: 'p1' });
		const { result, http } = await receive({
			body,
			headers: signedHeaders(body),
			events: ['post.published'],
		});
		assert.deepEqual(result, {});
		assert.strictEqual(http.calls.length, 0);
	});

	it('refuses a forged, missing or wrong-secret signature with 401 and starts nothing', async () => {
		const body = delivery('post.published', { postId: 'p1' });
		const wrongSecret = `whsec_${Buffer.from('another-secret-entirely!').toString('base64')}`;
		const cases: IDataObject[] = [
			signedHeaders(body, wrongSecret),
			{ ...signedHeaders(body), 'webhook-signature': undefined },
			{ ...signedHeaders(body), 'webhook-id': 'evt_other' },
			signedHeaders(`${body} `),
		];
		for (const headers of cases) {
			const { result, recorder } = await receive({ body, headers, events: ['post.published'] });
			assert.strictEqual(recorder.statusCode, 401);
			assert.strictEqual(result.workflowData, undefined);
		}
	});

	it('refuses a delivery when the node holds no secret', async () => {
		const body = delivery('post.published', { postId: 'p1' });
		const { recorder } = await receive({
			body,
			headers: signedHeaders(body),
			events: ['post.published'],
			staticData: {},
		});
		assert.strictEqual(recorder.statusCode, 401);
	});

	it('refuses a correctly signed delivery older than five minutes (a replay)', async () => {
		const body = delivery('post.published', { postId: 'p1' });
		const old = String(Math.floor(Date.now() / 1000) - 6 * 60);
		const { recorder, result } = await receive({
			body,
			headers: signedHeaders(body, SECRET, 'evt_1', old),
			events: ['post.published'],
		});
		assert.strictEqual(recorder.statusCode, 401);
		assert.match(JSON.stringify(recorder.body), /Stale/);
		assert.strictEqual(result.workflowData, undefined);
	});

	it('accepts any one signature during a secret rotation', async () => {
		const body = delivery('post.published', { postId: 'p1' });
		const headers = signedHeaders(body);
		const timestamp = String(headers['webhook-timestamp']);
		const previous = sign(
			`whsec_${Buffer.from('old-secret-24-bytes-long').toString('base64')}`,
			'evt_1',
			timestamp,
			body,
		);
		headers['webhook-signature'] = `${previous} ${String(headers['webhook-signature'])}`;
		const { result } = await receive({
			body,
			headers,
			events: ['post.published'],
			includeDetails: false,
		});
		assert.strictEqual(result.workflowData?.[0].length, 1);
	});

	it('starts the workflow once per webhook-id: a retried delivery is answered and dropped', async () => {
		const body = delivery('post.published', { postId: 'p1' });
		const staticData: IDataObject = { webhookId: ENDPOINT_ID, webhookSecret: SECRET };
		const first = await receive({
			body,
			headers: signedHeaders(body),
			events: ['post.published'],
			staticData,
			includeDetails: false,
		});
		const again = await receive({
			body,
			headers: signedHeaders(body),
			events: ['post.published'],
			staticData,
			includeDetails: false,
		});
		assert.strictEqual(first.result.workflowData?.[0].length, 1);
		assert.deepEqual(again.result, { webhookResponse: { received: true, duplicate: true } });
	});

	it(`remembers only the last ${REMEMBERED_DELIVERIES} delivery IDs`, async () => {
		const seen = Array.from({ length: REMEMBERED_DELIVERIES }, (_, index) => `old_${index}`);
		const staticData: IDataObject = {
			webhookId: ENDPOINT_ID,
			webhookSecret: SECRET,
			deliveryIds: seen,
		};
		const body = delivery('post.published', { postId: 'p1' }, 'evt_new');
		await receive({
			body,
			headers: signedHeaders(body, SECRET, 'evt_new'),
			events: ['post.published'],
			staticData,
			includeDetails: false,
		});
		const ids = staticData.deliveryIds as string[];
		assert.strictEqual(ids.length, REMEMBERED_DELIVERIES);
		assert.strictEqual(ids[ids.length - 1], 'evt_new');
		assert.notInclude(ids, 'old_0');
	});
});
