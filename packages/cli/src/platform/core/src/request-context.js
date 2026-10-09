// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { AsyncLocalStorage } from 'node:async_hooks';
const storage = new AsyncLocalStorage();
let processCredentialsDisabled = false;
let processClientName;
let processLinkCampaign = 'mcp_local';
export function runWithRequestCredentials(credentials, fn) {
    return storage.run(credentials, fn);
}
export function currentRequestCredentials() {
    return storage.getStore();
}
/** Hosted mode: never fall back to EVOLINK_API_KEY or the local credential helper. */
export function disableProcessCredentials() {
    processCredentialsDisabled = true;
}
export function processCredentialsAllowed() {
    return !processCredentialsDisabled;
}
export function currentCredentialMode() {
    if (storage.getStore()?.serviceChannel)
        return 'signed_in';
    return processCredentialsDisabled ? 'api_key' : 'local';
}
/** stdio: remember the assistant name from the MCP initialize handshake. */
export function setProcessClientName(name) {
    processClientName = sanitizeClientName(name);
}
/** The request's assistant name inside a hosted scope, otherwise the stdio client's. */
export function currentClientName() {
    const scoped = storage.getStore();
    if (scoped)
        return sanitizeClientName(scoped.clientName);
    return processClientName;
}
/** stdio entry points: which edition this process is, for site links outside a hosted request. */
export function setProcessLinkCampaign(campaign) {
    processLinkCampaign = campaign;
}
/** What site links need to know about the caller: the hosted request's own values, otherwise the stdio client's. */
export function currentLinkContext() {
    const scoped = storage.getStore();
    if (scoped) {
        return { clientId: scoped.clientId, clientName: sanitizeClientName(scoped.clientName), campaign: scoped.linkCampaign ?? processLinkCampaign };
    }
    return { clientName: processClientName, campaign: processLinkCampaign };
}
/** Printable ASCII only, at most 64 characters, so it is safe in a header and a log line. */
export function sanitizeClientName(value) {
    const cleaned = (value ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 64);
    return cleaned || undefined;
}
