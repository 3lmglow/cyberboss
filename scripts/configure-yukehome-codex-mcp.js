#!/usr/bin/env node
const fs = require("fs/promises");
const path = require("path");

const SECTION_NAME = "mcp_servers.cyberboss_tools";
const YUKEHOME_TOOL_TOPICS = ["reminder", "channel", "sticker"];

function configError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") {
      options.apply = true;
      continue;
    }
    const keyByFlag = {
      "--config": "configPath",
      "--cyberboss-home": "cyberbossHome",
      "--state-dir": "stateDir",
      "--workspace-root": "workspaceRoot",
      "--node": "nodePath",
    };
    const key = keyByFlag[value];
    if (!key) throw configError("cyberboss_mcp_argument_invalid", `Unknown argument: ${value}`);
    options[key] = String(argv[index + 1] || "").trim();
    index += 1;
  }
  for (const key of ["configPath", "cyberbossHome", "stateDir", "workspaceRoot", "nodePath"]) {
    if (!options[key] || !path.isAbsolute(options[key])) {
      throw configError("cyberboss_mcp_path_invalid", `${key} must be an absolute path`);
    }
    options[key] = path.normalize(options[key]);
  }
  return options;
}

function renderSection({ cyberbossHome, stateDir, workspaceRoot, nodePath }) {
  const entrypoint = path.join(cyberbossHome, "bin", "cyberboss.js");
  const args = [
    entrypoint,
    "tool-mcp-server",
    "--runtime-id",
    "yukehome",
    "--workspace-root",
    workspaceRoot,
    "--state-dir",
    stateDir,
    "--tool-topics",
    YUKEHOME_TOOL_TOPICS.join(","),
  ];
  return [
    `[${SECTION_NAME}]`,
    `command = ${JSON.stringify(nodePath)}`,
    `args = ${JSON.stringify(args)}`,
    "enabled = true",
    "required = true",
    'default_tools_approval_mode = "approve"',
    "startup_timeout_sec = 15",
    "tool_timeout_sec = 300",
  ].join("\n");
}

function removeTomlSection(lines, sectionName) {
  const header = `[${sectionName}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/u.test(lines[end])) end += 1;
  lines.splice(start, end - start);
}

function upsertSection(source, options) {
  const lines = String(source || "").replace(/\r\n/gu, "\n").split("\n");
  removeTomlSection(lines, SECTION_NAME);
  while (lines.length > 0 && !lines.at(-1).trim()) lines.pop();
  lines.push("", ...renderSection(options).split("\n"), "");
  return lines.join("\n");
}

function timestampForPath(now = new Date()) {
  return now.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

async function configure(options, { now = new Date(), logger = console } = {}) {
  const entrypoint = path.join(options.cyberbossHome, "bin", "cyberboss.js");
  for (const filePath of [options.configPath, options.nodePath, entrypoint]) {
    const info = await fs.stat(filePath);
    if (!info.isFile()) throw configError("cyberboss_mcp_file_invalid", `Not a file: ${filePath}`);
  }
  const currentInfo = await fs.stat(options.configPath);
  if (process.platform !== "win32" && (currentInfo.mode & 0o077) !== 0) {
    throw configError("cyberboss_mcp_config_permissions_unsafe", "Codex config must be owner-only");
  }
  const previous = await fs.readFile(options.configPath, "utf8");
  const next = upsertSection(previous, options);
  const changed = previous.replace(/\r\n/gu, "\n") !== next;
  if (!options.apply || !changed) {
    logger.log(JSON.stringify({ apply: options.apply, changed, section: SECTION_NAME }));
    return { applied: false, changed, backupPath: null };
  }
  const backupPath = `${options.configPath}.before-cyberboss-${timestampForPath(now)}.bak`;
  const temporaryPath = path.join(
    path.dirname(options.configPath),
    `.${path.basename(options.configPath)}.cyberboss-${process.pid}.tmp`,
  );
  await fs.copyFile(options.configPath, backupPath);
  await fs.chmod(backupPath, 0o600);
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(next, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, options.configPath);
    await fs.chmod(options.configPath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
  logger.log(JSON.stringify({ apply: true, changed: true, section: SECTION_NAME, backupPath }));
  return { applied: true, changed: true, backupPath };
}

async function main() {
  await configure(parseArgs());
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[cyberboss-mcp-config] ${error?.code || "failed"}: ${error?.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  YUKEHOME_TOOL_TOPICS,
  configure,
  parseArgs,
  renderSection,
  upsertSection,
};
