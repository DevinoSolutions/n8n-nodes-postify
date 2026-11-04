import type { INodeProperties } from 'n8n-workflow';

export const analyticsOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['analytics'] } },
	options: [
		{
			name: 'Get Summary',
			value: 'getSummary',
			action: 'Get the analytics summary',
			description:
				'Get workspace-wide post counts, delivery success rate, the 14-day publish timeline and summed engagement',
		},
	],
	default: 'getSummary',
};

export const analyticsFields: INodeProperties[] = [];
