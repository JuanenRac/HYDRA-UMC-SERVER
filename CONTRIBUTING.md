# Contributing to HYDRA-UMC-SERVER 🛰️

## Technology Stack
- **Runtime**: Node.js 20+.
- **Language**: TypeScript.
- **Framework**: Express + WebSocket (`ws`).

## Guidelines
1. **API Versioning**: Any breaking change to the JSON structure must bump `REMOTE_API_VERSION`.
2. **Atomicity**: New commands should be added to the atomic `POST /api/robot/:id/command` route.
3. **Security**: Ensure all writes are gated by the `authenticate` middleware.
