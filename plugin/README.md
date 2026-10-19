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

## Authentication

`mcp.json` declares OAuth with dynamic client registration under `extensions["com.openai"].auth`, as described in "Configure MCP authentication": https://developers.openai.com/plugins/build/plugins#configure-mcp-authentication. The authorization, token and registration endpoints come from OAuth discovery at https://mcp.codeqr.io/.well-known/oauth-authorization-server, so the package carries no overrides, client id or secret.

Before connecting, check in the dashboard that the saved MCP is still `https://mcp.codeqr.io/mcp` with the current client registration. The OpenAI docs warn that an existing client registration can lock credential changes, so an upload does not necessarily replace it.
