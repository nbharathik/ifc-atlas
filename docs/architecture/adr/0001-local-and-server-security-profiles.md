# ADR 0001: Local and server security profiles

- Status: Accepted
- Date: 2026-07-26
- Owners: backend, desktop, deployment

## Context

IFC Atlas supports a trusted desktop application and a shared web deployment.
Treating both as the same unauthenticated process made public binding,
WebSocket access, plugin execution, and secret handling unsafe.

## Decision

Use two explicit profiles:

- `local`: loopback-only, with a random per-launch bearer token for Tauri;
- `server`: may bind publicly, requires a strong configured bearer token, and
  disables arbitrary Python/plugin execution by default.

HTTP and WebSocket API traffic share the same authentication policy. Child
processes receive an allowlisted environment rather than the parent
environment. Extensions remain trusted-local until a real OS/process sandbox
and capability policy are implemented.

## Consequences

Benefits:

- desktop use stays simple while cross-origin local API access is protected;
- public deployments fail closed when authentication is missing;
- future per-project authorization can replace the coarse shared token behind
  the same profile boundary.

Risks:

- the shared-server token is transitional, not user/project authorization;
- local tooling must know the per-launch token;
- deployment configuration has an additional required mode.

## Verification

- security profile, HTTP, WebSocket, weak-token, and public-bind tests pass;
- Tauri tests confirm a fresh unlogged token is passed to both processes;
- server-mode code-execution tests fail closed;
- Docker security settings are structure-checked. Runtime Docker validation is
  deferred because Docker is unavailable in the current environment.
