import { constants } from "node:fs"
import { access, chmod } from "node:fs/promises"
import { resolve } from "node:path"

const helperPath = resolve(
  process.cwd(),
  "node_modules",
  "node-pty",
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "spawn-helper",
)

try {
  await access(helperPath, constants.F_OK)
  await chmod(helperPath, 0o755)
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error
  }
}
