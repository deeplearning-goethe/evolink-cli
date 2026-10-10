import { parseArgs } from 'node:util';
import * as fs from 'node:fs/promises';
import { State } from './state.mjs';
import { serverURL } from './network.mjs';
import { Credentials } from './auth.mjs';
import { Api } from './api.mjs';
import { Media } from './media.mjs';
import { upload, download, downloadAll, getUpload } from './files.mjs';
import { commandHelp } from './help.mjs';
import { installSkill, skillStatus, validateAgent } from './skills.mjs';
import { doctor } from './doctor.mjs';
import { setup } from './setup.mjs';
import { CLI_VERSION } from './version.mjs';
import { CliError, requireThat, errorView, localFile } from './errors.mjs';

const TASK_STATUS_FILTERS = Object.freeze(['processing', 'completed', 'failed', 'cancelled']);
const TASK_STATUS_HELP = `Allowed task status filters: ${TASK_STATUS_FILTERS.join(', ')}.
processing includes queued tasks. pending and queued are not filter values.
Omit --status to list recent tasks across all states.`;

const TASKS_LIST_HELP = `Usage: evolink tasks list [options]

Read recent tasks across your EvoLink account (free), newest first.

  --status STATUS  ${TASK_STATUS_FILTERS.join('|')}
  --type TYPE      image|video|audio; omit to include all media types
  --since TIME     Creation time: ISO 8601, Unix seconds, or 30m, 2h, 1d
  --until TIME     Inclusive creation-time upper bound; same formats as since
  --model MODEL    Exact model ID
  --page N         Page number, 1-100000 (default 1)
  --limit N        Integer from 1 to 50 (default 20)
  --json           Return one JSON envelope on stdout

${TASK_STATUS_HELP}
Filters are case-sensitive. A returned task status can be pending;
response statuses are not the same as allowed --status filters.
--since/--until filter the selected page; one call does not search all history.
total counts server-filtered tasks before time filtering; next_page continues.
An empty list does not prove an uncertain submission created no task.
cancelled is a read filter; the CLI does not provide a cancel command.
Connection options: --server URL, --token-stdin.

Examples:
  evolink tasks list --status processing --json
  evolink tasks list --status completed --type video --limit 50 --json
  evolink tasks list --since 30m --json
`;

const HELP = `EvoLink CLI ${CLI_VERSION} (Node.js 22+)

  setup [--agent NAME] [--no-browser] [--timeout SECONDS]
                                 Reuse or finish login, install skills and verify (free)
  auth login [--no-browser] [--timeout SECONDS]
                                 Sign in; keep this command running for the callback
  auth status | auth logout      Check or revoke this CLI session
  balance                        Verify connection and account balance (free)
  models search [--query TEXT] [--type image|video|audio|all] [--limit N]
  models show MODEL              Read parameters and pricing (free)
  models pricing [--model MODEL] [--modality TYPE] [--view summary|full]
                                 Read public default rules; not a quote (no login)
  models schema MODEL            Read versioned input/submission schemas (free)
  models recommend --type TYPE [--query TEXT] [--references image,video,audio]
  docs search --query TEXT        Search official model reference excerpts (free)
  estimate --model MODEL --input-file FILE [--media-seconds N]
           [--pricing-parameters JSON] [--pricing-source account|public_reference]
  estimate --refresh-quote ID      Refresh saved input and budget; approval required
  generate image|video|audio --quote ID --confirm [--wait] [--timeout SECONDS]
  tasks get ID | tasks wait ID [--timeout SECONDS]
  tasks list [--type TYPE] [--status STATUS] [--since TIME] [--limit N]
             [--until TIME] [--model MODEL] [--page N]
  tasks batch --ids ID,ID         Read up to 50 known tasks together (free)
  usage [--since 30d] [--until TIME] [--model MODEL] [--type TYPE] [--max-pages N]
                                 Summarize retained task costs; not a bill (free)
  tasks resume --quote ID         Recover using the original request ID
  upload FILE [--upload-path FOLDER]
  uploads get ID                 Read a saved upload receipt (free)
  download TASK_ID --output FILE [--index N]
  download TASK_ID --all --output-dir DIR [--template NAME] [--resume]
  skills install [--agent NAME] [--replace-modified]
                                 Install or update; back up replaced files
  skills status [--agent NAME]   Check installed skill content and CLI version
  doctor [--agent NAME]          Check prerequisites, connection, models and skills (free)

Options: --json, --server RESOURCE_URL, --api-url URL, --files-url URL,
         --token-stdin, --help, --version
The CLI calls the platform API directly. --server identifies the OAuth resource.
Agents: all (default), codex, claude-code, cursor, gemini, opencode, copilot,
        openclaw, hermes.
Input: --input JSON or --input-file FILE, plus optional --prompt TEXT.
${TASK_STATUS_HELP}
Task list types: image, video, audio; omit --type to include all types.
Task list example: evolink tasks list --status processing --json
Run evolink tasks list --help for filter details and recovery caveats.
Each command accepts --help --json for its machine-readable command reference.
Model/docs/usage capabilities come from the bundled shared platform module.
After upgrading the package, run evolink skills install to refresh its skill.

Login timeout: 30-900 seconds, default 180. On SSH, forward the callback port.
The CLI verifies skill files; your assistant must confirm it loads evolink-cli.
Quotes expire in 15 minutes. --confirm is only for an already approved quote.
Spending caps protect the estimate at submission, not final settlement.
Ctrl-C stops local waiting; submitted tasks continue on EvoLink.
`;

