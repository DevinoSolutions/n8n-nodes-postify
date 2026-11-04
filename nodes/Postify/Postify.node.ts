import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type JsonObject,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';
import { handlers } from './actions';
import { analyticsFields, analyticsOperations } from './descriptions/analytics';
import { channelFields, channelOperations } from './descriptions/channel';
import { mediaFields, mediaOperations } from './descriptions/media';
import { postFields, postOperations } from './descriptions/post';
import { getChannels, searchPosts } from './listSearch';

/*
 * Programmatic style, not declarative: creating a post retries once with the same
 * Idempotency-Key and body on a 5xx or a 409 idempotency_in_progress, and Upload is three
 * dependent calls (ticket, unauthenticated PUT to the presigned URL, complete) with polling,
 * which routing rules cannot express.
 */
export class Postify implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Postify',
		name: 'postify',
		icon: { light: 'file:../../icons/postify.svg', dark: 'file:../../icons/postify.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Draft and schedule social media posts across your connected channels, upload media, and read analytics in Postify',
		defaults: {
			name: 'Postify',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'postifyApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Analytics',
						value: 'analytics',
						description: 'Workspace-wide publishing and engagement numbers',
					},
					{
						name: 'Channel',
						value: 'channel',
						description: 'Social accounts connected to the workspace',
					},
					{
						name: 'Media',
						value: 'media',
						description: 'Images and videos in the media library',
					},
					{
						name: 'Post',
						value: 'post',
						description: 'Draft and scheduled social media posts',
					},
				],
				default: 'post',
			},
			postOperations,
			channelOperations,
			mediaOperations,
			analyticsOperations,
			...postFields,
			...channelFields,
			...mediaFields,
			...analyticsFields,
		],
	};

	methods = {
		loadOptions: {
			getChannels,
		},
		listSearch: {
			searchPosts,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const handler = handlers[resource]?.[operation];
				if (!handler) {
					throw new NodeOperationError(
						this.getNode(),
						`The operation '${operation}' is not supported for '${resource}'`,
						{ itemIndex },
					);
				}

				const result = await handler.call(this, itemIndex);
				const results: IDataObject[] = Array.isArray(result) ? result : [result];
				returnData.push(
					...this.helpers.constructExecutionMetaData(this.helpers.returnJsonArray(results), {
						itemData: { item: itemIndex },
					}),
				);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				// Errors from the request helpers are already NodeApiError or NodeOperationError, and
				// both constructors hand those back unchanged; anything else gets wrapped.
				if (error instanceof NodeApiError) {
					throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}

		return [returnData];
	}
}
