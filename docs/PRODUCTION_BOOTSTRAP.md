<!-- =============================================================================
HYDRA-UMC-SERVER - Production bootstrap security guide
Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
GPL-3.0-or-later - see LICENSE
============================================================================= -->

# Production Bootstrap Security

## Required first-start configuration

Before the first `NODE_ENV=production` start, provide these values through
systemd, a container secret store or another local deployment mechanism:

```text
JWT_SECRET=<unique high-entropy secret>
HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME=<chosen administrator>
HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD=<strong unique password>
```

The server refuses a production start when `JWT_SECRET` is empty. If no local
`data/users.json` exists, it also refuses to create an administrator until both
bootstrap credentials are supplied. The values are used only to create the
local password hash; do not commit them, add them to a README or expose them to
clients.

## Development and test

Development and test mode preserve their isolated convenience fallback so a
fresh checkout can run contract tests. Do not expose that mode to an untrusted
network. A client must always request credentials from its operator rather than
assuming a reusable administrator password.

## Rotation

- Change a compromised administrator password through the authenticated users
  endpoint or administration UI.
- Rotate `JWT_SECRET` deliberately; existing JWTs become invalid after a
  restart.
- Keep deployment secrets outside version control and restrict file access to
  the account that runs the server.
