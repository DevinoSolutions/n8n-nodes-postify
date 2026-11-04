import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
	INodePropertyOptions,
} from 'n8n-workflow';
import { postifyApiRequest } from './shared/transport';

export interface Channel extends IDataObject {
	id: string;
	platform: string;
	handle: string;
	status: string;
}

export interface Post extends IDataObject {
	id: string;
	status: string;
	title: string | null;
	body: string | null;
	scheduled_at: string | null;
	created_at: string;
	variants: Array<{ channel_id: string; body: string }>;
}

export interface CursorPage<T> {
	data: T[];
	has_more: boolean;
	next_cursor: string | null;
}

/** How a channel reads in a dropdown: two channels can share a handle across networks. */
export function channelLabel(channel: Channel): string {
	return channel.status === 'live'
		? `${channel.handle} (${channel.platform})`
		: `${channel.handle} (${channel.platform}, ${channel.status})`;
}

/**
 * Connected channels for the Channels field (GET /v1/channels). Not paginated: the channel count
 * is plan-bounded, at most 50. Channels that cannot publish are listed with their status, so a
 * workflow that picks one fails at Postify with Postify's own message instead of silently.
 */
export async function getChannels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const response = (await postifyApiRequest.call(this, {
		method: 'GET',
		path: '/v1/channels',
	})) as unknown as { data: Channel[] };
	return (response.data ?? []).map((channel) => ({
		name: channelLabel(channel),
		value: channel.id,
		description: channel.status === 'live' ? undefined : `Status: ${channel.status}`,
	}));
}

/** How a post reads in a list: its title, else the start of its text. */
export function postLabel(post: Post): string {
	const text = post.title?.trim() || post.body?.trim() || post.variants?.[0]?.body?.trim() || '';
	const short = text.length > 60 ? `${text.slice(0, 57)}...` : text;
	return `${short || post.id} (${post.status})`;
}

/**
 * Posts for the Post field, newest first (GET /v1/posts). The API has no text search, so each
 * page of 100 is filtered here by title and text.
 */
export async function searchPosts(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const qs: IDataObject = { limit: 100 };
	if (paginationToken) qs.after = paginationToken;
	const page = (await postifyApiRequest.call(this, {
		method: 'GET',
		path: '/v1/posts',
		qs,
	})) as unknown as CursorPage<Post>;
	const wanted = filter?.trim().toLowerCase();
	const results: INodeListSearchItems[] = (page.data ?? [])
		.filter(
			(post) =>
				!wanted ||
				postLabel(post).toLowerCase().includes(wanted) ||
				post.id.toLowerCase() === wanted,
		)
		.map((post) => ({ name: postLabel(post), value: post.id }));
	return { results, paginationToken: page.has_more ? (page.next_cursor ?? undefined) : undefined };
}
