import {
	NodeOperationError,
	sleep,
	type IDataObject,
	type IExecuteFunctions,
	type IN8nHttpFullResponse,
} from 'n8n-workflow';
import type { CursorPage } from './listSearch';
import { createIdempotencyKey, sendWithOneRetry, type CreatePosition } from './shared/idempotency';
import { postifyApiRequest, postifyRequest, throwApiError } from './shared/transport';
import { normalisePublishAt, toStringList } from './shared/utils';

type Handler = (this: IExecuteFunctions, itemIndex: number) => Promise<IDataObject | IDataObject[]>;

function requiredString(
	this: IExecuteFunctions,
	name: string,
	displayName: string,
	itemIndex: number,
): string {
	const value = String(this.getNodeParameter(name, itemIndex, '') ?? '').trim();
	if (value === '') {
		throw new NodeOperationError(this.getNode(), `The '${displayName}' parameter is empty`, {
			itemIndex,
		});
	}
	return value;
}

/** Reads an optional piece of n8n context; a runtime that lacks it yields `undefined`. */
function optional<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}

/** Upper bound on pages for Return All, so a huge workspace cannot run one item forever. */
const MAX_PAGES = 200;

/** GET a cursor-paginated `/v1` list until `limit` items or the last page. */
async function readPages(
	this: IExecuteFunctions,
	path: string,
	baseQs: IDataObject,
	itemIndex: number,
): Promise<IDataObject[]> {
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = returnAll ? Infinity : (this.getNodeParameter('limit', itemIndex, 50) as number);
	const results: IDataObject[] = [];
	let after: string | null = null;
	for (let page = 0; page < MAX_PAGES && results.length < limit; page++) {
		const qs: IDataObject = { ...baseQs, limit: Math.min(100, limit - results.length) };
		if (after) qs.after = after;
		const response = (await postifyApiRequest.call(
			this,
			{ method: 'GET', path, qs },
			itemIndex,
		)) as unknown as CursorPage<IDataObject>;
		results.push(...(response.data ?? []));
		if (!response.has_more || !response.next_cursor) break;
		after = response.next_cursor;
	}
	return results.slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/*                                    Post                                    */
/* -------------------------------------------------------------------------- */

interface MediaItem extends IDataObject {
	url: string;
	type: string;
	alt?: string;
}

function readMedia(fields: IDataObject): MediaItem[] {
	const items = ((fields.media as IDataObject | undefined)?.items ?? []) as IDataObject[];
	return items
		.filter((item) => typeof item.url === 'string' && item.url.trim() !== '')
		.map((item) => {
			const media: MediaItem = {
				url: String(item.url).trim(),
				type: item.type === 'video' ? 'video' : 'image',
			};
			if (typeof item.alt === 'string' && item.alt.trim() !== '') media.alt = item.alt.trim();
			return media;
		});
}

/**
 * The CreatePostRequest body: one variant per chosen channel carrying the same text and media,
 * plus exactly one mode (`draft: true` or `scheduled_at`). Publish-now is deliberately not
 * offered, like the Zapier app: it is the dangerous `posts:publish` operation.
 */
export function buildPostBody(
	this: IExecuteFunctions,
	itemIndex: number,
	mode: { draft: true } | { scheduled_at: string },
): IDataObject {
	const channelIds = toStringList(this.getNodeParameter('channelIds', itemIndex, []));
	if (channelIds.length === 0) {
		throw new NodeOperationError(this.getNode(), 'No channel was chosen', {
			itemIndex,
			description: 'Pick at least one connected channel to post to.',
		});
	}
	const text = requiredString.call(this, 'text', 'Text', itemIndex);
	const fields = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
	const media = readMedia(fields);

	const body: IDataObject = {
		variants: channelIds.map((channelId) => {
			const variant: IDataObject = { channel_id: channelId, body: text };
			if (media.length > 0) variant.media = media;
			return variant;
		}),
		...mode,
	};
	// An empty Title would be stored as a blank title; it is left out instead.
	if (typeof fields.title === 'string' && fields.title.trim() !== '') {
		body.title = fields.title.trim();
	}
	return body;
}

function createPosition(this: IExecuteFunctions, itemIndex: number): CreatePosition {
	return {
		instanceId: optional(() => this.getInstanceId()),
		workflowId: optional(() => this.getWorkflow().id),
		executionId: optional(() => this.getExecutionId()),
		nodeName: this.getNode().name,
		runIndex: optional(() => this.getWorkflowDataProxy(itemIndex).$thisRunIndex) ?? 0,
		itemIndex,
	};
}

/**
 * POST /v1/posts with an `Idempotency-Key`, retried once with the same key and body on a 5xx, a
 * 409 `idempotency_in_progress` or a request that got no answer, so a post is created once.
 */
async function createPost(
	this: IExecuteFunctions,
	itemIndex: number,
	mode: { draft: true } | { scheduled_at: string },
	context: string,
): Promise<IDataObject> {
	const body = buildPostBody.call(this, itemIndex, mode);
	const fields = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
	const key = createIdempotencyKey(fields.idempotencyKey, createPosition.call(this, itemIndex));
	const response = await sendWithOneRetry(
		async () =>
			await postifyRequest.call(this, {
				method: 'POST',
				path: '/v1/posts',
				headers: { 'Idempotency-Key': key },
				body,
			}),
	);
	if (response.statusCode >= 400) {
		throwApiError.call(this, response, context, itemIndex);
	}
	return response.body as IDataObject;
}

/** Drafts are never published and do not count against the plan's posts-per-month allowance. */
const createDraft: Handler = async function (itemIndex) {
	return await createPost.call(
		this,
		itemIndex,
		{ draft: true },
		'Postify did not create the draft:',
	);
};

/**
 * A scheduled post PUBLISHES FOR REAL at `scheduled_at`. It counts against the plan's
 * posts-per-month allowance, and Postify refuses TikTok channels without a privacy choice, which
 * this node does not set: its message says to draft the post and schedule it in Postify.
 */
const schedule: Handler = async function (itemIndex) {
	const timezone = optional(() => this.getTimezone()) ?? 'UTC';
	const publishAt = normalisePublishAt(this.getNodeParameter('publishAt', itemIndex, ''), timezone);
	if (!publishAt.ok) {
		// Refused before any request: nothing is created and no allowance spent.
		throw new NodeOperationError(this.getNode(), publishAt.message, { itemIndex });
	}
	if (Date.parse(publishAt.value) <= Date.now()) {
		throw new NodeOperationError(
			this.getNode(),
			`'Publish At' must be in the future; ${publishAt.value} has passed`,
			{ itemIndex, description: 'Pick a later time, or use Create Draft to save it instead.' },
		);
	}
	return await createPost.call(
		this,
		itemIndex,
		{ scheduled_at: publishAt.value },
		'Postify did not schedule the post:',
	);
};

const getPost: Handler = async function (itemIndex) {
	const id = String(
		this.getNodeParameter('postId', itemIndex, '', { extractValue: true }) ?? '',
	).trim();
	if (!id) {
		throw new NodeOperationError(this.getNode(), 'No post was chosen', { itemIndex });
	}
	return await postifyApiRequest.call(
		this,
		{ method: 'GET', path: `/v1/posts/${encodeURIComponent(id)}` },
		itemIndex,
	);
};

const getManyPosts: Handler = async function (itemIndex) {
	const filters = this.getNodeParameter('filters', itemIndex, {}) as IDataObject;
	const qs: IDataObject = {};
	if (typeof filters.status === 'string' && filters.status !== '') qs.status = filters.status;
	return await readPages.call(this, '/v1/posts', qs, itemIndex);
};

/* -------------------------------------------------------------------------- */
/*                                   Channel                                  */
/* -------------------------------------------------------------------------- */

/** GET /v1/channels is not paginated (at most 50 channels); Limit trims the list here. */
const getManyChannels: Handler = async function (itemIndex) {
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = returnAll ? Infinity : (this.getNodeParameter('limit', itemIndex, 50) as number);
	const response = await postifyApiRequest.call(
		this,
		{ method: 'GET', path: '/v1/channels' },
		itemIndex,
	);
	return ((response.data as IDataObject[] | undefined) ?? []).slice(0, limit);
};

/* -------------------------------------------------------------------------- */
/*                                    Media                                   */
/* -------------------------------------------------------------------------- */

/** How long and how often Upload waits for a video or audio file to finish processing. */
export const mediaWaitSettings = { intervalMs: 10_000, attempts: 12 };

interface UploadTicket extends IDataObject {
	asset_id: string;
	upload_url: string;
}

/**
 * Postify's three-step upload: POST /v1/media/uploads for a ticket (with the exact size, which
 * Postify signs into the URL), PUT the bytes to the presigned `upload_url` WITHOUT the Postify
 * credential (the URL carries its own signature, and the key must never reach the storage host),
 * then POST /v1/media/uploads/{id}/complete. A video stays `pending` while Postify probes it;
 * Wait Until Ready polls complete (idempotent) until it is `ready` or `failed`.
 */
const uploadMedia: Handler = async function (itemIndex) {
	const property = requiredString.call(this, 'binaryPropertyName', 'Input Binary Field', itemIndex);
	const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
	const binary = this.helpers.assertBinaryData(itemIndex, property);
	const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, property);

	const fileName =
		(typeof options.fileName === 'string' && options.fileName.trim()) ||
		binary.fileName ||
		`upload.${binary.fileExtension ?? 'bin'}`;
	const contentType = binary.mimeType || 'application/octet-stream';

	const ticket = (await postifyApiRequest.call(
		this,
		{
			method: 'POST',
			path: '/v1/media/uploads',
			body: { filename: fileName, content_type: contentType, size_bytes: buffer.length },
		},
		itemIndex,
	)) as UploadTicket;

	const put = (await this.helpers.httpRequest({
		method: 'PUT',
		url: ticket.upload_url,
		body: buffer,
		headers: { 'Content-Type': contentType },
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as IN8nHttpFullResponse;
	if (put.statusCode >= 400) {
		throw new NodeOperationError(
			this.getNode(),
			`The file upload to Postify's storage failed with HTTP ${put.statusCode}`,
			{
				itemIndex,
				description:
					'The upload link lives 15 minutes and accepts exactly the declared size and type. Run the node again for a new link.',
			},
		);
	}

	const completePath = `/v1/media/uploads/${encodeURIComponent(ticket.asset_id)}/complete`;
	let asset = await postifyApiRequest.call(this, { method: 'POST', path: completePath }, itemIndex);
	const wait = options.waitUntilReady !== false;
	for (
		let attempt = 0;
		wait && asset.status === 'pending' && attempt < mediaWaitSettings.attempts;
		attempt++
	) {
		await sleep(mediaWaitSettings.intervalMs);
		asset = await postifyApiRequest.call(this, { method: 'POST', path: completePath }, itemIndex);
	}
	if (asset.status === 'failed') {
		throw new NodeOperationError(
			this.getNode(),
			`Postify could not use the file: ${String(asset.failure_reason ?? 'processing failed')}`,
			{ itemIndex },
		);
	}
	return asset;
};

const getManyMedia: Handler = async function (itemIndex) {
	return await readPages.call(this, '/v1/media', {}, itemIndex);
};

/* -------------------------------------------------------------------------- */
/*                                  Analytics                                 */
/* -------------------------------------------------------------------------- */

const getAnalyticsSummary: Handler = async function (itemIndex) {
	return await postifyApiRequest.call(this, { method: 'GET', path: '/v1/analytics' }, itemIndex);
};

export const handlers: Record<string, Record<string, Handler>> = {
	post: { createDraft, schedule, get: getPost, getAll: getManyPosts },
	channel: { getAll: getManyChannels },
	media: { upload: uploadMedia, getAll: getManyMedia },
	analytics: { getSummary: getAnalyticsSummary },
};
