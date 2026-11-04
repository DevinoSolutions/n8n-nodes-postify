import { assert, describe, it } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import { Postify } from '../nodes/Postify/Postify.node';
import { executeContext, MockHttp, rejection, sampleChannel, type TestBinary } from './helpers';

const node = new Postify();
const API = 'https://app.usepostify.com';
const UPLOAD_URL = 'https://storage.example.com/bucket/org/asset.png?X-Amz-Signature=abc';
const PNG: TestBinary = {
	data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
	mimeType: 'image/png',
	fileName: 'chart.png',
	fileExtension: 'png',
};

function asset(overrides: IDataObject = {}): IDataObject {
	return {
		id: 'asset_1',
		filename: 'chart.png',
		content_type: 'image/png',
		kind: 'image',
		status: 'ready',
		url: 'https://cdn.example.com/asset_1.png',
		failure_reason: null,
		size_bytes: 8,
		width: 1,
		height: 1,
		duration_sec: null,
		created_at: '2026-11-04T10:00:00.000Z',
		...overrides,
	};
}

const TICKET = {
	statusCode: 201,
	body: {
		asset_id: 'asset_1',
		upload_url: UPLOAD_URL,
		method: 'PUT',
		expires_at: '2026-11-04T10:15:00.000Z',
	},
};

async function run(
	params: IDataObject[],
	http: MockHttp,
	binary: Record<string, TestBinary> = { data: PNG },
) {
	return await node.execute.call(executeContext(params, http, { binary }));
}

describe('Channel > Get Many', () => {
	it('GETs /v1/channels once and returns each channel as an item', async () => {
		const http = new MockHttp([
			{
				statusCode: 200,
				body: { data: [sampleChannel(), sampleChannel({ id: 'ch_x', platform: 'x' })] },
			},
		]);
		const [items] = await run(
			[{ resource: 'channel', operation: 'getAll', returnAll: true }],
			http,
		);
		assert.strictEqual(http.calls.length, 1);
		assert.strictEqual(http.calls[0].method, 'GET');
		assert.strictEqual(http.calls[0].url, `${API}/v1/channels`);
		assert.strictEqual(http.calls[0].qs, undefined);
		assert.deepEqual(
			items.map((item) => item.json.id),
			['ch_li', 'ch_x'],
		);
		assert.deepEqual(items[0].json, sampleChannel());
	});

	it('trims the list to Limit (the endpoint is not paginated)', async () => {
		const http = new MockHttp([
			{ statusCode: 200, body: { data: [sampleChannel(), sampleChannel({ id: 'ch_x' })] } },
		]);
		const [items] = await run(
			[{ resource: 'channel', operation: 'getAll', returnAll: false, limit: 1 }],
			http,
		);
		assert.strictEqual(items.length, 1);
	});

	it('names the missing scope when the key lacks channels:read', async () => {
		const http = new MockHttp([
			{
				statusCode: 403,
				body: {
					code: 'insufficient_scope',
					detail: 'This operation requires the `channels:read` scope.',
				},
			},
		]);
		const error = await rejection(
			run([{ resource: 'channel', operation: 'getAll', returnAll: true }], http),
		);
		assert.match(error.message, /channels:read/);
		assert.match(String(error.description), /missing a permission/);
	});
});

describe('Analytics > Get Summary', () => {
	it('GETs /v1/analytics and returns the summary as one item', async () => {
		const summary = {
			totals: { posts: 10, published: 6, scheduled: 2, failed: 1, channels: 3 },
			delivery: { attempts: 12, success_rate: 0.9 },
			timeline: [{ date: '2026-11-03', published: 2 }],
			engagement: { impressions: 100, likes: 5, comments: 1, shares: 0, clicks: 3 },
		};
		const http = new MockHttp([{ statusCode: 200, body: summary }]);
		const [[item]] = await run([{ resource: 'analytics', operation: 'getSummary' }], http);
		assert.strictEqual(http.calls[0].method, 'GET');
		assert.strictEqual(http.calls[0].url, `${API}/v1/analytics`);
		assert.deepEqual(item.json, summary);
	});
});

