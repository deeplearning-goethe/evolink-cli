import { parseArgs } from 'node:util';
import * as fs from 'node:fs/promises';
import { State } from './state.mjs';
import { serverURL } from './network.mjs';
import { Credentials } from './auth.mjs';
import { Mcp } from './mcp.mjs';
import { Media } from './media.mjs';
import { upload, download } from './files.mjs';
import { installSkill } from './skills.mjs';
import { doctor } from './doctor.mjs';
import { CliError, requireThat, errorView, localFile } from './errors.mjs';

const HELP = `EvoLink CLI 0.5.0 (Node.js 22+)

  auth login [--no-browser]       Sign in and approve in your browser
  auth status | auth logout      Check or revoke this CLI session
  balance                        Verify connection and account balance (free)
  models search [--query TEXT] [--type image|video|audio|all] [--limit N]
  models show MODEL              Read parameters and pricing (free)
  estimate --model MODEL --input-file FILE [--max-cost-usd USD] [--media-seconds N]
  generate image|video|audio --quote ID --confirm [--wait] [--timeout SECONDS]
  tasks get ID | tasks wait ID [--timeout SECONDS]
  tasks list [--type TYPE] [--status STATUS] [--since TIME] [--limit N]
  tasks resume --quote ID         Recover using the original request ID
  upload FILE [--upload-path FOLDER]
  uploads get ID                 Recover a lost upload result (free)
  download TASK_ID --output FILE [--index N]
  skills install [--agent NAME]  Install the bundled skill for coding agents
  doctor                         Check runtime, login and connection (free)

Options: --json, --server URL, --token-stdin, --help, --version
Agents: all (default), codex, claude-code, cursor, gemini, opencode, copilot,
        openclaw, hermes.
Input: --input JSON or --input-file FILE, plus optional --prompt TEXT.
Quotes expire in 15 minutes. --confirm is only for an already approved quote.
Spending caps protect the estimate at submission, not final settlement.
Ctrl-C stops local waiting; submitted tasks continue on EvoLink.
`;

const OPTIONS = Object.fromEntries(['server', 'query', 'type', 'limit', 'model', 'input', 'input-file', 'prompt', 'media-seconds',
  'max-cost-usd', 'quote', 'timeout', 'status', 'since', 'output', 'index', 'upload-path', 'agent'].map(k => [k, { type: 'string' }]));
for (const k of ['json', 'token-stdin', 'no-browser', 'confirm', 'wait', 'help', 'version']) OPTIONS[k] = { type: 'boolean' };

