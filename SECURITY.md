# Security Policy 🔒 (HYDRA-UMC-SERVER)

## Reporting a Vulnerability

As the central "brain" of the ecosystem, server security is vital. Please report any flaws in **JWT handling**, **API authentication**, or **Path Traversal** risks:

1. **Private Report**: Email `electrohobby3d@gmail.com`.
2. **No Public Issues**: Do not disclose authentication bypasses in the public tracker.
3. **Disclosure**: We will release a fix and then publish the advisory.

### Key Areas of Concern
- JWT token forgery.
- Unauthenticated access to `POST /api/settings`.
- Path traversal in work-file uploads.
