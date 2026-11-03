/**
 * Fail-closed Cloudflare staging config generator. NEVER deploys resources.
 *
 * The generated pair of Wrangler configs has no public route, workers.dev,
 * automatic Cron, credential, or binding to existing production resources.
 * A unique dedicated D1 UUID must be supplied by the operator.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PREPROD = Object.freeze({
  name:'waffopay-preprod-isolated',
  mock:'waffopay-preprod-mock',
  liveD1:'9003f99a-bcef-4ba5-a961-33c399a01ab5',
  d1Name:'waffopay-preprod-ledger-isolated',
});
const account = /^[0-9a-f]{32}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validatePreprodInput(input) {
  if(!input || typeof input!=='object' || Array.isArray(input))throw new Error('invalid_preprod_input');
  if(Object.keys(input).sort().join(',')!=='accountId,d1Id')throw new Error('unexpected_preprod_configuration');
  if(!account.test(input.accountId || ''))throw new Error('invalid_cloudflare_account');
  if(!uuid.test(input.d1Id || '')||input.d1Id===PREPROD.liveD1)throw new Error('dedicated_preprod_d1_required');
  return Object.freeze({accountId:input.accountId,d1Id:input.d1Id.toLowerCase()});
}

export function renderPreprodConfigs(input) {
  const {accountId,d1Id}=validatePreprodInput(input);
  const shared=`compatibility_date = "2026-09-05"
account_id = "${accountId}"
workers_dev = false

[observability]
enabled = true
head_sampling_rate = 1
`;
  const worker=`name = "${PREPROD.name}"
main = "../workers/waffopay/preprod-worker.js"
${shared}
[vars]
WAFFO_PREPROD_ISOLATED = "true"
WAFFO_ENVIRONMENT = "test"
WAFFO_PRODUCTION_ENABLED = "true"
WAFFO_PRODUCTION_ENTITLEMENT_ENABLED = "false"
WAFFO_PROD_MERCHANT_ID = "MER_PREPROD1"
WAFFO_PROD_STORE_ID = "STO_PREPROD1"
WAFFO_PROD_PRODUCT_ID = "PROD_PREPROD1"

[[d1_databases]]
binding = "WAFFO_PRODUCTION_LEDGER"
database_name = "${PREPROD.d1Name}"
database_id = "${d1Id}"

[[services]]
binding = "WAFFO_PREPROD_PROVIDER"
service = "${PREPROD.mock}"

[[services]]
binding = "WAFFO_PREPROD_RPC"
service = "${PREPROD.mock}"
`;
  const mock=`name = "${PREPROD.mock}"
main = "../workers/waffopay/preprod-mock.js"
${shared}`;
  // Reject accidental exposed routes, Cron or live production URLs/names.
  for(const doc of [worker,mock]){
    if(/(?:^|\n)\s*(?:routes?|crons?|triggers)\s*=/m.test(doc)
      ||/\[\[routes\]\]|\[triggers\]/.test(doc)
      ||/waffopay\.sunland\.dev|api\.waffo\.ai|supabase\.co|https?:\/\//.test(doc)
      ||/WAFFO_PRIVATE_KEY_PRODUCTION|WAFFO_PRODUCTION_SERVICE_ROLE_KEY|WAFFO_IDENTITY_SERVICE/.test(doc)) {
      throw new Error('unsafe_preprod_config');
    }
  }
  return {worker,mock};
}

export function writePreprodConfigs(input, outputDirectory) {
  const dir=resolve(outputDirectory);
  if(!dir.endsWith('/.preprod-generated'))throw new Error('preprod_output_must_be_gitignored');
  const outputs=renderPreprodConfigs(input);
  mkdirSync(dir,{recursive:true});
  for(const [kind,contents] of Object.entries(outputs)){
    const path=join(dir,kind+'.toml');
    if(existsSync(path))throw new Error('refusing_to_overwrite_existing_preprod_config');
    writeFileSync(path,contents,{mode:0o600,flag:'wx'});
  }
  return 2;
}

if(process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])){
  try{
    if(process.argv.length!==3)throw new Error('usage');
    writePreprodConfigs({
      accountId:process.env.CLOUDFLARE_ACCOUNT_ID,
      d1Id:process.env.WAFFO_PREPROD_D1_ID,
    },process.argv[2]);
    process.stdout.write('Created two isolated, private, Cron-free Wrangler configs. Nothing deployed.\n');
  }catch(error){
    process.stderr.write('[BLOCKED] '+String(error.message).slice(0,100)+'\n');
    process.exitCode=2;
  }
}
