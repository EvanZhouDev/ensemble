import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const APP_NAME = "Ensemble"

if (process.platform === "darwin") {
  const plistPath = resolve(
    process.cwd(),
    "node_modules",
    "electron",
    "dist",
    "Electron.app",
    "Contents",
    "Info.plist",
  )

  try {
    await access(plistPath, constants.F_OK)
    await execFileAsync("/usr/bin/plutil", [
      "-replace",
      "CFBundleDisplayName",
      "-string",
      APP_NAME,
      plistPath,
    ])
    await execFileAsync("/usr/bin/plutil", [
      "-replace",
      "CFBundleName",
      "-string",
      APP_NAME,
      plistPath,
    ])
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error
    }
  }
}
