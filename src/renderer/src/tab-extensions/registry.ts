import { TabRegistry } from "../tab-sdk"
import { aiAgentExtension } from "./ai-agent/extension"
import { coreExtension } from "./core/extension"

export const tabRegistry = new TabRegistry([aiAgentExtension, coreExtension])
