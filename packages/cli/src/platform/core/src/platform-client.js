// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { z } from 'zod';
import { registerPlatformOperations } from './platform-operations.js';
import { runWithRequestCredentials } from './request-context.js';
import { requestUploadToken } from './services/api-client.js';
import { fileStreamUploadFrom } from './services/file-client.js';
import { errorResult, failure } from './tools/shared.js';
/** Local execution of the shared operations. Network traffic is REST only. */
export class PlatformClient {
    config;
    operations = new Map();
    constructor(config) {
        this.config = config;
        const registry = { registerTool: (name, definition, handler) => {
                this.operations.set(name, { schema: z.object(definition.inputSchema), handler });
                return {};
            } };
        registerPlatformOperations(registry, config);
    }
    async call(name, args, credentials) {
        const operation = this.operations.get(name);
        if (!operation)
            return failure('Unknown platform operation.', { error: { category: 'invalid_request' }, charged: 'no' });
        const parsed = operation.schema.safeParse(args);
        if (!parsed.success)
            return failure('The operation arguments are invalid; nothing was submitted or charged.', {
                error: { category: 'invalid_request' }, problems: parsed.error.issues.map(issue => ({ param: issue.path.join('.'), problem: issue.message })), charged: 'no',
            });
        return runWithRequestCredentials(credentials, async () => {
            try {
                return await operation.handler(parsed.data, { signal: credentials.http?.signal ?? new AbortController().signal });
            }
            catch (error) {
                return errorResult(error);
            }
        });
    }
    async upload(source, size, mime, name, credentials, uploadPath) {
        return runWithRequestCredentials(credentials, async () => {
            const token = await requestUploadToken(this.config, 'upload_file');
            return fileStreamUploadFrom(source, size, mime, name, { uploadPath, auth: { bearer: token.token },
                signal: credentials.http?.signal, timeoutMs: 900_000 });
        });
    }
}
