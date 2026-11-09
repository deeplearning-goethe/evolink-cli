import { CliError } from './errors.mjs';

const choice = values => ({ type: 'string', allowed_values: values });
const integer = (min, max, defaultValue) => ({ type: 'integer', minimum: min, maximum: max, ...(defaultValue === undefined ? {} : { default: defaultValue }) });
const string = description => ({ type: 'string', description });
const flag = { type: 'boolean' };
const media = choice(['image', 'video', 'audio']);
const allMedia = choice(['image', 'video', 'audio', 'all']);
const time = string('Creation time: ISO 8601, Unix seconds, or relative 30m, 2h, 1d.');
const agent = string('all, codex, claude-code, cursor, gemini, opencode, copilot, openclaw, hermes');
const login = { 'no-browser': flag, timeout: integer(30, 900, 180) };
const COMMANDS = {
  setup: ['[options]', 'Reuse or finish login, install and verify the skill. Free.', { agent, ...login }],
  'auth login': ['[options]', 'Browser OAuth login. Keep the command running until the callback completes.', login],
  'auth status': ['', 'Offline view of the saved login. The access token renews automatically before each command; an elapsed access_token_expires_at is not an expired login. Verify with balance.', {}],
  'auth logout': ['', 'Revoke this CLI session; other OAuth sessions retain access.', {}],
  balance: ['', 'Read account balance and the shared CLI/MCP OAuth key limits. Free.', {}],
  'models search': ['[options]', 'Search currently available models; search order is not a quality ranking.', { query: string('Search keywords'), type: allMedia, limit: integer(1, 50, 20), page: integer(1, 100000, 1) }],
  'models show': ['MODEL', 'Read documented parameters, example input, reference fields and pricing. Free.', {}],
  'models pricing': ['[options]', 'Read public default pricing rules without login. Decimal-string rates, minimums, tiers and expressions are configuration references, not account prices, quotes, bills or final spending caps. Coverage follows returned policies and legacy text adapters; empty results do not mean free.', {
    model: string('Exact model ID; omit for the filtered list'), 'product-id': string('Product ID'), operation: string('Operation, e.g. text_generation'),
    modality: choice(['text', 'image', 'video', 'audio']), lifecycle: choice(['active', 'preview', 'deprecated']), view: { ...choice(['summary', 'full']), default: 'full' },
  }],
  'models schema': ['MODEL', 'Read versioned input and generation-submission response schemas. The response schema may omit final task outputs; runtime constraints also apply.', {}],
  'models recommend': ['--type TYPE [options]', 'Compare documented available alternatives with selection reasons. Unit rates are not total quotes.', { type: media, query: string('Search keywords; every term must match'), references: string('Comma-separated image,video,audio'), limit: integer(1, 10, 3) }],
  'docs search': ['--query TEXT [options]', 'Search versioned official model reference excerpts, not the live full website.', { query: string('Required model reference keywords'), type: allMedia, limit: integer(1, 20, 5) }],
  estimate: ['--model MODEL --input-file FILE|--inputs-file FILE [options] | --refresh-quote ID', 'Prepare an estimate valid until the returned approval expiry, at most 24 hours from the estimate. generate estimates again before submitting: the same input at the approved price or lower submits; a higher price, a changed input or an expired quote needs a new estimate and approval. Show the estimated cost and material uncertainty, then obtain user approval. No spending cap is created from the estimate. --inputs-file prepares one quote for a batch: one approval covers all its inputs.', {
    model: string('Required model ID'), input: string('JSON object; mutually exclusive with input-file and inputs-file'), 'input-file': string('Local JSON file; mutually exclusive with input and inputs-file'),
    'inputs-file': string('Local JSON array or JSONL file of 1-50 inputs for one model, estimated and later submitted together'), prompt: string('Optional prompt; not with inputs-file'),
    'pricing-source': choice(['account', 'public_reference']), 'pricing-parameters': string('JSON object containing declared billing usage'),
    'refresh-quote': string('Refresh an unsubmitted saved quote with its existing input and budget'),
    'max-cost-usd': { type: 'number', exclusive_minimum: 0, maximum: 10000, description: 'Compatibility option for an explicit user budget: compare the estimate only; it does not cap the final charge' }, 'media-seconds': { type: 'number', exclusive_minimum: 0, maximum: 3600 },
  }],
  'tasks get': ['TASK_ID', 'Read one task. A failed task status is a successful query outcome. Free.', {}],
  'tasks wait': ['TASK_ID [options]', 'Wait locally. Ctrl-C stops waiting; the submitted task continues. Free.', { timeout: integer(1, 86400, 1800) }],
  'tasks batch': ['--ids ID,ID', 'Read 1-50 known tasks in one free query; missing IDs are reported, not regenerated.', { ids: string('Required comma-separated task IDs, at most 50') }],
  'tasks list': ['[options]', 'Page through account tasks. since/until filter only the selected page; total is before time filtering. Empty results do not prove no task was submitted.', {
    status: choice(['processing', 'completed', 'failed', 'cancelled']), type: media, since: time, until: time, model: string('Exact model ID'), page: integer(1, 100000, 1), limit: integer(1, 50, 20),
  }],
  'tasks resume': ['--quote ID', 'Recover an uncertain submission, or finish a partly submitted batch, with the original request ID within 23 hours of its first submission. Accepted inputs return their tasks without a new charge. Its quote must still hold: after a price rise or its expiry nothing is sent; check tasks list for what went through and estimate only the rest as a new generation or batch. Use generate for an approved quote that has never been submitted.', { quote: string('Original quote ID') }],
  usage: ['[options]', 'Summarize reported completed-task credits by creation time. Account-wide retained tasks; bounded scan with coverage and missing-cost metadata. Excludes payments/refunds and pending reservations. Not a bill or final budget.', {
    since: { ...time, default: '30d' }, until: time, model: string('Exact model ID'), type: media, 'max-pages': integer(1, 20, 5),
  }],
  upload: ['FILE [options]', 'Upload one readable local reference. Free. One-time upload addresses must not be exposed.', { 'upload-path': string('Optional upload folder') }],
  'uploads get': ['UPLOAD_ID', 'Read a saved upload receipt. An unknown result cannot be recovered by request ID; this command never uploads again. Free.', {}],
  download: ['TASK_ID --output FILE | --all --output-dir DIR [options]', 'Download original media, verify content and preserve existing files. --all writes recovery receipts; --resume verifies prior SHA-256 hashes and downloads the remainder. Partial delivery exits nonzero and never regenerates.', {
    output: string('New file path, for a single result'), index: integer(1, 50, 1), all: flag, 'output-dir': string('Directory, required with all'),
    template: { ...string('Filename placeholders: {task_id}, {index}, {kind}, {ext}; no directories'), default: '{task_id}-{index}.{ext}' }, resume: flag,
  }],
  'skills install': ['[options]', 'Install or synchronize bundled skill files; protect modified files and back up replacements.', { agent, 'replace-modified': flag }],
  'skills status': ['[options]', 'Compare installed skill contents and package version.', { agent }],
  doctor: ['[options]', 'Check prerequisites, connection, model discovery, skill contents and CLI updates separately. An available update, and installed skill findings without --agent, are guidance only. Free.', { agent }],
};
for (const type of ['image', 'video', 'audio']) COMMANDS[`generate ${type}`] = [
  '--quote ID --confirm [options] | --model MODEL --input-file FILE|--inputs-file FILE --skip-estimate [options]',
  'Submit the saved quote after explicit user approval. Changes require a new quote. --skip-estimate submits without a quote, only when the user explicitly said not to estimate or confirm; invalid input and an explicit budget are still refused, and the task is charged by actual usage. A batch returns its task IDs at once. Never call generate to poll progress.',
  { quote: string('Approved quote ID'), confirm: flag, wait: { ...flag, description: 'Wait for one task; not for a batch' }, timeout: integer(1, 86400, 1800),
    'skip-estimate': { ...flag, description: 'Submit without a quote: only when the user explicitly opted out of estimates' },
    model: string('Model ID, with skip-estimate'), input: string('JSON object, with skip-estimate'), 'input-file': string('Local JSON file, with skip-estimate'),
    'inputs-file': string('Local JSON array or JSONL file of 1-50 inputs for one model, with skip-estimate'), prompt: string('Optional prompt, with skip-estimate and one input'),
    'media-seconds': { type: 'number', exclusive_minimum: 0, maximum: 3600, description: 'With skip-estimate' }, 'pricing-parameters': string('JSON object of declared billing usage, with skip-estimate'),
    'max-cost-usd': { type: 'number', exclusive_minimum: 0, maximum: 10000, description: 'An explicit user budget, with skip-estimate; still checked before submitting' } },
];

