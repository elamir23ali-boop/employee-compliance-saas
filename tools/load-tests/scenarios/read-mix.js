// E6 read-mix load scenario -- the Phase 3 (100k) / Phase 4 (stress) driver.
//
// Open-model constant-ish arrival rate: k6 fires REQ_RATE iterations/second
// regardless of how slow the API gets, so latency degradation and queueing
// show up instead of being masked by a closed VU loop.
//
//   k6 run tools/load-tests/scenarios/read-mix.js
//   k6 run -e REQ_RATE=150 -e HOLD=5m tools/load-tests/scenarios/read-mix.js
//   k6 run -e BASE_URL=http://host:3000 -e SUMMARY_JSON=out.json ...
//
// Env knobs (all optional):
//   REQ_RATE   target iterations/sec during the hold      (default 80)
//   RAMP       ramp-up duration to REQ_RATE               (default 30s)
//   HOLD       steady-state duration at REQ_RATE          (default 3m)
//   MAX_VUS    VU ceiling k6 may allocate                 (default 200)
//   BASE_URL / KEYCLOAK_ISSUER / KEYCLOAK_CLIENT_ID / SEED_KC_PASSWORD
//
// NOTE: the e0-test realm issues 300s access tokens (realm-export.json). setup()
// grabs them at t=0, so keep RAMP+HOLD+rampdown under ~4m or a long run will
// start 401ing. For longer soaks, split into back-to-back runs.

import { sleep } from 'k6';
import { fetchTokens, readMixIteration } from '../lib/workload.js';

const REQ_RATE = Number(__ENV.REQ_RATE || 80);
const RAMP = __ENV.RAMP || '30s';
const HOLD = __ENV.HOLD || '3m';
const MAX_VUS = Number(__ENV.MAX_VUS || 200);

export const options = {
  scenarios: {
    read_mix: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: Math.min(50, MAX_VUS),
      maxVUs: MAX_VUS,
      stages: [
        { target: REQ_RATE, duration: RAMP },
        { target: REQ_RATE, duration: HOLD },
        { target: 0, duration: '20s' },
      ],
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    // Fail the run if the API drops requests or slows past a usable bar.
    http_req_failed: ['rate<0.01'],
    'http_req_duration{expected_response:true}': ['p(95)<800', 'p(99)<2000'],
    lat_dash_summary: ['p(95)<500'],
    lat_dash_doc_stats: ['p(95)<800'],
    lat_dash_expiring: ['p(95)<500'],
    lat_emp_search: ['p(95)<600'],
    lat_emp_list: ['p(95)<800'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  const tokens = fetchTokens();
  console.log(`read-mix: REQ_RATE=${REQ_RATE}/s RAMP=${RAMP} HOLD=${HOLD} MAX_VUS=${MAX_VUS}`);
  return { tokens };
}

export default function (data) {
  readMixIteration(data.tokens);
}

export function handleSummary(data) {
  const out = { stdout: textSummary(data) };
  if (__ENV.SUMMARY_JSON) out[__ENV.SUMMARY_JSON] = JSON.stringify(data, null, 2);
  return out;
}

// Minimal inline text summary (avoids importing from jslib.k6.io at runtime,
// which the sandboxed CI/offline box may not reach).
function textSummary(data) {
  const m = data.metrics;
  const line = (label, metric, keys) => {
    if (!metric) return `${label}: n/a`;
    const v = metric.values;
    const parts = keys.map((k) => `${k}=${(v[k] ?? 0).toFixed(1)}`);
    return `${label.padEnd(22)} ${parts.join('  ')}`;
  };
  const L = ['avg', 'p(90)', 'p(95)', 'p(99)', 'max'];
  return [
    '',
    `iterations: ${m.iterations?.values.count ?? 0}  (${(m.iterations?.values.rate ?? 0).toFixed(1)}/s)`,
    `http_reqs:  ${m.http_reqs?.values.count ?? 0}`,
    `http_req_failed: ${((m.http_req_failed?.values.rate ?? 0) * 100).toFixed(2)}%`,
    `checks: ${((m.checks?.values.rate ?? 0) * 100).toFixed(2)}%`,
    '',
    line('http_req_duration', m.http_req_duration, L),
    line('  dashboard/summary', m.lat_dash_summary, L),
    line('  dashboard/doc-stats', m.lat_dash_doc_stats, L),
    line('  dashboard/expiring', m.lat_dash_expiring, L),
    line('  employees?q=', m.lat_emp_search, L),
    line('  employees?page=', m.lat_emp_list, L),
    line('  health/ready', m.lat_health, L),
    '',
  ].join('\n');
}
