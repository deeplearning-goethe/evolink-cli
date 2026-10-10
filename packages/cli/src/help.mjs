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
  'auth status': ['', 'Check this CLI login without spending money.', {}],
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
  estimate: ['--model MODEL --input-file FILE [options] | --refresh-quote ID', 'Prepare an account quote valid until the backend expiry, at most 15 minutes. Show cost uncertainties and obtain user approval. max-cost-usd checks the submission estimate; it does not cap final settlement.', {
    model: string('Required model ID'), input: string('JSON object; mutually exclusive with input-file'), 'input-file': string('Local JSON file; mutually exclusive with input'), prompt: string('Optional prompt'),
    'pricing-source': choice(['account', 'public_reference']), 'pricing-parameters': string('JSON object containing declared billing usage'),
    'refresh-quote': string('Refresh an unsubmitted saved quote with its existing input and budget'),
    'max-cost-usd': { type: 'number', exclusive_minimum: 0, maximum: 10000 }, 'media-seconds': { type: 'number', exclusive_minimum: 0, maximum: 3600 },
  }],
  'tasks get': ['TASK_ID', 'Read one task. A failed task status is a successful query outcome. Free.', {}],
  'tasks wait': ['TASK_ID [options]', 'Wait locally. Ctrl-C stops waiting; the submitted task continues. Free.', { timeout: integer(1, 86400, 1800) }],
  'tasks batch': ['--ids ID,ID', 'Read 1-50 known tasks in one free query; missing IDs are reported, not regenerated.', { ids: string('Required comma-separated task IDs, at most 50') }],
  'tasks list': ['[options]', 'Page through account tasks. since/until filter only the selected page; total is before time filtering. Empty results do not prove no task was submitted.', {
    status: choice(['processing', 'completed', 'failed', 'cancelled']), type: media, since: time, until: time, model: string('Exact model ID'), page: integer(1, 100000, 1), limit: integer(1, 50, 20),
  }],
  'tasks resume': ['--quote ID', 'Recover an uncertain submission with the original request ID. Use generate for an approved quote that has never been submitted.', { quote: string('Original quote ID') }],
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
  doctor: ['[options]', 'Check prerequisites, connection, model discovery and skill contents separately. Free.', { agent }],
};
for (const type of ['image', 'video', 'audio']) COMMANDS[`generate ${type}`] = [
  '--quote ID --confirm [options]', 'Submit the saved quote after explicit user approval. Changes require a new quote. Never call generate to poll progress.',
  { quote: string('Approved quote ID'), confirm: flag, wait: flag, timeout: integer(1, 86400, 1800) },
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
