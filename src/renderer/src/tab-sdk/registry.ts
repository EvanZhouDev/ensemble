import type { TabExtensionDefinition, TabTypeDefinition } from "./types"

export class TabRegistry {
  readonly extensions: TabExtensionDefinition[]
  readonly tabTypes: TabTypeDefinition[]
  private readonly tabTypeById: Map<string, TabTypeDefinition>

  constructor(extensions: TabExtensionDefinition[]) {
    this.extensions = extensions
    this.tabTypes = extensions.flatMap((extension) => extension.tabs)
    this.tabTypeById = new Map(this.tabTypes.map((tabType) => [tabType.id, tabType]))
  }

  getTabType(tabTypeId: string): TabTypeDefinition | null {
    return this.tabTypeById.get(tabTypeId) ?? null
  }
}
