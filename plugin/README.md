# CodeQR plugin package

Source of the CodeQR plugin for the ChatGPT and Codex plugin directory: the manifest (`plugin.json`), the MCP server connection (`mcp.json`), the icon and the onboarding skill.

`tests/plugin-package.test.ts` checks the package against the submission limits.

## Build the ZIP

```sh
cd plugin && zip -r ../codeqr-plugin.zip . -x '.*' -x '*/.*'
```

The ZIP is ignored by git.

## Upload

The owner uploads `codeqr-plugin.zip` in platform.openai.com, under Plugins, as the existing CodeQR listing. The demo video and the reviewer credentials are entered in the dashboard form, not in the package.
