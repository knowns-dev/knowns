---
id: doc-3cd319a2beb3ecff3aac15cdf8b70325
title: Auth Patterns
createdAt: '2026-02-24T10:28:43.531Z'
updatedAt: '2026-02-24T10:29:50.517Z'
description: Authentication patterns and best practices
tags:
  - pattern
  - auth
  - security
---
# Auth Patterns

## Overview
This document describes authentication patterns used in the project.

## JWT Authentication
We use JWT tokens for stateless authentication.

### Token Structure
- Access token: 1 hour expiry
- Refresh token: 7 days expiry

## Best Practices
1. Always use HTTPS
2. Store refresh tokens in httpOnly cookies
3. Implement rate limiting



## Related Tasks
- @task-a3x4iw

## References
- [JWT.io](https://jwt.io)
- @doc/README



## Related Tasks
- @task-0olb64

## References
- [JWT.io](https://jwt.io)
- @doc/README



## Related Tasks
- @task-5tem7m

## References
- [JWT.io](https://jwt.io)
- @doc/README
