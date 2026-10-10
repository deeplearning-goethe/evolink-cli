// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { registerDiscovery } from './tools/discovery.js';
import { registerTaskUsage } from './tools/task-usage.js';
import { registerCheckBalance } from './tools/check-balance.js';
import { registerEstimateCost } from './tools/estimate-cost.js';
import { registerGenerateTools } from './tools/generate.js';
import { registerGetModel } from './tools/get-model.js';
import { registerPricingRules } from './tools/get-pricing-rules.js';
import { registerGetTask } from './tools/get-task.js';
import { registerListTasks } from './tools/list-tasks.js';
import { registerSearchModels } from './tools/search-models.js';
export function registerPlatformOperations(registry, config) {
    registerSearchModels(registry, config);
    registerDiscovery(registry, config);
    registerGetModel(registry, config);
    registerPricingRules(registry);
    registerEstimateCost(registry, config);
    registerGenerateTools(registry, config);
    registerGetTask(registry, config);
    registerListTasks(registry, config);
    registerTaskUsage(registry, config);
    registerCheckBalance(registry, config);
}
