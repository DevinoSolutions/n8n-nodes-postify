import { assert, describe, it } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import { Postify } from '../nodes/Postify/Postify.node';
import {
	executeContext,
	locator,
	MockHttp,
	rejection,
	samplePost,
	type ExecutionPosition,
} from './helpers';

const node = new Postify();
const API = 'https://app.usepostify.com';

function draftParams(overrides: IDataObject = {}): IDataObject {
	return {
		resource: 'post',
		operation: 'createDraft',
		channelIds: ['ch_li', 'ch_x'],
		text: 'Shipping the new scheduler today',
		additionalFields: {},
		...overrides,
	};
}

function scheduleParams(overrides: IDataObject = {}): IDataObject {
	return draftParams({
		operation: 'schedule',
		publishAt: '2099-01-15T09:30:00+01:00',
		...overrides,
	});
}

async function run(
	params: IDataObject[],
	http: MockHttp,
	options: { continueOnFail?: boolean; position?: ExecutionPosition; timezone?: string } = {},
) {
	return await node.execute.call(executeContext(params, http, options));
}

function keys(http: MockHttp): string[] {
	return http.calls.map((call) => String(call.headers['Idempotency-Key']));
}

function created(count: number, status = 'draft') {
	return Array.from({ length: count }, () => ({ statusCode: 201, body: samplePost({ status }) }));
}

const TWO_VARIANTS = [
	{ channel_id: 'ch_li', body: 'Shipping the new scheduler today' },
	{ channel_id: 'ch_x', body: 'Shipping the new scheduler today' },
];