describe('Media > Upload', () => {
	it('gets a ticket, PUTs the bytes to the presigned URL without the API key, then completes', async () => {
		const http = new MockHttp([TICKET, { statusCode: 200 }, { statusCode: 200, body: asset() }]);
		const [[item]] = await run(
			[{ resource: 'media', operation: 'upload', binaryPropertyName: 'data', options: {} }],
			http,
		);

		const [ticket, put, complete] = http.calls;
		assert.strictEqual(ticket.credentialName, 'postifyApi');
		assert.strictEqual(ticket.method, 'POST');
		assert.strictEqual(ticket.url, `${API}/v1/media/uploads`);
		assert.deepEqual(ticket.body, {
			filename: 'chart.png',
			content_type: 'image/png',
			size_bytes: 8,
		});

		assert.strictEqual(put.credentialName, null);
		assert.strictEqual(put.method, 'PUT');
		assert.strictEqual(put.url, UPLOAD_URL);
		assert.deepEqual(put.headers, { 'Content-Type': 'image/png' });
		assert.strictEqual(put.headers.Authorization, undefined);
		assert.ok(Buffer.isBuffer(put.body));
		assert.ok((put.body as Buffer).equals(PNG.data));

		assert.strictEqual(complete.credentialName, 'postifyApi');
		assert.strictEqual(complete.method, 'POST');
		assert.strictEqual(complete.url, `${API}/v1/media/uploads/asset_1/complete`);
		assert.deepEqual(item.json, asset());
	});

	it('uses File Name when set, and the named binary field', async () => {
		const http = new MockHttp([TICKET, { statusCode: 200 }, { statusCode: 200, body: asset() }]);
		await run(
			[
				{
					resource: 'media',
					operation: 'upload',
					binaryPropertyName: 'video',
					options: { fileName: ' teaser.mp4 ' },
				},
			],
			http,
			{ video: { data: Buffer.alloc(3), mimeType: 'video/mp4' } },
		);
		assert.deepEqual(http.calls[0].body, {
			filename: 'teaser.mp4',
			content_type: 'video/mp4',
			size_bytes: 3,
		});
	});

	it('polls complete while a video is pending, until it is ready', async () => {
		const pending = { statusCode: 200, body: asset({ status: 'pending', url: null }) };
		const http = new MockHttp([
			TICKET,
			{ statusCode: 200 },
			pending,
			pending,
			{ statusCode: 200, body: asset({ kind: 'video' }) },
		]);
		const [[item]] = await run(
			[{ resource: 'media', operation: 'upload', binaryPropertyName: 'data', options: {} }],
			http,
		);
		assert.strictEqual(http.calls.length, 5);
		for (const call of http.calls.slice(2)) {
			assert.strictEqual(call.url, `${API}/v1/media/uploads/asset_1/complete`);
		}
		assert.strictEqual(item.json.status, 'ready');
	});

	it('returns the pending asset at once when Wait Until Ready is off', async () => {
		const http = new MockHttp([
			TICKET,
			{ statusCode: 200 },
			{ statusCode: 200, body: asset({ status: 'pending', url: null }) },
		]);
		const [[item]] = await run(
			[
				{
					resource: 'media',
					operation: 'upload',
					binaryPropertyName: 'data',
					options: { waitUntilReady: false },
				},
			],
			http,
		);
		assert.strictEqual(http.calls.length, 3);
		assert.strictEqual(item.json.status, 'pending');
	});

	it("fails the item with Postify's reason when the asset is failed", async () => {
		const http = new MockHttp([
			TICKET,
			{ statusCode: 200 },
			{
				statusCode: 400,
				body: { code: 'validation_failed', detail: 'The file is over your plan limit.' },
			},
		]);
		const error = await rejection(
			run(
				[{ resource: 'media', operation: 'upload', binaryPropertyName: 'data', options: {} }],
				http,
			),
		);
		assert.match(error.message, /over your plan limit/);

		const failed = new MockHttp([
			TICKET,
			{ statusCode: 200 },
			{ statusCode: 200, body: asset({ status: 'failed', failure_reason: 'No video track' }) },
		]);
		const failure = await rejection(
			run(
				[{ resource: 'media', operation: 'upload', binaryPropertyName: 'data', options: {} }],
				failed,
			),
		);
		assert.match(failure.message, /Postify could not use the file: No video track/);
	});

	it('stops before completing when the storage PUT is refused', async () => {
		const http = new MockHttp([TICKET, { statusCode: 403, body: 'SignatureDoesNotMatch' }]);
		const error = await rejection(
			run(
				[{ resource: 'media', operation: 'upload', binaryPropertyName: 'data', options: {} }],
				http,
			),
		);
		assert.match(error.message, /upload to Postify's storage failed with HTTP 403/);
		assert.strictEqual(http.calls.length, 2);
	});
});

describe('Media > Get Many', () => {
	it('pages GET /v1/media with the cursor', async () => {
		const http = new MockHttp([
			{ statusCode: 200, body: { data: [asset({ id: 'a1' })], has_more: true, next_cursor: 'm1' } },
			{
				statusCode: 200,
				body: { data: [asset({ id: 'a2' })], has_more: false, next_cursor: null },
			},
		]);
		const [items] = await run([{ resource: 'media', operation: 'getAll', returnAll: true }], http);
		assert.deepEqual(
			items.map((item) => item.json.id),
			['a1', 'a2'],
		);
		assert.strictEqual(http.calls[0].url, `${API}/v1/media`);
		assert.deepEqual(http.calls[0].qs, { limit: 100 });
		assert.deepEqual(http.calls[1].qs, { limit: 100, after: 'm1' });
	});
});