function number(value, name, min, max, integer = false) {
  if (value === undefined) return undefined;
  const n = Number(value);
  requireThat(value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n)), 'invalid_option', `${name} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
  return n;
}

export function validateCommand(args, options) {
  const [command, action] = args;
  const routes = {
    'auth login': [2, 'no-browser'], 'auth status': [2], 'auth logout': [2], balance: [1],
    'models search': [2, 'query', 'type', 'limit'], 'models show': [3],
    estimate: [1, 'model', 'input', 'input-file', 'prompt', 'media-seconds', 'max-cost-usd'],
    'generate image': [2, 'quote', 'confirm', 'wait', 'timeout'], 'generate video': [2, 'quote', 'confirm', 'wait', 'timeout'], 'generate audio': [2, 'quote', 'confirm', 'wait', 'timeout'],
    'tasks get': [3], 'tasks wait': [3, 'timeout'], 'tasks list': [2, 'type', 'status', 'since', 'limit'], 'tasks resume': [2, 'quote'],
    upload: [2, 'upload-path'], 'uploads get': [3], download: [2, 'output', 'index'], 'skills install': [2, 'agent'], doctor: [1],
  };
  const route = routes[`${command} ${action}`] || routes[command];
  requireThat(route && args.length === route[0], 'unknown_command', 'Unknown command or argument count. Run evolink --help.');
  const allowed = new Set(['json', 'server', 'token-stdin', ...route.slice(1)]);
  requireThat(Object.keys(options).every(k => allowed.has(k)), 'invalid_option', 'An option does not apply to this command. Run evolink --help.');
  if (options.timeout !== undefined) number(options.timeout, 'timeout', 1, 86400, true);
  if (options.type !== undefined) requireThat(['image', 'video', 'audio', ...(command === 'models' ? ['all'] : [])].includes(options.type), 'invalid_type', 'Unsupported media type.');
  if (options.status !== undefined) requireThat(['processing', 'completed', 'failed', 'cancelled'].includes(options.status), 'invalid_status', 'Unsupported task status.');
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
  const media = number(options['media-seconds'], 'media-seconds', Number.MIN_VALUE, 3600);
  const cap = number(options['max-cost-usd'], 'max-cost-usd', Number.MIN_VALUE, 10_000);
  return { model: options.model, input, ...(media !== undefined ? { media_seconds: media } : {}), ...(cap !== undefined ? { max_cost_usd: cap } : {}) };
}

export async function dispatch(positionals, options, { state, server, credentials, mcp, signal, progress, skillHome }) {
  const [command, action, id] = positionals;
  const media = new Media({ mcp, state, server });
  if (command === 'auth') {
    if (action === 'login') return credentials.login({ noBrowser: options['no-browser'], signal, progress });
    if (action === 'status') return credentials.status();
    if (action === 'logout') return credentials.logout();
  }
  if (command === 'balance') return mcp.call('check_balance');
  if (command === 'models') {
    if (action === 'show' && id) return mcp.call('get_model', { model: id });
    if (action === 'search') return mcp.call('search_models', { type: options.type || 'all', query: options.query, limit: number(options.limit, 'limit', 1, 50, true) || 20 });
  }
  if (command === 'estimate') return media.estimate(await estimateArgs(options));
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
    if (action === 'get' && id) return mcp.call('get_task', { task_id: id, wait_seconds: 0 });
    if (action === 'wait' && id) return media.wait(id, { timeout: number(options.timeout, 'timeout', 1, 86400, true) || 1800, signal, progress });
    if (action === 'resume' && options.quote) return media.resume(options.quote);
    if (action === 'list') return mcp.call('list_tasks', { type: options.type, status: options.status, since: options.since, limit: number(options.limit, 'limit', 1, 50, true) || 20 });
  }
  if (command === 'upload' && action) return upload(action, { mcp, state, server, signal, upload_path: options['upload-path'] });
  if (command === 'uploads' && action === 'get' && id) {
    const result = await mcp.call('get_upload', { upload_id: id });
    // A waiting upload may contain a bearer-like one-time URL; do not expose it.
    const { upload_url, text, ...view } = result;
    return { ...view, text: upload_url ? 'The upload is waiting for its original one-time PUT. No address is exposed by this recovery query.' : text };
  }
  if (command === 'download' && action) {
    requireThat(options.output, 'missing_output', 'Pass --output with a new local file path.');
    return download(action, options.output, { mcp, server, signal, index: number(options.index, 'index', 1, 50, true) || 1 });
  }
  if (command === 'skills' && action === 'install') return installSkill({ home: skillHome, agent: options.agent });
  if (command === 'doctor') return doctor({ state, server, credentials, mcp });
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
    if (options.version) { io.stdout.write(options.json ? JSON.stringify({ schema_version: 1, ok: true, version: '0.5.0' }) + '\n' : '0.5.0\n'); return; }
    if (options.help || !positionals.length) { io.stdout.write(options.json ? JSON.stringify({ schema_version: 1, ok: true, help: HELP }) + '\n' : HELP); return; }
    validateCommand(positionals, options);
    const server = serverURL(options.server);
    const state = new State();
    const token = options['token-stdin'] ? await stdinToken(io.stdin) : undefined;
    const credentials = new Credentials({ server, state, token });
    const mcp = new Mcp(credentials, { signal: controller.signal });
    const result = publicView(await dispatch(positionals, options, { state, server, credentials, mcp, signal: controller.signal, progress: message => io.stderr.write(message + '\n') }));
    const view = { schema_version: 1, ...result, ok: result.ok !== false };
    io.stdout.write(options.json ? JSON.stringify(view) + '\n' : `${result.text || JSON.stringify(view, null, 2)}\n${result.quote_id ? `Quote: ${result.quote_id}\n` : ''}`);
    if (!view.ok) process.exitCode = 1;
  } catch (error) {
    const view = { schema_version: 1, ok: false, error: errorView(error) };
    (options.json ? io.stdout : io.stderr).write(options.json ? JSON.stringify(view) + '\n' : `${view.error.code}: ${view.error.message}\n${view.error.details ? JSON.stringify(view.error.details, null, 2) + '\n' : ''}`);
    process.exitCode = error.exitCode || (controller.signal.aborted ? 130 : 1);
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