const OPTIONS = Object.fromEntries(['server', 'api-url', 'files-url', 'query', 'type', 'limit', 'model', 'modality', 'view', 'product-id', 'operation', 'lifecycle', 'input', 'input-file', 'prompt', 'media-seconds',
  'pricing-source', 'pricing-parameters', 'refresh-quote', 'max-cost-usd', 'quote', 'timeout', 'status', 'since', 'until', 'page', 'ids', 'references', 'max-pages', 'output', 'output-dir', 'template', 'index', 'upload-path', 'agent'].map(k => [k, { type: 'string' }]));
for (const k of ['json', 'token-stdin', 'no-browser', 'replace-modified', 'confirm', 'wait', 'all', 'resume', 'help', 'version']) OPTIONS[k] = { type: 'boolean' };

function number(value, name, min, max, integer = false) {
  if (value === undefined) return undefined;
  const n = Number(value);
  requireThat(value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n)), 'invalid_option', `${name} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
  return n;
}

export function validateCommand(args, options) {
  const [command, action] = args;
  const routes = {
    setup: [1, 'agent', 'no-browser', 'timeout'],
    'auth login': [2, 'no-browser', 'timeout'], 'auth status': [2], 'auth logout': [2], balance: [1],
    'models search': [2, 'query', 'type', 'limit', 'page'], 'models show': [3], 'models schema': [3],
    'models pricing': [2, 'model', 'modality', 'view', 'product-id', 'operation', 'lifecycle'],
    'models recommend': [2, 'type', 'query', 'references', 'limit'], 'docs search': [2, 'query', 'type', 'limit'],
    usage: [1, 'since', 'until', 'type', 'model', 'max-pages'],
    estimate: [1, 'model', 'input', 'input-file', 'prompt', 'media-seconds', 'max-cost-usd', 'pricing-source', 'pricing-parameters', 'refresh-quote'],
    'generate image': [2, 'quote', 'confirm', 'wait', 'timeout'], 'generate video': [2, 'quote', 'confirm', 'wait', 'timeout'], 'generate audio': [2, 'quote', 'confirm', 'wait', 'timeout'],
    'tasks get': [3], 'tasks wait': [3, 'timeout'], 'tasks batch': [2, 'ids'], 'tasks list': [2, 'type', 'status', 'since', 'until', 'model', 'page', 'limit'], 'tasks resume': [2, 'quote'],
    upload: [2, 'upload-path'], 'uploads get': [3], download: [2, 'output', 'index', 'all', 'output-dir', 'template', 'resume'],
    'skills install': [2, 'agent', 'replace-modified'], 'skills status': [2, 'agent'], doctor: [1, 'agent'],
  };
  const route = routes[`${command} ${action}`] || routes[command];
  requireThat(route && args.length === route[0], 'unknown_command', 'Unknown command or argument count. Run evolink --help.');
  const allowed = new Set(['json', 'server', 'api-url', 'files-url', 'token-stdin', ...route.slice(1)]);
  requireThat(Object.keys(options).every(k => allowed.has(k)), 'invalid_option', 'An option does not apply to this command. Run evolink --help.');
  if (options.agent !== undefined) validateAgent(options.agent);
  if (options.timeout !== undefined) number(options.timeout, 'timeout', command === 'setup' || command === 'auth' ? 30 : 1,
    command === 'setup' || command === 'auth' ? 900 : 86400, true);
  requireThat(!(command === 'setup' && options['token-stdin']), 'invalid_option', 'setup uses the saved OS login. Use balance or doctor for a one-command stdin token.');
  if (options.type !== undefined) requireThat(['image', 'video', 'audio', ...(command === 'docs' || (command === 'models' && action === 'search') ? ['all'] : [])].includes(options.type), 'invalid_type', 'Unsupported media type.');
  if (options.page !== undefined) number(options.page, 'page', 1, 100000, true);
  if (options['max-pages'] !== undefined) number(options['max-pages'], 'max-pages', 1, 20, true);
  if (options.limit !== undefined) number(options.limit, 'limit', 1, command === 'docs' ? 20 : action === 'recommend' ? 10 : 50, true);
  if (command === 'models' && action === 'recommend') {
    requireThat(options.type, 'missing_type', 'Pass --type image, video or audio.');
    if (options.references !== undefined) references(options.references);
  }
  if (command === 'docs') requireThat(options.query?.trim(), 'missing_query', 'Pass --query with model reference keywords.');
  if (command === 'tasks' && action === 'batch') taskIds(options.ids);
  if (command === 'download') {
    requireThat(options.all ? options['output-dir'] && !options.output && !options.index : options.output && !options['output-dir'] && !options.template && !options.resume,
      'invalid_option', 'Choose --output FILE [--index N], or --all --output-dir DIR [--template NAME] [--resume].');
  }
  if (options.status !== undefined) requireThat(TASK_STATUS_FILTERS.includes(options.status), 'invalid_status',
    `Unsupported task status filter. ${TASK_STATUS_HELP}`, {
      param: 'status', value: options.status, allowed_values: TASK_STATUS_FILTERS,
      queued_filter: 'processing', request_sent: false,
      next_step: 'Use --status processing for queued or running tasks, or omit --status. Run evolink tasks list --help.',
    });
}

function references(value) {
  const kinds = value.split(',');
  requireThat(kinds.length >= 1 && kinds.length <= 3 && kinds.every(kind => ['image', 'video', 'audio'].includes(kind)),
    'invalid_references', 'Use comma-separated reference kinds: image, video, audio.');
  return [...new Set(kinds)];
}

function taskIds(value) {
  const ids = (value ?? '').split(',');
  requireThat(ids.length >= 1 && ids.length <= 50 && ids.every(id => /^[A-Za-z0-9._:-]{4,128}$/.test(id)),
    'invalid_task_ids', 'Pass --ids with 1-50 comma-separated task IDs.');
  return [...new Set(ids)];
}

async function estimateArgs(options) {
  requireThat(options.model, 'missing_model', 'Pass --model.');
  requireThat(!(options.input && options['input-file']), 'invalid_input', 'Choose --input or --input-file.');
  let input = {};
  const raw = options['input-file'] ? await localFile(() => fs.readFile(options['input-file'], 'utf8'), { file: options['input-file'] }) : options.input || '{}';
  try { input = JSON.parse(raw); }
  catch { throw new CliError('invalid_input', 'The input must contain valid JSON.'); }
  requireThat(input && typeof input === 'object' && !Array.isArray(input), 'invalid_input', 'The model input must be a JSON object.');
  if (options.prompt !== undefined) {
    requireThat(input.prompt === undefined || input.prompt === options.prompt, 'invalid_input', 'prompt was supplied twice with different values.');
    input.prompt = options.prompt;
  }
  let pricingParameters;
  if (options['pricing-parameters'] !== undefined) {
    try { pricingParameters = JSON.parse(options['pricing-parameters']); } catch { throw new CliError('invalid_input', 'pricing-parameters must contain valid JSON.'); }
    requireThat(pricingParameters && typeof pricingParameters === 'object' && !Array.isArray(pricingParameters), 'invalid_input', 'pricing-parameters must be a JSON object.');
  }
  requireThat(options['pricing-source'] === undefined || ['account', 'public_reference'].includes(options['pricing-source']), 'invalid_option', 'pricing-source must be account or public_reference.');
  const media = number(options['media-seconds'], 'media-seconds', Number.MIN_VALUE, 3600);
  const cap = number(options['max-cost-usd'], 'max-cost-usd', Number.MIN_VALUE, 10_000);
  return { model: options.model, input, ...(pricingParameters !== undefined ? { pricing_parameters: pricingParameters } : {}), ...(options['pricing-source'] ? { pricing_source: options['pricing-source'] } : {}), ...(media !== undefined ? { media_seconds: media } : {}), ...(cap !== undefined ? { max_cost_usd: cap } : {}) };
}

export async function dispatch(positionals, options, { state, server, credentials, client, mcp = client, signal, progress, skillHome }) {
  client = mcp;
  const [command, action, id] = positionals;
  const media = new Media({ client, state, server });
  if (command === 'auth') {
    if (action === 'login') return credentials.login({ noBrowser: options['no-browser'], timeout: options.timeout === undefined ? undefined : Number(options.timeout) * 1000, signal, progress });
    if (action === 'status') return credentials.status();
    if (action === 'logout') return credentials.logout();
  }
  if (command === 'balance') return client.call('check_balance');
  if (command === 'models') {
    if (action === 'pricing') return client.call('get_pricing_rules', {
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.modality !== undefined ? { modality: options.modality } : {}),
      ...(options.view !== undefined ? { view: options.view } : {}),
      ...(options['product-id'] !== undefined ? { product_id: options['product-id'] } : {}),
      ...(options.operation !== undefined ? { operation: options.operation } : {}),
      ...(options.lifecycle !== undefined ? { lifecycle: options.lifecycle } : {}),
    }, { requireCapability: true });
    if (action === 'show' && id) return client.call('get_model', { model: id });
    if (action === 'schema' && id) {
      const model = await client.call('get_model', { model: id });
      requireThat(model.input_schema, 'schema_unavailable', 'The service has no versioned input schema for this model. Use models show for documented parameters; update the CLI if needed.');
      return model;
    }
    if (action === 'search') return client.call('search_models', { type: options.type || 'all', query: options.query, limit: number(options.limit, 'limit', 1, 50, true) || 20,
      ...(options.page !== undefined ? { page: Number(options.page) } : {}) },
      options.page !== undefined ? { requireCapability: true, requiredInputs: ['page'] } : undefined);
    if (action === 'recommend') return client.call('recommend_models', { type: options.type, query: options.query,
      references: options.references ? references(options.references) : [], limit: number(options.limit, 'limit', 1, 10, true) || 3 }, { requireCapability: true });
  }
  if (command === 'docs') return client.call('search_docs', { query: options.query, type: options.type || 'all', limit: number(options.limit, 'limit', 1, 20, true) || 5 }, { requireCapability: true });
  if (command === 'usage') return client.call('get_task_usage', { since: options.since || '30d', until: options.until, model: options.model, type: options.type,
    max_pages: number(options['max-pages'], 'max-pages', 1, 20, true) || 5 }, { requireCapability: true });
  if (command === 'estimate') {
    if (options['refresh-quote']) {
      requireThat(!['model', 'input', 'input-file', 'prompt', 'media-seconds', 'max-cost-usd', 'pricing-source', 'pricing-parameters'].some(key => options[key] !== undefined),
        'invalid_option', 'refresh-quote reuses the saved input and budget; do not combine it with new estimate parameters.');
      return media.refresh(options['refresh-quote']);
    }
    return media.estimate(await estimateArgs(options));
  }
  if (command === 'generate') {
    requireThat(options.quote, 'missing_quote', 'Run estimate and obtain user approval before generation.');
    requireThat(!['model', 'input', 'input-file', 'prompt', 'max-cost-usd', 'media-seconds'].some(k => options[k] !== undefined), 'quote_changed', 'Generation uses the saved quote. Change inputs by preparing a new estimate.');
    const result = await media.generate(action, options.quote, { confirmed: options.confirm });
    if (options.wait && result.task_id && result.status !== 'completed') {
      const task = await media.wait(result.task_id, { timeout: number(options.timeout, 'timeout', 1, 86400, true) || 1800, signal, progress });
      return { ...task, quote_id: options.quote, client_request_id: result.client_request_id };
    }
    return result;
  }
  if (command === 'tasks') {
    if (action === 'get' && id) return client.call('get_task', { task_id: id, wait_seconds: 0 });
    if (action === 'wait' && id) return media.wait(id, { timeout: number(options.timeout, 'timeout', 1, 86400, true) || 1800, signal, progress });
    if (action === 'resume' && options.quote) return media.resume(options.quote);
    if (action === 'batch') return client.call('list_tasks', { task_ids: taskIds(options.ids) });
    if (action === 'list') {
      const added = Object.fromEntries(['model', 'until', 'page'].filter(key => options[key] !== undefined).map(key => [key, key === 'page' ? Number(options[key]) : options[key]]));
      return client.call('list_tasks', { type: options.type, status: options.status, since: options.since, limit: number(options.limit, 'limit', 1, 50, true) || 20, ...added },
        Object.keys(added).length ? { requireCapability: true, requiredInputs: Object.keys(added) } : undefined);
    }
  }
  if (command === 'upload' && action) return upload(action, { client, state, server, signal, upload_path: options['upload-path'] });
  if (command === 'uploads' && action === 'get' && id) {
    if (client.uploadFile) return getUpload(id, { client, state, server });
    const result = await client.call('get_upload', { upload_id: id });
    // A waiting upload may contain a bearer-like one-time URL; do not expose it.
    const { upload_url, text, ...view } = result;
    return { ...view, text: upload_url ? 'The upload is waiting for its original one-time PUT. No address is exposed by this recovery query.' : text };
  }
  if (command === 'download' && action) {
    if (options.all) return downloadAll(action, options['output-dir'], { client, server, state, signal, template: options.template, resume: options.resume });
    requireThat(options.output, 'missing_output', 'Pass --output with a new local file path.');
    return download(action, options.output, { client, server, signal, index: number(options.index, 'index', 1, 50, true) || 1 });
  }
  if (command === 'skills' && action === 'install') return installSkill({ home: skillHome, agent: options.agent, replaceModified: options['replace-modified'] });
  if (command === 'skills' && action === 'status') return skillStatus({ home: skillHome, agent: options.agent });
  if (command === 'setup') return setup({ state, server, credentials, client, agent: options.agent, skillHome,
    noBrowser: options['no-browser'], timeout: options.timeout === undefined ? undefined : Number(options.timeout) * 1000, signal, progress });
  if (command === 'doctor') return doctor({ state, server, credentials, client, agent: options.agent, skillHome });
  throw new CliError('unknown_command', 'Unknown command or missing argument. Run evolink --help.');
}

function publicView(data) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !key.startsWith('_')));
}

async function stdinToken(stream) {
  let token = '';
  for await (const chunk of stream) {
    token += chunk;
    requireThat(token.length <= 64 * 1024, 'invalid_token', 'The stdin token is too long.');
  }
  token = token.trim();
  requireThat(token && !/\s/.test(token), 'invalid_token', 'Supply one OAuth access token through stdin.');
  return token;
}

export async function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }) {
  let options = { json: argv.includes('--json') };
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    let positionals;
    try { ({ values: options, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })); }
    catch { throw new CliError('invalid_option', 'Invalid command option. Run evolink --help.'); }
    if (options.version) { io.stdout.write(options.json ? JSON.stringify({ schema_version: 1, ok: true, version: CLI_VERSION }) + '\n' : CLI_VERSION + '\n'); return; }
    if (options.help || !positionals.length) {
      const reference = commandHelp(positionals);
      const help = options.help && positionals.length === 2 && positionals[0] === 'tasks' && positionals[1] === 'list' ? TASKS_LIST_HELP : reference?.help || HELP;
      io.stdout.write(options.json ? JSON.stringify({ schema_version: 1, ok: true, ...reference, help }) + '\n' : help); return;
    }
    validateCommand(positionals, options);
    const server = serverURL(options.server);
    const state = new State();
    const token = options['token-stdin'] ? await stdinToken(io.stdin) : undefined;
    const credentials = new Credentials({ server, state, token });
    const client = new Api(credentials, { signal: controller.signal, apiUrl: options['api-url'], filesUrl: options['files-url'] });
    const result = publicView(await dispatch(positionals, options, { state, server, credentials, client, signal: controller.signal, progress: message => io.stderr.write(message + '\n') }));
    const view = { schema_version: 1, ...result, ok: result.ok !== false };
    io.stdout.write(options.json ? JSON.stringify(view) + '\n' : `${result.text || JSON.stringify(view, null, 2)}\n${result.quote_id ? `Quote: ${result.quote_id}\n` : ''}`);
    if (!view.ok) process.exitCode = view.error?.code === 'interrupted' ? 130 : 1;
  } catch (error) {
    const view = { schema_version: 1, ok: false, error: errorView(error) };
    (options.json ? io.stdout : io.stderr).write(options.json ? JSON.stringify(view) + '\n' : `${view.error.code}: ${view.error.message}\n${view.error.details ? JSON.stringify(view.error.details, null, 2) + '\n' : ''}`);
    process.exitCode = error.exitCode || (controller.signal.aborted ? 130 : 1);
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
