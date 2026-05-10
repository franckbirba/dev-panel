import { z } from 'zod';
import { adminGet } from './_http.js';

// Pull all the rich metadata the widget attached as a `system` thread
// message and hoist it to the top level of the capability response.
// Why: Qwen3-Coder is a small model — it doesn't deep-scan nested
// `messages[].metadata` objects on its own. The widget already captures
// url, userAgent, viewport, console, network, dom, screenshot, etc
// (src/react/captureFlow.js#postCapture), but stores them on the first
// system message of the capture's thread. We surface them flat so the
// LLM uses them without prompting.
function extractWidgetContext(messages) {
  if (!Array.isArray(messages)) return {};
  const sys = messages.find(
    (m) => m && m.role === 'system' && m.metadata && typeof m.metadata === 'object'
  );
  if (!sys) return {};
  const md = sys.metadata;
  // Console + network arrays can be huge — cap each so they don't blow
  // the LLM's context. Full data is still in the DB if Shelly asks for it.
  const consoleEntries = Array.isArray(md.console) ? md.console.slice(-10) : [];
  const networkErrors = Array.isArray(md.network) ? md.network.slice(-5) : [];
  return {
    url: md.url ?? null,
    user_agent: md.userAgent ?? null,
    viewport: md.viewport ?? null,
    title: md.title ?? null,
    component: md.component ?? null,
    has_screenshot: !!md.screenshot,
    has_dom_snapshot: !!md.dom,
    console_tail: consoleEntries,
    network_errors: networkErrors,
    // Truncate the dom snapshot so it's a hint, not a 200KB blob.
    dom_excerpt:
      typeof md.dom === 'string' ? md.dom.slice(0, 800) : null,
  };
}

export const captureDetail = {
  name: 'capture_detail',
  description:
    'Fetch a single capture by id. Returns the full content, status, reporter, plus the *widget context* captured at submit time — page URL, viewport, component path, recent console/network errors, DOM excerpt — all hoisted to the top level so you can use them without parsing nested messages. Pairs 1:1 with CaptureCard. Use when Franck (or a Talk-about-it action) names a specific capture uuid.',
  paramSchema: z.object({
    capture_id: z.string().describe('Capture UUID'),
  }),
  renderHint: 'Capture',
  async handler({ capture_id }) {
    const data = await adminGet(`/api/admin/captures/${encodeURIComponent(capture_id)}`);
    const c = data.capture || data;
    const widgetCtx = extractWidgetContext(c.messages);
    return {
      id: c.id,
      project_name: c.project_name,
      // Devpanel's project_id (FK to projects.id). NOT the Plane id.
      project_id: c.project_id,
      // Plane project UUID — required by promote_capture to create the
      // work item in the right Plane project. May be null if this devpanel
      // project isn't linked to a Plane project. (DEVPA-217)
      plane_project_id: c.plane_project_id ?? null,
      kind: c.kind,
      status: c.status,
      content: c.content,
      screenshot_url: c.screenshot_url,
      environment: c.environment,
      external_url: c.external_url,
      reporter: c.reporter,
      created_at: c.created_at,
      updated_at: c.updated_at,
      plane_work_item_id: c.plane_work_item_id,
      plane_sequence_id: c.plane_sequence_id,
      // Hoisted widget context — see extractWidgetContext above.
      widget_context: widgetCtx,
      // Conversation history — every reply Franck/Shelly/agents have made
      // on this capture's thread (excluding the system metadata row that
      // we hoisted above).
      messages: Array.isArray(c.messages)
        ? c.messages.filter(
            (m) => !(m.role === 'system' && m.metadata && m.content?.startsWith('Captured:'))
          )
        : [],
    };
  },
};