export function commandHelp(positionals) {
  if (!positionals.length) return { commands: Object.keys(COMMANDS) };
  const name = COMMANDS[positionals.slice(0, 2).join(' ')] ? positionals.slice(0, 2).join(' ') : positionals[0];
  const entry = COMMANDS[name];
  if (!entry) {
    const subcommands = Object.keys(COMMANDS).filter(command => command.startsWith(`${positionals[0]} `));
    if (positionals.length === 1 && subcommands.length) return { command: positionals[0], subcommands,
      help: [`Usage: evolink ${positionals[0]} COMMAND --help`, '', ...subcommands.map(command => `  ${command}`), ''].join('\n') };
    throw new CliError('unknown_command', 'Unknown command. Run evolink --help for the command list.');
  }
  const [argumentsText, description, options] = entry;
  const usage = `evolink ${name}${argumentsText ? ` ${argumentsText}` : ''}`;
  const help = [`Usage: ${usage}`, '', description, '',
    ...Object.entries(options).map(([key, spec]) => `  --${key}  ${spec.allowed_values ? spec.allowed_values.join('|') : spec.description || spec.type}${spec.minimum !== undefined ? `; ${spec.minimum}-${spec.maximum}` : ''}${spec.default !== undefined ? ` (default ${spec.default})` : ''}`),
    '', 'Connection/output options: --server RESOURCE_URL, --api-url URL, --files-url URL, --token-stdin, --json, --help.', 'This help query needs no login and sends no request.', ''].join('\n');
  return { command: name, usage, description, options, help };
}
