import type { INodeProperties } from 'n8n-workflow';
import { ID_PLACEHOLDER, paginationFields } from './common';

const showForCreate = { resource: ['post'], operation: ['createDraft', 'schedule'] };
const showForSchedule = { resource: ['post'], operation: ['schedule'] };
const showForGet = { resource: ['post'], operation: ['get'] };
const showForGetAll = { resource: ['post'], operation: ['getAll'] };

export const POST_STATUSES = [
	'draft',
	'scheduled',
	'publishing',
	'published',
	'failed',
	'needs_approval',
] as const;

export const postOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['post'] } },
	options: [
		{
			name: 'Create Draft',
			value: 'createDraft',
			action: 'Create a draft post',
			description:
				'Save a draft post for one or more channels, to review and schedule in Postify. Nothing is published.',
		},
		{
			name: 'Get',
			value: 'get',
			action: 'Get a post',
			description: "Get a post with its status and each channel's delivery outcome",
		},
		{
			name: 'Get Many',
			value: 'getAll',
			action: 'Get many posts',
			description: 'List posts, newest first',
		},
		{
			name: 'Schedule',
			value: 'schedule',
			action: 'Schedule a post to publish',
			description:
				'Schedule a post that Postify publishes for real, publicly, to the chosen social accounts at the set time',
		},
	],
	default: 'createDraft',
};

export const postFields: INodeProperties[] = [
	{
		displayName: 'Channel Names or IDs',
		name: 'channelIds',
		type: 'multiOptions',
		typeOptions: { loadOptionsMethod: 'getChannels' },
		required: true,
		default: [],
		description:
			'The connected social accounts to post to. Each gets its own copy of the text. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: { show: showForCreate },
	},
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		required: true,
		default: '',
		typeOptions: { rows: 4 },
		placeholder: 'e.g. Our new scheduler is live. Try it today.',
		description: "What to post. Postify checks it against each network's limits when it publishes.",
		displayOptions: { show: showForCreate },
	},
	{
		displayName:
			'This post publishes for real: at the time below, Postify posts it publicly to every chosen social account. To review it first, use Create Draft instead.',
		name: 'publishNotice',
		type: 'notice',
		default: '',
		displayOptions: { show: showForSchedule },
	},
	{
		displayName: 'Publish At',
		name: 'publishAt',
		type: 'dateTime',
		required: true,
		default: '',
		description:
			"When Postify publishes the post. Must be in the future. A time without a timezone is read in the workflow's timezone. TikTok channels cannot be scheduled from n8n: create a draft and schedule it in Postify.",
		displayOptions: { show: showForSchedule },
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: showForCreate },
		options: [
			{
				displayName: 'Deduplication Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '',
				placeholder: 'e.g. {{ $json.rowId }}',
				description:
					'Map something unique to this post, such as a row or record ID. Postify will not create a second post with the same key within 24 hours, even if the execution is retried or the workflow re-runs. Left empty, Retry On Fail does not create items twice, but a manual retry of a failed execution does.',
			},
			{
				displayName: 'Media',
				name: 'media',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Media',
				description:
					"Images or videos attached to the post on every chosen channel. Use the URL from the Media resource's Upload operation.",
				options: [
					{
						displayName: 'Item',
						name: 'items',
						values: [
							{
								displayName: 'URL',
								name: 'url',
								type: 'string',
								default: '',
								placeholder: 'e.g. {{ $json.url }}',
								description: 'The URL of a ready Postify media asset',
							},
							{
								displayName: 'Type',
								name: 'type',
								type: 'options',
								default: 'image',
								options: [
									{ name: 'Image', value: 'image' },
									{ name: 'Video', value: 'video' },
								],
							},
							{
								displayName: 'Alt Text',
								name: 'alt',
								type: 'string',
								default: '',
								description: 'Accessibility text, where the network supports it',
							},
						],
					},
				],
			},
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				default: '',
				description: "An internal title shown in Postify's calendar. It is never published.",
			},
		],
	},
	{
		displayName: 'Post',
		name: 'postId',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		description: 'The post to get',
		displayOptions: { show: showForGet },
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				placeholder: 'Select a post...',
				typeOptions: { searchListMethod: 'searchPosts', searchable: true },
			},
			{
				displayName: 'By ID',
				name: 'id',
				type: 'string',
				placeholder: ID_PLACEHOLDER,
			},
		],
	},
	...paginationFields(showForGetAll),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: showForGetAll },
		options: [
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				default: 'scheduled',
				options: [
					{ name: 'Draft', value: 'draft' },
					{ name: 'Failed', value: 'failed' },
					{ name: 'Needs Approval', value: 'needs_approval' },
					{ name: 'Published', value: 'published' },
					{ name: 'Publishing', value: 'publishing' },
					{ name: 'Scheduled', value: 'scheduled' },
				],
				description: 'Only posts in this state',
			},
		],
	},
];
