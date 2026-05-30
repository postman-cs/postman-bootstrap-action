import * as core from '@actions/core';

import { runAction } from './index.js';

runAction().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
