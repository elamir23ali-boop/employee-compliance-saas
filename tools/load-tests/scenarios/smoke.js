// E6 load-test smoke check: 1 VU, ~30 iterations. Confirms auth + every
// endpoint in the read-mix responds 200 against the current seed before a
// real load run. Not a benchmark.
//
//   k6 run tools/load-tests/scenarios/smoke.js

import { sleep } from 'k6';
import { fetchTokens, readMixIteration } from '../lib/workload.js';

export const options = {
  vus: 1,
  iterations: 30,
  thresholds: {
    checks: ['rate==1.0'],
    http_req_failed: ['rate==0.0'],
  },
};

export function setup() {
  return { tokens: fetchTokens() };
}

export default function (data) {
  readMixIteration(data.tokens);
  sleep(0.2);
}
