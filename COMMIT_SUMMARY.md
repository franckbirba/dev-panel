# OAuth 2.1 Implementation for /mcp Endpoint

## Summary

Implemented OAuth 2.1 authentication for the MCP endpoint at `/mcp`, allowing users to authenticate via Google OAuth in addition to the existing Bearer token authentication.

## Changes Made

### 1. New OAuth Implementation (`src/mcp/oauth.js`)
- Added complete OAuth 2.1 flow using the `arctic` library
- Implemented Google OAuth integration with proper state management
- Created access token system for MCP sessions
- Added session cleanup functionality

### 2. Updated MCP HTTP Server (`src/server/mcp-http.js`)
- Modified authentication to support both Bearer tokens and OAuth 2.1 access tokens
- Added OAuth login endpoint (`/mcp/oauth/login`)
- Added OAuth callback endpoint (`/mcp/oauth/callback`)
- Integrated cookie-based session management

### 3. Server Middleware (`src/server/index.js`)
- Added `cookie-parser` middleware for session cookie handling

## How It Works

1. User visits `/mcp/oauth/login` to start OAuth flow
2. User is redirected to Google OAuth consent screen
3. After consent, Google redirects back to `/mcp/oauth/callback`
4. Application exchanges authorization code for tokens
5. User info is retrieved and access token is created
6. User can now authenticate to MCP using the Bearer access token

## Security Features

- State parameter validation to prevent CSRF attacks
- Secure cookie settings (HttpOnly, Secure)
- Token expiration (24 hours)
- Session cleanup for expired OAuth sessions
- Timing-safe comparison for token validation
