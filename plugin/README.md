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

`mcp.json` carries no authentication block. Its `$schema`, the Agent Plugins 1.0.0 `mcp.schema.json`, allows only `type`, `url` and `headers` on a streamable-http server, so an `extensions["com.openai"].auth` object there fails validation. The authorization, token and registration endpoints come from OAuth discovery at https://mcp.codeqr.io/.well-known/oauth-authorization-server, where dynamic client registration is advertised.

Before connecting, check in the dashboard that the saved MCP is still `https://mcp.codeqr.io/mcp`, that its authentication is OAuth with dynamic client registration, and that it keeps the current client registration. The OpenAI docs warn that an existing client registration can lock credential changes, so an upload does not necessarily replace it. If the dashboard asks for the method, choose OAuth with dynamic client registration there.
