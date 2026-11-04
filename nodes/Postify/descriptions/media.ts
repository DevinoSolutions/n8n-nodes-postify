import type { INodeProperties } from 'n8n-workflow';
import { paginationFields } from './common';

const showForUpload = { resource: ['media'], operation: ['upload'] };
const showForGetAll = { resource: ['media'], operation: ['getAll'] };

export const mediaOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['media'] } },
	options: [
		{
			name: 'Get Many',
			value: 'getAll',
			action: 'Get many media assets',
			description: "List the workspace's media library, newest first",
		},
		{
			name: 'Upload',
			value: 'upload',
			action: 'Upload a media file',
			description:
				"Upload an image or video from the item's binary data to the media library, to attach to posts. Nothing is published.",
		},
	],
	default: 'upload',
};

export const mediaFields: INodeProperties[] = [
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		default: 'data',
		hint: 'The name of the input binary field holding the file',
		description:
			'An image, video or audio file, for example from an HTTP Request or Read/Write Files node',
		displayOptions: { show: showForUpload },
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: showForUpload },
		options: [
			{
				displayName: 'File Name',
				name: 'fileName',
				type: 'string',
				default: '',
				placeholder: 'e.g. launch-teaser.mp4',
				description: "The name to store the file under. Defaults to the binary data's file name.",
			},
			{
				displayName: 'Wait Until Ready',
				name: 'waitUntilReady',
				type: 'boolean',
				default: true,
				description:
					'Whether to wait (up to 2 minutes) until Postify has processed a video or audio file, so the asset can be attached to a scheduled post right away. Images are ready at once. Each check is one API request.',
			},
		],
	},
	...paginationFields(showForGetAll),
];