describe('Post > Create Draft', () => {
	it('POSTs one variant per channel with draft: true to /v1/posts and returns the post', async () => {
		const http = new MockHttp(created(1));
		const [[item]] = await run([draftParams()], http);

		assert.deepEqual(item.json, samplePost({ status: 'draft' }));
		assert.deepEqual(item.pairedItem, { item: 0 });
		const [call] = http.calls;
		assert.strictEqual(call.credentialName, 'postifyApi');
		assert.strictEqual(call.method, 'POST');
		assert.strictEqual(call.url, `${API}/v1/posts`);
		assert.deepEqual(call.body, { variants: TWO_VARIANTS, draft: true });
		assert.match(String(call.headers['Idempotency-Key']), /^n8n-run:[0-9a-f]{64}$/);
		assert.strictEqual(call.headers.Accept, 'application/json');
	});

	it('adds a trimmed title and the same media list to every variant', async () => {
		const http = new MockHttp(created(1));
		await run(
			[
				draftParams({
					channelIds: ['ch_li'],
					additionalFields: {
						title: '  Launch week  ',
						media: {
							items: [
								{ url: 'https://cdn.example.com/a.png', type: 'image', alt: ' A chart ' },
								{ url: 'https://cdn.example.com/b.mp4', type: 'video', alt: '' },
								{ url: '   ', type: 'image' },
							],
						},
					},
				}),
			],
			http,
		);
		assert.deepEqual(http.calls[0].body, {
			variants: [
				{
					channel_id: 'ch_li',
					body: 'Shipping the new scheduler today',
					media: [
						{ url: 'https://cdn.example.com/a.png', type: 'image', alt: 'A chart' },
						{ url: 'https://cdn.example.com/b.mp4', type: 'video' },
					],
				},
			],
			draft: true,
			title: 'Launch week',
		});
	});

	it('accepts channel IDs given as a comma-separated expression', async () => {
		const http = new MockHttp(created(1));
		await run([draftParams({ channelIds: 'ch_li, ch_x' })], http);
		assert.deepEqual((http.calls[0].body as IDataObject).variants, TWO_VARIANTS);
	});

	it('refuses an item with no channel or no text without calling Postify', async () => {
		const http = new MockHttp();
		const noChannel = await rejection(run([draftParams({ channelIds: [] })], http));
		assert.match(noChannel.message, /No channel was chosen/);
		const noText = await rejection(run([draftParams({ text: '   ' })], http));
		assert.match(noText.message, /'Text' parameter is empty/);
		assert.strictEqual(http.calls.length, 0);
	});

	it('derives a distinct Idempotency-Key per item, run and execution', async () => {
		const http = new MockHttp(created(4));
		await run([draftParams(), draftParams()], http);
		await run([draftParams()], http, { position: { runIndex: 1 } });
		await run([draftParams()], http, { position: { executionId: '1002' } });
		assert.strictEqual(new Set(keys(http)).size, 4);
	});

	it('derives the same key when n8n re-runs the node for Retry On Fail', async () => {
		const http = new MockHttp(created(2));
		await run([draftParams()], http);
		await run([draftParams()], http);
		const [first, second] = keys(http);
		assert.strictEqual(first, second);
	});

	it('uses a mapped Deduplication Key, namespaced, the same in every execution', async () => {
		const http = new MockHttp(created(2));
		const params = draftParams({ additionalFields: { idempotencyKey: ' row-42 ' } });
		await run([params], http);
		await run([params], http, { position: { executionId: '9999' } });
		assert.deepEqual(keys(http), ['n8n-post:row-42', 'n8n-post:row-42']);
	});

	it('hashes a Deduplication Key that is not header-safe (spaces, non-ASCII, too long)', async () => {
		const http = new MockHttp(created(3));
		for (const key of ['row 42', 'ligne-é', 'x'.repeat(300)]) {
			await run([draftParams({ additionalFields: { idempotencyKey: key } })], http);
		}
		for (const key of keys(http)) assert.match(key, /^n8n-post:[0-9a-f]{64}$/);
	});

	it('uses a random key when n8n gives no execution ID', async () => {
		const http = new MockHttp(created(2));
		await run([draftParams()], http, { position: { executionId: null } });
		await run([draftParams()], http, { position: { executionId: null } });
		const [first, second] = keys(http);
		assert.match(first, /^n8n-[0-9a-f-]{36}$/);
		assert.notStrictEqual(first, second);
	});

	it('retries once with the same key and byte-identical body after a 5xx', async () => {
		const http = new MockHttp([{ statusCode: 502, body: 'Bad gateway' }, ...created(1)]);
		await run([draftParams()], http);
		assert.strictEqual(http.calls.length, 2);
		assert.strictEqual(keys(http)[0], keys(http)[1]);
		assert.strictEqual(JSON.stringify(http.calls[0].body), JSON.stringify(http.calls[1].body));
	});

	it('retries once with the same key after 409 idempotency_in_progress', async () => {
		const http = new MockHttp([
			{ statusCode: 409, body: { code: 'idempotency_in_progress', detail: 'Still running' } },
			...created(1),
		]);
		const [[item]] = await run([draftParams()], http);
		assert.strictEqual(http.calls.length, 2);
		assert.strictEqual(keys(http)[0], keys(http)[1]);
		assert.strictEqual(item.json.id, 'cmc9x2y3z0001abcd');
	});

	it('retries once with the same key when the first request got no answer', async () => {
		const http = new MockHttp([{ statusCode: 0, networkError: 'ECONNRESET' }, ...created(1)]);
		await run([draftParams()], http);
		assert.strictEqual(http.calls.length, 2);
		assert.strictEqual(keys(http)[0], keys(http)[1]);
	});

	it('does not retry a reused-key 422 and reports it in Postify words', async () => {
		const http = new MockHttp([
			{
				statusCode: 422,
				body: {
					code: 'idempotency_key_reused',
					detail: 'This Idempotency-Key was used with a different request body.',
					request_id: 'req_123',
				},
			},
		]);
		const error = await rejection(run([draftParams()], http));
		assert.strictEqual(http.calls.length, 1);
		assert.match(error.message, /Postify did not create the draft: This Idempotency-Key was used/);
		assert.match(String(error.description), /Request ID: req_123/);
	});

	it('explains an exhausted plan allowance instead of suggesting a retry', async () => {
		const http = new MockHttp([
			{ statusCode: 429, body: { code: 'quota_exhausted', detail: 'Monthly API requests used.' } },
		]);
		const error = await rejection(run([draftParams()], http));
		assert.strictEqual(http.calls.length, 1);
		assert.match(String(error.description), /Retrying will not help/);
	});

	it('lists field errors from a 400 validation_failed', async () => {
		const http = new MockHttp([
			{
				statusCode: 400,
				body: {
					code: 'validation_failed',
					detail: 'Request validation failed',
					errors: [{ pointer: '/variants/0/channel_id', message: 'Unknown channel' }],
				},
			},
		]);
		const error = await rejection(run([draftParams()], http));
		assert.match(String(error.description), /\/variants\/0\/channel_id: Unknown channel/);
	});

	it('with Continue On Fail, outputs the error for the failed item and goes on', async () => {
		const http = new MockHttp([
			{ statusCode: 401, body: { code: 'invalid_api_key', detail: 'Invalid API key' } },
			...created(1),
		]);
		const [items] = await run([draftParams(), draftParams()], http, { continueOnFail: true });
		assert.strictEqual(items.length, 2);
		assert.match(String(items[0].json.error), /Invalid API key/);
		assert.deepEqual(items[0].pairedItem, { item: 0 });
		assert.strictEqual(items[1].json.id, 'cmc9x2y3z0001abcd');
	});
});

