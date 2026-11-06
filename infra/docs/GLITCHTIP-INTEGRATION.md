# GlitchTip Integration Guide

This document provides detailed instructions for configuring and testing the GlitchTip → DevPanel captures integration, specifically for the Zeno project.

## Overview

GlitchTip is configured to forward runtime errors to the DevPanel captures inbox via a webhook integration. When an error occurs in the Zeno application, it's captured by GlitchTip and automatically sent to DevPanel where it appears as a new capture in the inbox.

## Finding the Zeno Project ID

The Zeno project ID is required to configure the webhook URL. To find it:

```bash
# On the production server
sqlite3 /home/deploy/dev-panel/storage/projects.db "SELECT id, name FROM projects WHERE name LIKE '%zeno%';"
```

This will return output similar to:
```
abcd1234-5678-90ef-ghij-klmnopqrstuv|zeno
```

The first column is the project ID that should be used in the webhook URL.

## Webhook Configuration

The webhook URL follows this pattern:
```
https://devpanl.dev/api/webhooks/glitchtip/<project-id>?secret=<GLITCHTIP_BRIDGE_HMAC_SECRET>
```

Where:
- `<project-id>` is the DevPanel project ID for Zeno (found above)
- `<GLITCHTIP_BRIDGE_HMAC_SECRET>` is stored in the production environment variables

## Testing the Integration

### Using the Test Script

A test script is provided at `scripts/test-glitchtip-zeno-webhook.sh`:

```bash
# Test with a known project ID and secret
./scripts/test-glitchtip-zeno-webhook.sh <project-id> <secret>

# Test with just a project ID (will likely fail authentication)
./scripts/test-glitchtip-zeno-webhook.sh <project-id>
```

### Manual Testing

You can also test manually with curl:

```bash
# Test the endpoint
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"action":"created","data":{"issue":{"id":"test-manual","title":"Manual test error","fingerprint":["manual-test"]}}}' \
  "https://devpanl.dev/api/webhooks/glitchtip/<project-id>?secret=<GLITCHTIP_BRIDGE_HMAC_SECRET>"
```

## Real-world Testing

To test with a real error from Zeno:

1. Trigger an error in the Zeno application (e.g., cause a JavaScript error)
2. Wait up to 5 minutes for the error to appear in GlitchTip
3. Check the DevPanel captures inbox at `https://devpanl.dev/dashboard/captures`
4. Look for a new capture with source "glitchtip"

## Troubleshooting

### Common Issues

1. **"unknown project" error (HTTP 404)**
   - The project ID in the URL is incorrect
   - Solution: Verify the project ID using the database query above

2. **"invalid signature" error (HTTP 401)**
   - The secret parameter is missing or incorrect
   - Solution: Verify the `GLITCHTIP_BRIDGE_HMAC_SECRET` value

3. **No captures appearing**
   - GlitchTip alert rules are not configured correctly
   - Solution: Check GlitchTip project settings → Alerts → Rules

### Checking Logs

To debug issues, check the DevPanel logs:

```bash
# On the production server
docker logs devpanel-api | grep -i glitchtip
```

### Rate Limiting

The system implements rate limiting of 100 events per minute per project. If exceeded, subsequent events will be rejected with HTTP 429.

## Security Notes

- The `GLITCHTIP_BRIDGE_HMAC_SECRET` should never be committed to version control
- The webhook URL acts as a capability URL - anyone with the URL can send events
- Rotate the secret by regenerating it and updating both GlitchTip and the DevPanel environment