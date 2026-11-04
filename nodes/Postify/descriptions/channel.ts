import type { INodeProperties } from 'n8n-workflow';
import { paginationFields } from './common';

const showForGetAll = { resource: ['channel'], operation: ['getAll'] };

export const channelOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['channel'] } },
	options: [
		{
			name: 'Get Many',
			value: 'getAll',
			action: 'Get many channels',
			description: 'List the social accounts connected to the workspace',
		},
	],
	default: 'getAll',
};

export const channelFields: INodeProperties[] = [...paginationFields(showForGetAll)];