describe('Post > Schedule', () => {
	it('POSTs scheduled_at with its offset kept, and no draft flag', async () => {
		const http = new MockHttp(created(1, 'scheduled'));
		await run([scheduleParams()], http);
		assert.deepEqual(http.calls[0].body, {
			variants: TWO_VARIANTS,
			scheduled_at: '2099-01-15T09:30:00+01:00',
		});
		assert.strictEqual(http.calls[0].url, `${API}/v1/posts`);
	});

	it("reads a picker value with no offset in the workflow's timezone and sends UTC", async () => {
		const http = new MockHttp(created(2, 'scheduled'));
		// 09:30 in Paris is 08:30 UTC in winter and 07:30 UTC in summer.
		await run([scheduleParams({ publishAt: '2099-01-15T09:30:00' })], http, {
			timezone: 'Europe/Paris',
		});
		await run([scheduleParams({ publishAt: '2099-07-15T09:30:00' })], http, {
			timezone: 'Europe/Paris',
		});
		assert.strictEqual((http.calls[0].body as IDataObject).scheduled_at, '2099-01-15T08:30:00Z');
		assert.strictEqual((http.calls[1].body as IDataObject).scheduled_at, '2099-07-15T07:30:00Z');
	});

	it('accepts a JS Date or a Luxon-style DateTime from an expression', async () => {
		const http = new MockHttp(created(2, 'scheduled'));
		await run([scheduleParams({ publishAt: new Date('2099-03-01T12:00:00Z') })], http);
		await run(
			[scheduleParams({ publishAt: { toISO: () => '2099-03-01T14:00:00.000+02:00' } })],
			http,
		);
		assert.strictEqual((http.calls[0].body as IDataObject).scheduled_at, '2099-03-01T12:00:00Z');
		assert.strictEqual(
			(http.calls[1].body as IDataObject).scheduled_at,
			'2099-03-01T14:00:00+02:00',
		);
	});

	it('refuses a past, unreadable or impossible time without calling Postify', async () => {
		const http = new MockHttp();
		const past = await rejection(
			run([scheduleParams({ publishAt: '2020-01-01T09:00:00Z' })], http),
		);
		assert.match(past.message, /must be in the future/);
		const junk = await rejection(run([scheduleParams({ publishAt: 'tomorrow' })], http));
		assert.match(junk.message, /must be a date and time/);
		const impossible = await rejection(
			run([scheduleParams({ publishAt: '2099-02-30T09:00:00Z' })], http),
		);
		assert.match(impossible.message, /not a real date and time/);
		assert.strictEqual(http.calls.length, 0);
	});

	it("passes on Postify's TikTok refusal with the scheduling context", async () => {
		const http = new MockHttp([
			{
				statusCode: 400,
				body: {
					code: 'validation_failed',
					detail: 'A scheduled TikTok post needs settings.tiktokPrivacy.',
				},
			},
		]);
		const error = await rejection(run([scheduleParams()], http));
		assert.match(error.message, /^Postify did not schedule the post: A scheduled TikTok post/);
	});

	it('warns in the editor that the post publishes for real', () => {
		const operations = node.description.properties.find(
			(property) =>
				property.name === 'operation' && property.displayOptions?.show?.resource?.[0] === 'post',
		);
		const scheduleOption = (
			operations?.options as Array<{ value: string; description: string }>
		).find((option) => option.value === 'schedule');
		assert.match(String(scheduleOption?.description), /publishes for real/);
		const notice = node.description.properties.find(
			(property) => property.name === 'publishNotice',
		);
		assert.strictEqual(notice?.type, 'notice');
		assert.match(notice?.displayName ?? '', /publishes for real/);
		assert.deepEqual(notice?.displayOptions?.show?.operation, ['schedule']);
	});

	it('offers no immediate publish operation', () => {
		const values = node.description.properties
			.filter((property) => property.name === 'operation')
			.flatMap((property) => (property.options as Array<{ value: string }>).map((o) => o.value));
		assert.notInclude(values, 'publish');
		assert.notInclude(values, 'publishNow');
	});
});

