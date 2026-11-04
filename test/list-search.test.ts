import { assert, describe, it } from 'vitest';
import { getChannels, searchPosts } from '../nodes/Postify/listSearch';
import { loadOptionsContext, MockHttp, sampleChannel, samplePost } from './helpers';

describe('Channels dropdown', () => {
	it('lists GET /v1/channels as "handle (network)", with the status when it cannot publish', async () => {
		const http = new MockHttp([
			{
				statusCode: 200,
				body: {
					data: [
						sampleChannel(),
						sampleChannel({
							id: 'ch_x',
							platform: 'x',
							handle: '@acme',
							status: 'reauth_required',
						}),
					],
				},
			},
		]);
		const options = await getChannels.call(loadOptionsContext(http));
		assert.strictEqual(http.calls[0].method, 'GET');
		assert.strictEqual(http.calls[0].url, 'https://app.usepostify.com/v1/channels');
		assert.deepEqual(options, [
			{ name: 'Acme Inc (linkedin)', value: 'ch_li', description: undefined },
			{ name: '@acme (x, reauth_required)', value: 'ch_x', description: 'Status: reauth_required' },
		]);
	});
});

describe('Post search', () => {
	it('reads 100 posts per page, labels them by title or text, and passes the cursor on', async () => {
		const http = new MockHttp([
			{
				statusCode: 200,
				body: {
					data: [
						samplePost({ id: 'p1', title: 'Launch week', status: 'scheduled' }),
						samplePost({ id: 'p2', variants: [{ channel_id: 'ch_li', body: 'Hello there' }] }),
					],
					has_more: true,
					next_cursor: 'c1',
				},
			},
		]);
		const result = await searchPosts.call(loadOptionsContext(http));
		assert.deepEqual(http.calls[0].qs, { limit: 100 });
		assert.deepEqual(result, {
			results: [
				{ name: 'Launch week (scheduled)', value: 'p1' },
				{ name: 'Hello there (draft)', value: 'p2' },
			],
			paginationToken: 'c1',
		});
	});

	it('filters the page by the typed text and sends the pagination token as after', async () => {
		const http = new MockHttp([
			{
				statusCode: 200,
				body: {
					data: [
						samplePost({ id: 'p1', title: 'Launch week' }),
						samplePost({ id: 'p2', title: 'Recap' }),
					],
					has_more: false,
					next_cursor: null,
				},
			},
		]);
		const result = await searchPosts.call(loadOptionsContext(http), 'recap', 'c1');
		assert.deepEqual(http.calls[0].qs, { limit: 100, after: 'c1' });
		assert.deepEqual(result, {
			results: [{ name: 'Recap (draft)', value: 'p2' }],
			paginationToken: undefined,
		});
	});
});
