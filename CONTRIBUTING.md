# Contributing to HYDRA-UMC-SERVER 🛰️

## Technology Stack
- **Runtime**: Node.js 20+.
- **Language**: TypeScript.
- **Framework**: Express + WebSocket (`ws`).

## Guidelines
1. **API Versioning**: Any breaking change to the JSON structure must bump `REMOTE_API_VERSION`.
2. **Atomicity**: New commands should be added to the atomic `POST /api/robot/:id/command` route.
3. **Security**: Ensure all writes are gated by the `authenticate` middleware.

## Running the tests
`npm test` starts real sibling services for the relay contracts, so it needs checkouts of `HYDRA-UMC-SDK`, `HYDRA-UMC-VOICE-UI` and `HYDRA-UMC-CONNECTOR-HUB` next to this repository (or point `HYDRA_UMC_SDK_ROOT`, `HYDRA_UMC_VOICE_UI_ROOT` and `HYDRA_UMC_CONNECTOR_HUB_ROOT` at them). CI prepares them automatically. `npm run test:unit` needs none of them.
