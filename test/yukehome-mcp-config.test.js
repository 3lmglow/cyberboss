const assert = require("node:assert/strict");
const test = require("node:test");
const {
  renderSection,
  upsertSection,
} = require("../scripts/configure-yukehome-codex-mcp");

const options = {
  configPath: "/home/ubuntu/.codex/config.toml",
  cyberbossHome: "/home/ubuntu/apps/cyberboss",
  stateDir: "/home/ubuntu/.cyberboss",
  workspaceRoot: "/home/ubuntu/workspace",
  nodePath: "/usr/bin/node",
};

test("renders the existing CyberBoss tool host as a required MCP server", () => {
  const section = renderSection(options);
  assert.match(section, /\[mcp_servers\.cyberboss_tools\]/u);
  assert.match(section, /tool-mcp-server/u);
  assert.match(section, /--state-dir/u);
  assert.match(section, /required = true/u);
});

test("upsert is idempotent and preserves unrelated Codex config", () => {
  const once = upsertSection('model = "gpt-test"\n', options);
  const twice = upsertSection(once, options);
  assert.equal(twice, once);
  assert.match(twice, /model = "gpt-test"/u);
  assert.equal((twice.match(/\[mcp_servers\.cyberboss_tools\]/gu) || []).length, 1);
});
