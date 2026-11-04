import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class PostifyApi implements ICredentialType {
	name = 'postifyApi';

	displayName = 'Postify API';

	icon: Icon = { light: 'file:../icons/postify.svg', dark: 'file:../icons/postify.dark.svg' };

	documentationUrl =
		'https://github.com/DevinoSolutions/n8n-nodes-postify?tab=readme-ov-file#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'postify_live_...',
			description:
				'A workspace API key from Postify under Settings > API keys (a workspace owner or admin can create one). A key belongs to one workspace. The connection test lists its channels, so the key needs the channels:read scope.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://app.usepostify.com',
			url: '/v1/channels',
			method: 'GET',
		},
	};
}
