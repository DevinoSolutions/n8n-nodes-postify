import type { INodeProperties } from 'n8n-workflow';

export type DisplayShow = NonNullable<NonNullable<INodeProperties['displayOptions']>['show']>;

/** Return All and Limit for a Get Many operation. */
export function paginationFields(show: DisplayShow): INodeProperties[] {
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			description: 'Whether to return all results or only up to a given limit',
			displayOptions: { show },
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			typeOptions: { minValue: 1 },
			default: 50,
			description: 'Max number of results to return',
			displayOptions: { show: { ...show, returnAll: [false] } },
		},
	];
}

export const ID_PLACEHOLDER = 'e.g. cmc1x2y3z0001abcd';
