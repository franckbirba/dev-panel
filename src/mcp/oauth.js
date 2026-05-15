import { generateState, generateCodeVerifier } from 'arctic';
import { serialize, parse } from 'cookie';

// OAuth 2.1 configuration
const GOOGLE_OAUTH_CONFIG = {
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: process.env.OAUTH_REDIRECT_URI || 'https://devpanl.dev/mcp/oauth/callback',
  scopes: ['openid', 'profile', 'email']
};

// In-memory store for OAuth sessions (in production, use Redis or database)
const oauthSessions = new Map();

// Generate OAuth authorization URL
export function generateAuthUrl() {
  if (!GOOGLE_OAUTH_CONFIG.clientId) {
    throw new Error('GOOGLE_CLIENT_ID not configured');
  }
  
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  
  // Store session data
  const sessionId = generateState(); // Reuse state generator for session ID
  oauthSessions.set(sessionId, { 
    state, 
    codeVerifier,
    createdAt: Date.now()
  });
  
  // Build Google OAuth URL
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CONFIG.clientId,
    redirect_uri: GOOGLE_OAUTH_CONFIG.redirectUri,
    response_type: 'code',
    scope: GOOGLE_OAUTH_CONFIG.scopes.join(' '),
    state: state,
    access_type: 'offline',
    prompt: 'consent'
  });
  
  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    sessionId
  };
}

// Exchange authorization code for tokens
export async function exchangeCodeForTokens(code, state, storedState, codeVerifier) {
  if (state !== storedState) {
    throw new Error('Invalid state parameter');
  }
  
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CONFIG.clientId,
    client_secret: GOOGLE_OAUTH_CONFIG.clientSecret,
    redirect_uri: GOOGLE_OAUTH_CONFIG.redirectUri,
    grant_type: 'authorization_code',
    code: code,
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to exchange code for tokens: ${response.status} ${errorText}`);
  }

  const tokens = await response.json();
  return tokens;
}

// Verify ID token and get user info
export async function getUserInfo(idToken) {
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
  if (!response.ok) {
    throw new Error('Failed to verify ID token');
  }
  
  const userInfo = await response.json();
  
  // Verify the audience matches our client ID
  if (userInfo.aud !== GOOGLE_OAUTH_CONFIG.clientId) {
    throw new Error('Invalid token audience');
  }
  
  return {
    id: userInfo.sub,
    email: userInfo.email,
    name: userInfo.name,
    picture: userInfo.picture,
    email_verified: userInfo.email_verified === 'true'
  };
}

// Create access token for MCP session
export function createAccessToken(userInfo, sessionId) {
  const payload = {
    sub: userInfo.id,
    email: userInfo.email,
    name: userInfo.name,
    sessionId: sessionId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24) // 24 hours
  };
  
  // Simple base64 encoding for demo purposes
  // In production, use proper JWT signing
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

// Verify access token
export function verifyAccessToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
    
    // Check expiration
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      throw new Error('Token expired');
    }
    
    return payload;
  } catch (err) {
    throw new Error('Invalid token');
  }
}

// Cleanup expired sessions
export function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of oauthSessions.entries()) {
    // Remove sessions older than 1 hour
    if (now - session.createdAt > 60 * 60 * 1000) {
      oauthSessions.delete(sessionId);
    }
  }
}

// Periodically cleanup expired sessions
setInterval(cleanupExpiredSessions, 10 * 60 * 1000); // Every 10 minutes

// Export oauthSessions for use in mcp-http.js
export { oauthSessions };