describe('Post > Get and Get Many', () => {
	it('GETs /v1/posts/{id} with the ID from the resource locator, URL-encoded', async () => {
		const http = new MockHttp([{ statusCode: 200, body: samplePost({ id: 'a/b' }) }]);
		const [[item]] = await run(
			[{ resource: 'post', operation: 'get', postId: locator('a/b', 'id') }],
			http,
		);
		assert.strictEqual(http.calls[0].method, 'GET');
		assert.strictEqual(http.calls[0].url, `${API}/v1/posts/a%2Fb`);
		assert.strictEqual(http.calls[0].body, undefined);
		assert.strictEqual(item.json.id, 'a/b');
	});

	it('reports an unknown post (404) as an error', async () => {
		const http = new MockHttp([
			{ statusCode: 404, body: { code: 'resource_not_found', detail: 'Post not found.' } },
		]);
		const error = await rejection(
			run([{ resource: 'post', operation: 'get', postId: locator('nope') }], http),
		);
		assert.match(error.message, /Post not found/);
	});

	it('pages GET /v1/posts with the cursor and a status filter until Return All is satisfied', async () => {
		const http = new MockHttp([
			{
				statusCode: 200,
				body: { data: [samplePost({ id: 'p1' })], has_more: true, next_cursor: 'c1' },
			},
			{
				statusCode: 200,
				body: { data: [samplePost({ id: 'p2' })], has_more: false, next_cursor: null },
			},
		]);
		const [items] = await run(
			[
				{
					resource: 'post',
					operation: 'getAll',
					returnAll: true,
					filters: { status: 'scheduled' },
				},
			],
			http,
		);
		assert.deepEqual(
			items.map((item) => item.json.id),
			['p1', 'p2'],
		);
		assert.strictEqual(http.calls[0].url, `${API}/v1/posts`);
		assert.deepEqual(http.calls[0].qs, { status: 'scheduled', limit: 100 });
		assert.deepEqual(http.calls[1].qs, { status: 'scheduled', limit: 100, after: 'c1' });
	});

	it('asks for no more than Limit and stops there', async () => {
		const http = new MockHttp([
			{
				statusCode: 200,
				body: {
					data: [samplePost({ id: 'p1' }), samplePost({ id: 'p2' })],
					has_more: true,
					next_cursor: 'c1',
				},
			},
		]);
		const [items] = await run(
			[{ resource: 'post', operation: 'getAll', returnAll: false, limit: 2, filters: {} }],
			http,
		);
		assert.strictEqual(items.length, 2);
		assert.strictEqual(http.calls.length, 1);
		assert.deepEqual(http.calls[0].qs, { limit: 2 });
	});
});
